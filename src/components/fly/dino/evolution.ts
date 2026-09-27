/**
 * Neuroevolution for the Dino population.
 *
 * Validated recipe (see engine agent's worklog, Task 1):
 *  - sort by fitness (score at death)
 *  - elitism: top-2 brains are cloned verbatim (their lifetime dopamine
 *    learning is baked into the plastic weights, so it carries over)
 *  - the rest are bred via tournament-of-5 selection + uniform crossover,
 *    then hit with `child.mutate(0.15, strength)` for exploration
 */

import { FlyBrain } from "@/lib/flybrain/engine";

function tournament(brains: FlyBrain[], scores: number[]): FlyBrain {
  let best = Math.floor(Math.random() * brains.length);
  for (let k = 0; k < 4; k++) {
    const i = Math.floor(Math.random() * brains.length);
    if (scores[i] > scores[best]) best = i;
  }
  return brains[best];
}

export function evolvePopulation(
  brains: FlyBrain[],
  scores: number[],
  targetPop: number,
  mutationStrength: number
): FlyBrain[] {
  const n = Math.max(1, targetPop);
  const order = brains.map((_, i) => i).sort((a, b) => scores[b] - scores[a]);
  const next: FlyBrain[] = [brains[order[0]].clone()];
  if (n > 1 && brains.length > 1) {
    next.push(brains[order[1]].clone());
  }
  while (next.length < n) {
    const a = tournament(brains, scores);
    const b = tournament(brains, scores);
    const child = FlyBrain.crossover(a, b);
    child.mutate(0.15, mutationStrength);
    next.push(child);
  }
  return next.slice(0, n);
}
