/**
 * Built-in demo brains — deterministically-trained connectomes shipped with
 * the app so the Brain Library is never empty on a fresh install.
 *
 * The data lives in src/lib/generated/demo-brains.json and is produced by
 * scripts/gen-demo-brains.ts (seeded, byte-identical on re-run):
 *   - "Dino Champion"         — headless neuroevolution on a simplified
 *     rasterizer of the dino world (30 gens × 8 seeded restarts, champion
 *     picked by best median fresh-world score),
 *   - "Dusk Rider"            — the real BicycleTrainerCore driven headlessly
 *     at high turbo (801 generations of dusk-road balancing),
 *   - "Conditioned Lab Fly"   — a FlyBrain run through the BrainLab
 *     conditioning wizard's exact 24-trial schedule.
 *
 * OWNERSHIP: task 13-b (demo brains).
 *
 * CONSUMERS: BrainLibrary (built-in section + snapshot short-circuits) and
 * the Dino Arena (instant racers via `DEMO_BRAINS.filter(task === "dino")`).
 * Demo brains are CLIENT-SIDE ONLY — they are never POSTed to the database
 * and never deleted; every snapshot they need is carried inline.
 *
 * The JSON's kenyonToMbon weights are 4-decimal rounded (shrinkSnapshot in
 * the generator) — plain floats, so `FlyBrain.fromJSON` loads them as-is.
 */

import generatedJson from "@/lib/generated/demo-brains.json";
import type { BrainSnapshot } from "@/lib/flybrain/types";

export interface DemoBrain {
  /** stable id, e.g. "demo-dino-champion" */
  id: string;
  /** display name shown in the library / arena */
  name: string;
  task: "dino" | "bicycle" | "lab";
  generation: number;
  score: number;
  /** short human note — how this brain was trained */
  note: string;
  /** the full serialized connectome (same shape as DB rows carry) */
  snapshot: BrainSnapshot;
  /** marks built-in rows in the library UI */
  builtIn: true;
}

// ---------------------------------------------------------------------------
// generated-file envelope (validated loudly at module load)
// ---------------------------------------------------------------------------

interface RawArch {
  retinaCols: number;
  retinaRows: number;
  medullaChannels: number;
  medullaPools: number;
  lobulaCount: number;
  kenyonCount: number;
  mbonCount: number;
  motorCount: number;
  seed: number;
}

interface RawDemoBrainFile {
  v: number;
  generator: string;
  seed: number;
  createdAt: string;
  brains: {
    id: string;
    name: string;
    task: string;
    generation: number;
    score: number;
    note: string;
    builtIn: boolean;
    snapshot: {
      version: number;
      task: string;
      name: string;
      arch: RawArch;
      generation: number;
      score: number;
      createdAt: string;
      weights: {
        kenyonToMbon: number[];
        mbonToMotor: number[];
        lobulaToMotor?: number[];
        mbonBias: number[];
        motorBias: number[];
      };
      meta: { steps: number; rewards: number; punishments: number; note?: string };
    };
  }[];
}

function fail(message: string): never {
  throw new Error(
    `demo-brains: the generated bundle is malformed (${message}). ` +
      `Re-run \`bun scripts/gen-demo-brains.ts\` to regenerate src/lib/generated/demo-brains.json.`,
  );
}

function assertNumber(value: unknown, label: string): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fail(`${label} is not a finite number`);
}

function assertString(value: unknown, label: string): string {
  return typeof value === "string" && value.trim().length > 0 ? value : fail(`${label} is not a non-empty string`);
}

function assertArray(value: unknown, label: string): number[] {
  return Array.isArray(value) && value.every((x) => typeof x === "number" && Number.isFinite(x))
    ? (value as number[])
    : fail(`${label} is not an array of finite numbers`);
}

// The JSON import carries its inferred literal type; re-cast through unknown
// so the validation below owns the shape (and so future BrainSnapshot fields
// added to the engine — e.g. an optional lobulaToMotor — cannot break this
// module at compile time).
const file = generatedJson as unknown as Partial<RawDemoBrainFile>;

// ---------------------------------------------------------------------------
// module-load guard — fail LOUDLY (app-level crash) if the bundle is broken
// ---------------------------------------------------------------------------

if (!file || typeof file !== "object") fail("the JSON root is not an object");
if (file.v !== 1) fail(`envelope version is ${String(file.v)}, expected 1`);
if (!Array.isArray(file.brains) || file.brains.length === 0) fail("the brains array is missing or empty");

const seenIds = new Set<string>();

for (const raw of file.brains) {
  const id = assertString(raw?.id, "a brain id");
  if (seenIds.has(id)) fail(`duplicate brain id "${id}"`);
  seenIds.add(id);
  assertString(raw?.name, `brain "${id}" name`);
  if (raw?.task !== "dino" && raw?.task !== "bicycle" && raw?.task !== "lab") {
    fail(`brain "${id}" task is "${String(raw?.task)}", expected dino | bicycle | lab`);
  }
  assertNumber(raw?.generation, `brain "${id}" generation`);
  assertNumber(raw?.score, `brain "${id}" score`);
  assertString(raw?.note, `brain "${id}" note`);

  const snap = raw?.snapshot;
  if (!snap || typeof snap !== "object") fail(`brain "${id}" is missing its snapshot`);
  if (snap.version !== 1) fail(`brain "${id}" snapshot version is ${String(snap.version)}, expected 1`);
  const arch = snap.arch;
  if (!arch || typeof arch !== "object") fail(`brain "${id}" snapshot is missing its architecture`);
  assertString(snap.task, `brain "${id}" snapshot task`);

  // weight-array sizes must match the architecture exactly — FlyBrain.fromJSON
  // would throw later and far away from the cause
  const weights = snap.weights;
  if (!weights || typeof weights !== "object") fail(`brain "${id}" snapshot is missing its weights`);
  const km = assertArray(weights.kenyonToMbon, `brain "${id}" weights.kenyonToMbon`);
  const mm = assertArray(weights.mbonToMotor, `brain "${id}" weights.mbonToMotor`);
  const mb = assertArray(weights.mbonBias, `brain "${id}" weights.mbonBias`);
  const mo = assertArray(weights.motorBias, `brain "${id}" weights.motorBias`);
  if (km.length !== arch.kenyonCount * arch.mbonCount) {
    fail(`brain "${id}" kenyonToMbon has ${km.length} weights, architecture needs ${arch.kenyonCount * arch.mbonCount}`);
  }
  if (mm.length !== arch.motorCount * arch.mbonCount) {
    fail(`brain "${id}" mbonToMotor has ${mm.length} weights, architecture needs ${arch.motorCount * arch.mbonCount}`);
  }
  if (mb.length !== arch.mbonCount) {
    fail(`brain "${id}" mbonBias has ${mb.length} weights, architecture needs ${arch.mbonCount}`);
  }
  if (mo.length !== arch.motorCount) {
    fail(`brain "${id}" motorBias has ${mo.length} weights, architecture needs ${arch.motorCount}`);
  }
}

// ---------------------------------------------------------------------------
// public surface (contract: DemoBrain + DEMO_BRAINS — unchanged shapes)
// ---------------------------------------------------------------------------

export const DEMO_BRAINS: readonly DemoBrain[] = (file.brains ?? []).map((raw) => ({
  id: raw.id,
  name: raw.name,
  task: raw.task as DemoBrain["task"],
  generation: raw.generation,
  score: raw.score,
  note: raw.note,
  snapshot: raw.snapshot as unknown as BrainSnapshot,
  builtIn: true,
}));

/** O(1) demo-brain lookup by id (e.g. "demo-dino-champion"). */
export function getDemoBrain(id: string): DemoBrain | undefined {
  return DEMO_BRAINS.find((b) => b.id === id);
}
