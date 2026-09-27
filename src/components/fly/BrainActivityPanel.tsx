"use client";

/**
 * BrainActivityPanel — compact 2D canvas showing live brain activity:
 * region activity strips + dopamine meter. Used inside the trainers.
 * PLACEHOLDER — will be replaced by the visualization agent.
 *
 * CONTRACT:
 * - draws one horizontal strip per brain region (retina…motor) where each
 *   neuron is a small cell colored by its rate (brain.rates), spikes flash
 * - a dopamine bar at the bottom: green when > 0 (reward), red when < 0
 * - reads brain state each frame via rAF; no React re-render per frame
 */

import { FlyBrain } from "@/lib/flybrain/engine";

export interface BrainActivityPanelProps {
  brain: FlyBrain | null;
  height?: number;
  className?: string;
}

export function BrainActivityPanel({ brain, height = 140, className }: BrainActivityPanelProps) {
  return (
    <div
      className={`flex items-center justify-center rounded-lg border border-border bg-muted/30 text-xs text-muted-foreground ${className ?? ""}`}
      style={{ height }}
    >
      {brain ? "live brain activity…" : "no brain"}
    </div>
  );
}
