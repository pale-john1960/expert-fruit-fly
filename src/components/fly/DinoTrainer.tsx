"use client";

/**
 * DinoTrainer — the Chrome Dino game taught to a population of flies,
 * generation by generation. PLACEHOLDER — will be replaced by the dino agent.
 *
 * CONTRACT:
 * - self-contained section: game canvas + population + training controls
 * - each fly owns a FlyBrain (DEFAULT_ARCH_DINO, motor 0 = jump, 1 = duck)
 * - all flies share the same obstacle world; each controls its own dino
 * - retina from the rendered game frame via retinaFromImageData()
 * - rewards: +dopamine for passing obstacles; punishment on death
 * - generation ends when all flies die → evolve (elitism+crossover+mutate)
 * - consumes pending loads from useBrainStore("dino")
 * - "Save brain" POSTs best fly's snapshot to /api/brains
 */

export type DinoTrainerProps = Record<string, never>;

export function DinoTrainer(_props: DinoTrainerProps = {}) {
  return (
    <div className="flex h-64 items-center justify-center rounded-xl border border-border bg-muted/30 text-muted-foreground">
      Dino trainer loading…
    </div>
  );
}
