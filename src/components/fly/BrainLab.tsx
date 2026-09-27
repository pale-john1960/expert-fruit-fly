"use client";

/**
 * BrainLab — interactive explorer for the fruit fly brain.
 * PLACEHOLDER — will be replaced by the visualization agent.
 *
 * CONTRACT:
 * - hosts a live demo FlyBrain (DEFAULT_ARCH_LAB, motorCount 4)
 * - animated visual stimulus (moving bar/pattern) fed to the retina
 * - "Sugar" (+dopamine) and "Shock" (−dopamine) buttons
 * - manual poke: click neurons in the 3D view to stimulate them
 * - shows BrainVisualizer3D + region legend + live stats (spikes/s, dopamine)
 */

export type BrainLabProps = Record<string, never>;

export function BrainLab(_props: BrainLabProps = {}) {
  return (
    <div className="flex h-64 items-center justify-center rounded-xl border border-border bg-muted/30 text-muted-foreground">
      Brain lab loading…
    </div>
  );
}
