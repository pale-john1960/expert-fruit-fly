"use client";

/**
 * BrainVisualizer3D — real-time 3D visualization of the fruit fly brain.
 * PLACEHOLDER — will be replaced by the 3D visualizer agent.
 *
 * CONTRACT:
 * - props.brain: FlyBrain instance (or null while initializing)
 * - reads brain state every animation frame WITHOUT React re-renders:
 *   brain.rates (0..1), brain.spiked (0/1), brain.positions, brain.regions,
 *   brain.getDopamine(), brain.getSampleEdges(maxEdges)
 * - renders neurons as glowing points/spheres per region with anatomical
 *   colors, synapse edges as faint lines that flash when pre-synaptic rates
 *   are high, dopamine surge as a scene-wide color pulse (green reward /
 *   red punishment), slow auto-rotate + orbit controls
 */

import { FlyBrain } from "@/lib/flybrain/engine";

export interface BrainVisualizer3DProps {
  brain: FlyBrain | null;
  className?: string;
  height?: number | string;
  compact?: boolean;
}

export function BrainVisualizer3D({ brain, className, height = 420 }: BrainVisualizer3DProps) {
  return (
    <div
      className={`flex items-center justify-center rounded-xl border border-border bg-muted/30 text-muted-foreground ${className ?? ""}`}
      style={{ height }}
      data-testid="brain-visualizer"
    >
      <div className="text-center">
        <p className="text-sm font-medium">3D Brain Visualizer</p>
        <p className="text-xs">
          {brain ? `${brain.total} neurons ready — full 3D view loading…` : "waiting for a brain…"}
        </p>
      </div>
    </div>
  );
}
