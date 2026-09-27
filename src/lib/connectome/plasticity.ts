/**
 * Dopamine-gated plasticity on the real KC→MBON synapses (61,210 edges).
 *
 * Three-factor rule, after the mushroom-body learning motif (doomfly /
 * Shiu et al. lineage of models):
 *   eligibility  e += 1        when the presynaptic Kenyon cell fires
 *   e ← e × 0.99               each neural tick (0.5 ms → ~50 ms trace)
 *   dopamine d                 global scalar; PAM burst → +d, PPL burst → −d,
 *                               decays ×0.95 per tick
 *   w ← clamp(w + η · d · e, 0, 2)   every neural tick
 *
 * Only edges with nonzero eligibility are touched (active-list compaction,
 * same trick as the LIF engine) — resting edges cost nothing, so a tick is
 * O(active) instead of O(61,210).
 */

import type { PlasticTable } from "./circuit";

const ABSENT = 0xffffffff;
/** eligibility below this is treated as zero (retired from the active list) */
const ELIG_FLOOR = 1e-3;

export interface PlasticStats {
  /** cumulative Σ|Δw| since the last brain reset — "how much was learned" */
  absDw: number;
  /** mean multiplier over all plastic edges (1 = newborn) */
  meanW: number;
  /** the synapse furthest from its newborn weight */
  strongest: { src: number; dst: number; w: number } | null;
  /** edges currently carrying an eligibility trace */
  activeEdges: number;
  /** edges with w > 1.01 */
  potentiated: number;
  /** edges with w < 0.99 */
  depressed: number;
}

export class Plasticity {
  dopamine = 0;
  private readonly table: PlasticTable;
  /** edge indices with elig > 0 (compacted) */
  private readonly active: Uint32Array;
  private activeLen = 0;
  /** edge → slot in `active` (ABSENT = not active) */
  private readonly slot: Uint32Array;
  private absDw = 0;

  constructor(table: PlasticTable) {
    this.table = table;
    const n = table.edgeCount;
    this.active = new Uint32Array(n);
    this.slot = new Uint32Array(n).fill(ABSENT);
  }

  /** fresh brain: multipliers back to 1, traces and dopamine cleared */
  reset() {
    this.table.w.fill(1);
    this.table.elig.fill(0);
    this.slot.fill(ABSENT);
    this.activeLen = 0;
    this.dopamine = 0;
    this.absDw = 0;
  }

  /** a reward (+) or punishment (−) event hits the dopamine scalar */
  burst(amount: number) {
    this.dopamine += amount;
    if (this.dopamine > 3) this.dopamine = 3;
    if (this.dopamine < -3) this.dopamine = -3;
  }

  /** the presynaptic KC fired → its plastic edges gain eligibility */
  onKCfired(kc: number) {
    const t = this.table;
    const a = t.kcOff[kc];
    const b = t.kcOff[kc + 1];
    const elig = t.elig;
    for (let e = a; e < b; e++) {
      elig[e] += 1;
      if (this.slot[e] === ABSENT) {
        this.slot[e] = this.activeLen;
        this.active[this.activeLen++] = e;
      }
    }
  }

  /** one neural tick: decay eligibility, apply the 3-factor update, decay dopamine */
  tick(lr: number) {
    const { w, elig } = this.table;
    const active = this.active;
    const lrDa = lr * this.dopamine;
    let i = 0;
    while (i < this.activeLen) {
      const e = active[i];
      let el = elig[e] * 0.99;
      if (el < ELIG_FLOOR) el = 0;
      elig[e] = el;
      if (lrDa !== 0) {
        let nw = w[e] + lrDa * el;
        if (nw < 0) nw = 0;
        else if (nw > 2) nw = 2;
        this.absDw += Math.abs(nw - w[e]);
        w[e] = nw;
      }
      if (el === 0) {
        // retire: swap-remove from the active list
        const last = active[--this.activeLen];
        active[i] = last;
        this.slot[last] = i;
        this.slot[e] = ABSENT;
      } else {
        i++;
      }
    }
    this.dopamine *= 0.95;
  }

  stats(): PlasticStats {
    const { w, edgeCount } = this.table;
    let sum = 0;
    let maxDev = 0;
    let strongest: PlasticStats["strongest"] = null;
    let potentiated = 0;
    let depressed = 0;
    for (let e = 0; e < edgeCount; e++) {
      const v = w[e];
      sum += v;
      const dev = Math.abs(v - 1);
      if (dev > maxDev) {
        maxDev = dev;
        strongest = { src: this.table.src[e], dst: this.table.dst[e], w: v };
      }
      if (v > 1.01) potentiated++;
      else if (v < 0.99) depressed++;
    }
    return {
      absDw: this.absDw,
      meanW: edgeCount ? sum / edgeCount : 1,
      strongest,
      activeEdges: this.activeLen,
      potentiated,
      depressed,
    };
  }
}
