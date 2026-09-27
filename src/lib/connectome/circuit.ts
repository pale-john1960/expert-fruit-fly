/**
 * Circuit derivation for the Connectome Ride — turns the raw MaleCNS CSR
 * into the specific populations this task needs, using VERIFIED pathway
 * facts (public/connectome/README.md):
 *
 *   Kenyon cells (type KC*)           4,064 — sparse mushroom-body input
 *   MBONs (type MBON*)                   97 — mushroom body output
 *   Reward DANs (PAM*)                  316 — dopamine, appetitive
 *   Punishment DANs (PPL1/PPL2*)         24 — dopamine, aversive
 *   KC→MBON edges                     61,210 (463,640 synapses) — PLASTIC
 *   DAN→KC edges                     129,113 — dopamine really reaches KCs
 *   Visual sensory: LC4 (126), LC9 (219), LPLC2 (185) — side L/R
 *   Readout DNs (L/R pairs): DNa02, DNp09, DNg100, DNg97, DNa11, DNg13,
 *   MDN, DNp01 — direct LC→DN and MBON→DN edges exist in the graph.
 *
 * The plastic table is stored as flat typed arrays (src/dst/w/elig +
 * per-KC CSR offsets) rather than a Map-of-Maps: the trainer decays and
 * updates all 61,210 eligibility traces ~2,000×/s, which flat arrays do in
 * ~60 µs while nested Map iteration would cost tens of milliseconds.
 * `mulFor()` provides the O(log) multiplier lookup the LIF engine needs.
 */

import type { ConnectomeGraph } from "./loader";

/** flat KC→MBON plastic synapse table (THE learning substrate) */
export interface PlasticTable {
  edgeCount: number;
  /** KC index per edge */
  src: Uint32Array;
  /** MBON index per edge (sorted within each KC's slice) */
  dst: Uint32Array;
  /** synaptic multiplier — starts at 1, clamped [0, 2] */
  w: Float32Array;
  /** eligibility trace per edge */
  elig: Float32Array;
  /** per-KC CSR offsets into src/dst/w/elig (len n+1; non-KCs are empty) */
  kcOff: Uint32Array;
  /** total real synapses spanned by the plastic edges */
  synapses: number;
  /** multiplier lookup for the LIF delivery loop (binary search) */
  mulFor: (kc: number, target: number) => number;
  /** isSource flags for the LIF synapse-scale hook (KC with ≥1 plastic edge) */
  isSource: Uint8Array;
}

export interface CircuitSpec {
  kc: Uint32Array;
  mbon: Uint32Array;
  pam: Uint32Array;
  ppl: Uint32Array;
  lcLeft: Uint32Array;
  lcRight: Uint32Array;
  lcAll: Uint32Array;
  dnLeft: Uint32Array;
  dnRight: Uint32Array;
  plastic: PlasticTable;
  /** type name of every circuit member (labels for HUD stats) */
  labels: Map<number, string>;
}

const READOUT_DN_TYPES = new Set([
  "DNa02",
  "DNp09",
  "DNg100",
  "DNg97",
  "DNa11",
  "DNg13",
  "MDN",
  "DNp01",
]);
const SENSORY_LC_TYPES = new Set(["LC4", "LC9", "LPLC2"]);

export function buildCircuit(graph: ConnectomeGraph): CircuitSpec {
  const { neurons, offsets, sources, counts, n } = graph;

  const kc: number[] = [];
  const mbon: number[] = [];
  const pam: number[] = [];
  const ppl: number[] = [];
  const lcLeft: number[] = [];
  const lcRight: number[] = [];
  const dnLeft: number[] = [];
  const dnRight: number[] = [];

  const mbonFlag = new Uint8Array(n);
  const kcFlag = new Uint8Array(n);

  for (let i = 0; i < neurons.length; i++) {
    const row = neurons[i];
    const type = row[1];
    const side = row[3];
    if (type.startsWith("KC")) {
      kc.push(i);
      kcFlag[i] = 1;
    } else if (type.startsWith("MBON")) {
      mbon.push(i);
      mbonFlag[i] = 1;
    } else if (type.startsWith("PAM")) {
      pam.push(i);
    } else if (type.startsWith("PPL")) {
      ppl.push(i);
    }
    if (SENSORY_LC_TYPES.has(type)) {
      if (side === "L") lcLeft.push(i);
      else if (side === "R") lcRight.push(i);
    } else if (READOUT_DN_TYPES.has(type)) {
      if (side === "L") dnLeft.push(i);
      else if (side === "R") dnRight.push(i);
    }
  }

  // ---- plastic KC→MBON edges, collected target-major then flattened -----
  // (edges of MBON j = sources[offsets[j]..offsets[j+1]); each KC's slice
  //  ends up sorted by target index, which mulFor's binary search relies on)
  const plasticSrc: number[] = [];
  const plasticDst: number[] = [];
  let synapseTotal = 0;
  for (const j of mbon) {
    for (let e = offsets[j]; e < offsets[j + 1]; e++) {
      const s = sources[e];
      if (kcFlag[s]) {
        plasticSrc.push(s);
        plasticDst.push(j);
        synapseTotal += counts[e];
      }
    }
  }
  const edgeCount = plasticSrc.length;

  // per-KC CSR (counting sort by source — preserves the ascending dst order)
  const kcOff = new Uint32Array(n + 1);
  for (let e = 0; e < edgeCount; e++) kcOff[plasticSrc[e] + 1]++;
  for (let i = 0; i < n; i++) kcOff[i + 1] += kcOff[i];
  const cursor = kcOff.slice();
  const src = new Uint32Array(edgeCount);
  const dst = new Uint32Array(edgeCount);
  for (let e = 0; e < edgeCount; e++) {
    const k = cursor[plasticSrc[e]]++;
    src[k] = plasticSrc[e];
    dst[k] = plasticDst[e];
  }

  const w = new Float32Array(edgeCount).fill(1);
  const elig = new Float32Array(edgeCount);
  const isSource = new Uint8Array(n);
  for (let i = 0; i < n; i++) if (kcOff[i + 1] > kcOff[i]) isSource[i] = 1;

  const mulFor = (kcIdx: number, target: number): number => {
    let lo = kcOff[kcIdx];
    let hi = kcOff[kcIdx + 1] - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      const d = dst[mid];
      if (d === target) return w[mid];
      if (d < target) lo = mid + 1;
      else hi = mid - 1;
    }
    return 1; // not a plastic pair — unmodified synapse
  };

  const plastic: PlasticTable = {
    edgeCount,
    src,
    dst,
    w,
    elig,
    kcOff,
    synapses: synapseTotal,
    mulFor,
    isSource,
  };

  const lcAll = [...lcLeft, ...lcRight];

  const labels = new Map<number, string>();
  for (const i of kc) labels.set(i, neurons[i][1]);
  for (const i of mbon) labels.set(i, neurons[i][1]);
  for (const i of pam) labels.set(i, neurons[i][1]);
  for (const i of ppl) labels.set(i, neurons[i][1]);
  for (const i of lcAll) labels.set(i, neurons[i][1]);
  for (const i of dnLeft) labels.set(i, neurons[i][1]);
  for (const i of dnRight) labels.set(i, neurons[i][1]);

  return {
    kc: Uint32Array.from(kc),
    mbon: Uint32Array.from(mbon),
    pam: Uint32Array.from(pam),
    ppl: Uint32Array.from(ppl),
    lcLeft: Uint32Array.from(lcLeft),
    lcRight: Uint32Array.from(lcRight),
    lcAll: Uint32Array.from(lcAll),
    dnLeft: Uint32Array.from(dnLeft),
    dnRight: Uint32Array.from(dnRight),
    plastic,
    labels,
  };
}

/**
 * Sensory interface: assign each LC neuron a retina column (+ row band) via
 * a seeded hash of its index — deterministic across sessions. Left-side LCs
 * watch the LEFT half of the 24×9 retina, right-side LCs the right half,
 * so lateral image brightness becomes a lateral firing-rate asymmetry.
 * The returned arrays are aligned with [...lcLeft, ...lcRight] (== lcAll).
 */
export interface LcAssignment {
  /** retina column per LC (index-aligned with the lcAll array) */
  col: Uint8Array;
  /** first retina row of the band */
  rowLo: Uint8Array;
  /** number of rows in the band (2..4) */
  rowSpan: Uint8Array;
}

export function assignLcColumns(
  lcLeft: Uint32Array,
  lcRight: Uint32Array,
  cols: number,
  rows: number,
  seed = 7
): LcAssignment {
  // small splitmix-style hash of (index, salt) — deterministic
  const hash = (i: number, salt: number) => {
    let x =
      (Math.imul(i + 1, 0x9e3779b1) ^
        Math.imul(salt + 1, 0x85ebca6b) ^
        seed) >>>
      0;
    x = Math.imul(x ^ (x >>> 16), 2246822519) >>> 0;
    x = Math.imul(x ^ (x >>> 13), 3266489917) >>> 0;
    return (x ^ (x >>> 16)) >>> 0;
  };
  const count = lcLeft.length + lcRight.length;
  const col = new Uint8Array(count);
  const rowLo = new Uint8Array(count);
  const rowSpan = new Uint8Array(count);
  const half = Math.floor(cols / 2);
  let k = 0;
  for (const list of [lcLeft, lcRight]) {
    const base = list === lcLeft ? 0 : half;
    for (let m = 0; m < list.length; m++, k++) {
      const i = list[m];
      col[k] = base + (hash(i, 11) % half);
      rowSpan[k] = 2 + (hash(i, 23) % 3); // 2..4 rows
      rowLo[k] = hash(i, 37) % (rows - rowSpan[k] + 1);
    }
  }
  return { col, rowLo, rowSpan };
}
