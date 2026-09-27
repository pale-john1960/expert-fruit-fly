/**
 * FlyBrain — a browser-sized fruit fly connectome simulator.
 *
 * Design follows the approach validated by the "fly sim" wave of 2025/2026:
 *  1. Leaky-integrate-and-fire (LIF) neurons for spiking stages (Shiu et al. 2024)
 *  2. Graded (non-spiking) early visual stages, like the real fly eye
 *  3. Mushroom body (Kenyon cells → MBONs) as the learning hub
 *  4. Dopamine-gated 3-factor plasticity:
 *        Δw = η · dopamine · eligibility(pre, post)
 *     reward (dopamine > 0) strengthens recently co-active synapses,
 *     punishment (dopamine < 0) weakens them. This is how a real fly learns
 *     to associate odours/vision with sugar or shock.
 *  5. Neuroevolution on top: whole connectomes mutate + breed across generations.
 */

import {
  BrainArchitecture,
  BrainLineage,
  BrainRegion,
  BrainSnapshot,
  Edge,
  RegionRange,
  BRAIN_REGIONS,
} from "./types";
import { mulberry32, gaussian, clamp } from "./rng";

// ---------------------------------------------------------------------------
// Tunable parameters (defaults hand-tuned; overridable per brain instance)
// ---------------------------------------------------------------------------
export interface BrainParams {
  vThreshold: number; // spike threshold
  vLeak: number; // membrane leak per tick
  pspDecay: number; // post-synaptic potential decay
  refractory: number; // ticks of refractory period
  rateDecay: number; // firing-rate smoothing
  laminaAdapt: number; // adaptation speed → temporal contrast
  laminaGain: number; // transient contrast gain
  medullaScale: number; // medulla kernel normalization scale
  lobulaGain: number; // input gain of lobula neurons
  kenyonGain: number; // input gain of Kenyon cells (low ⇒ sparse)
  mbonGain: number; // input gain of MBONs
  motorGain: number; // input gain of motor neurons
  eligDecay: number; // eligibility trace decay
  wMin: number;
  wMax: number;
  lrKM: number; // learning rate kenyon→mbon
  lrMM: number; // learning rate mbon→motor
  dopamineDecay: number;
  /** APL (anterior paired lateral) neuron gain — global inhibition of
   *  Kenyon cells, the mechanism that keeps mushroom-body codes sparse */
  aplGain: number;
  /** intrinsic noise σ on spiking neurons — gives smooth firing rates and
   *  drives action exploration (like real membrane channel noise) */
  noiseSigma: number;
}

export const DEFAULT_PARAMS: BrainParams = {
  vThreshold: 1.0,
  vLeak: 0.8,
  pspDecay: 0.72,
  refractory: 3,
  rateDecay: 0.82,
  laminaAdapt: 0.06,
  laminaGain: 2.2,
  medullaScale: 2.5,
  lobulaGain: 0.7,
  kenyonGain: 1.6,
  mbonGain: 1.5,
  motorGain: 2.5,
  eligDecay: 0.8,
  wMin: -1.6,
  wMax: 1.6,
  lrKM: 0.04,
  lrMM: 0.08,
  dopamineDecay: 0.75,
  aplGain: 3.0,
  noiseSigma: 0.08,
};

export interface LayerSizes {
  retina: number;
  lamina: number;
  medulla: number;
  lobula: number;
  kenyon: number;
  mbon: number;
  motor: number;
}

const NOISE_BUF = 4096;

export class FlyBrain {
  readonly arch: BrainArchitecture;
  readonly p: BrainParams;
  readonly sizes: LayerSizes;
  readonly total: number;
  readonly regions: RegionRange[];

  // --- neural state (ordered by region, see `regions`) ---
  v: Float32Array; // membrane potential (spiking stages)
  psp: Float32Array; // accumulated synaptic input
  spiked: Uint8Array; // 1 if the neuron spiked this tick
  rates: Float32Array; // smoothed activity 0..1 (graded stages = value)
  refrac: Uint8Array;

  // graded visual state
  private retinaV: Float32Array;
  private laminaV: Float32Array;
  private laminaAdapt: Float32Array;
  private medullaV: Float32Array;

  // --- plastic weights (the LEARNED part of the brain) ---
  kenyonToMbon: Float32Array; // [mbon * kenyonCount + k]
  mbonToMotor: Float32Array; // [motor * mbonCount + m]
  lobulaToMotor: Float32Array; // [motor * lobulaCount + l] — the Giant Fiber
  // escape reflex pathway (visual → motor shortcut, like the real fly's
  // giant fiber system that triggers escape jumps in 2 synapses)
  mbonBias: Float32Array;
  motorBias: Float32Array;

  // eligibility traces + neuromodulation
  private eligKM: Float32Array;
  private eligMM: Float32Array;
  private eligLM: Float32Array;
  dopamine = 0;
  /** MBON valence compartments: +1 = appetitive (reward-learning), -1 = aversive
   *  (punishment-learning) — like the real mushroom body compartments */
  readonly mbonValence: Int8Array;

  // stats
  steps = 0;
  rewards = 0;
  punishments = 0;
  /** APL neuron feedback signal (mean Kenyon activity) */
  private aplActivity = 0;
  /** pre-generated gaussian noise table (cheap deterministic-ish noise) */
  private noiseBuf: Float32Array;

  // --- fixed wiring (CSR-style flat arrays) ---
  // medulla pools: kernel weights over retina cells
  private medullaKernel: Float32Array; // [pool * retinaSize + cell]
  private medullaKernelNZ: Int32Array; // non-zero cell indices per pool (grid stride)
  // lobula ← medulla (random sparse)
  private lobulaIn: Int32Array; // [lobula * K + i]
  private lobulaW: Float32Array;
  private lobulaFanIn: number;
  // kenyon ← lobula (random sparse, high threshold → sparse coding)
  private kenyonIn: Int32Array;
  private kenyonW: Float32Array;
  private kenyonFanIn: number;

  // --- visualization data ---
  readonly positions: Float32Array; // xyz per neuron (anatomical layout)
  private vizEdges: Edge[] | null = null;

  // motor output (smoothed)
  motorRates: Float32Array;

  constructor(arch: BrainArchitecture, params?: Partial<BrainParams>) {
    this.arch = { ...arch };
    this.p = { ...DEFAULT_PARAMS, ...params };
    const s: LayerSizes = {
      retina: arch.retinaCols * arch.retinaRows,
      lamina: arch.retinaCols * arch.retinaRows,
      medulla: arch.medullaChannels * arch.medullaPools,
      lobula: arch.lobulaCount,
      kenyon: arch.kenyonCount,
      mbon: arch.mbonCount,
      motor: arch.motorCount,
    };
    this.sizes = s;
    this.total =
      s.retina + s.lamina + s.medulla + s.lobula + s.kenyon + s.mbon + s.motor;

    let start = 0;
    this.regions = BRAIN_REGIONS.map((region) => {
      const count = (s as Record<string, number>)[region] as number;
      const range = { region, start, count };
      start += count;
      return range;
    });

    this.v = new Float32Array(this.total);
    this.psp = new Float32Array(this.total);
    this.spiked = new Uint8Array(this.total);
    this.rates = new Float32Array(this.total);
    this.refrac = new Uint8Array(this.total);

    this.retinaV = new Float32Array(s.retina);
    this.laminaV = new Float32Array(s.retina);
    this.laminaAdapt = new Float32Array(s.retina);
    this.medullaV = new Float32Array(s.medulla);

    this.kenyonToMbon = new Float32Array(s.mbon * s.kenyon);
    this.mbonToMotor = new Float32Array(s.motor * s.mbon);
    this.lobulaToMotor = new Float32Array(s.motor * s.lobula);
    this.mbonBias = new Float32Array(s.mbon);
    this.motorBias = new Float32Array(s.motor);
    this.eligKM = new Float32Array(s.mbon * s.kenyon);
    this.eligMM = new Float32Array(s.motor * s.mbon);
    this.eligLM = new Float32Array(s.motor * s.lobula);
    this.motorRates = new Float32Array(s.motor);
    this.mbonValence = new Int8Array(s.mbon);
    for (let m = 0; m < s.mbon; m++) {
      this.mbonValence[m] = m < Math.ceil(s.mbon / 2) ? 1 : -1;
    }

    this.medullaKernel = new Float32Array(s.medulla * s.retina);
    this.medullaKernelNZ = new Int32Array(s.medulla * s.retina); // 0 = unused
    this.lobulaFanIn = Math.min(10, s.medulla);
    this.lobulaIn = new Int32Array(s.lobula * this.lobulaFanIn);
    this.lobulaW = new Float32Array(s.lobula * this.lobulaFanIn);
    this.kenyonFanIn = Math.min(6, s.lobula);
    this.kenyonIn = new Int32Array(s.kenyon * this.kenyonFanIn);
    this.kenyonW = new Float32Array(s.kenyon * this.kenyonFanIn);

    this.positions = new Float32Array(this.total * 3);

    this.buildFixedWiring();
    this.initPlasticWeights();
    this.buildPositions();
    // pre-generate noise table
    const nrand = mulberry32(this.arch.seed ^ 0xa0ce);
    this.noiseBuf = new Float32Array(NOISE_BUF);
    for (let i = 0; i < NOISE_BUF; i++) {
      // sum of uniforms ≈ gaussian (Irwin–Hall)
      this.noiseBuf[i] =
        (nrand() + nrand() + nrand() + nrand() + nrand() + nrand() - 3) * 0.8;
    }
  }

  // -------------------------------------------------------------------------
  // Construction of the fixed (innate) connectome — deterministic on seed
  // -------------------------------------------------------------------------
  private buildFixedWiring() {
    const rand = mulberry32(this.arch.seed);
    const { retinaCols: C, retinaRows: R, medullaChannels: CH, medullaPools: P } =
      this.arch;
    const retinaSize = this.sizes.retina;

    // --- medulla kernels: 8 fixed feature channels (the fly's "hardware") ---
    // pools laid out as poolCols × poolRows over the retina grid
    const poolCols = P === 24 ? 8 : P === 12 ? 4 : Math.ceil(Math.sqrt(P));
    const poolRows = Math.max(1, Math.round(P / poolCols));
    const cellW = C / poolCols;
    const cellH = R / poolRows;

    for (let ch = 0; ch < CH; ch++) {
      for (let p = 0; p < P; p++) {
        const pool = ch * P + p;
        const pc = p % poolCols;
        const pr = Math.floor(p / poolCols);
        for (let r = 0; r < R; r++) {
          // only cells inside this pool's rectangle get kernel weight
          if (r < pr * cellH || r >= (pr + 1) * cellH) continue;
          for (let c = 0; c < C; c++) {
            if (c < pc * cellW || c >= (pc + 1) * cellW) continue;
            // cell center in pool-local coords, -1..1
            const lx = ((c - pc * cellW) / cellW) * 2 - 1;
            const ly = ((r - pr * cellH) / cellH) * 2 - 1;
            let w = 0;
            switch (ch) {
              case 0: // ON center / OFF surround (bright spots)
                w = (1 - Math.abs(lx) * 1.2) * (1 - Math.abs(ly) * 1.2) * 2 - 0.5;
                break;
              case 1: // OFF center / ON surround (dark spots)
                w = 0.5 - (1 - Math.abs(lx) * 1.2) * (1 - Math.abs(ly) * 1.2) * 2;
                break;
              case 2: // horizontal edge (bright left)
                w = -lx * 0.9;
                break;
              case 3: // horizontal edge (bright right)
                w = lx * 0.9;
                break;
              case 4: // vertical edge (bright top)
                w = -ly * 0.9;
                break;
              case 5: // vertical edge (bright bottom)
                w = ly * 0.9;
                break;
              case 6: // local contrast energy
                w = Math.abs(lx) * Math.abs(ly) * 0.8 + 0.1;
                break;
              case 7: // wide brightness (pool luminance)
                w = 0.35;
                break;
            }
            const idx = pool * retinaSize + r * C + c;
            this.medullaKernel[idx] = w;
            this.medullaKernelNZ[idx] = Math.abs(w) > 0.05 ? 1 : 0;
          }
        }
      }
    }

    // --- lobula ← medulla: RETINOTOPIC sparse sampling (fixed) ---
    // each lobula neuron only "looks at" one region of the visual field
    // (like the real optic lobe), so position information survives
    for (let l = 0; l < this.sizes.lobula; l++) {
      const homePool = l % P; // retinotopic home
      const hpCol = homePool % poolCols;
      const hpRow = Math.floor(homePool / poolCols);
      for (let k = 0; k < this.lobulaFanIn; k++) {
        // sample from home pool or immediate neighbors
        let pc = hpCol;
        let pr = hpRow;
        const jitter = Math.floor(rand() * 3) - 1;
        if (k % 3 === 1) pc = Math.min(poolCols - 1, Math.max(0, hpCol + jitter));
        if (k % 3 === 2) pr = Math.min(poolRows - 1, Math.max(0, hpRow + jitter));
        const pool = pr * poolCols + pc;
        const ch = Math.floor(rand() * CH);
        const src = ch * P + pool;
        this.lobulaIn[l * this.lobulaFanIn + k] = src;
        this.lobulaW[l * this.lobulaFanIn + k] = 0.5 + rand() * 0.7;
      }
    }

    // --- kenyon ← lobula: SPATIALLY-STRUCTURED divergent wiring ---
    // each Kenyon cell looks at a small window of the visual field (like the
    // real fly's projection neurons), so the mushroom body keeps a coarse
    // map of WHERE things happened — essential for learning place/task cues
    const lobulaByPool: number[][] = Array.from({ length: P }, () => []);
    for (let l = 0; l < this.sizes.lobula; l++) {
      lobulaByPool[l % P].push(l);
    }
    for (let k = 0; k < this.sizes.kenyon; k++) {
      const homePool = Math.floor(rand() * P);
      const candidates: number[] = [];
      for (let dp = -1; dp <= 1; dp++) {
        const p = (homePool + dp + P) % P;
        candidates.push(...lobulaByPool[p]);
      }
      for (let j = 0; j < this.kenyonFanIn; j++) {
        const src = candidates[Math.floor(rand() * candidates.length)] ?? 0;
        this.kenyonIn[k * this.kenyonFanIn + j] = src;
        this.kenyonW[k * this.kenyonFanIn + j] = 0.45 + rand() * 0.6;
      }
    }
  }

  private initPlasticWeights() {
    const rand = mulberry32(this.arch.seed ^ 0x5eed);
    // Kenyon→MBON: small modulatory weights on top of tonic MBON firing
    for (let i = 0; i < this.kenyonToMbon.length; i++) {
      this.kenyonToMbon[i] = (rand() - 0.5) * 0.5;
    }
    // MBON→motor: APPROACH pathway (appetitive MBONs excite motors) vs
    // AVOIDANCE pathway (aversive MBONs inhibit motors — real MBONs are
    // largely GABAergic/inhibitory). Reward potentiates approach,
    // punishment potentiates avoidance. Behavior = the balance.
    for (let o = 0; o < this.sizes.motor; o++) {
      for (let m = 0; m < this.sizes.mbon; m++) {
        const mag = 0.25 + rand() * 0.45;
        this.mbonToMotor[o * this.sizes.mbon + m] =
          this.mbonValence[m] > 0 ? mag : -mag;
      }
    }
    // Giant-fiber reflex (lobula→motor): small random seeds — evolution
    // sculpts this fast pathway (it's how a fly "knows" to escape-jump)
    for (let i = 0; i < this.lobulaToMotor.length; i++) {
      this.lobulaToMotor[i] = (rand() - 0.5) * 0.8;
    }
    // tonic biases near threshold: noise-driven baseline firing
    // (real MBONs and motor neurons fire tonically at rest)
    for (let m = 0; m < this.sizes.mbon; m++) this.mbonBias[m] = 1.0;
    for (let m = 0; m < this.sizes.motor; m++) this.motorBias[m] = 1.28;
  }

  // -------------------------------------------------------------------------
  // Anatomical 3D layout (for the visualizer) — eyes front, motor rear/bottom
  // -------------------------------------------------------------------------
  private buildPositions() {
    const rand = mulberry32(this.arch.seed ^ 0xbee);
    const set = (i: number, x: number, y: number, z: number) => {
      this.positions[i * 3] = x;
      this.positions[i * 3 + 1] = y;
      this.positions[i * 3 + 2] = z;
    };
    const { retinaCols: C, retinaRows: R, medullaChannels: CH, medullaPools: P } =
      this.arch;

    // retina: wide plane at the front (the compound eyes)
    const rr = this.range("retina");
    for (let r = 0; r < R; r++) {
      for (let c = 0; c < C; c++) {
        const i = rr.start + r * C + c;
        const x = (c / (C - 1) - 0.5) * 3.6;
        const y = (r / (R - 1) - 0.5) * 1.25;
        set(i, x, y, 2.2);
      }
    }

    // lamina: slightly behind, narrower
    const la = this.range("lamina");
    for (let r = 0; r < R; r++) {
      for (let c = 0; c < C; c++) {
        const i = la.start + r * C + c;
        const x = (c / (C - 1) - 0.5) * 3.1;
        const y = (r / (R - 1) - 0.5) * 1.1;
        set(i, x, y, 1.75);
      }
    }

    // medulla: two mirrored slabs (left/right hemispheres), channels stacked
    const me = this.range("medulla");
    const poolCols = P === 24 ? 8 : P === 12 ? 4 : Math.ceil(Math.sqrt(P));
    for (let ch = 0; ch < CH; ch++) {
      for (let p = 0; p < P; p++) {
        const i = me.start + ch * P + p;
        const pc = p % poolCols;
        const pr = Math.floor(p / poolCols);
        const poolRows = Math.max(1, Math.round(P / poolCols));
        const side = pc < poolCols / 2 ? -1 : 1;
        const x = side * (0.55 + (ch / CH) * 0.85 + (rand() - 0.5) * 0.06);
        const y = (pr / Math.max(1, poolRows - 1) - 0.5) * 1.5;
        set(i, x, y, 1.0 - (ch / CH) * 0.35);
      }
    }

    // lobula: two tight clusters
    const lo = this.range("lobula");
    for (let l = 0; l < this.sizes.lobula; l++) {
      const i = lo.start + l;
      const side = l % 2 === 0 ? -1 : 1;
      const t = rand() * Math.PI * 2;
      const u = rand();
      const rad = 0.32 * Math.cbrt(u);
      set(
        i,
        side * 0.72 + Math.cos(t) * rad,
        Math.sin(t) * rad * 0.8,
        0.45 + (rand() - 0.5) * 0.3
      );
    }

    // kenyon: twin mushroom bodies (calyx ellipsoids + vertical stalk hint)
    const ke = this.range("kenyon");
    for (let k = 0; k < this.sizes.kenyon; k++) {
      const i = ke.start + k;
      const side = k % 2 === 0 ? -1 : 1;
      const t = rand() * Math.PI * 2;
      const u = rand();
      const rad = 0.42 * Math.cbrt(u);
      const stalk = rand() < 0.25;
      if (stalk) {
        // peduncle / vertical lobe descending
        set(
          i,
          side * 0.42 + (rand() - 0.5) * 0.08,
          -0.35 - rand() * 0.55,
          -0.15 + (rand() - 0.5) * 0.08
        );
      } else {
        // calyx
        set(
          i,
          side * 0.42 + Math.cos(t) * rad,
          0.3 + Math.sin(t) * rad * 0.55,
          -0.15 + (rand() - 0.5) * 0.3
        );
      }
    }

    // mbon: arc wrapping under the mushroom bodies
    const mb = this.range("mbon");
    for (let m = 0; m < this.sizes.mbon; m++) {
      const i = mb.start + m;
      const a = (m / this.sizes.mbon) * Math.PI - Math.PI / 2;
      set(i, Math.sin(a) * 0.85, -0.55 + Math.cos(a) * 0.18, -0.5);
    }

    // motor: bottom rear, spread on a line
    const mo = this.range("motor");
    for (let m = 0; m < this.sizes.motor; m++) {
      const i = mo.start + m;
      const x =
        this.sizes.motor === 1
          ? 0
          : (m / (this.sizes.motor - 1) - 0.5) * 0.9;
      set(i, x, -0.95, -0.75);
    }
  }

  range(region: BrainRegion): RegionRange {
    return this.regions.find((r) => r.region === region)!;
  }

  // -------------------------------------------------------------------------
  // Simulation
  // -------------------------------------------------------------------------

  /**
   * Advance the whole brain by one tick.
   * @param input  retinal input currents, length = retinaCols*retinaRows,
   *               values roughly 0..1 (brightness)
   * @param dopamineDelta  neuromodulation injected this tick
   *               ( > 0 reward / sugar, < 0 punishment / shock )
   * @returns motor firing rates 0..1 (smoothed)
   */
  step(input: ArrayLike<number>, dopamineDelta = 0): Float32Array {
    this.steps++;
    const s = this.sizes;

    // --- decay dopaminergic tone ---
    this.dopamine = clamp(
      this.dopamine * this.p.dopamineDecay + dopamineDelta,
      -1,
      1
    );
    if (dopamineDelta > 0.01) this.rewards += dopamineDelta;
    if (dopamineDelta < -0.01) this.punishments += -dopamineDelta;

    // === 1. RETINA (graded photoreceptors with contrast normalization) ===
    // like real photoreceptor adaptation: subtract the mean luminance so the
    // brain encodes CONTRAST (what stands out), not absolute brightness
    const rr = this.range("retina");
    let mean = 0;
    for (let i = 0; i < s.retina; i++) mean += input[i] ?? 0;
    mean /= s.retina;
    for (let i = 0; i < s.retina; i++) {
      const val = clamp((input[i] ?? 0) - mean * 0.85, 0, 1.2);
      this.retinaV[i] = val;
      this.rates[rr.start + i] = val;
      this.spiked[rr.start + i] = 0;
    }

    // === 2. LAMINA (graded: sustained + transient contrast, like real
    //     photoreceptor→lamina channels that keep both components) ===
    const la = this.range("lamina");
    for (let i = 0; i < s.retina; i++) {
      this.laminaAdapt[i] += this.p.laminaAdapt * (this.retinaV[i] - this.laminaAdapt[i]);
      // sustained component keeps static patterns visible…
      const sustained = 0.18 + 0.62 * this.retinaV[i];
      // …transient component emphasizes changes (motion/onsets)
      const transient = (this.retinaV[i] - this.laminaAdapt[i]) * this.p.laminaGain;
      const val = clamp(sustained + transient, 0, 1);
      this.laminaV[i] = val;
      this.rates[la.start + i] = val;
      this.spiked[la.start + i] = 0;
    }

    // === 3. MEDULLA (fixed feature channels + cross-pool normalization) ===
    // each channel is centered across pools (like lateral inhibition in the
    // real medulla) so pools report CONTRAST vs the rest of the visual field
    const me = this.range("medulla");
    const retinaSize = s.retina;
    const poolArea = Math.max(1, Math.round(retinaSize / this.arch.medullaPools));
    const P = this.arch.medullaPools;
    for (let p = 0; p < s.medulla; p++) {
      let acc = 0;
      const base = p * retinaSize;
      for (let cell = 0; cell < retinaSize; cell++) {
        if (this.medullaKernelNZ[base + cell]) {
          acc += this.medullaKernel[base + cell] * this.laminaV[cell];
        }
      }
      this.medullaV[p] = acc / poolArea * this.p.medullaScale;
    }
    // center each channel across its pools
    for (let ch = 0; ch < this.arch.medullaChannels; ch++) {
      let cmean = 0;
      for (let p = 0; p < P; p++) cmean += this.medullaV[ch * P + p];
      cmean /= P;
      for (let p = 0; p < P; p++) {
        const idx = ch * P + p;
        const val = clamp(0.5 + (this.medullaV[idx] - cmean) * 1.8, 0, 1);
        this.medullaV[idx] = val;
        this.rates[me.start + idx] = val;
        this.spiked[me.start + idx] = 0;
      }
    }

    // === 4..7. SPIKING STAGES, layer by layer ===
    // lobula
    const lo = this.range("lobula");
    this.updateLIFLayer(lo.start, s.lobula, (l) => {
      let acc = 0;
      const base = l * this.lobulaFanIn;
      for (let k = 0; k < this.lobulaFanIn; k++) {
        // deviation-from-baseline: lobula encodes visual EVENTS, not the
        // constant background (keeps the layer in its dynamic range)
        acc += this.lobulaW[base + k] * (this.medullaV[this.lobulaIn[base + k]] - 0.5);
      }
      return acc * this.p.lobulaGain;
    });

    // kenyon (mushroom body intrinsic cells) — sparse coding enforced by the
    // APL neuron: global feedback inhibition proportional to total KC activity
    const ke = this.range("kenyon");
    const lobulaRates = this.rates.subarray(lo.start, lo.start + s.lobula);
    const aplInhib = this.aplActivity * this.p.aplGain;
    this.updateLIFLayer(ke.start, s.kenyon, (k) => {
      let acc = 0;
      const base = k * this.kenyonFanIn;
      for (let j = 0; j < this.kenyonFanIn; j++) {
        acc += this.kenyonW[base + j] * lobulaRates[this.kenyonIn[base + j]];
      }
      return acc * this.p.kenyonGain - aplInhib;
    });
    // update APL activity (mean Kenyon rate, smoothed)
    {
      let sum = 0;
      for (let k = 0; k < s.kenyon; k++) sum += this.rates[ke.start + k];
      const mean = sum / s.kenyon;
      this.aplActivity = this.aplActivity * 0.85 + mean * 0.15;
    }

    // mbon (mushroom body output neurons) — plastic input
    const mb = this.range("mbon");
    const kenyonRates = this.rates.subarray(ke.start, ke.start + s.kenyon);
    this.updateLIFLayer(mb.start, s.mbon, (m) => {
      let acc = 0;
      const base = m * s.kenyon;
      for (let k = 0; k < s.kenyon; k++) {
        acc += this.kenyonToMbon[base + k] * kenyonRates[k];
      }
      return this.mbonBias[m] + acc * this.p.mbonGain;
    });

    // motor — plastic input from mbon + the giant-fiber escape reflex
    // (lobula → motor shortcut for fast visual actions)
    const mo = this.range("motor");
    const mbonRates = this.rates.subarray(mb.start, mb.start + s.mbon);
    const lobulaRates2 = this.rates.subarray(lo.start, lo.start + s.lobula);
    this.updateLIFLayer(mo.start, s.motor, (m) => {
      let acc = 0;
      const base = m * s.mbon;
      for (let j = 0; j < s.mbon; j++) {
        acc += this.mbonToMotor[base + j] * mbonRates[j];
      }
      const lbase = m * s.lobula;
      for (let l = 0; l < s.lobula; l++) {
        acc += this.lobulaToMotor[lbase + l] * lobulaRates2[l];
      }
      return this.motorBias[m] + acc * this.p.motorGain;
    });

    // smoothed motor output
    for (let m = 0; m < s.motor; m++) {
      const idx = mo.start + m;
      this.motorRates[m] = this.motorRates[m] * 0.7 + this.rates[idx] * 0.3;
    }

    // === 8. DOPAMINE-GATED PLASTICITY (3-factor rule) ===
    // eligibility: which synapses were recently co-active… (decays every tick
    // regardless of dopamine, so credit is assigned to *recent* activity)
    for (let e = 0; e < this.eligKM.length; e++) this.eligKM[e] *= this.p.eligDecay;
    for (let e = 0; e < this.eligMM.length; e++) this.eligMM[e] *= this.p.eligDecay;
    for (let e = 0; e < this.eligLM.length; e++) this.eligLM[e] *= this.p.eligDecay;
    for (let k = 0; k < s.kenyon; k++) {
      const pre = kenyonRates[k];
      if (pre < 0.05) continue;
      for (let m = 0; m < s.mbon; m++) {
        const post = mbonRates[m];
        const e = m * s.kenyon + k;
        this.eligKM[e] += pre * post;
      }
    }
    for (let m = 0; m < s.mbon; m++) {
      const pre = mbonRates[m];
      if (pre < 0.05) continue;
      for (let o = 0; o < s.motor; o++) {
        const post = this.rates[mo.start + o];
        const e = o * s.mbon + m;
        this.eligMM[e] += pre * post;
      }
    }
    // giant-fiber reflex eligibility (lobula × motor co-activity)
    for (let l = 0; l < s.lobula; l++) {
      const pre = lobulaRates2[l];
      if (pre < 0.05) continue;
      for (let o = 0; o < s.motor; o++) {
        const post = this.rates[mo.start + o];
        const e = o * s.lobula + l;
        this.eligLM[e] += pre * post;
      }
    }
    // …and dopamine decides if that activity is worth keeping.
    // Compartment rule (like real mushroom-body compartments):
    //   reward (d>0) potentiates appetitive MBON synapses, weakens aversive
    //   punishment (d<0) potentiates aversive MBON synapses, weakens appetitive
    if (Math.abs(this.dopamine) > 0.005) {
      const d = this.dopamine;
      for (let m = 0; m < s.mbon; m++) {
        const dComp = d * this.mbonValence[m];
        const base = m * s.kenyon;
        for (let k = 0; k < s.kenyon; k++) {
          const e = base + k;
          const elig = this.eligKM[e];
          if (elig > 0.001) {
            this.kenyonToMbon[e] = clamp(
              this.kenyonToMbon[e] + this.p.lrKM * dComp * elig,
              this.p.wMin,
              this.p.wMax
            );
          }
        }
      }
      for (let o = 0; o < s.motor; o++) {
        const base = o * s.mbon;
        for (let m = 0; m < s.mbon; m++) {
          const e = base + m;
          const elig = this.eligMM[e];
          if (elig > 0.001) {
            // same compartment logic: reward potentiates links driven by
            // appetitive MBONs, punishment potentiates aversive-driven links
            this.mbonToMotor[e] = clamp(
              this.mbonToMotor[e] + this.p.lrMM * d * this.mbonValence[m] * elig,
              this.p.wMin,
              this.p.wMax
            );
          }
        }
      }
      // giant-fiber reflex: plain 3-factor rule (no compartments — it's
      // a hardwired reflex pathway that experience can still tune)
      for (let e = 0; e < this.eligLM.length; e++) {
        const elig = this.eligLM[e];
        if (elig > 0.001) {
          this.lobulaToMotor[e] = clamp(
            this.lobulaToMotor[e] + this.p.lrMM * d * elig,
            this.p.wMin,
            this.p.wMax
          );
        }
      }
    }

    return this.motorRates;
  }

  /** LIF update for one spiking layer with an input-current closure.
   *  Inputs are in "steady-state potential" units: a sustained input of 1.0
   *  brings the membrane exactly to threshold (leak-compensated). */
  private updateLIFLayer(
    start: number,
    count: number,
    inputOf: (i: number) => number
  ) {
    const inputScale = 1 - this.p.vLeak;
    const noise = this.p.noiseSigma;
    const nz = noise > 0 ? this.noiseBuf : null;
    for (let i = 0; i < count; i++) {
      const idx = start + i;
      let v = this.v[idx];
      // apply pending psp (pokes / external current)
      v = v * this.p.vLeak + this.psp[idx] * inputScale;
      this.psp[idx] *= this.p.pspDecay;

      if (this.refrac[idx] > 0) {
        this.refrac[idx]--;
        this.spiked[idx] = 0;
        this.v[idx] = 0;
        this.rates[idx] *= this.p.rateDecay;
        continue;
      }

      // incoming current + intrinsic membrane noise
      v += inputOf(i) * inputScale;
      if (nz) v += (nz[idx & (NOISE_BUF - 1)] + nz[(idx * 7 + this.steps) & (NOISE_BUF - 1)]) * noise;

      if (v >= this.p.vThreshold) {
        this.spiked[idx] = 1;
        this.v[idx] = 0;
        this.refrac[idx] = this.p.refractory;
        this.rates[idx] = this.rates[idx] * this.p.rateDecay + (1 - this.p.rateDecay);
      } else {
        this.spiked[idx] = 0;
        this.v[idx] = v;
        this.rates[idx] *= this.p.rateDecay;
      }
    }
  }

  /** Inject current straight into a neuron (Brain Lab "poke" feature). */
  poke(neuronIndex: number, strength = 1.5) {
    if (neuronIndex < 0 || neuronIndex >= this.total) return;
    const region = this.regionOf(neuronIndex);
    if (region === "retina" || region === "lamina" || region === "medulla") {
      // graded layers: boost their stored value via psp/v (visual approximation)
      this.psp[neuronIndex] += strength * 0.8;
    } else {
      this.psp[neuronIndex] += strength;
    }
  }

  regionOf(neuronIndex: number): BrainRegion | null {
    for (const r of this.regions) {
      if (neuronIndex >= r.start && neuronIndex < r.start + r.count) {
        return r.region;
      }
    }
    return null;
  }

  /** Current dopamine tone −1..1 (for visualization). */
  getDopamine(): number {
    return this.dopamine;
  }

  // -------------------------------------------------------------------------
  // Neuroevolution
  // -------------------------------------------------------------------------

  clone(): FlyBrain {
    const b = new FlyBrain(this.arch, this.p);
    b.kenyonToMbon.set(this.kenyonToMbon);
    b.mbonToMotor.set(this.mbonToMotor);
    b.lobulaToMotor.set(this.lobulaToMotor);
    b.mbonBias.set(this.mbonBias);
    b.motorBias.set(this.motorBias);
    b.steps = this.steps;
    b.rewards = this.rewards;
    b.punishments = this.punishments;
    return b;
  }

  /** Gaussian mutation of every evolvable parameter.
   *  kmRate is separate (default much lower): the dense Kenyon→MBON matrix
   *  carries learned associations and should drift slowly, while the compact
   *  giant-fiber and readout pathways evolve quickly. */
  mutate(rate = 0.1, strength = 0.15, kmRate?: number): void {
    const rand = mulberry32(
      (Math.random() * 0xffffffff) >>> 0
    );
    const kmr = kmRate ?? rate * 0.12;
    const go = (arr: Float32Array, r: number) => {
      for (let i = 0; i < arr.length; i++) {
        if (rand() < r) {
          arr[i] = clamp(arr[i] + gaussian(rand) * strength, this.p.wMin, this.p.wMax);
        }
      }
    };
    go(this.kenyonToMbon, kmr);
    go(this.mbonToMotor, rate);
    go(this.lobulaToMotor, rate);
    // biases evolve within a narrower range
    for (let i = 0; i < this.mbonBias.length; i++) {
      if (rand() < rate) this.mbonBias[i] += gaussian(rand) * strength * 0.3;
    }
    for (let i = 0; i < this.motorBias.length; i++) {
      if (rand() < rate) this.motorBias[i] += gaussian(rand) * strength * 0.3;
    }
  }

  /** Uniform crossover — each synapse randomly from either parent. */
  static crossover(a: FlyBrain, b: FlyBrain): FlyBrain {
    if (
      a.sizes.mbon !== b.sizes.mbon ||
      a.sizes.kenyon !== b.sizes.kenyon ||
      a.sizes.motor !== b.sizes.motor
    ) {
      return a.clone();
    }
    const child = new FlyBrain(a.arch, a.p);
    const rand = mulberry32((Math.random() * 0xffffffff) >>> 0);
    for (let i = 0; i < child.kenyonToMbon.length; i++) {
      child.kenyonToMbon[i] = rand() < 0.5 ? a.kenyonToMbon[i] : b.kenyonToMbon[i];
    }
    for (let i = 0; i < child.mbonToMotor.length; i++) {
      child.mbonToMotor[i] = rand() < 0.5 ? a.mbonToMotor[i] : b.mbonToMotor[i];
    }
    for (let i = 0; i < child.lobulaToMotor.length; i++) {
      child.lobulaToMotor[i] = rand() < 0.5 ? a.lobulaToMotor[i] : b.lobulaToMotor[i];
    }
    for (let i = 0; i < child.mbonBias.length; i++) {
      child.mbonBias[i] = rand() < 0.5 ? a.mbonBias[i] : b.mbonBias[i];
    }
    for (let i = 0; i < child.motorBias.length; i++) {
      child.motorBias[i] = rand() < 0.5 ? a.motorBias[i] : b.motorBias[i];
    }
    return child;
  }

  // -------------------------------------------------------------------------
  // Serialization — save / load learned brains
  // -------------------------------------------------------------------------

  toJSON(
    task: string,
    name: string,
    generation = 0,
    score = 0,
    lineage?: BrainLineage
  ): BrainSnapshot {
    const r4 = (a: Float32Array) => Array.from(a, (x) => Math.round(x * 1e5) / 1e5);
    const snap: BrainSnapshot = {
      version: 1,
      task,
      name,
      arch: { ...this.arch },
      generation,
      score,
      createdAt: new Date().toISOString(),
      weights: {
        kenyonToMbon: r4(this.kenyonToMbon),
        mbonToMotor: r4(this.mbonToMotor),
        lobulaToMotor: r4(this.lobulaToMotor),
        mbonBias: r4(this.mbonBias),
        motorBias: r4(this.motorBias),
      },
      meta: {
        steps: this.steps,
        rewards: Math.round(this.rewards * 10) / 10,
        punishments: Math.round(this.punishments * 10) / 10,
      },
    };
    // optional training pedigree (Task 13-c) — absent on every older snapshot
    if (lineage) snap.lineage = lineage;
    return snap;
  }

  static fromJSON(snap: BrainSnapshot): FlyBrain {
    const brain = new FlyBrain(snap.arch);
    brain.kenyonToMbon.set(snap.weights.kenyonToMbon);
    brain.mbonToMotor.set(snap.weights.mbonToMotor);
    if (snap.weights.lobulaToMotor) {
      brain.lobulaToMotor.set(snap.weights.lobulaToMotor);
    }
    brain.mbonBias.set(snap.weights.mbonBias);
    brain.motorBias.set(snap.weights.motorBias);
    brain.steps = snap.meta?.steps ?? 0;
    brain.rewards = snap.meta?.rewards ?? 0;
    brain.punishments = snap.meta?.punishments ?? 0;
    return brain;
  }

  // -------------------------------------------------------------------------
  // Visualization helpers
  // -------------------------------------------------------------------------

  /** A stable, representative sample of edges for the 3D visualizer. */
  getSampleEdges(maxEdges = 520): Edge[] {
    if (this.vizEdges) return this.vizEdges;
    const rand = mulberry32(this.arch.seed ^ 0xed9e);
    const edges: Edge[] = [];
    const rr = this.range("retina");
    const la = this.range("lamina");
    const me = this.range("medulla");
    const lo = this.range("lobula");
    const ke = this.range("kenyon");
    const mb = this.range("mbon");
    const mo = this.range("motor");
    const s = this.sizes;

    // retina → lamina (subsampled identity)
    for (let i = 0; i < s.retina; i += 3) {
      edges.push({ from: rr.start + i, to: la.start + i, weight: 1, plastic: false });
    }
    // lamina → medulla (random pool cells)
    for (let p = 0; p < s.medulla; p++) {
      const from = la.start + Math.floor(rand() * s.retina);
      edges.push({ from, to: me.start + p, weight: 0.8, plastic: false });
    }
    // medulla → lobula
    for (let l = 0; l < s.lobula; l++) {
      for (let k = 0; k < 2; k++) {
        const src = this.lobulaIn[l * this.lobulaFanIn + k];
        edges.push({
          from: me.start + src,
          to: lo.start + l,
          weight: this.lobulaW[l * this.lobulaFanIn + k],
          plastic: false,
        });
      }
    }
    // lobula → kenyon (sparse, the divergent explosion)
    for (let k = 0; k < s.kenyon; k += 2) {
      const j = Math.floor(rand() * this.kenyonFanIn);
      const src = this.kenyonIn[k * this.kenyonFanIn + j];
      edges.push({
        from: lo.start + src,
        to: ke.start + k,
        weight: this.kenyonW[k * this.kenyonFanIn + j],
        plastic: false,
      });
    }
    // kenyon → mbon (plastic! sample strongly-weighted ones)
    const plasticSamples: Edge[] = [];
    for (let m = 0; m < s.mbon; m++) {
      const base = m * s.kenyon;
      // pick top-N by |w|
      const top: Edge[] = [];
      const step = Math.max(1, Math.floor(s.kenyon / 40));
      for (let k = 0; k < s.kenyon; k += step) {
        top.push({
          from: ke.start + k,
          to: mb.start + m,
          weight: this.kenyonToMbon[base + k],
          plastic: true,
        });
      }
      top.sort((a, b) => Math.abs(b.weight) - Math.abs(a.weight));
      plasticSamples.push(...top.slice(0, 14));
    }
    edges.push(...plasticSamples);
    // mbon → motor (plastic)
    for (let o = 0; o < s.motor; o++) {
      for (let m = 0; m < s.mbon; m++) {
        edges.push({
          from: mb.start + m,
          to: mo.start + o,
          weight: this.mbonToMotor[o * s.mbon + m],
          plastic: true,
        });
      }
    }

    // shuffle lightly and cap
    for (let i = edges.length - 1; i > 0; i--) {
      if (rand() < 0.3) {
        const j = Math.floor(rand() * (i + 1));
        [edges[i], edges[j]] = [edges[j], edges[i]];
      }
    }
    this.vizEdges = edges.slice(0, maxEdges);
    return this.vizEdges;
  }
}

// ---------------------------------------------------------------------------
// Retina encoding helpers
// ---------------------------------------------------------------------------

/**
 * Downsample RGBA image data (from a canvas) into retinal input currents.
 * Returns values ~0..1 where 1 = bright.
 */
export function retinaFromImageData(
  data: Uint8ClampedArray,
  width: number,
  height: number,
  cols: number,
  rows: number,
  invert = false
): Float32Array {
  const out = new Float32Array(cols * rows);
  const cw = width / cols;
  const ch = height / rows;
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      let acc = 0;
      let n = 0;
      const x0 = Math.floor(c * cw);
      const x1 = Math.min(width, Math.floor((c + 1) * cw));
      const y0 = Math.floor(r * ch);
      const y1 = Math.min(height, Math.floor((r + 1) * ch));
      for (let y = y0; y < y1; y++) {
        for (let x = x0; x < x1; x++) {
          const i = (y * width + x) * 4;
          // luminance-ish; alpha compositing on dark background
          const a = data[i + 3] / 255;
          const lum = (data[i] * 0.299 + data[i + 1] * 0.587 + data[i + 2] * 0.114) / 255;
          acc += lum * a;
          n++;
        }
      }
      let v = n > 0 ? acc / n : 0;
      if (invert) v = 1 - v;
      out[r * cols + c] = v;
    }
  }
  return out;
}
