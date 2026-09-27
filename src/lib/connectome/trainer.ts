/**
 * ConnectomeRideCore — ONE real brain riding ONE bicycle, learning for its
 * whole lifetime. There is NO evolution and NO population here: the network
 * IS the real MaleCNS connectome (166,700 neurons, 25.5M directed edges),
 * and the ONLY thing that changes through the fly's life is the strength of
 * its 61,210 real KC→MBON synapses (dopamine-gated 3-factor plasticity).
 *
 * Loop (per physics tick, DT = 1/60 s, rAF-accumulated):
 *   1. buildRetina — the shared 24×9 dusk-road retina (bicycle/retina.ts)
 *   2. LC firing rates ← retina column-band brightness (left cols → lcLeft
 *      cells, right cols → lcRight cells; assignLcColumns is deterministic)
 *   3. ~33 LIF neural ticks (16.5 ms of brain time ≈ real time at ×1)
 *   4. KC spikes → eligibility traces, one Plasticity 3-factor update
 *   5. DN readout EMAs (80 ms) from descending-neuron spike counts
 *   6. steer = steerGain·(emaR−emaL)/(emaR+emaL+ε) via the REUSED
 *      steerFromMotors helper (clamped ±0.5), pedal = cruise + gain·mean
 *   7. stepBike → falls/offroad fire the real PPL cluster (aversive
 *      dopamine); every metre of progress fires the real PAM cluster
 *      (appetitive dopamine) + plasticity.burst(+sugar)
 *
 * Construction is async (76 MB connectome download + wiring): use the
 * `getRideCore()` singleton accessor or `ConnectomeRideCore.create()`.
 *
 * The 3D dusk world is REUSED from the bicycle tab: `sceneCore()` hands the
 * (structurally compatible) core to DuskScene — see the adapter note there.
 */

import { getConnectome, type ConnectomeGraph, type LoadProgress } from "./loader";
import { BrainCPU, PARAMETERS, type SynapseScale } from "./lif";
import {
  buildCircuit,
  assignLcColumns,
  type CircuitSpec,
  type LcAssignment,
} from "./circuit";
import { Plasticity } from "./plasticity";
import {
  DT,
  EPISODE_TIMEOUT_S,
  finishRider,
  makeBikeState,
  roadCurvature,
  stepBike,
  steerFromMotors,
  type BikeState,
} from "@/components/fly/bicycle/physics";
import {
  buildRoad,
  riderTransform,
  type RoadData,
} from "@/components/fly/bicycle/road";
import {
  buildRetina,
  RETINA_COLS,
  RETINA_ROWS,
  RETINA_SIZE,
} from "@/components/fly/bicycle/retina";
import { playSound } from "@/lib/sound";
// TYPE-ONLY import: lets sceneCore() declare the DuskScene adapter contract
// without any runtime coupling to the bicycle trainer module.
import type { BicycleTrainerCore } from "@/components/fly/bicycle/trainer";

// ------------------------------------------------------------- constants
/** LIF ticks per physics tick. The spec's "≈33" (real-time brain) measured
 *  at simSpeed ×0.17 on this machine: the visual cascade parks ~70K neurons
 *  in the event-driven active set, and scanning it 2000×/s dominates. 16
 *  ticks (8 ms of brain time per 16.7 ms physics tick) restores ~×1 simSpeed
 *  with the same drive rates — more brain-time per wall-second, honestly
 *  reported by the sim-speed chip. */
const NEURAL_TICKS_PER_PHYSICS = 16;
/** Wall-clock budget for neural work per frame (ms). When exhausted the
 *  physics accumulator is NOT drained further — the sim simply runs slower
 *  than requested (graceful degradation; `simSpeed` in the HUD reports it). */
const WORK_BUDGET_MS = 8;
/** physics-tick accumulator clamp — never spiral after a GC / stall */
const MAX_STEPS_PER_FRAME = 120;
/** pause between episodes (real seconds) — the brain persists across them */
const EPISODE_PAUSE_S = 1.2;
const MILESTONE_STEP_M = 25;
const MILESTONE_BONUS = 0.5;
/** baseline LC firing (Hz) on dark background — brightness adds on top */
const SENSORY_BASE_HZ = 6;
/** spontaneous Kenyon-cell firing (Hz): real flies keep the mushroom body
 *  sparsely active (~0.5–2 Hz per KC) — and it is THE eligibility substrate.
 *  The visual LC drive provably does NOT reach the (olfactory) mushroom body
 *  in the real wiring (measured: 0.04 KC spikes/s without this), so without
 *  spontaneous firing there would be no eligibility traces at all. */
const KC_BACKGROUND_HZ = 1;
/** Poisson rate while a dopamine neuron is bursting (Hz) */
const DAN_BURST_HZ = 120;
/** how many of the 316 PAM cells fire during a reward burst */
const PAM_SUBSET = 40;
/** descending-neuron readout smoothing (s) */
const DN_EMA_TAU = 0.08;
/** MBON display smoothing (s) */
const MBON_EMA_TAU = 0.25;
/** floor pedal drive — the fly always rolls, DN activity adds on top */
const CRUISE_BASE = 0.07;
const PEDAL_MAX = 0.3;
/** window for the "spikes/s" HUD stat (real seconds) */
const STATS_WINDOW_S = 2.5;

// ------------------------------------------------------------- tuning
/** Live-tunable shaping (Round-14 pattern: public fields + clamped setter
 *  + snapshot — dopamine magnitudes are trainer-level input, the LIF wiring
 *  math never changes). */
export interface RideTuning {
  /** dopamine per metre of forward progress (PAM burst scale, ≥ 0) */
  sugarPerM: number;
  /** dopamine when the rider falls / leaves the road (≤ 0, PPL burst) */
  punishPPL: number;
  /** η of the 3-factor rule (Δw = η·dopamine·eligibility) */
  learningRate: number;
  /** LC brightness → firing-rate gain (Hz per unit brightness) */
  sensoryGain: number;
  /** DN asymmetry → handlebar authority */
  steerGain: number;
  /** DN mean rate → extra pedal drive */
  pedalGain: number;
}

const TUNING_CLAMP: Record<keyof RideTuning, [number, number]> = {
  sugarPerM: [0, 0.2],
  punishPPL: [-2, 0],
  learningRate: [0, 0.2],
  sensoryGain: [20, 400],
  steerGain: [0.2, 4],
  pedalGain: [0, 0.02],
};

export const DEFAULT_TUNING: RideTuning = {
  sugarPerM: 0.05,
  punishPPL: -0.6,
  learningRate: 0.04,
  sensoryGain: 50,
  steerGain: 1.2,
  pedalGain: 0.004,
};

const TUNING_LABEL: Record<keyof RideTuning, string> = {
  sugarPerM: "sugar/m",
  punishPPL: "PPL shock",
  learningRate: "η",
  sensoryGain: "sensory gain",
  steerGain: "steer gain",
  pedalGain: "pedal gain",
};

// -------------------------------------------------------------- events
/** Same pattern as the bicycle trainer's event feed. */
export interface TrainerEvent {
  id: number;
  kind: "fall" | "offroad" | "milestone" | "episode" | "best" | "info" | "tune";
  text: string;
}

/** The one rider — the shape DuskScene's BikeRig reads (idx/st/retina/tag/
 *  doneRealT); `tag` is simply absent (never a challenge rider). */
export interface ConRider {
  idx: number;
  st: BikeState;
  retina: Float32Array;
  doneRealT: number;
}

/**
 * ONE real brain + ONE bicycle for a whole lifetime of episodes.
 * Construct via `create()` / `getRideCore()` (the connectome load is async).
 */
export class ConnectomeRideCore {
  readonly graph: ConnectomeGraph;
  readonly n: number;
  readonly circuit: CircuitSpec;
  readonly lc: LcAssignment;
  readonly brain: BrainCPU;
  readonly plasticity: Plasticity;
  readonly road: RoadData = buildRoad();

  // --- DuskScene adapter surface (structural subset of BicycleTrainerCore)
  riders: ConRider[] = [];
  leaderIdx = 0;
  /** always null here — the dusk scene's chase camera just checks truthiness */
  challenge: null = null;
  realTime = 0;
  /** decaying camera-shake amplitude (set when the rider bites the dust) */
  shake = 0;

  // --- episode / lifetime state
  episode = 1;
  phase: "riding" | "crashed" = "riding";
  simTime = 0;
  bestDistance = 0;
  events: TrainerEvent[] = [];
  /** Round-14 manual start: NEVER auto-run — the UI must press Start */
  running = false;
  turbo = 1;

  // --- live tuning (public fields, Round-14 pattern)
  sugarPerM = DEFAULT_TUNING.sugarPerM;
  punishPPL = DEFAULT_TUNING.punishPPL;
  learningRate = DEFAULT_TUNING.learningRate;
  sensoryGain = DEFAULT_TUNING.sensoryGain;
  steerGain = DEFAULT_TUNING.steerGain;
  pedalGain = DEFAULT_TUNING.pedalGain;

  // --- internals
  private retina = new Float32Array(RETINA_SIZE);
  private rates: Float32Array;
  /** externally stimulated neurons: LC cells + currently-bursting DANs */
  private driven: number[];
  private drivenDirty = false;
  /** DAN index → real-time second when its burst ends */
  private danBurstUntil = new Map<number, number>();
  private readonly pamSubset: Uint32Array;
  private readonly pplSubset: Uint32Array;
  private motor = new Float32Array(3);
  private emaL = 0;
  private emaR = 0;
  private mbonEma = 0;
  private prevKcCounts: Uint32Array;
  private prevDnL: Uint32Array;
  private prevDnR: Uint32Array;
  private prevMbonCounts: Uint32Array;
  private meterFloor = 0;
  private milestoneFloor = 0;
  private episodeEndReal = 0;
  private accumulator = 0;
  private eventSeq = 1;
  private totalSpikes = 0;
  private totalKcSpikes = 0;
  private spikeSamples: { t: number; s: number; k: number }[] = [];
  private simSpeedEma = 0;

  constructor(graph: ConnectomeGraph) {
    this.graph = graph;
    this.n = graph.n;

    const circuit = buildCircuit(graph);
    if (circuit.lcAll.length === 0) {
      throw new Error("no sensory LC neurons found in the connectome bundle");
    }
    if (circuit.kc.length === 0 || circuit.plastic.edgeCount === 0) {
      throw new Error("no plastic KC→MBON synapses found in the connectome bundle");
    }
    this.circuit = circuit;
    this.lc = assignLcColumns(circuit.lcLeft, circuit.lcRight, RETINA_COLS, RETINA_ROWS);

    // THE learning hook: real KC→MBON synapses scaled by plastic multipliers
    const scale: SynapseScale = {
      isSource: circuit.plastic.isSource,
      mul: (source, target) => circuit.plastic.mulFor(source, target),
    };
    this.brain = new BrainCPU(graph, { seed: 1, synapseScale: scale });
    this.plasticity = new Plasticity(circuit.plastic);

    this.pamSubset = subsetOf(circuit.pam, PAM_SUBSET);
    this.pplSubset = circuit.ppl; // all 24 punishment DANs

    this.rates = new Float32Array(this.n);
    this.driven = Array.from(circuit.lcAll);
    // spontaneous KC background keeps the eligibility substrate alive —
    // appended once here, never removed (constant rate, see comment above)
    for (let i = 0; i < circuit.kc.length; i++) {
      this.rates[circuit.kc[i]] = KC_BACKGROUND_HZ;
      this.driven.push(circuit.kc[i]);
    }
    this.prevKcCounts = new Uint32Array(circuit.kc.length);
    this.prevDnL = new Uint32Array(circuit.dnLeft.length);
    this.prevDnR = new Uint32Array(circuit.dnRight.length);
    this.prevMbonCounts = new Uint32Array(circuit.mbon.length);

    this.riders = [this.makeRider()];

    // Loader contract: neurons.json rows are released once the circuit is
    // derived (keeps resident memory near the ~410 MB graph itself). Safe
    // because exactly ONE core is constructed per page session — every
    // later `getRideCore()` call returns this instance.
    graph.neurons = [];

    this.log(
      "info",
      `Real brain wired — ${graph.n.toLocaleString()} neurons · ${graph.edges.toLocaleString()} synapses. Episode 1 is ready.`
    );
  }

  /** Async factory — loads (or reuses) the 76 MB connectome bundle, then
   *  builds the circuit + LIF engine. `onProgress` drives the loading UI. */
  static async create(
    onProgress?: (p: LoadProgress) => void
  ): Promise<ConnectomeRideCore> {
    let total = 29;
    const wrapped = (p: LoadProgress) => {
      total = p.total;
      onProgress?.(p);
    };
    const graph = await getConnectome(wrapped);
    onProgress?.({ done: total, total, file: "connectome wiring", phase: "wire" });
    // let the "wiring" progress paint before the ~0.5 s synchronous build
    await new Promise((resolve) => setTimeout(resolve, 40));
    return new ConnectomeRideCore(graph);
  }

  // ------------------------------------------------------------- main loop

  /** advance the simulation by `frameDt` real seconds (rAF-driven) */
  advance(frameDt: number) {
    this.realTime += frameDt;
    if (this.shake > 0.0001) this.shake *= Math.exp(-frameDt * 5);
    if (!this.running) return;

    if (this.phase === "crashed") {
      // inter-episode pause: dopamine + eligibility keep decaying at the
      // physics rate so the shock washes out before the next ride
      this.plasticity.tick(this.learningRate);
      if (this.realTime - this.episodeEndReal >= EPISODE_PAUSE_S) {
        this.startEpisode();
      }
      return;
    }

    this.accumulator += frameDt * this.turbo;
    if (this.accumulator > MAX_STEPS_PER_FRAME * DT) {
      this.accumulator = MAX_STEPS_PER_FRAME * DT; // never spiral
    }
    const t0 = performance.now();
    let steps = 0;
    while (this.accumulator >= DT) {
      // work budget: at least one unit always runs; beyond that, degrade
      // gracefully (the accumulator keeps the remainder → sim slows down)
      if (steps > 0 && performance.now() - t0 > WORK_BUDGET_MS) break;
      this.accumulator -= DT;
      this.tick();
      steps++;
    }
    if (frameDt > 0.01) {
      const ratio = (steps * DT) / frameDt;
      this.simSpeedEma += (ratio - this.simSpeedEma) * Math.min(1, frameDt * 2);
    }
  }

  private tick() {
    const rider = this.riders[0];
    const st = rider.st;
    this.simTime += DT;

    // 1) sensory: retina → LC firing rates
    buildRetina(this.retina, st, this.road);
    this.updateLcRates();

    // 2) DAN bursts: expire finished ones, keep the driven list current
    this.updateDanBursts();

    // 3) the neural batch: ~33 LIF ticks = ~16.5 ms of brain time
    let spikes = 0;
    for (let t = 0; t < NEURAL_TICKS_PER_PHYSICS; t++) {
      const fired = this.brain.advance(this.rates, this.driven);
      spikes += fired.length;
    }
    this.totalSpikes += spikes;

    // 4) learning: KC fires → eligibility, then one 3-factor update
    this.detectKcFires();
    this.plasticity.tick(this.learningRate);

    // 5) DN readout EMAs from the descending-neuron spike counters
    this.updateDnReadout();

    // 6) motor → bicycle physics. steerFromMotors computes
    //    (m1 − m0)·3·gain clamped ±0.5; feeding it the NORMALISED DN rates
    //    with gain = steerGain/3 yields exactly
    //    steerGain·(emaR−emaL)/(emaR+emaL+ε), clamped ±0.5.
    const denom = this.emaR + this.emaL + 1e-6;
    this.motor[0] = this.emaL / denom;
    this.motor[1] = this.emaR / denom;
    const meanEma = (this.emaL + this.emaR) / 2;
    let pedal = CRUISE_BASE + this.pedalGain * meanEma;
    if (pedal > PEDAL_MAX) pedal = PEDAL_MAX;
    this.motor[2] = pedal;
    const delta = steerFromMotors(this.motor, this.steerGain / 3);
    const res = stepBike(st, delta, pedal, DT, roadCurvature(st.s));

    // 7) reward: per-metre progress sugar (+ real PAM burst)
    const meters = Math.floor(st.s) - this.meterFloor;
    if (meters > 0) {
      this.meterFloor += meters;
      const amount = this.sugarPerM * meters;
      this.plasticity.burst(amount);
      this.burstDan(this.pamSubset, amount);
    }
    const mile = Math.floor(st.s / MILESTONE_STEP_M);
    if (mile > this.milestoneFloor) {
      this.milestoneFloor = mile;
      this.plasticity.burst(MILESTONE_BONUS);
      this.burstDan(this.pamSubset, MILESTONE_BONUS);
      if (this.turbo === 1) playSound("ding", 0.5);
      this.log(
        "milestone",
        `${mile * MILESTONE_STEP_M} m milestone (+${MILESTONE_BONUS} dopamine)`
      );
    }

    // 8) spikes/s sample window
    this.spikeSamples.push({
      t: this.realTime,
      s: this.totalSpikes,
      k: this.totalKcSpikes,
    });
    while (
      this.spikeSamples.length > 2 &&
      this.realTime - this.spikeSamples[0].t > STATS_WINDOW_S
    ) {
      this.spikeSamples.shift();
    }

    // 9) episode end conditions
    if (res.fell || res.offRoad) {
      const reason: "fall" | "offroad" = res.fell ? "fall" : "offroad";
      const punish = finishRider(st, reason, this.simTime, {
        fall: this.punishPPL,
        offroad: this.punishPPL * 0.7, // leaving the road hurts a bit less
      });
      rider.doneRealT = this.realTime;
      this.plasticity.burst(punish);
      this.burstDan(this.pplSubset, -punish);
      if (reason === "fall") this.shake = Math.min(0.9, this.shake + 0.5);
      if (this.turbo === 1) playSound("fall", 0.25);
      this.endEpisode(reason, punish);
      return;
    }
    if (this.simTime >= EPISODE_TIMEOUT_S) {
      finishRider(st, "timeout", this.simTime, { fall: 0, offroad: 0 });
      rider.doneRealT = this.realTime;
      this.endEpisode("timeout", 0);
    }
  }

  // ---------------------------------------------------------- populations

  private makeRider(): ConRider {
    return {
      idx: 0,
      st: makeBikeState(Math.random),
      retina: this.retina, // single shared retina buffer (always current)
      doneRealT: 0,
    };
  }

  private startEpisode() {
    this.episode += 1;
    this.phase = "riding";
    this.simTime = 0;
    this.accumulator = 0;
    this.meterFloor = 0;
    this.milestoneFloor = 0;
    this.riders[0] = this.makeRider();
    this.log(
      "episode",
      `Episode ${this.episode} — same brain, fresh legs (learning persists)`
    );
  }

  private endEpisode(reason: "fall" | "offroad" | "timeout", punish: number) {
    const st = this.riders[0].st;
    this.phase = "crashed";
    this.episodeEndReal = this.realTime;
    if (reason === "timeout") {
      this.log(
        "episode",
        `Survived the full ${EPISODE_TIMEOUT_S} s — ${st.finalS.toFixed(0)} m`
      );
    } else {
      this.log(
        reason,
        `${reason === "fall" ? "Fell" : "Left the road"} at ${st.finalS.toFixed(0)} m (${punish.toFixed(2)} dopamine · PPL burst)`
      );
    }
    if (st.finalS > this.bestDistance) {
      this.bestDistance = st.finalS;
      playSound("milestone");
      this.log("best", `New best ride: ${st.finalS.toFixed(0)} m`);
    }
  }

  // ------------------------------------------------------------ subsystems

  /** LC firing rates from the retina: each LC watches one column band;
   *  left-side LCs watch the LEFT half of the retina, right-side the right. */
  private updateLcRates() {
    const lcAll = this.circuit.lcAll;
    const { col, rowLo, rowSpan } = this.lc;
    for (let k = 0; k < lcAll.length; k++) {
      const c = col[k];
      const lo = rowLo[k];
      const span = rowSpan[k];
      let sum = 0;
      for (let r = 0; r < span; r++) {
        sum += this.retina[(lo + r) * RETINA_COLS + c];
      }
      this.rates[lcAll[k]] = SENSORY_BASE_HZ + this.sensoryGain * (sum / span);
    }
  }

  /** expire finished DAN bursts; rebuild the driven list on any change */
  private updateDanBursts() {
    if (this.danBurstUntil.size === 0 && !this.drivenDirty) return;
    let expired = false;
    for (const [idx, until] of this.danBurstUntil) {
      if (this.realTime >= until) {
        this.danBurstUntil.delete(idx);
        this.rates[idx] = 0;
        expired = true;
      }
    }
    if (expired || this.drivenDirty) this.rebuildDriven();
  }

  private rebuildDriven() {
    const lcAll = this.circuit.lcAll;
    const kc = this.circuit.kc;
    const extra = Array.from(this.danBurstUntil.keys());
    const next = new Array<number>(lcAll.length + kc.length + extra.length);
    let p = 0;
    for (let i = 0; i < lcAll.length; i++) next[p++] = lcAll[i];
    for (let i = 0; i < kc.length; i++) next[p++] = kc[i];
    for (let i = 0; i < extra.length; i++) next[p++] = extra[i];
    this.driven = next;
    this.drivenDirty = false;
  }

  /** a dopamine event: drive the given DAN cluster for a scaled duration so
   *  the reward/punishment neurons really fire (their spikes are modulatory —
   *  sign 0 — so this is visible firing, while the learning signal itself is
   *  the plasticity.burst scalar). */
  private burstDan(subset: Uint32Array, amount: number) {
    if (amount <= 0 || subset.length === 0) return;
    const duration = 0.1 + Math.min(0.5, 0.15 * amount);
    const until = this.realTime + duration;
    for (let i = 0; i < subset.length; i++) {
      const idx = subset[i];
      const prev = this.danBurstUntil.get(idx) ?? 0;
      this.danBurstUntil.set(idx, Math.max(prev, until));
      this.rates[idx] = DAN_BURST_HZ;
    }
    this.rebuildDriven();
  }

  /** KC spike detection via lifetime-counter deltas → eligibility traces */
  private detectKcFires() {
    const kc = this.circuit.kc;
    const counts = this.brain.counts;
    const prev = this.prevKcCounts;
    let fired = 0;
    for (let k = 0; k < kc.length; k++) {
      const i = kc[k];
      const c = counts[i];
      const d = c - prev[k];
      if (d > 0) {
        this.plasticity.onKCfired(i);
        fired += d;
      }
      prev[k] = c;
    }
    this.totalKcSpikes += fired;
  }

  /** DN readout: instantaneous MEAN per-neuron rates over the neural batch
   *  (sum / population / seconds), smoothed by 80 ms EMAs; the steering
   *  asymmetry is scale-invariant, but the pedal and the HUD display expect
   *  per-neuron Hz. MBON mean rate gets its own display EMA. */
  private updateDnReadout() {
    const counts = this.brain.counts;
    const neuralSec = (NEURAL_TICKS_PER_PHYSICS * PARAMETERS.dt) / 1000;

    let dl = 0;
    const dnL = this.circuit.dnLeft;
    for (let k = 0; k < dnL.length; k++) {
      dl += counts[dnL[k]] - this.prevDnL[k];
      this.prevDnL[k] = counts[dnL[k]];
    }
    let dr = 0;
    const dnR = this.circuit.dnRight;
    for (let k = 0; k < dnR.length; k++) {
      dr += counts[dnR[k]] - this.prevDnR[k];
      this.prevDnR[k] = counts[dnR[k]];
    }
    const rateL = dnL.length ? dl / neuralSec / dnL.length : 0;
    const rateR = dnR.length ? dr / neuralSec / dnR.length : 0;
    const kEma = 1 - Math.exp(-DT / DN_EMA_TAU);
    this.emaL += (rateL - this.emaL) * kEma;
    this.emaR += (rateR - this.emaR) * kEma;

    let dm = 0;
    const mbon = this.circuit.mbon;
    for (let k = 0; k < mbon.length; k++) {
      dm += counts[mbon[k]] - this.prevMbonCounts[k];
      this.prevMbonCounts[k] = counts[mbon[k]];
    }
    const rateM = mbon.length ? dm / neuralSec / mbon.length : 0;
    const kMbon = 1 - Math.exp(-DT / MBON_EMA_TAU);
    this.mbonEma += (rateM - this.mbonEma) * kMbon;
  }

  // -------------------------------------------------------------- controls

  setRunning(run: boolean) {
    this.running = run;
  }

  setTurbo(t: number) {
    this.turbo = t;
  }

  /** Live tuning — clamped to safe ranges, applied mid-episode (mirrors the
   *  bicycle trainer's Round-14 setRewardTuning pattern). */
  setTuning(patch: Partial<RideTuning>) {
    const applied: string[] = [];
    for (const key of Object.keys(TUNING_CLAMP) as (keyof RideTuning)[]) {
      const value = patch[key];
      if (typeof value !== "number" || !Number.isFinite(value)) continue;
      const [lo, hi] = TUNING_CLAMP[key];
      const next = Math.min(hi, Math.max(lo, value));
      if (next === this[key]) continue;
      this[key] = next;
      applied.push(
        `${TUNING_LABEL[key]} → ${
          key === "sensoryGain" ? next.toFixed(0) : next.toFixed(3)
        }`
      );
    }
    if (applied.length > 0) {
      this.log("tune", `Tuning: ${applied.join(" · ")}`);
    }
  }

  /** immutable copy of the current tuning (HUD + sliders read this) */
  tuningSnapshot(): RideTuning {
    return {
      sugarPerM: this.sugarPerM,
      punishPPL: this.punishPPL,
      learningRate: this.learningRate,
      sensoryGain: this.sensoryGain,
      steerGain: this.steerGain,
      pedalGain: this.pedalGain,
    };
  }

  /** Fresh newborn brain: episodes, plastic multipliers, counters — and it
   *  parks (never auto-restarts). The connectome itself stays resident. */
  reset() {
    this.brain.reset();
    this.plasticity.reset();
    this.episode = 1;
    this.bestDistance = 0;
    this.simTime = 0;
    this.accumulator = 0;
    this.phase = "riding";
    this.meterFloor = 0;
    this.milestoneFloor = 0;
    this.emaL = 0;
    this.emaR = 0;
    this.mbonEma = 0;
    this.simSpeedEma = 0;
    this.totalSpikes = 0;
    this.totalKcSpikes = 0;
    this.spikeSamples = [];
    this.prevKcCounts.fill(0);
    this.prevDnL.fill(0);
    this.prevDnR.fill(0);
    this.prevMbonCounts.fill(0);
    this.danBurstUntil.clear();
    this.rates.fill(0);
    // re-seed the spontaneous KC background after the full rate wipe
    for (let i = 0; i < this.circuit.kc.length; i++) {
      this.rates[this.circuit.kc[i]] = KC_BACKGROUND_HZ;
    }
    this.rebuildDriven();
    this.riders = [this.makeRider()];
    this.running = false;
    this.shake = 0;
    this.log("info", "Fresh newborn brain — plastic synapses reset, episode 1 waits");
  }

  log(kind: TrainerEvent["kind"], text: string) {
    this.events.push({ id: this.eventSeq++, kind, text });
    if (this.events.length > 60) this.events.shift();
  }

  // -------------------------------------------------------------- readouts

  get leader(): ConRider | null {
    return this.riders[0] ?? null;
  }

  /** immutable snapshot for React HUD updates (polled a few times/sec) */
  hudSnapshot() {
    const st = this.riders[0].st;
    const samples = this.spikeSamples;
    let spikesPerSec = 0;
    let kcPerSec = 0;
    if (samples.length >= 2 && this.realTime - samples[samples.length - 1].t < 0.4) {
      const a = samples[0];
      const b = samples[samples.length - 1];
      const span = b.t - a.t;
      if (span > 0.25) {
        spikesPerSec = (b.s - a.s) / span;
        kcPerSec = (b.k - a.k) / span;
      }
    }
    return {
      episode: this.episode,
      phase: this.phase,
      running: this.running,
      turbo: this.turbo,
      simSpeed: this.simSpeedEma,
      dist: st.alive ? st.s : st.finalS,
      best: this.bestDistance,
      speed: st.v,
      lean: st.phi,
      episodeSeconds: this.simTime,
      emaL: this.emaL,
      emaR: this.emaR,
      mbon: this.mbonEma,
      spikesPerSec,
      kcPerSec,
      activeNeurons: this.brain.activeCount,
      dopamine: this.plasticity.dopamine,
      /** true once any neural tick has ever run (start-gate copy) */
      everRan: this.totalSpikes > 0,
      plastic: this.plasticity.stats(),
      events: this.events.slice(-8),
      tuning: this.tuningSnapshot(),
    };
  }

  /** world transform of rider i (for the 3D rig — same as the bicycle's) */
  riderWorld(i: number): {
    x: number;
    z: number;
    heading: number;
    lean: number;
    y: number;
  } {
    const r = this.riders[i];
    if (!r) return { x: 0, z: 0, heading: 0, lean: 0, y: 0 };
    const t = riderTransform(this.road, r.st.s, r.st.u, r.st.psi);
    return { x: t.x, z: t.z, heading: t.heading, lean: r.st.phi, y: 0 };
  }

  /**
   * DuskScene adapter (the LOWER-RISK scene choice, documented): the bicycle
   * tab's 3D dusk world reads exactly these members of BicycleTrainerCore —
   * `riders[i].st/.retina/.doneRealT/.tag`, `riderWorld(i)`, `leaderIdx`,
   * `leader`, `realTime`, `shake`, `challenge`, `road`, `advance(dt)` — and
   * ConnectomeRideCore provides every one of them structurally (tag is
   * simply absent, challenge is always null). One documented cast reuses the
   * entire proven scene (road ribbon, posts, fireflies, bike rig, chase cam,
   * retina mini-canvas driver) instead of a second hand-rolled scene.
   */
  sceneCore(): BicycleTrainerCore {
    return this as unknown as BicycleTrainerCore;
  }
}

export type ConHudSnapshot = ReturnType<ConnectomeRideCore["hudSnapshot"]>;

/** every k-th element, at most `max` (deterministic subset of a population) */
function subsetOf(pop: Uint32Array, max: number): Uint32Array {
  if (pop.length <= max) return pop;
  const stride = Math.ceil(pop.length / max);
  const out: number[] = [];
  for (let i = 0; i < pop.length; i += stride) out.push(pop[i]);
  return Uint32Array.from(out);
}

// ------------------------------------------------------------- singleton
// Exactly ONE core per page session: the ~410 MB graph + LIF transpose are
// built once and shared — switching tabs and back reuses the SAME brain (its
// lifetime learning persists), and the 76 MB download happens once ever
// (loader-level CacheStorage). Failed loads reset the promise → retry works.

let shared: Promise<ConnectomeRideCore> | null = null;
/** every waiting caller's progress callback gets the events, not just the
 *  one whose call happened to start the download (StrictMode remounts and
 *  tab-away-and-back mid-load both stay live); cleared once settled. */
const progressListeners = new Set<(p: LoadProgress) => void>();

export function getRideCore(
  onProgress?: (p: LoadProgress) => void
): Promise<ConnectomeRideCore> {
  if (onProgress) progressListeners.add(onProgress);
  if (!shared) {
    shared = ConnectomeRideCore.create((p) => {
      for (const listener of progressListeners) listener(p);
    }).catch((error: unknown) => {
      shared = null; // allow retry after a failure
      throw error;
    });
    shared.finally(() => progressListeners.clear());
  }
  return shared;
}
