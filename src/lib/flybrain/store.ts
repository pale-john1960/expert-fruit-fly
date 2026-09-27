"use client";

/**
 * Shared state for cross-component brain loading:
 * the Brain Library "Load" button drops a snapshot here, and the matching
 * trainer (Dino / Bicycle) picks it up and adopts the learned brain.
 */

import { create } from "zustand";
import type { BrainSnapshot } from "./types";

interface BrainStore {
  /** pending loads keyed by task ("dino" | "bicycle" | ...) */
  pending: Record<string, BrainSnapshot>;
  /** info banner text (e.g. "Loaded 'Speedy' into the Dino trainer") */
  banner: string | null;
  requestLoad: (task: string, snapshot: BrainSnapshot, name: string) => void;
  consumeLoad: (task: string) => BrainSnapshot | null;
  clearBanner: () => void;
}

export const useBrainStore = create<BrainStore>((set, get) => ({
  pending: {},
  banner: null,
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
}));
