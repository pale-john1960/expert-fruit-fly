/**
 * Neuroevolution for the Dino population.
 *
 * Validated recipe (see engine agent's worklog, Task 1):
 *  - sort by fitness (score at death)
 *  - elitism: top-2 brains are cloned verbatim (their lifetime dopamine
 *    learning is baked into the plastic weights, so it carries over)
 *  - the rest are bred via tournament-of-5 selection + uniform crossover,
 *    then hit with `child.mutate(0.15, strength)` for exploration
 *
 * Lineage tracking (Task 9-b, pure record-keeping — the ALGORITHM above is
 * untouched: no extra RNG calls, no reordering, the optional 5th argument
 * only OBSERVES what the step does):
 *  - every brain the population ever contains gets a lineage node with a
 *    monotonically-increasing id, its parents' node ids (0 = founder,
 *    1 = elitism clone, 2 = crossover child), the generation it lived in
 *    and its final best score (recorded when that generation ends)
 *  - `buildLineageView` walks that graph back from the all-time champion to
 *    produce the "family tree": the main line follows the higher-scoring
 *    parent at each crossover fork, the other parent is kept as a one-deep
 *    side branch, and ancestry older than ~12 generations collapses into a
 *    "…N more generations" chip.
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

// ---------------------------------------------------------------------------
// Lineage record — session-scoped, in-memory only
// ---------------------------------------------------------------------------
/** How a brain came to exist. */
export type LineageOrigin = "founder" | "clone" | "crossover";

export interface LineageNode {
  id: number;
  /** 0-2 parent node ids (founders have none) */
  parents: number[];
  /** generation this brain lived in */
  gen: number;
  /** its final best score (death score), recorded when its generation ends */
  score: number;
  origin: LineageOrigin;
}

export interface LineageRecord {
  nodes: Map<number, LineageNode>;
  /** brain instance → its node id (weak: retired brains get GC'd) */
  ids: WeakMap<FlyBrain, number>;
  nextId: number;
  /** bumped whenever the record is rebuilt (reset / adopt) so React can tell
   *  two champions with coincidentally equal ids/scores apart */
  version: number;
}

export function freshLineage(): LineageRecord {
  return { nodes: new Map(), ids: new WeakMap(), nextId: 1, version: 1 };
}

/** Give the initial (random or adopted) population its founder nodes. */
export function registerFounders(
  rec: LineageRecord,
  brains: FlyBrain[],
  gen: number
): void {
  for (const b of brains) {
    const id = rec.nextId++;
    rec.nodes.set(id, { id, parents: [], gen, score: 0, origin: "founder" });
    rec.ids.set(b, id);
  }
}

export function nodeIdOf(rec: LineageRecord, brain: FlyBrain): number {
  return rec.ids.get(brain) ?? 0;
}

/** Context handed to evolvePopulation so it can record parent links as it
 *  builds each child. `parentIds`/`parentScores` are aligned with `brains`. */
export interface LineageContext {
  record: LineageRecord;
  parentIds: number[];
  parentScores: number[];
  /** generation the new children will live in */
  childGen: number;
}

function registerChild(
  ctx: LineageContext,
  brain: FlyBrain,
  parents: number[]
): number {
  const rec = ctx.record;
  const id = rec.nextId++;
  rec.nodes.set(id, {
    id,
    parents: parents.filter((p) => p > 0),
    gen: ctx.childGen,
    score: 0, // recorded when this child's own generation ends
    origin: parents.length > 1 ? "crossover" : "clone",
  });
  rec.ids.set(brain, id);
  return id;
}

export function evolvePopulation(
  brains: FlyBrain[],
  scores: number[],
  targetPop: number,
  mutationStrength: number,
  lineage?: LineageContext
): FlyBrain[] {
  const n = Math.max(1, targetPop);
  const order = brains.map((_, i) => i).sort((a, b) => scores[b] - scores[a]);
  if (lineage) {
    // retire the parents: their generation just ended, so their final score
    // is known (max guards against brains sharing a node — adopted clones)
    for (let i = 0; i < lineage.parentIds.length; i++) {
      const node = lineage.record.nodes.get(lineage.parentIds[i]);
      if (node) node.score = Math.max(node.score, lineage.parentScores[i] ?? 0);
    }
  }
  const next: FlyBrain[] = [brains[order[0]].clone()];
  const nextParents: number[][] = [
    lineage ? [lineage.parentIds[order[0]] ?? 0] : [],
  ];
  if (n > 1 && brains.length > 1) {
    next.push(brains[order[1]].clone());
    nextParents.push(lineage ? [lineage.parentIds[order[1]] ?? 0] : []);
  }
  while (next.length < n) {
    const a = tournament(brains, scores);
    const b = tournament(brains, scores);
    const child = FlyBrain.crossover(a, b);
    child.mutate(0.15, mutationStrength);
    next.push(child);
    nextParents.push(
      lineage
        ? [nodeIdOf(lineage.record, a), nodeIdOf(lineage.record, b)]
        : []
    );
  }
  const out = next.slice(0, n);
  if (lineage) {
    for (let i = 0; i < out.length; i++) {
      registerChild(lineage, out[i], nextParents[i]);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Champion-line view (the "family tree" the UI draws)
// ---------------------------------------------------------------------------
export interface LineageViewNode {
  id: number;
  gen: number;
  score: number;
  origin: LineageOrigin;
}

export interface LineageView {
  /** main line, OLDEST → champion (one node per generation) */
  main: LineageViewNode[];
  /** aligned with `main`: sides[i] = the non-main crossover parent of
   *  main[i] (shown one level deep only, never recursed into) */
  sides: (LineageViewNode | null)[];
  /** generations of ancestry collapsed behind the shown window */
  hiddenGens: number;
  /** oldest tracked ancestor (even if not shown) — for the summary line */
  rootGen: number;
  rootScore: number;
  champion: LineageViewNode;
  /** champion.gen − root.gen — the span of breeding behind the champion */
  breedGens: number;
}

/** show at most the last ~12 generations / ~14 main nodes */
const MAX_SHOWN_GENS = 12;
const MAX_MAIN_NODES = 13;
/** cycle guard — gens strictly decrease, this is pure paranoia */
const MAX_WALK = 4000;

function toView(n: LineageNode): LineageViewNode {
  return { id: n.id, gen: n.gen, score: n.score, origin: n.origin };
}

/**
 * Walk back from the champion through its parents. At every crossover fork
 * the higher-scoring parent continues the main line and the other parent is
 * kept as a side branch (depth 1 only).
 */
export function buildLineageView(
  rec: LineageRecord,
  championId: number
): LineageView | null {
  const champNode = rec.nodes.get(championId);
  if (!champNode) return null;

  // full walk, champion-first: full[0] = champion … full[L-1] = root;
  // fullSides[k] = the fork's non-main parent for the child full[k-1]
  const full: LineageViewNode[] = [toView(champNode)];
  const fullSides: (LineageNode | null)[] = [null];
  let cur = champNode;
  while (cur.parents.length > 0 && full.length < MAX_WALK) {
    const ps = cur.parents
      .map((id) => rec.nodes.get(id))
      .filter((p): p is LineageNode => Boolean(p));
    if (ps.length === 0) break;
    ps.sort((a, b) => b.score - a.score); // main line = higher-scoring parent
    full.push(toView(ps[0]));
    fullSides.push(ps.length > 1 ? ps[1] : null);
    cur = ps[0];
  }

  const champion = full[0];
  const root = full[full.length - 1];

  // prune: keep the champion + the most recent MAX_SHOWN_GENS ancestors
  let end = 1;
  while (
    end < full.length &&
    end < MAX_MAIN_NODES &&
    champion.gen - full[end].gen <= MAX_SHOWN_GENS
  ) {
    end++;
  }
  const main = full.slice(0, end).reverse();
  // main[i] = full[end-1-i]; its fork side lives at fullSides[end-i]
  const sides: (LineageViewNode | null)[] = new Array(end).fill(null);
  for (let i = 1; i < end; i++) {
    const side = fullSides[end - i];
    sides[i] = side ? toView(side) : null;
  }

  return {
    main,
    sides,
    hiddenGens: main[0].gen - root.gen,
    rootGen: root.gen,
    rootScore: root.score,
    champion,
    breedGens: champion.gen - root.gen,
  };
}
