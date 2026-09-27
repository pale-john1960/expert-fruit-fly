"use client";

/**
 * Shared state for cross-component brain loading:
 * the Brain Library "Load" button drops a snapshot here, and the matching
 * trainer (Dino / Bicycle) picks it up and adopts the learned brain.
 *
 * Also carries the cross-tab deep-link intent (Task 12-c): the Dopamine
 * Playground's "Run the real experiment" CTA in the How It Works tab sets
 * `labIntent` and flips the app to the Brain Lab via the app's public "1"
 * hotkey; BrainLab consumes the one-shot intent on mount and auto-arms the
 * 24-trial conditioning wizard. NOTE: this store has NO persist middleware,
 * so `labIntent` is ephemeral by construction — it never reaches
 * localStorage and dies with the page (exactly what a navigation intent
 * should do).
 */

import { create } from "zustand";
import type { BrainSnapshot } from "./types";

/** cross-tab deep-link targets inside the Brain Lab */
export type LabIntent = "conditioning";

interface BrainStore {
  /** pending loads keyed by task ("dino" | "bicycle" | ...) */
  pending: Record<string, BrainSnapshot>;
  /** info banner text (e.g. "Loaded 'Speedy' into the Dino trainer") */
  banner: string | null;
  /** one-shot deep-link intent; set by the playground CTA, consumed by BrainLab */
  labIntent: LabIntent | null;
  requestLoad: (task: string, snapshot: BrainSnapshot, name: string) => void;
  consumeLoad: (task: string) => BrainSnapshot | null;
  clearBanner: () => void;
  /** arm the deep-link intent (idempotent set) */
  requestLabIntent: (kind: LabIntent) => void;
  /** take-and-clear the intent; returns null when nothing is pending */
  consumeLabIntent: () => LabIntent | null;
}

export const useBrainStore = create<BrainStore>((set, get) => ({
  pending: {},
  banner: null,
  labIntent: null,
  requestLoad: (task, snapshot, name) =>
    set((s) => ({
      pending: { ...s.pending, [task]: snapshot },
      banner: `Loaded "${name}" (gen ${snapshot.generation}) — switch to the ${
        task === "dino" ? "Dino" : task === "bicycle" ? "Bicycle" : task
      } tab to continue training it.`,
    })),
  consumeLoad: (task) => {
    const snap = get().pending[task];
    if (snap) {
      const { [task]: _, ...rest } = get().pending;
      set({ pending: rest });
      return snap;
    }
    return null;
  },
  clearBanner: () => set({ banner: null }),
  requestLabIntent: (kind) => set({ labIntent: kind }),
  consumeLabIntent: () => {
    const kind = get().labIntent;
    if (kind) set({ labIntent: null });
    return kind;
  },
}));
