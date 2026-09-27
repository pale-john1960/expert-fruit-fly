/**
 * Champion lineage ("family tree") for the Bicycle population.
 *
 * Pure record-keeping — the evolution recipe in trainer.ts (elitism top-2 +
 * tournament-of-3 crossover + mutation) is untouched: no extra RNG calls,
 * no reordering, these helpers only OBSERVE what the trainer already does.
 *
 *  - every brain the training population ever contains gets a lineage node
 *    with a monotonically-increasing id, its parents' node ids (0 parents =
 *    founder, 1 = elite clone, 2 = crossover child), the generation it
 *    lived in and its final distance in metres (recorded when that
 *    generation ends — a rider's score IS its distance)
 *  - `buildLineageView` walks that graph back from the all-time champion
 *    (core.bestBrain) to produce the family tree: the main line follows the
 *    higher-scoring parent at each crossover fork, the other parent is kept
 *    as a one-deep side branch, and ancestry older than ~12 generations
 *    collapses into a "…N more generations" chip
 *  - watch-best / challenge riders never create nodes (challenges re-key
 *    their trained champion clone onto the champion's EXISTING node)
 *
 * Mirrors src/components/fly/dino/evolution.ts (Task 9-b) with bicycle
 * specifics: score = metres, adopted snapshots seed ONE shared founder line.
 */

import type { FlyBrain } from "@/lib/flybrain/engine";

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
  /** its final distance in metres, recorded when its generation ends */
  score: number;
  origin: LineageOrigin;
}

export interface LineageRecord {
  nodes: Map<number, LineageNode>;
  /** brain instance → its node id (weak: retired brains get GC'd) */
  ids: WeakMap<FlyBrain, number>;
  nextId: number;
  /** bumped whenever the record is rebuilt (reset / adopt) so React can
   *  tell two champions with coincidentally equal ids/scores apart —
   *  monotonic per session, never reset to 1 */
  version: number;
}

let lineageEpoch = 0;

export function freshLineage(): LineageRecord {
  lineageEpoch += 1;
  return { nodes: new Map(), ids: new WeakMap(), nextId: 1, version: lineageEpoch };
}

/** Give a population its founder nodes (gen 1 randoms, or an adopted line). */
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

export function nodeIdOf(rec: LineageRecord, brain: FlyBrain | null): number {
  return brain ? (rec.ids.get(brain) ?? 0) : 0;
}

/** Key a clone instance onto an existing node (adopted champion, challenge
 *  fold-back) — never creates nodes. */
export function rekeyToNode(rec: LineageRecord, brain: FlyBrain, nodeId: number): void {
  if (nodeId > 0 && rec.nodes.has(nodeId)) rec.ids.set(brain, nodeId);
}

/** A generation just ended: record each rider's final distance on its node.
 *  Riders without a node (watch-best clones, challenge riders) are skipped —
 *  `finalS` guards with max for brains sharing a node (adopted clones). */
export function retireGeneration(
  rec: LineageRecord,
  riders: ReadonlyArray<{ brain: FlyBrain; st: { finalS: number } }>
): void {
  for (const r of riders) {
    const node = rec.nodes.get(nodeIdOf(rec, r.brain));
    if (node) node.score = Math.max(node.score, r.st.finalS);
  }
}

/** Context describing one evolution step, as the trainer actually performed
 *  it. `children[0..eliteCount-1]` are the elite clones (1 parent each, from
 *  `eliteBrains[i]`); the rest are crossover children whose parents are
 *  consecutive pairs from `picks` (the tournament picks, in call order). */
export interface EvolutionStep {
  eliteBrains: FlyBrain[];
  eliteCount: number;
  picks: FlyBrain[];
  /** generation the new children will live in */
  childGen: number;
}

/** Register the freshly built next generation + its parent links. */
export function recordEvolution(
  rec: LineageRecord,
  children: FlyBrain[],
  step: EvolutionStep
): void {
  for (let i = 0; i < children.length; i++) {
    let parents: number[];
    if (i < step.eliteCount && i < step.eliteBrains.length) {
      parents = [nodeIdOf(rec, step.eliteBrains[i])];
    } else {
      const k = (i - step.eliteCount) * 2;
      const a = step.picks[k];
      const b = step.picks[k + 1];
      parents = a && b ? [nodeIdOf(rec, a), nodeIdOf(rec, b)] : [];
    }
    // dedupe: an adopted population shares ONE founder node, so its first
    // crossover children genuinely have a single distinct ancestor
    const unique = [...new Set(parents.filter((p) => p > 0))];
    const id = rec.nextId++;
    rec.nodes.set(id, {
      id,
      parents: unique,
      gen: step.childGen,
      score: 0, // recorded when this child's own generation ends
      origin: unique.length > 1 ? "crossover" : "clone",
    });
    rec.ids.set(children[i], id);
  }
}

// ---------------------------------------------------------------------------
// Champion-line view (the "family tree" the UI draws)
// ---------------------------------------------------------------------------
export interface LineageViewNode {
  id: number;
  gen: number;
  /** metres (rounded only for display) */
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

/** show at most the last ~12 generations / ~13 main nodes */
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
 * kept as a side branch (depth 1 only). `liveChampionScore` (the trainer's
 * live best-ever distance) raises the champion's shown metres mid-generation,
 * before its own generation ends and retires its score.
 */
export function buildLineageView(
  rec: LineageRecord,
  championId: number,
  liveChampionScore = 0
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

  // the champion's score is at least its live best-ever distance (a freshly
  // crowned rider hasn't had its generation end yet)
  full[0].score = Math.max(full[0].score, liveChampionScore);

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
