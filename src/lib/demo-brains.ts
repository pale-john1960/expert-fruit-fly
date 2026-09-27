/**
 * Built-in demo brains — deterministically-trained connectomes shipped with
 * the app so the Brain Library is never empty on a fresh install.
 *
 * OWNERSHIP: this file is owned by task 13-b (demo brains). It currently
 * contains the type contract only; 13-b replaces the placeholder with real
 * generated snapshots (see scripts/gen-demo-brains.ts).
 *
 * CONSUMERS: BrainLibrary (built-in section) and the Dino Arena (instant
 * racers when the user has no saved dino brains yet).
 */

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

/**
 * Built-in demo brains. EMPTY until 13-b lands — consumers must treat it as
 * possibly-empty (hide the section / fall back to user brains gracefully).
 */
export const DEMO_BRAINS: readonly DemoBrain[] = [];
