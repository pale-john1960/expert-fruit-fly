/**
 * Event-driven leaky-integrate-and-fire engine for the REAL MaleCNS
 * connectome (166,700 neurons, 25.5M directed edges).
 *
 * Faithful TypeScript port of `src/brain.js` from Xenova's
 * "fruit-fly-simulation" (https://huggingface.co/spaces/Xenova/fruit-fly-simulation),
 * MIT license — © the space's author. The LIF parameterisation follows
 * Shiu et al. 2024 (Nature, "A leaky integrate-and-fire model ..."),
 * adapted to MaleCNS without fitting. Units: mV, ms, Hz. No fitted weights.
 *
 * Port notes (this project):
 *  - dt = 0.5 ms instead of the reference's 0.1 ms (5× cheaper ticks; EM/ES
 *    recomputed from tau, so the dynamics stay the same regime).
 *  - delay = 4 ticks (2 ms), refractory = 4 ticks (2 ms) — the reference's
 *    1.8 / 2.2 ms rounded to whole ticks.
 *  - ONE addition beyond the reference: an optional `synapseScale` hook that
 *    multiplies delivered synaptic current for flagged source neurons. That
 *    is THE learning hook — the trainer uses it to scale real KC→MBON
 *    synapses by plastic multipliers (dopamine-gated 3-factor rule).
 *
 * Memory: the outgoing transpose is built ONCE (~204 MB of Uint32s for
 * targets+counts) on top of the incoming CSR (~204 MB). ~410 MB total RAM
 * for the full graph — documented, accepted for a real connectome.
 */

import type { ConnectomeGraph } from "./loader";

export const PARAMETERS = Object.freeze({
  /** simulation step (ms) */
  dt: 0.5,
  rest: -52,
  threshold: -45,
  /** membrane time constant (ms) */
  tauM: 20,
  /** synaptic current time constant (ms) */
  tauS: 5,
  /** absolute refractory period, in ticks (4 × 0.5 ms = 2 ms ≈ ref 2.2 ms) */
  refractory: 4,
  /** axonal delay, in ticks (4 × 0.5 ms = 2 ms ≈ ref 1.8 ms) */
  delay: 4,
  /** mV per synapse (Shiu et al., unfitted) */
  synapse: 0.275,
  /** voltage kick of one external Poisson spike (mV) */
  poissonWeight: 68.75,
});

/** Deterministic hash — port of the reference `randomWord` (Poisson drive). */
export function randomWord(i: number, t: number, seed = 1): number {
  let x =
    (Math.imul(i + 1, 747796405) ^ Math.imul(t + 1, 2891336453) ^ seed) >>> 0;
  x = Math.imul(x ^ (x >>> 16), 2246822519) >>> 0;
  x = Math.imul(x ^ (x >>> 13), 3266489917) >>> 0;
  return (x ^ (x >>> 16)) >>> 0;
}

/**
 * Build the OUTGOING transpose of the target-major CSR (edges of source i =
 * transpose.offsets[i]..transpose.offsets[i+1]). Port of `outgoingGraph`.
 * ~204 MB for the full MaleCNS graph; built once per brain.
 */
export function outgoingGraph(g: ConnectomeGraph): {
  offsets: Uint32Array;
  targets: Uint32Array;
  counts: Uint32Array;
} {
  const n = g.n;
  const offsets = new Uint32Array(n + 1);
  for (let i = 0; i < g.sources.length; i++) offsets[g.sources[i] + 1]++;
  for (let i = 0; i < n; i++) offsets[i + 1] += offsets[i];
  const cursor = offsets.slice();
  const targets = new Uint32Array(g.sources.length);
  const counts = new Uint32Array(g.sources.length);
  for (let j = 0; j < n; j++) {
    for (let e = g.offsets[j]; e < g.offsets[j + 1]; e++) {
      const k = cursor[g.sources[e]]++;
      targets[k] = j;
      counts[k] = g.counts[e];
    }
  }
  return { offsets, targets, counts };
}

const EM = Math.exp(-PARAMETERS.dt / PARAMETERS.tauM);
const ES = Math.exp(-PARAMETERS.dt / PARAMETERS.tauS);
const COUPLING =
  (PARAMETERS.tauS / (PARAMETERS.tauM - PARAMETERS.tauS)) * (EM - ES);

/** active-set compaction tolerances (see the comment inside `advance`) */
const REST_EPS = 1e-4; // mV from rest
const G_EPS = 1e-6; // residual synaptic current

/** Learning hook: scale delivered current for edges leaving flagged sources. */
export interface SynapseScale {
  /** flags[n] — 1 for sources whose edges may carry a plastic multiplier */
  isSource: Uint8Array;
  /** multiplier of the (source, target) synapse (1 = unmodified) */
  mul: (source: number, target: number) => number;
}

/**
 * Event-driven scheduling; exactly-resting neurons need no state update.
 * Port of the reference `BrainCPU` class.
 */
export class BrainCPU {
  readonly graph: ConnectomeGraph;
  readonly n: number;
  readonly seed: number;
  readonly out: {
    offsets: Uint32Array;
    targets: Uint32Array;
    counts: Uint32Array;
  };
  /** plastic KC→MBON multiplier lookup (optional — the learning hook) */
  private readonly scale: SynapseScale | null;

  v!: Float32Array;
  g!: Float32Array;
  until!: Uint32Array;
  /** lifetime spike counter per neuron (stats/readouts read deltas) */
  counts!: Uint32Array;
  /** delay ring: spikes due for delivery `delay` ticks later */
  history!: number[][];
  tick = 0;
  active!: Uint32Array;
  present!: Uint8Array;
  activeCount = 0;
  /** lifetime synaptic deliveries (stats: "synaptic events/s") */
  deliveries = 0;

  constructor(
    graph: ConnectomeGraph,
    {
      seed = 1,
      synapseScale,
    }: { seed?: number; synapseScale?: SynapseScale } = {}
  ) {
    this.graph = graph;
    this.n = graph.n;
    this.seed = seed;
    this.scale = synapseScale ?? null;
    this.out = outgoingGraph(graph);
    this.reset();
  }

  reset() {
    const n = this.n;
    this.v = new Float32Array(n).fill(PARAMETERS.rest);
    this.g = new Float32Array(n);
    this.until = new Uint32Array(n);
    this.counts = new Uint32Array(n);
    this.history = Array.from({ length: PARAMETERS.delay + 1 }, () => []);
    this.tick = 0;
    this.active = new Uint32Array(n);
    this.present = new Uint8Array(n);
    this.activeCount = 0;
  }

  private activate(i: number) {
    if (!this.present[i]) {
      this.present[i] = 1;
      this.active[this.activeCount++] = i;
    }
  }

  /**
   * One neural tick. `driven` is the caller-maintained list of externally
   * stimulated neurons (their Hz rates live in `rates`); Poisson drive uses
   * the deterministic `randomWord` hash, exactly like the reference.
   * Returns the array of neurons that fired this tick (sorted ascending).
   */
  advance(
    rates: Float32Array,
    driven: readonly number[],
    silenced = false
  ): number[] {
    const { v, g, until, counts, active, present } = this;
    const t = this.tick;
    const p = PARAMETERS;
    const scale = this.scale;
    const fired: number[] = [];
    let kept = 0;
    for (let k = 0; k < this.activeCount; k++) {
      const i = active[k];
      // Compaction: retire neurons that are back at (numerical) rest. The
      // reference skipped only the EXACT stationary state, but Float32 never
      // quite returns to it (v−rest hits a rounding fixed point), leaving
      // ~100K zombie neurons in the scan forever after any strong input.
      // The epsilon is 5 orders of magnitude below threshold — dynamics-safe.
      if (v[i] - p.rest < REST_EPS && p.rest - v[i] < REST_EPS && g[i] < G_EPS) {
        v[i] = p.rest;
        g[i] = 0;
        present[i] = 0;
        continue;
      }
      active[kept++] = i;
      if (t >= until[i]) {
        v[i] = p.rest + (v[i] - p.rest) * EM + g[i] * COUPLING;
        g[i] *= ES;
        if (v[i] > p.threshold) fired.push(i);
      }
    }
    this.activeCount = kept;
    // Preserve the dense reference's source order and Float32 accumulation.
    fired.sort((a, b) => a - b);
    const due = this.history[t % (p.delay + 1)];
    const out = this.out;
    const graph = this.graph;
    if (!silenced) {
      for (const i of due) {
        const sign = graph.sign[i] * p.synapse;
        if (sign === 0) continue;
        const plastic = scale !== null && scale.isSource[i] === 1;
        for (let e = out.offsets[i]; e < out.offsets[i + 1]; e++) {
          const j = out.targets[e];
          if (t >= until[j]) {
            // KC→MBON synapses scale their weight by the plastic multiplier.
            g[j] += out.counts[e] * sign * (plastic ? scale!.mul(i, j) : 1);
            this.deliveries++;
            this.activate(j);
          }
        }
      }
    }
    for (const i of driven) {
      if (
        t >= until[i] &&
        randomWord(i, t, this.seed) / 4294967296 < (rates[i] * p.dt) / 1000
      ) {
        v[i] += p.poissonWeight;
        this.activate(i);
      }
    }
    for (const i of fired) {
      v[i] = p.rest;
      g[i] = 0;
      // Reference semantics: externally driven neurons skip the refractory
      // period so the stimulus rate directly controls their firing.
      until[i] = t + (rates[i] > 0 ? 0 : p.refractory);
      counts[i]++;
    }
    this.history[t % (p.delay + 1)] = [];
    this.history[(t + p.delay) % (p.delay + 1)] = fired;
    this.tick++;
    return fired;
  }

  /** total spikes since the last counter reset (stats) */
  totalSpikes(): number {
    let s = 0;
    const c = this.counts;
    for (let i = 0; i < c.length; i++) s += c[i];
    return s;
  }
}
