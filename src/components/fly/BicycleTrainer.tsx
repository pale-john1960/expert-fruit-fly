"use client";

/**
 * BicycleTrainer — a fly learns to ride a bicycle in a 3D dusk world.
 * PLACEHOLDER — will be replaced by the bicycle agent.
 *
 * CONTRACT:
 * - self-contained section: R3F 3D scene + physics + training controls
 * - each fly owns a FlyBrain (DEFAULT_ARCH_BICYCLE, motors: steerL, steerR, pedal)
 * - simplified bicycle balance physics (lean dynamics, steering correction)
 * - retina synthesized from road view (perspective projection of the path)
 * - reward: forward progress / staying upright; punishment: falling / off-road
 * - generational evolution between episodes + lifetime dopamine learning
 * - consumes pending loads from useBrainStore("bicycle")
 * - "Save brain" POSTs best fly's snapshot to /api/brains
 */

export type BicycleTrainerProps = Record<string, never>;

export function BicycleTrainer(_props: BicycleTrainerProps = {}) {
  return (
    <div className="flex h-64 items-center justify-center rounded-xl border border-border bg-muted/30 text-muted-foreground">
      Bicycle trainer loading…
    </div>
  );
}
