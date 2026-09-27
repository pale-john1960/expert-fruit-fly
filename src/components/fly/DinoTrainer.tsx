"use client";

/**
 * DinoTrainer — a population of FlyBrains learns to play the Chrome Dino
 * runner, generation by generation.
 *
 * How it works:
 *  - every 60Hz sim step, the shared world (obstacles, ground, sky — NO
 *    flies) is drawn to an offscreen canvas, downscaled to 240×90 and
 *    encoded into a 24×9 retina frame shared by ALL flies (they can't see
 *    themselves — pure reactive vision)
 *  - each alive fly steps its brain: motor 0 > 0.12 → jump, motor 1 > 0.15 → duck
 *  - clearing an obstacle injects +0.4 dopamine (sugar); crashing injects
 *    −0.3 (shock) and kills the fly
 *  - when every fly is dead (or the 3-minute cap hits), the generation
 *    ends: top-2 brains are cloned (elitism), the rest are bred via
 *    tournament-of-5 crossover + mutation → next generation, automatically
 *  - cross-component brain loading via useBrainStore, session autosave via
 *    localStorage, best-brain export to the library via POST /api/brains
 *  - duck-defense metrics ("Pterodactyl report"): every run tracks birds
 *    seen vs cleared + a death cause (bird/cactus/timeout), aggregated into
 *    a session progress bar; "bird practice" spawns pterodactyls from
 *    score 0 so ducking can be trained deliberately
 *  - sound effects via @/lib/sound (milestone on new HI, gen on evolve,
 *    crash/jump at real-time speed, ding on save, click on start/resume)
 *  - "You vs the fly" duel mode: the human plays a dino avatar (arrow keys)
 *    head-to-head against the champion brain in the SAME world — identical
 *    obstacles for both, so it's a fair race. Each avatar collides
 *    independently; once one dies the survivor gets 30s to run up its
 *    score. The champion keeps receiving its usual sugar (+0.4 per clear)
 *    and shock (−0.3 on crash) during duels — extra lifetime learning —
 *    and its trained weights are written back into the trainer's champion
 *    when the duel ends, so rematches compound. Training is only PARKED
 *    while dueling (same generation, same world on return).
 *  - champion lineage ("family tree"): every brain gets a lineage node
 *    (parents + generation + final score) recorded as the evolution step
 *    builds children — elitism clones get 1 parent, crossover children 2.
 *    The champion's line is walked back through its parents and drawn as a
 *    compact SVG family tree below the score chart (higher-scoring parent
 *    continues the main line, the other parent shows as a rose side
 *    branch). Session memory only — it resets with the population.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { FlyBrain, retinaFromImageData } from "@/lib/flybrain/engine";
import { DEFAULT_ARCH_DINO } from "@/lib/flybrain/types";
import type { BrainLineage, BrainSnapshot } from "@/lib/flybrain/types";
import { useBrainStore } from "@/lib/flybrain/store";
import { hydrateSoundMuted, playSound } from "@/lib/sound";
import { BrainActivityPanel } from "./BrainActivityPanel";
import {
  buildLineageView,
  evolvePopulation,
  freshLineage,
  nodeIdOf,
  registerFounders,
} from "./dino/evolution";
import type {
  LineageOrigin,
  LineageRecord,
  LineageView,
  LineageViewNode,
} from "./dino/evolution";
import {
  BASE_SPEED,
  DUCK_THRESHOLD,
  DUEL_SURVIVOR_CAP_S,
  FLY_X,
  GAME_H,
  GAME_W,
  GEN_TIME_CAP_S,
  GROUND_Y,
  JUMP_COOLDOWN_MS,
  JUMP_THRESHOLD,
  JUMP_V,
  PUNISH_CRASH,
  RETINA_COLS,
  RETINA_H,
  RETINA_ROWS,
  RETINA_W,
  REWARD_CLEAR,
  birdsClearedCount,
  birdsSeenCount,
  createWorld,
  drawFly,
  drawWorld,
  freshDuckCounters,
  freshFly,
  hitObstacle,
  stepAvatarPhysics,
  stepWorld,
  trackBirdEncounters,
} from "./dino/game";
import type {
  DeathCause,
  DuckCounters,
  FlyAvatar,
  World,
} from "./dino/game";
import { EvolutionChart } from "./dino/EvolutionChart";
import {
  downloadTextFile,
  sessionExportFilename,
  toHistoryCsv,
  toSessionMarkdown,
} from "@/lib/session-export";
import { toast } from "sonner";
import { Toaster } from "@/components/ui/sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Progress } from "@/components/ui/progress";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Separator } from "@/components/ui/separator";
import { Slider } from "@/components/ui/slider";
import { Switch } from "@/components/ui/switch";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import {
  Tooltip as UITooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import {
  Activity,
  ArrowLeft,
  Bird,
  ChevronDown,
  Download,
  Eye,
  FileText,
  Gamepad2,
  GitBranch,
  History,
  Loader2,
  Pause,
  Play,
  RotateCcw,
  Save,
  Sparkles,
  Sprout,
  Swords,
  Trophy,
  Users,
  X,
  Zap,
} from "lucide-react";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------
interface GenStat {
  gen: number;
  best: number;
  avg: number;
}

interface FeedEvent {
  id: number;
  label: string;
  value: number;
  kind: "reward" | "punish" | "info";
  t: number;
}

interface SimRunner {
  brain: FlyBrain;
  fly: ReturnType<typeof freshFly>;
  alive: boolean;
  deathScore: number;
  idx: number;
  /** per-run duck-defense stats — the "Pterodactyl report" */
  duck: DuckCounters;
  deathCause: DeathCause | null;
}

interface Sim {
  world: World;
  runners: SimRunner[];
  /** population parked while "watch best" replays the champion */
  savedRunners: SimRunner[] | null;
  watchMode: boolean;
  watchCooldown: number | null;
  generation: number;
  bestEver: number;
  bestGen: number;
  bestBrain: FlyBrain | null;
  history: GenStat[];
  events: FeedEvent[];
  eventId: number;
  /** bird practice: pterodactyls spawn from score 0 (read at spawn time) */
  birdPractice: boolean;
  /** duck-defense totals folded in from finished generations */
  sessionBirdsSeen: number;
  sessionBirdsCleared: number;
  /** death-cause counts for the CURRENT generation */
  genBirdDeaths: number;
  genCactusDeaths: number;
  genTimeoutDeaths: number;
  /** duel session tally (persists across duels and population resets) */
  duelWins: number;
  duelLosses: number;
  duelBest: number; // best HUMAN score achieved in a duel this session
  /** champion lineage graph (session memory — resets with the population) */
  lineage: LineageRecord;
  /** lineage node id of the current all-time champion brain (0 = none) */
  bestNodeId: number;
}

interface Art {
  game: HTMLCanvasElement;
  gameCtx: CanvasRenderingContext2D;
  retina: HTMLCanvasElement;
  retinaCtx: CanvasRenderingContext2D;
}

// ---------------------------------------------------------------------------
// "You vs the fly" duel mode
// ---------------------------------------------------------------------------
interface DuelAvatar {
  fly: FlyAvatar;
  alive: boolean;
  /** score at death (frozen once dead) */
  deathScore: number;
}

interface DuelResult {
  winner: "you" | "fly" | "tie";
  youScore: number;
  flyScore: number;
}

/** Module-level duel state — stepped by the same rAF loop, never re-created
 *  by React renders. The training Sim is only PARKED while a duel runs. */
interface DuelSim {
  world: World;
  human: DuelAvatar;
  /** the champion brain, cloned from sim.bestBrain (it keeps learning) */
  ai: { brain: FlyBrain } & DuelAvatar;
  /** held duck key (ArrowDown / S) */
  duckHeld: boolean;
  /** edge-triggered jump (set by keydown, consumed by the next step) */
  jumpQueued: boolean;
  /** world time of the first avatar's death — starts the 30s survivor cap */
  firstDeathT: number | null;
  ended: boolean;
  result: DuelResult | null;
}

/** Duel slice pushed into React at the 4Hz flush cadence. */
interface DuelHud {
  you: number;
  fly: number;
  youAlive: boolean;
  flyAlive: boolean;
  youAir: boolean; // human avatar airborne (for tests / data-duel attr)
  score: number;
  speed: number;
  ended: boolean;
  result: DuelResult | null;
  wins: number;
  losses: number;
  best: number;
}

/** Both avatars collide at the SAME x lane (FLY_X) so the race is perfectly
 *  fair — identical timing against identical obstacles. The sprites are
 *  drawn a little apart purely visually. */
const DUEL_HUMAN_X = FLY_X + 14;
const DUEL_FLY_X = FLY_X - 14;
const DUEL_HUMAN_RING = "rgba(251,191,36,0.95)";
const DUEL_HUMAN_LABEL = "#fbbf24";
const DUEL_FLY_RING = "rgba(52,211,153,0.9)";
const DUEL_FLY_LABEL = "#34d399";

const STEP_DT = 1 / 60;
const MAX_STEPS_PER_FRAME = 60;
const AUTOSAVE_KEY = "fly-dino-autosave";

// ---------------------------------------------------------------------------
// Simulation internals (module level — zero React re-renders in the loop)
// ---------------------------------------------------------------------------
function createArt(): Art {
  const game = document.createElement("canvas");
  game.width = GAME_W;
  game.height = GAME_H;
  const gameCtx = game.getContext("2d");
  const retina = document.createElement("canvas");
  retina.width = RETINA_W;
  retina.height = RETINA_H;
  const retinaCtx = retina.getContext("2d", { willReadFrequently: true });
  if (!gameCtx || !retinaCtx) {
    throw new Error("2D canvas unavailable");
  }
  return { game, gameCtx, retina, retinaCtx };
}

function makeRunner(brain: FlyBrain, idx: number): SimRunner {
  return {
    brain,
    fly: freshFly(),
    alive: true,
    deathScore: 0,
    idx,
    duck: freshDuckCounters(),
    deathCause: null,
  };
}

/** New world honoring the current bird-practice setting. */
function freshWorld(sim: Sim): World {
  const w = createWorld();
  w.birdPractice = sim.birdPractice;
  return w;
}

function pushEvent(
  sim: Sim,
  label: string,
  value: number,
  kind: FeedEvent["kind"],
  t: number
): void {
  sim.eventId += 1;
  sim.events.push({ id: sim.eventId, label, value, kind, t });
  if (sim.events.length > 40) sim.events.splice(0, sim.events.length - 40);
}

function bestAliveBrain(sim: Sim): FlyBrain | null {
  let best: FlyBrain | null = null;
  let bestR = -Infinity;
  for (const r of sim.runners) {
    if (r.alive && r.brain.rewards > bestR) {
      bestR = r.brain.rewards;
      best = r.brain;
    }
  }
  return best ?? sim.runners[0]?.brain ?? null;
}

function autosave(sim: Sim): void {
  try {
    // snapshot.generation = session's latest gen, so "Resume" continues
    // numbering where the session left off (population = clones of best brain)
    const snap = sim.bestBrain
      ? sim.bestBrain.toJSON("dino", "session best", sim.generation, sim.bestEver)
      : null;
    localStorage.setItem(
      AUTOSAVE_KEY,
      JSON.stringify({
        v: 1,
        gen: sim.generation,
        bestScore: sim.bestEver,
        history: sim.history.slice(-200),
        snapshot: snap,
      })
    );
  } catch {
    // storage blocked/full — autosave is best-effort
  }
}

function endGeneration(sim: Sim, popSize: number, mutStrength: number): void {
  for (const r of sim.runners) {
    if (r.alive) {
      r.deathScore = sim.world.score;
      r.deathCause = "timeout";
      sim.genTimeoutDeaths += 1;
    }
  }
  const scores = sim.runners.map((r) => r.deathScore);
  const best = Math.max(...scores);
  const avg = scores.reduce((a, b) => a + b, 0) / Math.max(1, scores.length);
  sim.history.push({ gen: sim.generation, best, avg });

  // fold this generation's per-run bird encounters into the session totals
  const genBirdsSeen = sim.runners.reduce((a, r) => a + birdsSeenCount(r.duck), 0);
  const genBirdsCleared = sim.runners.reduce((a, r) => a + birdsClearedCount(r.duck), 0);
  sim.sessionBirdsSeen += genBirdsSeen;
  sim.sessionBirdsCleared += genBirdsCleared;

  let bi = 0;
  for (let i = 1; i < scores.length; i++) if (scores[i] > scores[bi]) bi = i;
  if (best > sim.bestEver) {
    sim.bestEver = best;
    sim.bestGen = sim.generation;
    sim.bestBrain = sim.runners[bi].brain.clone();
    sim.bestNodeId = nodeIdOf(sim.lineage, sim.runners[bi].brain);
    playSound("milestone"); // new all-time HI score
  }
  const duckNote =
    genBirdsSeen > 0
      ? ` · duck ${Math.round((100 * genBirdsCleared) / genBirdsSeen)}%`
      : "";
  pushEvent(
    sim,
    `Generation ${sim.generation} ended — best ${best}, avg ${avg.toFixed(1)}${duckNote}`,
    0,
    "info",
    sim.world.t
  );
  autosave(sim);
  playSound("gen"); // generation complete → evolve

  const brains = evolvePopulation(
    sim.runners.map((r) => r.brain),
    scores,
    popSize,
    mutStrength,
    // lineage record-keeping (pure observation — the recipe is unchanged)
    {
      record: sim.lineage,
      parentIds: sim.runners.map((r) => nodeIdOf(sim.lineage, r.brain)),
      parentScores: scores,
      childGen: sim.generation + 1,
    }
  );
  sim.generation += 1;
  sim.runners = brains.map((b, i) => makeRunner(b, i));
  sim.genBirdDeaths = 0;
  sim.genCactusDeaths = 0;
  sim.genTimeoutDeaths = 0;
  sim.world = freshWorld(sim);
}

// ---------------------------------------------------------------------------
// Duel mode internals (module level, like the training loop)
// ---------------------------------------------------------------------------
function createDuel(sim: Sim): DuelSim {
  const w = createWorld();
  w.birdPractice = sim.birdPractice; // duel world behaves like the trainer's
  return {
    world: w,
    human: { fly: freshFly(), alive: true, deathScore: 0 },
    ai: {
      brain: sim.bestBrain ? sim.bestBrain.clone() : new FlyBrain(DEFAULT_ARCH_DINO),
      fly: freshFly(),
      alive: true,
      deathScore: 0,
    },
    duckHeld: false,
    jumpQueued: false,
    firstDeathT: null,
    ended: false,
    result: null,
  };
}

/** Both avatars are done — tally the session, fold the champion's lifetime
 *  dopamine back into the trainer's best brain, freeze the result. */
function finishDuel(d: DuelSim, s: Sim): void {
  if (d.result) return;
  const youScore = d.human.deathScore;
  const flyScore = d.ai.deathScore;
  const winner: DuelResult["winner"] =
    youScore > flyScore ? "you" : youScore < flyScore ? "fly" : "tie";
  if (winner === "you") s.duelWins += 1;
  else if (winner === "fly") s.duelLosses += 1;
  const newBest = youScore > s.duelBest;
  if (newBest) s.duelBest = youScore;
  // duels double as extra lifetime learning — keep the trained weights
  s.bestBrain = d.ai.brain.clone();
  d.result = { winner, youScore, flyScore };
  d.ended = true;
  if (newBest) playSound("milestone"); // new best duel score by the human
}

/** One 60Hz duel step: shared world → vision → human keys + champion brain →
 *  physics → per-avatar collisions → end conditions. */
function stepDuel(d: DuelSim, art: Art, s: Sim, dt: number): void {
  const w = d.world;
  const cleared = stepWorld(w, dt);

  // shared avatar physics (same helper as the training runners)
  stepAvatarPhysics(d.human.fly, dt);
  stepAvatarPhysics(d.ai.fly, dt);

  // human input: duck is held, jump is edge-triggered (ignores repeats)
  d.human.fly.ducking = d.duckHeld;
  if (d.jumpQueued) {
    d.jumpQueued = false;
    const f = d.human.fly;
    if (!f.airborne && f.jumpCooldownMs <= 0) {
      f.vy = -JUMP_V;
      f.airborne = true;
      f.jumpCooldownMs = JUMP_COOLDOWN_MS;
      playSound("jump", 0.15);
    }
  }
  // the champion re-decides duck every step, exactly like a training runner
  d.ai.fly.ducking = false;

  // vision: world WITHOUT avatars → shared retina (the fly can't see you)
  drawWorld(art.gameCtx, w);
  art.retinaCtx.drawImage(art.game, 0, 0, RETINA_W, RETINA_H);
  const img = art.retinaCtx.getImageData(0, 0, RETINA_W, RETINA_H);
  const input = retinaFromImageData(
    img.data,
    RETINA_W,
    RETINA_H,
    RETINA_COLS,
    RETINA_ROWS,
    false
  );

  // champion brain — usual dopamine during duels (obstacle clear +0.4,
  // crash −0.3 further down), so every duel is extra lifetime learning
  if (d.ai.alive) {
    const delta = cleared.length > 0 ? REWARD_CLEAR : 0;
    const m = d.ai.brain.step(input, delta);
    const f = d.ai.fly;
    if (!f.airborne && f.jumpCooldownMs <= 0 && m[0] > JUMP_THRESHOLD) {
      f.vy = -JUMP_V;
      f.airborne = true;
      f.jumpCooldownMs = JUMP_COOLDOWN_MS;
    }
    if (m[1] > DUCK_THRESHOLD) f.ducking = true;
  }

  // independent collisions — each avatar dies on its own
  if (d.human.alive && hitObstacle(w, d.human.fly)) {
    d.human.alive = false;
    d.human.deathScore = w.score;
    if (d.firstDeathT === null) d.firstDeathT = w.t;
    playSound("crash", 0.25);
  }
  if (d.ai.alive && hitObstacle(w, d.ai.fly)) {
    d.ai.alive = false;
    d.ai.deathScore = w.score;
    if (d.firstDeathT === null) d.firstDeathT = w.t;
    d.ai.brain.step(input, -PUNISH_CRASH); // death shock, same as training
    playSound("crash", 0.25);
  }

  // end conditions: both dead, or the survivor's 30s cap is up
  if (!d.human.alive && !d.ai.alive) {
    finishDuel(d, s);
  } else if (
    d.firstDeathT !== null &&
    w.t - d.firstDeathT >= DUEL_SURVIVOR_CAP_S
  ) {
    if (d.human.alive) {
      d.human.alive = false;
      d.human.deathScore = w.score;
    }
    if (d.ai.alive) {
      d.ai.alive = false;
      d.ai.deathScore = w.score;
    }
    finishDuel(d, s);
  }
}

function drawDuelMarker(
  ctx: CanvasRenderingContext2D,
  x: number,
  color: string
): void {
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.ellipse(x, GROUND_Y + 3.5, 10, 2.2, 0, 0, Math.PI * 2);
  ctx.fill();
}

function renderDuel(
  canvas: HTMLCanvasElement,
  game: HTMLCanvasElement,
  d: DuelSim,
  tNow: number
): void {
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  if (canvas.width > 0 && canvas.height > 0) {
    ctx.imageSmoothingEnabled = true;
    ctx.drawImage(game, 0, 0, GAME_W, GAME_H, 0, 0, canvas.width, canvas.height);
  }
  const sx = canvas.width / GAME_W;
  const sy = canvas.height / GAME_H;
  ctx.setTransform(sx, 0, 0, sy, 0, 0);

  // champion FLY — emerald ring + halo, drawn first, slightly ghosted
  if (d.ai.alive) {
    drawDuelMarker(ctx, DUEL_FLY_X, "rgba(52,211,153,0.7)");
    drawFly(ctx, {
      x: DUEL_FLY_X,
      feetY: d.ai.fly.y,
      airborne: d.ai.fly.airborne,
      ducking: d.ai.fly.ducking,
      wingPhase: d.ai.fly.wingPhase,
      alpha: 0.82,
      isBest: true,
      label: "FLY",
      ringColor: DUEL_FLY_RING,
      labelColor: DUEL_FLY_LABEL,
      t: tNow,
    });
  }
  // HUMAN — amber ring + halo, full opacity, drawn on top
  if (d.human.alive) {
    drawDuelMarker(ctx, DUEL_HUMAN_X, "rgba(251,191,36,0.8)");
    drawFly(ctx, {
      x: DUEL_HUMAN_X,
      feetY: d.human.fly.y,
      airborne: d.human.fly.airborne,
      ducking: d.human.fly.ducking,
      wingPhase: d.human.fly.wingPhase,
      alpha: 1,
      isBest: true,
      label: "YOU",
      ringColor: DUEL_HUMAN_RING,
      labelColor: DUEL_HUMAN_LABEL,
      t: tNow,
    });
  }
}

/** One 60Hz simulation step: world → vision → brains → action → collisions. */
function stepSim(
  sim: Sim,
  art: Art,
  dt: number,
  popSize: number,
  mutStrength: number,
  realTime: boolean
): void {
  const w = sim.world;
  const cleared = stepWorld(w, dt);

  // fly avatar physics (shared with the duel — same helper, no drift)
  for (const r of sim.runners) {
    stepAvatarPhysics(r.fly, dt);
    r.fly.ducking = false; // re-decided by the brain every step
  }

  // vision: world without flies → 240×90 → 24×9 retina (shared input)
  drawWorld(art.gameCtx, w);
  art.retinaCtx.drawImage(art.game, 0, 0, RETINA_W, RETINA_H);
  const img = art.retinaCtx.getImageData(0, 0, RETINA_W, RETINA_H);
  const input = retinaFromImageData(
    img.data,
    RETINA_W,
    RETINA_H,
    RETINA_COLS,
    RETINA_ROWS,
    false
  );

  // brains: dopamine rides along with the regular step
  for (const r of sim.runners) {
    if (!r.alive) continue;
    trackBirdEncounters(w, r.duck); // duck-defense bookkeeping (alive flies only)
    const delta = cleared.length > 0 ? REWARD_CLEAR : 0;
    const m = r.brain.step(input, delta);
    const f = r.fly;
    if (!f.airborne && f.jumpCooldownMs <= 0 && m[0] > JUMP_THRESHOLD) {
      f.vy = -JUMP_V;
      f.airborne = true;
      f.jumpCooldownMs = JUMP_COOLDOWN_MS;
      if (realTime) playSound("jump", 0.15);
    }
    if (m[1] > DUCK_THRESHOLD) f.ducking = true;
  }
  if (cleared.length > 0) {
    const dodgedBird = cleared.some((o) => o.type === "bird");
    pushEvent(
      sim,
      dodgedBird ? "Pterodactyl dodged (ducked under)" : "Obstacle cleared",
      REWARD_CLEAR,
      "reward",
      w.t
    );
  }

  // collisions → death shock (+ pterodactyl vs cactus report)
  for (const r of sim.runners) {
    if (!r.alive) continue;
    const hit = hitObstacle(w, r.fly);
    if (hit) {
      r.alive = false;
      r.deathScore = w.score;
      r.deathCause = hit.type;
      if (hit.type === "bird") sim.genBirdDeaths += 1;
      else sim.genCactusDeaths += 1;
      r.brain.step(input, -PUNISH_CRASH);
      pushEvent(
        sim,
        `Fly #${r.idx + 1} ${hit.type === "bird" ? "hit the bird" : "hit a cactus"}`,
        -PUNISH_CRASH,
        "punish",
        w.t
      );
      if (realTime) playSound("crash", 0.25);
    }
  }

  // generation end (or watch-mode replay restart)
  const anyAlive = sim.runners.some((r) => r.alive);
  if (!anyAlive || (!sim.watchMode && w.t >= GEN_TIME_CAP_S)) {
    if (sim.watchMode) {
      sim.watchCooldown = (sim.watchCooldown ?? 45) - 1;
      if (sim.watchCooldown <= 0) {
        sim.watchCooldown = null;
        if (sim.bestBrain) {
          sim.runners = [makeRunner(sim.bestBrain.clone(), 0)];
        }
        sim.world = freshWorld(sim);
      }
    } else {
      endGeneration(sim, popSize, mutStrength);
    }
  }
}

function renderVisible(
  canvas: HTMLCanvasElement,
  game: HTMLCanvasElement,
  sim: Sim,
  tNow: number
): void {
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  if (canvas.width > 0 && canvas.height > 0) {
    ctx.imageSmoothingEnabled = true;
    ctx.drawImage(game, 0, 0, GAME_W, GAME_H, 0, 0, canvas.width, canvas.height);
  }
  const sx = canvas.width / GAME_W;
  const sy = canvas.height / GAME_H;
  ctx.setTransform(sx, 0, 0, sy, 0, 0);

  const leader = bestAliveBrain(sim);
  for (const r of sim.runners) {
    if (!r.alive) continue;
    const isBest = sim.watchMode ? true : leader === r.brain;
    drawFly(ctx, {
      x: FLY_X,
      feetY: r.fly.y,
      airborne: r.fly.airborne,
      ducking: r.fly.ducking,
      wingPhase: r.fly.wingPhase,
      alpha: isBest ? 1 : 0.38,
      isBest,
      label: sim.watchMode ? undefined : "BEST",
      t: tNow,
    });
  }
}

// ---------------------------------------------------------------------------
// Champion lineage ("family tree") rendering
// ---------------------------------------------------------------------------
const L_SPACING = 72; // px between main-line generations
const L_MAIN_Y = 52; // baseline of the main line
const L_SIDE_DY = 38; // side-branch offset above/below the baseline
const L_HEIGHT = 112;

function lineageOriginText(o: LineageOrigin): string {
  return o === "crossover"
    ? "crossover child"
    : o === "clone"
      ? "elite clone"
      : "founding fly";
}

/** Compact hand-rolled SVG tree — no chart library. Oldest ancestor on the
 *  left, current champion on the right. Main-line circles are amber, sized
 *  and tinted by score; crossover forks merge in diagonally from smaller
 *  rose side-branch nodes (one level deep, never recursed into). Every node
 *  carries a native <title> tooltip. */
function LineageTreeSvg({ view }: { view: LineageView }) {
  const n = view.main.length;
  const sideNodes = view.sides.filter(
    (s): s is LineageViewNode => Boolean(s)
  );
  const maxScore = Math.max(
    1,
    ...view.main.map((m) => m.score),
    ...sideNodes.map((s) => s.score)
  );
  const hasChip = view.hiddenGens > 0;
  const chipText = `…${view.hiddenGens} more generation${view.hiddenGens === 1 ? "" : "s"}`;
  const chipW = Math.max(58, 16 + chipText.length * 4.7);
  const padL = hasChip ? 18 + chipW + 14 : 18;
  const padR = 66; // room for the ★ champion label
  const width = padL + (n - 1) * L_SPACING + padR;
  const xs = view.main.map((_, i) => padL + i * L_SPACING);
  const champIdx = n - 1;
  const mainR = (score: number) => 5 + 6 * Math.min(1, Math.max(0, score / maxScore));

  return (
    <svg
      data-testid="lineage-svg"
      data-nodes={n}
      data-sides={sideNodes.length}
      data-hidden={view.hiddenGens}
      data-champ-gen={view.champion.gen}
      width={width}
      height={L_HEIGHT}
      viewBox={`0 0 ${width} ${L_HEIGHT}`}
      role="img"
      aria-label={`Champion family tree — ${view.breedGens} generations of breeding from gen ${view.rootGen} to gen ${view.champion.gen}`}
      className="block"
    >
      {/* main-line baseline */}
      <line
        x1={xs[0]}
        y1={L_MAIN_Y}
        x2={xs[champIdx]}
        y2={L_MAIN_Y}
        stroke="rgba(245,158,11,0.28)"
        strokeWidth={1.5}
      />

      {/* collapsed older ancestry chip */}
      {hasChip && (
        <g>
          <title>{`Older ancestry collapsed — the full line goes back ${view.breedGens} generations to gen ${view.rootGen} (score ${view.rootScore})`}</title>
          <rect
            x={8}
            y={L_MAIN_Y - 9}
            width={chipW}
            height={18}
            rx={9}
            fill="rgba(245,158,11,0.06)"
            stroke="rgba(245,158,11,0.3)"
            strokeWidth={1}
          />
          <text
            x={8 + chipW / 2}
            y={L_MAIN_Y + 3}
            textAnchor="middle"
            fontSize={8}
            fill="#d6d3d1"
            className="font-mono"
          >
            {chipText}
          </text>
          <line
            x1={8 + chipW + 4}
            y1={L_MAIN_Y}
            x2={xs[0] - 10}
            y2={L_MAIN_Y}
            stroke="rgba(245,158,11,0.3)"
            strokeWidth={1}
            strokeDasharray="2 3"
          />
        </g>
      )}

      {/* crossover side branches — diagonal merges into the main line */}
      {view.sides.map((side, i) => {
        if (!side || i === 0) return null;
        const up = i % 2 === 1;
        const sx = (xs[i - 1] + xs[i]) / 2;
        const sy = up ? L_MAIN_Y - L_SIDE_DY : L_MAIN_Y + L_SIDE_DY;
        const childR = mainR(view.main[i].score);
        const endY = up ? L_MAIN_Y - childR - 3 : L_MAIN_Y + childR + 3;
        const cx = (sx + xs[i]) / 2;
        const cy = up ? sy + 16 : sy - 16;
        const sideR = 3.5 + 2.5 * Math.min(1, Math.max(0, side.score / maxScore));
        return (
          <g key={`s${side.id}`}>
            <path
              d={`M ${sx} ${sy} Q ${cx} ${cy} ${xs[i]} ${endY}`}
              fill="none"
              stroke="rgba(251,113,133,0.5)"
              strokeWidth={1.2}
            />
            <circle
              cx={sx}
              cy={sy}
              r={sideR}
              fill="rgba(251,113,133,0.28)"
              stroke="rgba(251,113,133,0.55)"
              strokeWidth={1}
              className="cursor-help"
            >
              <title>{`Gen ${side.gen} · score ${side.score} · crossover parent`}</title>
            </circle>
          </g>
        );
      })}

      {/* main-line nodes + generation ticks */}
      {view.main.map((m, i) => {
        const ratio = Math.min(1, Math.max(0, m.score / maxScore));
        const r = 5 + 6 * ratio;
        const isChamp = i === champIdx;
        return (
          <g key={m.id}>
            <circle
              cx={xs[i]}
              cy={L_MAIN_Y}
              r={r}
              fill={`rgba(245,158,11,${(0.3 + 0.65 * ratio).toFixed(3)})`}
              stroke="rgba(245,158,11,0.75)"
              strokeWidth={1.2}
              className="cursor-help"
            >
              <title>{`Gen ${m.gen} · score ${m.score} · ${lineageOriginText(m.origin)}`}</title>
            </circle>
            {/* generation tick + label */}
            <line
              x1={xs[i]}
              y1={L_MAIN_Y + 15}
              x2={xs[i]}
              y2={L_MAIN_Y + 19}
              stroke="rgba(168,162,158,0.4)"
              strokeWidth={1}
              aria-hidden
            />
            <text
              x={xs[i]}
              y={L_MAIN_Y + 30}
              textAnchor="middle"
              fontSize={8.5}
              fill="#a8a29e"
              className="font-mono"
            >
              {m.gen}
            </text>
            {/* score labels under the first + last (champion) nodes */}
            {i === 0 && n > 1 && (
              <text
                x={xs[0]}
                y={L_MAIN_Y + 43}
                textAnchor="middle"
                fontSize={8.5}
                fill="#a8a29e"
                className="font-mono"
              >
                score {m.score}
              </text>
            )}
            {isChamp && (
              <>
                <circle
                  cx={xs[i]}
                  cy={L_MAIN_Y}
                  r={r + 3.5}
                  fill="none"
                  stroke="#34d399"
                  strokeWidth={1.4}
                  strokeDasharray="3 2.5"
                />
                <text
                  x={xs[i]}
                  y={L_MAIN_Y - 26}
                  textAnchor="middle"
                  fontSize={9}
                  fontWeight={600}
                  fill="#34d399"
                  className="font-mono"
                >
                  ★ champion
                </text>
                <text
                  x={xs[i]}
                  y={L_MAIN_Y + 43}
                  textAnchor="middle"
                  fontSize={8.5}
                  fill="#fbbf24"
                  className="font-mono"
                >
                  score {m.score}
                </text>
              </>
            )}
          </g>
        );
      })}
    </svg>
  );
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------
export function DinoTrainer() {
  // --- UI state -------------------------------------------------------------
  const [running, setRunning] = useState(false);
  const [turbo, setTurbo] = useState(1);
  const [popSize, setPopSize] = useState(6);
  const [mutStrength, setMutStrength] = useState(0.3);
  const [watchBest, setWatchBest] = useState(false);
  const [birdPractice, setBirdPractice] = useState(false);
  const [brainName, setBrainName] = useState("");
  const [saving, setSaving] = useState(false);
  const [hud, setHud] = useState({
    gen: 1,
    alive: 6,
    total: 6,
    score: 0,
    best: 0,
    speed: BASE_SPEED,
    watch: false,
    birdsSeen: 0,
    birdsCleared: 0,
    birdDeaths: 0,
    cactusDeaths: 0,
  });
  const [feed, setFeed] = useState<FeedEvent[]>([]);
  const [history, setHistory] = useState<GenStat[]>([]);
  const [panelBrain, setPanelBrain] = useState<FlyBrain | null>(null);
  const [hasBest, setHasBest] = useState(false);
  // --- duel mode state (the duel itself lives in duelRef, React only mirrors) ---
  const [duelActive, setDuelActive] = useState(false);
  const [duelHud, setDuelHud] = useState<DuelHud | null>(null);
  const [resume, setResume] = useState<{
    gen: number;
    best: number;
    snap: BrainSnapshot;
    history: GenStat[];
  } | null>(null);
  // --- champion lineage (family tree) -------------------------------------
  const [lineageOpen, setLineageOpen] = useState(false);
  /** recomputed only when the champion changes (keyed — the 4Hz flush is a
   *  no-op for this state between crowns; the ≤20-node walk is cheap) */
  const [lineage, setLineage] = useState<{ key: string; view: LineageView | null }>({
    key: "none",
    view: null,
  });

  // --- refs (read inside the rAF loop without restarting it) ----------------
  const runningRef = useRef(running);
  const turboRef = useRef(turbo);
  const popSizeRef = useRef(popSize);
  const mutStrengthRef = useRef(mutStrength);
  const adoptedRef = useRef(false);
  /** Task 13-c lineage bookkeeping: wall-clock training-clock start (reset on
   *  fresh populations / adopted brains) + the name of the saved library brain
   *  this session continued from (null = wild-born population). Refs only —
   *  read exclusively inside the save handler. */
  const trainStartRef = useRef(Date.now());
  const parentNameRef = useRef<string | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const simRef = useRef<Sim | null>(null);
  const artRef = useRef<Art | null>(null);
  /** active duel (null = normal population training) */
  const duelRef = useRef<DuelSim | null>(null);

  useEffect(() => {
    runningRef.current = running;
  }, [running]);
  useEffect(() => {
    turboRef.current = turbo;
  }, [turbo]);
  useEffect(() => {
    popSizeRef.current = popSize;
  }, [popSize]);
  useEffect(() => {
    mutStrengthRef.current = mutStrength;
  }, [mutStrength]);

  /** Push sim state into React at ~4 Hz (keeps 60fps rendering pure canvas). */
  const flush = useCallback((s: Sim) => {
    // duck-defense aggregate: finished generations + live runs (watch-mode
    // replays are exhibitions — they don't pollute the training metric)
    const birdsSeen = s.watchMode
      ? s.sessionBirdsSeen
      : s.sessionBirdsSeen +
        s.runners.reduce((a, r) => a + birdsSeenCount(r.duck), 0);
    const birdsCleared = s.watchMode
      ? s.sessionBirdsCleared
      : s.sessionBirdsCleared +
        s.runners.reduce((a, r) => a + birdsClearedCount(r.duck), 0);
    setHud({
      gen: s.generation,
      alive: s.runners.filter((r) => r.alive).length,
      total: s.runners.length,
      score: s.world.score,
      best: s.bestEver,
      speed: s.world.speed,
      watch: s.watchMode,
      birdsSeen,
      birdsCleared,
      birdDeaths: s.genBirdDeaths,
      cactusDeaths: s.genCactusDeaths,
    });
    setFeed(s.events.slice(-8).reverse());
    setHistory(s.history.slice());
    setHasBest(Boolean(s.bestBrain));
    // duel slice (null when not dueling — Object.is-stable, no re-render churn)
    const d = duelRef.current;
    if (d) {
      setDuelHud({
        you: d.human.alive ? d.world.score : d.human.deathScore,
        fly: d.ai.alive ? d.world.score : d.ai.deathScore,
        youAlive: d.human.alive,
        flyAlive: d.ai.alive,
        youAir: d.human.fly.airborne,
        score: d.world.score,
        speed: d.world.speed,
        ended: d.ended,
        result: d.result,
        wins: s.duelWins,
        losses: s.duelLosses,
        best: s.duelBest,
      });
    } else {
      setDuelHud(null);
    }
    setPanelBrain((prev) => {
      const next = d
        ? d.ai.brain // duel: the champion's live brain
        : s.watchMode
          ? (s.runners[0]?.brain ?? null)
          : bestAliveBrain(s);
      return next === prev ? prev : next;
    });
    // champion lineage: rebuild the family-tree view ONLY when a new champion
    // is crowned (or the record resets) — never per tick
    const lKey =
      s.bestNodeId > 0
        ? `${s.lineage.version}:${s.bestNodeId}:${s.bestEver}`
        : "none";
    setLineage((prev) => {
      if (prev.key === lKey) return prev; // Object-identical → no re-render
      return {
        key: lKey,
        view: s.bestNodeId > 0 ? buildLineageView(s.lineage, s.bestNodeId) : null,
      };
    });
  }, []);

  // --- mount: build the sim + the animation loop ----------------------------
  useEffect(() => {
    hydrateSoundMuted(); // persisted mute preference (idempotent, SSR-safe)
    const art = createArt();
    artRef.current = art;
    const sim: Sim = {
      world: createWorld(),
      runners: Array.from({ length: popSizeRef.current }, (_, i) =>
        makeRunner(
          new FlyBrain({ ...DEFAULT_ARCH_DINO, seed: (Math.random() * 0x7fffffff) | 0 }),
          i
        )
      ),
      savedRunners: null,
      watchMode: false,
      watchCooldown: null,
      generation: 1,
      bestEver: 0,
      bestGen: 0,
      bestBrain: null,
      history: [],
      events: [],
      eventId: 0,
      birdPractice: false,
      sessionBirdsSeen: 0,
      sessionBirdsCleared: 0,
      genBirdDeaths: 0,
      genCactusDeaths: 0,
      genTimeoutDeaths: 0,
      duelWins: 0,
      duelLosses: 0,
      duelBest: 0,
      lineage: freshLineage(),
      bestNodeId: 0,
    };
    simRef.current = sim;
    // every brain in the initial random population is a lineage founder
    registerFounders(
      sim.lineage,
      sim.runners.map((r) => r.brain),
      1
    );
    drawWorld(art.gameCtx, sim.world); // first paint so pause view isn't blank
    setPanelBrain(sim.runners[0]?.brain ?? null);

    let raf = 0;
    let last = performance.now();
    let acc = 0;
    let lastFlush = 0;
    const frame = (ts: number) => {
      raf = requestAnimationFrame(frame);
      const dt = Math.min((ts - last) / 1000, 0.25);
      last = ts;
      const s = simRef.current;
      if (!s) return;
      const duel = duelRef.current;
      if (duel) {
        // duel mode: training is parked; the race always runs at real time
        // (a human is playing — turbo would be cheating)
        if (!duel.ended) {
          acc += dt;
          let n = 0;
          while (acc >= STEP_DT && n < MAX_STEPS_PER_FRAME) {
            stepDuel(duel, art, s, STEP_DT);
            acc -= STEP_DT;
            n += 1;
          }
          if (acc > 0.2) acc = 0.2;
        } else {
          acc = 0;
        }
      } else if (runningRef.current) {
        acc += dt * turboRef.current;
        let n = 0;
        // crash/jump sounds only in real time (turbo ×1) — no audio spam at ×10
        const realTime = turboRef.current === 1;
        while (acc >= STEP_DT && n < MAX_STEPS_PER_FRAME) {
          stepSim(
            s,
            art,
            STEP_DT,
            popSizeRef.current,
            mutStrengthRef.current,
            realTime
          );
          acc -= STEP_DT;
          n += 1;
        }
        if (acc > 0.2) acc = 0.2; // never spiral after a long stall
      }
      const canvas = canvasRef.current;
      if (canvas) {
        if (duel) renderDuel(canvas, art.game, duel, ts / 1000);
        else renderVisible(canvas, art.game, s, ts / 1000);
      }
      if (ts - lastFlush >= 250) {
        lastFlush = ts;
        flush(s);
      }
    };
    raf = requestAnimationFrame(frame);
    return () => cancelAnimationFrame(raf);
  }, [flush]);

  // --- responsive canvas backing store --------------------------------------
  useEffect(() => {
    const canvas = canvasRef.current;
    const wrap = canvas?.parentElement;
    if (!canvas || !wrap) return;
    const apply = () => {
      const w = wrap.clientWidth;
      if (w <= 0) return;
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      const cw = Math.round(w * dpr);
      const ch = Math.round((w * dpr * GAME_H) / GAME_W);
      if (canvas.width !== cw || canvas.height !== ch) {
        canvas.width = cw;
        canvas.height = ch;
      }
    };
    apply();
    const ro = new ResizeObserver(apply);
    ro.observe(wrap);
    return () => ro.disconnect();
  }, []);

  // --- duel keyboard: window listeners active ONLY while dueling ----------
  useEffect(() => {
    if (!duelActive) return;
    const isEditable = (t: EventTarget | null): boolean => {
      const el = t as HTMLElement | null;
      return (
        !!el &&
        typeof el.tagName === "string" &&
        (el.tagName === "INPUT" ||
          el.tagName === "TEXTAREA" ||
          el.isContentEditable === true)
      );
    };
    const down = (e: KeyboardEvent) => {
      if (isEditable(e.target)) return; // never steal typing
      const k = e.key;
      if (k === "ArrowUp" || k === " " || k === "w" || k === "W") {
        e.preventDefault(); // stop page scroll
        if (e.repeat) return; // ignore held-key repeats
        const d = duelRef.current;
        if (d && !d.ended) d.jumpQueued = true;
      } else if (k === "ArrowDown" || k === "s" || k === "S") {
        e.preventDefault();
        const d = duelRef.current;
        if (d) d.duckHeld = true;
      }
    };
    const up = (e: KeyboardEvent) => {
      const k = e.key;
      if (k === "ArrowDown" || k === "s" || k === "S") {
        const d = duelRef.current;
        if (d) d.duckHeld = false;
      }
    };
    const blur = () => {
      // alt-tab mid-duck would otherwise stick the key down forever
      const d = duelRef.current;
      if (d) d.duckHeld = false;
    };
    window.addEventListener("keydown", down);
    window.addEventListener("keyup", up);
    window.addEventListener("blur", blur);
    return () => {
      window.removeEventListener("keydown", down);
      window.removeEventListener("keyup", up);
      window.removeEventListener("blur", blur);
    };
  }, [duelActive]);

  // --- adopt a snapshot (library load / session resume) ---------------------
  const adoptSnapshot = useCallback(
    (snap: BrainSnapshot, restoreHistory?: GenStat[]) => {
      adoptedRef.current = true;
      setResume(null);
      // adopting any brain starts a fresh training clock (Task 13-c)
      trainStartRef.current = Date.now();
      const s = simRef.current;
      if (!s) return;
      if (!snap.arch || snap.arch.motorCount < 2) {
        toast.error("This snapshot is not compatible with the Dino task.");
        return;
      }
      const base = FlyBrain.fromJSON(snap);
      s.watchMode = false;
      s.savedRunners = null;
      s.watchCooldown = null;
      s.generation = Math.max(1, snap.generation || 1);
      s.bestEver = snap.score ?? 0;
      s.bestGen = snap.generation || 1;
      s.bestBrain = base.clone();
      s.history = restoreHistory ?? [];
      s.events = [];
      s.eventId = 0;
      s.sessionBirdsSeen = 0;
      s.sessionBirdsCleared = 0;
      s.genBirdDeaths = 0;
      s.genCactusDeaths = 0;
      s.genTimeoutDeaths = 0;
      // adopted population: fresh family line — the loaded brain is the root
      // founder (its recorded ancestry is unknowable from a snapshot)
      s.lineage = freshLineage();
      const n = popSizeRef.current;
      s.runners = Array.from({ length: n }, (_, i) => makeRunner(base.clone(), i));
      registerFounders(
        s.lineage,
        s.runners.map((r) => r.brain),
        s.generation
      );
      // the loaded champion's known score seeds its founder nodes
      for (const r of s.runners) {
        const node = s.lineage.nodes.get(nodeIdOf(s.lineage, r.brain));
        if (node) node.score = Math.max(node.score, s.bestEver);
      }
      s.bestNodeId = nodeIdOf(s.lineage, s.runners[0]?.brain ?? base);
      s.world = freshWorld(s);
      setWatchBest(false);
      setRunning(true);
      runningRef.current = true;
      flush(s);
      toast.success(
        `Loaded "${snap.name}" (gen ${snap.generation}, score ${snap.score}) — population replaced with its clones`
      );
    },
    [flush]
  );

  // --- cross-tab brain loads (Brain Library "Load" button) ------------------
  const pending = useBrainStore((s) => s.pending);
  useEffect(() => {
    const snap = useBrainStore.getState().consumeLoad("dino");
    if (snap) {
      // Task 13-c: this session continues from a SAVED brain — remember its
      // display name so the next save can record the clone relationship
      parentNameRef.current = snap.name;
      adoptSnapshot(snap);
    }
  }, [pending, adoptSnapshot]);

  // --- offer to resume the last session -------------------------------------
  useEffect(() => {
    if (adoptedRef.current) return;
    try {
      const raw = localStorage.getItem(AUTOSAVE_KEY);
      if (!raw) return;
      const parsed = JSON.parse(raw) as {
        gen: number;
        bestScore: number;
        history: GenStat[];
        snapshot: BrainSnapshot | null;
      };
      if (parsed?.snapshot && parsed.gen >= 1) {
        setResume({
          gen: parsed.gen,
          best: parsed.bestScore ?? 0,
          snap: parsed.snapshot,
          history: Array.isArray(parsed.history) ? parsed.history : [],
        });
      }
    } catch {
      // corrupted autosave — ignore
    }
  }, []);

  // --- controls --------------------------------------------------------------
  /** Bird practice only flips the spawn gate — existing obstacles and the
   *  spawn timer are untouched, so it applies to NEW obstacles only. */
  const toggleBirdPractice = (on: boolean) => {
    setBirdPractice(on);
    const s = simRef.current;
    if (!s) return;
    s.birdPractice = on;
    s.world.birdPractice = on;
    toast.info(
      on
        ? "Bird practice ON — pterodactyls spawn from score 0"
        : "Bird practice OFF — pterodactyls return after score 100"
    );
  };

  const toggleWatchMode = (on: boolean) => {
    const s = simRef.current;
    if (!s) return;
    setWatchBest(on); // keep the controlled switch in sync with sim.watchMode
    if (on) {
      if (!s.bestBrain) {
        toast.error("No best brain yet — let at least one generation finish.");
        return;
      }
      s.savedRunners = s.runners;
      s.watchMode = true;
      s.watchCooldown = null;
      s.runners = [makeRunner(s.bestBrain.clone(), 0)];
      s.world = freshWorld(s);
      setRunning(true);
      toast.info("Replaying the best-ever brain — enjoy the show");
    } else {
      s.watchMode = false;
      s.watchCooldown = null;
      if (s.savedRunners) {
        s.runners = s.savedRunners.map((r, i) => ({
          brain: r.brain,
          fly: freshFly(),
          alive: true,
          deathScore: 0,
          idx: i,
          // keep each fly's duck-defense bookkeeping (bird ids stay unique)
          duck: r.duck,
          deathCause: null,
        }));
      }
      s.savedRunners = null;
      s.world = freshWorld(s);
    }
    flush(s);
  };

  // --- duel mode: enter / rematch / exit --------------------------------------
  const enterDuel = () => {
    const s = simRef.current;
    if (!s) return;
    if (!s.bestBrain) {
      toast.error("No champion yet — let at least one generation finish.");
      return;
    }
    playSound("click");
    if (s.watchMode) {
      // leave watch-best first so the parked population comes back
      toggleWatchMode(false);
    }
    duelRef.current = createDuel(s);
    setDuelActive(true);
    flush(s);
    toast.info("Duel — same world, two avatars. ↑ / Space jump · ↓ duck");
  };

  const rematchDuel = () => {
    const s = simRef.current;
    if (!s) return;
    playSound("click");
    // fresh world + avatars; the champion keeps what it learned last duel
    duelRef.current = createDuel(s);
    flush(s);
  };

  const exitDuel = () => {
    const s = simRef.current;
    const d = duelRef.current;
    playSound("click");
    if (s && d) {
      // fold the champion's lifetime dopamine back in, even on early exit
      s.bestBrain = d.ai.brain.clone();
    }
    duelRef.current = null;
    setDuelActive(false);
    setDuelHud(null);
    if (s) {
      // restore the training view even if training is paused (stale duel
      // frame would otherwise linger on the offscreen canvas)
      const art = artRef.current;
      if (art) drawWorld(art.gameCtx, s.world);
      flush(s);
    }
  };

  const resetPopulation = () => {
    const s = simRef.current;
    if (!s) return;
    // fresh random population = a fresh training session (Task 13-c clock)
    trainStartRef.current = Date.now();
    parentNameRef.current = null;
    s.watchMode = false;
    s.savedRunners = null;
    s.watchCooldown = null;
    setWatchBest(false);
    s.generation = 1;
    s.bestEver = 0;
    s.bestGen = 0;
    s.bestBrain = null;
    s.history = [];
    s.events = [];
    s.eventId = 0;
    s.sessionBirdsSeen = 0;
    s.sessionBirdsCleared = 0;
    s.genBirdDeaths = 0;
    s.genCactusDeaths = 0;
    s.genTimeoutDeaths = 0;
    // lineage is session memory — a fresh population starts a fresh family
    // line (see the caption under the lineage card)
    s.lineage = freshLineage();
    s.bestNodeId = 0;
    const n = popSizeRef.current;
    s.runners = Array.from({ length: n }, (_, i) =>
      makeRunner(
        new FlyBrain({ ...DEFAULT_ARCH_DINO, seed: (Math.random() * 0x7fffffff) | 0 }),
        i
      )
    );
    registerFounders(
      s.lineage,
      s.runners.map((r) => r.brain),
      1
    );
    s.world = freshWorld(s);
    flush(s);
    toast.info(`Fresh random population of ${n} flies — generation 1`);
  };

  const saveBestBrain = async () => {
    const s = simRef.current;
    if (!s || !s.bestBrain) {
      toast.error("No best brain yet — finish a generation first.");
      return;
    }
    const name = brainName.trim() || `Dino fly gen ${s.bestGen}`;
    // Task 13-c — persist the training pedigree inside the snapshot: every
    // dino champion descends from the wild-born random founders; generations
    // + best-ever score describe THIS brain; trainedMs is the session clock.
    const lineage: BrainLineage = {
      trainer: "dino",
      generations: s.bestGen,
      trainedMs: Math.max(0, Date.now() - trainStartRef.current),
      pedigree: [
        { gen: 0, score: 0, label: "Wild-born" },
        { gen: s.bestGen, score: s.bestEver, label: "This brain" },
      ],
    };
    if (parentNameRef.current) lineage.parentName = parentNameRef.current;
    setSaving(true);
    try {
      const res = await fetch("/api/brains", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name,
          task: "dino",
          generation: s.bestGen,
          score: s.bestEver,
          snapshot: s.bestBrain.toJSON("dino", name, s.bestGen, s.bestEver, lineage),
        }),
      });
      if (!res.ok) {
        throw new Error(`HTTP ${res.status}`);
      }
      playSound("ding"); // saved to the library
      toast.success(`Saved "${name}" to the brain library`);
      setBrainName("");
    } catch (err) {
      toast.error(`Save failed: ${err instanceof Error ? err.message : "unknown error"}`);
    } finally {
      setSaving(false);
    }
  };

  const lastGenAvg = history.length > 0 ? history[history.length - 1].avg : null;

  // one-line summary for the lineage card header
  const lineageSummary = lineage.view
    ? lineage.view.breedGens > 0
      ? `${lineage.view.breedGens} generations of breeding — from gen ${lineage.view.rootGen}'s score ${lineage.view.rootScore} to gen ${lineage.view.champion.gen}'s ${lineage.view.champion.score}`
      : `The champion is an original fly — gen ${lineage.view.champion.gen}, score ${lineage.view.champion.score}. Bred descendants will grow its family line.`
    : "No champion yet — finish a generation to start the family line.";

  const toggleLineageOpen = (open: boolean) => {
    setLineageOpen(open);
    playSound("click");
  };

  // --- session export (Task 12-b) --------------------------------------------
  // Pure click-time work: snapshots the CURRENT React state (and the sim's
  // duel tally, which only lives on the Sim object) and hands them to the
  // pure helpers in @/lib/session-export. Never touches the 4Hz loop.
  const exportSession = (kind: "md" | "csv") => {
    const s = simRef.current;
    if (!s || history.length === 0) {
      toast.error("Nothing to export yet", {
        description: "Finish a generation first — then this session has a story to share.",
      });
      return;
    }
    if (kind === "csv") {
      const ok = downloadTextFile(
        sessionExportFilename("dino", "csv"),
        toHistoryCsv(history),
        "text/csv"
      );
      if (ok) {
        playSound("ding");
        toast.success("History CSV downloaded", {
          description: `${history.length} generations — best/avg per generation.`,
        });
      } else {
        toast.error("Download blocked", {
          description: "The browser refused the file download.",
        });
      }
      return;
    }
    const duelRan = s.duelWins + s.duelLosses > 0;
    const md = toSessionMarkdown({
      task: "dino",
      history,
      unit: "pt",
      stats: [
        { label: "Generation", value: String(hud.gen) },
        { label: "Best ever", value: `${hud.best} pt` },
        {
          label: "Avg last gen",
          value: lastGenAvg === null ? "—" : `${Math.round(lastGenAvg)} pt`,
        },
        { label: "Population size", value: String(popSize) },
        { label: "Mutation strength", value: mutStrength.toFixed(2) },
      ],
      duel: duelRan
        ? { wins: s.duelWins, losses: s.duelLosses, bestHuman: s.duelBest }
        : null,
      duckDefense:
        hud.birdsSeen > 0
          ? { birdsSeen: hud.birdsSeen, birdsCleared: hud.birdsCleared }
          : null,
    });
    const ok = downloadTextFile(
      sessionExportFilename("dino", "md"),
      md,
      "text/markdown"
    );
    if (ok) {
      playSound("ding");
      toast.success("Markdown report downloaded", {
        description: `Generation ${hud.gen} · best ever ${hud.best} pt — ready to share.`,
      });
    } else {
      toast.error("Download blocked", {
        description: "The browser refused the file download.",
      });
    }
  };

  // duck-defense color band: rose < 33% ≤ amber < 66% ≤ emerald
  const duckRate =
    hud.birdsSeen > 0 ? hud.birdsCleared / Math.max(1, hud.birdsSeen) : 0;
  const duckColor =
    hud.birdsSeen === 0
      ? { text: "text-muted-foreground", bar: "" }
      : duckRate < 0.33
        ? {
            text: "text-rose-300",
            bar: "[&_[data-slot=progress-indicator]]:bg-rose-500",
          }
        : duckRate < 0.66
          ? {
              text: "text-amber-300",
              bar: "[&_[data-slot=progress-indicator]]:bg-amber-500",
            }
          : {
              text: "text-emerald-300",
              bar: "[&_[data-slot=progress-indicator]]:bg-emerald-500",
            };

  // --- render ----------------------------------------------------------------
  return (
    <section aria-label="Dino training" className="w-full">
      {/* sonner toasts (self-contained: layout.tsx mounts the radix toaster) */}
      <Toaster theme="dark" position="bottom-right" closeButton />

      {/* header */}
      <div className="mb-4 flex flex-wrap items-start gap-3">
        <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl border border-amber-500/30 bg-amber-500/10 text-amber-400">
          <Gamepad2 className="h-5 w-5" aria-hidden />
        </div>
        <div className="min-w-0 flex-1">
          <h2 className="text-lg font-semibold leading-tight">Dino Training</h2>
          <p className="mt-0.5 text-sm text-muted-foreground">
            A population of flies plays the Chrome Dino runner. Clearing obstacles = sugar
            (reward). Crashing = shock (punishment). Survivors breed → next generation.
          </p>
        </div>
      </div>

      {/* resume banner */}
      {resume && (
        <div className="mb-4 flex flex-wrap items-center gap-3 rounded-lg border border-amber-500/30 bg-amber-500/10 px-4 py-2.5 text-sm">
          <History className="h-4 w-4 shrink-0 text-amber-400" aria-hidden />
          <span className="min-w-0 flex-1 text-amber-200/90">
            Previous session found — generation {resume.gen}, best score {resume.best}.
          </span>
          <Button
            size="sm"
            className="h-9 border border-amber-400/30 bg-amber-500/20 text-amber-100 hover:bg-amber-500/30"
            onClick={() => {
              playSound("click");
              adoptSnapshot(resume.snap, resume.history);
            }}
          >
            Resume last session
          </Button>
          <button
            type="button"
            onClick={() => setResume(null)}
            aria-label="Dismiss resume banner"
            className="text-amber-200/60 transition-colors hover:text-amber-200"
          >
            <X className="h-4 w-4" aria-hidden />
          </button>
        </div>
      )}

      <div className="flex flex-col gap-4 lg:flex-row lg:items-stretch">
        {/* --- left: the game --- */}
        <div className="min-w-0 flex-1 space-y-3">
          <Card className="gap-0 overflow-hidden py-0">
            <CardContent className="px-0 pb-0">
              <div className="relative w-full">
                <canvas
                  ref={canvasRef}
                  className="block w-full bg-[#14110d]"
                  style={{ aspectRatio: "480 / 140" }}
                  aria-label={
                    duelActive
                      ? "Duel game view — you versus the champion fly"
                      : "Dino runner game view — population of flies"
                  }
                  role="img"
                />

                {/* HUD overlay */}
                <div className="pointer-events-none absolute inset-0 flex flex-col justify-between p-2.5 sm:p-3">
                  <div className="flex items-start justify-between gap-2">
                    <div
                      className="flex flex-wrap items-center gap-1.5"
                      data-testid={duelActive ? "duel-hud" : undefined}
                      data-duel={
                        duelHud
                          ? `you:${duelHud.you}|fly:${duelHud.fly}|youAlive:${duelHud.youAlive ? 1 : 0}|flyAlive:${duelHud.flyAlive ? 1 : 0}|youAir:${duelHud.youAir ? 1 : 0}|ended:${duelHud.ended ? 1 : 0}${duelHud.result ? `|winner:${duelHud.result.winner}` : ""}`
                          : undefined
                      }
                    >
                      {duelHud ? (
                        <>
                          <Badge className="gap-1 border-amber-400/40 bg-amber-500/15 font-mono text-[10px] tabular-nums text-amber-200 backdrop-blur-sm sm:text-xs">
                            <span aria-hidden>YOU</span>
                            <span className="sr-only">your score:</span>
                            {duelHud.you}
                            {!duelHud.youAlive && (
                              <span className="text-rose-300" title="crashed">
                                ✕
                              </span>
                            )}
                          </Badge>
                          <Badge className="gap-1 border-emerald-400/40 bg-emerald-500/15 font-mono text-[10px] tabular-nums text-emerald-200 backdrop-blur-sm sm:text-xs">
                            <span aria-hidden>FLY</span>
                            <span className="sr-only">fly score:</span>
                            {duelHud.fly}
                            {!duelHud.flyAlive && (
                              <span className="text-rose-300" title="crashed">
                                ✕
                              </span>
                            )}
                          </Badge>
                          <Badge className="border-border/60 bg-black/50 font-mono text-[10px] tabular-nums backdrop-blur-sm sm:text-xs">
                            You {duelHud.wins} · Fly {duelHud.losses}
                          </Badge>
                          <Badge className="border-border/60 bg-black/50 font-mono text-[10px] tabular-nums backdrop-blur-sm sm:text-xs">
                            BEST {duelHud.best}
                          </Badge>
                        </>
                      ) : (
                        <>
                          <Badge className="border-border/60 bg-black/50 font-mono text-[10px] backdrop-blur-sm sm:text-xs">
                            GEN {hud.gen}
                          </Badge>
                          <Badge className="gap-1 border-border/60 bg-black/50 font-mono text-[10px] backdrop-blur-sm sm:text-xs">
                            <Users className="h-3 w-3" aria-hidden />
                            {hud.alive}/{hud.total} alive
                          </Badge>
                          {hud.watch && (
                            <Badge className="border-amber-500/40 bg-amber-500/20 font-mono text-[10px] text-amber-200 backdrop-blur-sm sm:text-xs">
                              WATCHING BEST
                            </Badge>
                          )}
                          {birdPractice && (
                            <Badge className="gap-1 border-amber-500/40 bg-amber-500/20 font-mono text-[10px] text-amber-200 backdrop-blur-sm sm:text-xs">
                              <Bird className="h-3 w-3" aria-hidden />
                              BIRD PRACTICE
                            </Badge>
                          )}
                          {(hud.birdDeaths > 0 || hud.cactusDeaths > 0) && (
                            <Badge
                              className="gap-1.5 border-border/60 bg-black/50 font-mono text-[10px] tabular-nums backdrop-blur-sm sm:text-xs"
                              aria-label={`This generation: ${hud.birdDeaths} bird deaths, ${hud.cactusDeaths} cactus deaths`}
                            >
                              <span className="flex items-center gap-1 text-rose-300">
                                <Bird className="h-3 w-3" aria-hidden />
                                {hud.birdDeaths}
                              </span>
                              <span className="text-muted-foreground/50" aria-hidden>
                                ·
                              </span>
                              <span className="flex items-center gap-1 text-emerald-300">
                                <Sprout className="h-3 w-3" aria-hidden />
                                {hud.cactusDeaths}
                              </span>
                              <span className="sr-only">deaths this gen (bird · cactus)</span>
                            </Badge>
                          )}
                        </>
                      )}
                    </div>
                    <div className="text-right leading-none">
                      <div className="font-mono text-lg font-bold tabular-nums text-amber-200 [text-shadow:0_0_12px_rgba(245,158,11,0.35)] sm:text-2xl">
                        {String(duelHud ? duelHud.score : hud.score).padStart(5, "0")}
                      </div>
                      <div className="mt-1 font-mono text-[10px] tabular-nums text-muted-foreground sm:text-xs">
                        {duelHud
                          ? `DUEL BEST ${String(duelHud.best).padStart(5, "0")}`
                          : `HI ${String(Math.max(hud.best, hud.score)).padStart(5, "0")}`}
                      </div>
                    </div>
                  </div>
                  <div className="flex items-center justify-between">
                    <Badge className="border-border/60 bg-black/50 font-mono text-[10px] tabular-nums backdrop-blur-sm">
                      SPD {((duelHud ? duelHud.speed : hud.speed) / BASE_SPEED).toFixed(1)}×
                    </Badge>
                    {duelHud ? (
                      <span className="flex items-center gap-1.5 font-mono text-[9px] text-muted-foreground sm:text-[10px]">
                        <kbd className="inline-flex h-4 min-w-4 items-center justify-center rounded border border-border/80 bg-black/50 px-1 text-[9px] leading-none text-foreground/90">
                          ↑
                        </kbd>
                        <span>jump</span>
                        <span aria-hidden>·</span>
                        <kbd className="inline-flex h-4 min-w-4 items-center justify-center rounded border border-border/80 bg-black/50 px-1 text-[9px] leading-none text-foreground/90">
                          ↓
                        </kbd>
                        <span>duck</span>
                      </span>
                    ) : (
                      <span className="font-mono text-[9px] text-muted-foreground/80 sm:text-[10px]">
                        retina 24×9 · {hud.total} brains
                      </span>
                    )}
                  </div>
                </div>

                {/* start overlay */}
                {!running && !duelActive && (
                  <button
                    type="button"
                    onClick={() => {
                      playSound("click");
                      setRunning(true);
                    }}
                    className="absolute inset-0 z-10 flex flex-col items-center justify-center gap-3 bg-black/45 backdrop-blur-[1px] transition-colors hover:bg-black/35"
                    aria-label="Start training"
                  >
                    <span className="flex h-14 w-14 items-center justify-center rounded-full bg-emerald-500 text-black shadow-lg shadow-emerald-500/30">
                      <Play className="h-6 w-6 translate-x-0.5" fill="currentColor" aria-hidden />
                    </span>
                    <span className="text-sm font-medium text-emerald-100">
                      Start training
                    </span>
                  </button>
                )}

                {/* duel result overlay */}
                {duelHud?.ended && duelHud.result && (
                  <div
                    role="dialog"
                    aria-label="Duel result"
                    data-testid="duel-result"
                    className="absolute inset-0 z-10 flex flex-col items-center justify-center gap-2.5 bg-black/60 p-4 backdrop-blur-[2px]"
                  >
                    <Trophy
                      className={
                        duelHud.result.winner === "you"
                          ? "h-8 w-8 text-amber-400"
                          : "h-8 w-8 text-muted-foreground"
                      }
                      aria-hidden
                    />
                    <p
                      className={
                        duelHud.result.winner === "you"
                          ? "text-center text-sm font-semibold text-amber-200 sm:text-base"
                          : "text-center text-sm font-semibold text-foreground/90 sm:text-base"
                      }
                    >
                      {duelHud.result.winner === "you"
                        ? `🏆 You outsurvived the fly, ${duelHud.result.youScore} vs ${duelHud.result.flyScore}`
                        : duelHud.result.winner === "fly"
                          ? `The fly wins this round — ${duelHud.result.flyScore} vs ${duelHud.result.youScore}. Keep training!`
                          : `Dead heat — ${duelHud.result.youScore} all. Rematch?`}
                    </p>
                    <p className="font-mono text-xs tabular-nums text-muted-foreground">
                      You {duelHud.result.youScore} · Fly {duelHud.result.flyScore} · session {duelHud.wins}–{duelHud.losses}
                    </p>
                    <div className="mt-1.5 flex flex-wrap items-center justify-center gap-2">
                      <Button className="h-11" onClick={rematchDuel}>
                        <RotateCcw aria-hidden />
                        Rematch
                      </Button>
                      <Button variant="outline" className="h-11" onClick={exitDuel}>
                        <ArrowLeft aria-hidden />
                        Back to training
                      </Button>
                    </div>
                  </div>
                )}
              </div>
            </CardContent>
          </Card>

          {/* turbo / duel bar */}
          {duelActive ? (
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div className="flex flex-wrap items-center gap-2">
                <Swords className="h-4 w-4 text-amber-400" aria-hidden />
                <Badge
                  variant="outline"
                  className="border-amber-500/40 bg-amber-500/10 font-mono text-xs tabular-nums text-amber-200"
                >
                  Duel · You {duelHud?.wins ?? 0} · Fly {duelHud?.losses ?? 0}
                </Badge>
                <Button
                  variant="outline"
                  className="h-11"
                  onClick={exitDuel}
                  aria-label="Leave duel mode and return to population training"
                >
                  <ArrowLeft aria-hidden />
                  Back to training
                </Button>
              </div>
              <p className="text-xs text-muted-foreground">
                Duels also train the champion — it still earns sugar and shock.
              </p>
            </div>
          ) : (
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div className="flex flex-wrap items-center gap-2">
                <div className="flex items-center gap-2">
                  <Zap className="h-4 w-4 text-amber-400" aria-hidden />
                  <ToggleGroup
                    type="single"
                    variant="outline"
                    value={String(turbo)}
                    onValueChange={(v) => {
                      if (v) setTurbo(Number(v));
                    }}
                    aria-label="Turbo speed"
                  >
                    <ToggleGroupItem value="1" className="h-11 min-w-14 font-mono">
                      ×1
                    </ToggleGroupItem>
                    <ToggleGroupItem value="3" className="h-11 min-w-14 font-mono">
                      ×3
                    </ToggleGroupItem>
                    <ToggleGroupItem value="10" className="h-11 min-w-14 font-mono">
                      ×10
                    </ToggleGroupItem>
                  </ToggleGroup>
                </div>
                <UITooltip>
                  <TooltipTrigger asChild>
                    {/* span wrapper: browsers fire no pointer events on a
                        disabled <button>, so the "train a champion first"
                        tooltip needs a hoverable parent to appear */}
                    <span className="inline-flex">
                      <Button
                        variant="outline"
                        className="h-11 gap-1.5 border-amber-500/40 bg-amber-500/10 text-amber-200 hover:bg-amber-500/20 hover:text-amber-100"
                        onClick={enterDuel}
                        disabled={!hasBest}
                      >
                        <Swords aria-hidden />
                        You vs the fly
                      </Button>
                    </span>
                  </TooltipTrigger>
                  <TooltipContent side="top">
                    {hasBest
                      ? "Race the champion brain — same world, same obstacles"
                      : "Train a champion first, then challenge it"}
                  </TooltipContent>
                </UITooltip>
              </div>
              <p className="text-xs text-muted-foreground">
                Turbo runs extra simulation steps per rendered frame.
              </p>
            </div>
          )}
        </div>

        {/* --- right: instruments --- */}
        <div className="w-full shrink-0 space-y-4 lg:w-96">
          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="flex items-center gap-2 text-sm">
                <Sparkles className="h-4 w-4 text-amber-400" aria-hidden />
                {duelActive ? "Champion fly — live brain" : "Best alive fly — live brain"}
              </CardTitle>
              <CardDescription className="text-xs">
                {duelActive
                  ? "Retina → optic lobe → mushroom body → motor of the brain you're racing."
                  : "Retina → optic lobe → mushroom body → motor of the current leader."}
              </CardDescription>
            </CardHeader>
            <CardContent>
              <BrainActivityPanel brain={panelBrain} height={150} />
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="flex items-center gap-2 text-sm">
                <Activity className="h-4 w-4 text-emerald-400" aria-hidden />
                Reward / punishment feed
              </CardTitle>
              <CardDescription className="text-xs">
                Sugar on clears, shock on crashes.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <ScrollArea className="h-60">
                <ul className="space-y-1.5 pr-3" aria-live="polite" aria-label="Dopamine events">
                  {feed.length === 0 && (
                    <li className="py-8 text-center text-xs text-muted-foreground">
                      No events yet — press Start.
                    </li>
                  )}
                  {feed.map((e) => (
                    <li
                      key={e.id}
                      className="flex items-center gap-2 rounded-md border border-border/50 bg-muted/20 px-2.5 py-1.5"
                    >
                      <Badge
                        className={
                          e.kind === "reward"
                            ? "border-emerald-500/30 bg-emerald-500/15 font-mono text-emerald-300"
                            : e.kind === "punish"
                              ? "border-rose-500/30 bg-rose-500/15 font-mono text-rose-300"
                              : "border-amber-500/30 bg-amber-500/15 font-mono text-amber-300"
                        }
                      >
                        {e.kind === "info"
                          ? "gen"
                          : e.value > 0
                            ? `+${e.value.toFixed(1)}`
                            : e.value.toFixed(1)}
                      </Badge>
                      <span className="min-w-0 flex-1 truncate text-xs">{e.label}</span>
                      <span className="font-mono text-[10px] tabular-nums text-muted-foreground">
                        {e.t.toFixed(1)}s
                      </span>
                    </li>
                  ))}
                </ul>
              </ScrollArea>
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-sm">Training controls</CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="flex gap-2">
                <Button
                  className="h-11 flex-1"
                  variant={running ? "secondary" : "default"}
                  onClick={() => {
                    playSound("click");
                    setRunning((r) => !r);
                  }}
                  disabled={duelActive}
                >
                  {running ? (
                    <Pause aria-hidden />
                  ) : (
                    <Play aria-hidden />
                  )}
                  {running ? "Pause" : "Play"}
                </Button>
                <Button
                  variant="outline"
                  className="h-11"
                  onClick={resetPopulation}
                  disabled={duelActive}
                  aria-label="Reset with a new random population"
                >
                  <RotateCcw aria-hidden />
                  Reset
                </Button>
              </div>

              <div className="space-y-1.5">
                <div className="flex items-center justify-between text-xs">
                  <Label htmlFor="pop-size">Population size</Label>
                  <span className="font-mono text-muted-foreground">
                    {popSize}{" "}
                    <span className="text-muted-foreground/60">(next gen)</span>
                  </span>
                </div>
                <Slider
                  id="pop-size"
                  className="py-4"
                  value={[popSize]}
                  min={4}
                  max={10}
                  step={1}
                  onValueChange={(v) => setPopSize(v[0] ?? 6)}
                  aria-label="Population size"
                />
              </div>

              <div className="space-y-1.5">
                <div className="flex items-center justify-between text-xs">
                  <Label htmlFor="mut-strength">Mutation strength</Label>
                  <span className="font-mono text-muted-foreground">
                    {mutStrength.toFixed(2)}
                  </span>
                </div>
                <Slider
                  id="mut-strength"
                  className="py-4"
                  value={[mutStrength]}
                  min={0.1}
                  max={0.5}
                  step={0.05}
                  onValueChange={(v) => setMutStrength(v[0] ?? 0.3)}
                  aria-label="Mutation strength"
                />
              </div>

              <div className="flex min-h-11 items-center justify-between gap-3 rounded-lg border border-border/60 bg-muted/20 px-3 py-2.5">
                <span className="flex items-center gap-2 text-sm">
                  <Eye className="h-4 w-4 text-amber-400" aria-hidden />
                  Watch best brain
                </span>
                <Switch
                  checked={watchBest}
                  onCheckedChange={toggleWatchMode}
                  className="h-6 w-11"
                  aria-label="Watch best brain replay"
                  disabled={duelActive}
                />
              </div>

              <div className="flex min-h-11 items-center justify-between gap-3 rounded-lg border border-border/60 bg-muted/20 px-3 py-2.5">
                <span className="flex min-w-0 flex-col gap-0.5">
                  <span className="flex items-center gap-2 text-sm">
                    <Bird className="h-4 w-4 shrink-0 text-amber-400" aria-hidden />
                    Bird practice
                  </span>
                  <span className="text-[11px] leading-snug text-muted-foreground">
                    Pterodactyls spawn from score 0
                  </span>
                </span>
                <Switch
                  checked={birdPractice}
                  onCheckedChange={toggleBirdPractice}
                  className="h-6 w-11"
                  aria-label="Bird practice — spawn birds from score 0"
                  disabled={duelActive}
                />
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="flex items-center gap-2 text-sm">
                <Trophy className="h-4 w-4 text-amber-400" aria-hidden />
                Stats &amp; save
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="grid grid-cols-3 gap-2 text-center">
                <div className="rounded-lg bg-muted/30 p-2.5">
                  <div className="font-mono text-lg font-bold leading-none">{hud.gen}</div>
                  <div className="mt-1 text-[10px] text-muted-foreground">generation</div>
                </div>
                <div className="rounded-lg bg-muted/30 p-2.5">
                  <div className="font-mono text-lg font-bold leading-none text-emerald-300">
                    {hud.best}
                  </div>
                  <div className="mt-1 text-[10px] text-muted-foreground">best ever</div>
                </div>
                <div className="rounded-lg bg-muted/30 p-2.5">
                  <div className="font-mono text-lg font-bold leading-none text-amber-300">
                    {lastGenAvg === null ? "—" : Math.round(lastGenAvg)}
                  </div>
                  <div className="mt-1 text-[10px] text-muted-foreground">avg last gen</div>
                </div>
              </div>

              {/* duck defense — the "Pterodactyl report" */}
              <div className="space-y-1.5">
                <div className="flex items-center justify-between gap-2 text-xs">
                  <span className="flex items-center gap-1.5">
                    <Bird className="h-3.5 w-3.5 text-amber-400" aria-hidden />
                    Duck defense
                  </span>
                  <span className={`font-mono tabular-nums ${duckColor.text}`}>
                    {hud.birdsSeen > 0
                      ? `${Math.round((100 * hud.birdsCleared) / hud.birdsSeen)}% (${hud.birdsCleared}/${hud.birdsSeen} birds cleared)`
                      : "— (0 birds seen)"}
                  </span>
                </div>
                <Progress
                  value={
                    hud.birdsSeen > 0 ? (100 * hud.birdsCleared) / hud.birdsSeen : 0
                  }
                  className={`h-1.5 ${duckColor.bar}`}
                  aria-label="Duck defense — share of pterodactyls cleared"
                />
                <p className="text-[10px] text-muted-foreground">
                  Pterodactyls ducked vs seen — this generation + session.
                </p>
              </div>
              <Separator />
              <div className="space-y-2">
                <Label htmlFor="brain-name">Brain name</Label>
                <div className="flex gap-2">
                  <Input
                    id="brain-name"
                    value={brainName}
                    onChange={(e) => setBrainName(e.target.value)}
                    placeholder={`Dino fly gen ${hud.gen}`}
                    className="h-11"
                    maxLength={40}
                  />
                  <Button
                    className="h-11 px-4"
                    onClick={saveBestBrain}
                    disabled={saving || !hasBest}
                  >
                    {saving ? (
                      <Loader2 className="animate-spin" aria-hidden />
                    ) : (
                      <Save aria-hidden />
                    )}
                    <span className="hidden sm:inline">Save best brain</span>
                    <span className="sm:hidden">Save</span>
                  </Button>
                </div>

                {/* --- session export (Task 12-b) — shareable markdown report
                      or history CSV; disabled until a generation finishes --- */}
                <DropdownMenu
                  onOpenChange={(open) => {
                    if (open) playSound("click");
                  }}
                >
                  <UITooltip>
                    <TooltipTrigger asChild>
                      {/* span wrapper: browsers fire no pointer events on a
                          disabled <button>, so the "finish a generation
                          first" tooltip needs a hoverable parent */}
                      <span className="flex w-full">
                        <DropdownMenuTrigger asChild>
                          <Button
                            variant="outline"
                            className="h-11 w-full gap-2 px-4"
                            disabled={history.length === 0}
                            data-testid="dino-export-trigger"
                            aria-label="Export session"
                          >
                            <Download aria-hidden />
                            <span>Export session</span>
                            <ChevronDown
                              className="ml-auto h-4 w-4 opacity-60"
                              aria-hidden
                            />
                          </Button>
                        </DropdownMenuTrigger>
                      </span>
                    </TooltipTrigger>
                    <TooltipContent side="top">
                      {history.length > 0
                        ? "Share this session — markdown report or history CSV"
                        : "Finish a generation first, then export"}
                    </TooltipContent>
                  </UITooltip>
                  <DropdownMenuContent align="start" className="w-56">
                    <DropdownMenuLabel>Export this session</DropdownMenuLabel>
                    <DropdownMenuItem
                      className="min-h-11 cursor-pointer"
                      data-testid="dino-export-md"
                      onSelect={() => exportSession("md")}
                    >
                      <FileText className="h-4 w-4" aria-hidden />
                      Markdown report
                      <span className="ml-auto text-[10px] text-muted-foreground">
                        .md
                      </span>
                    </DropdownMenuItem>
                    <DropdownMenuItem
                      className="min-h-11 cursor-pointer"
                      data-testid="dino-export-csv"
                      onSelect={() => exportSession("csv")}
                    >
                      <Download className="h-4 w-4" aria-hidden />
                      History CSV
                      <span className="ml-auto text-[10px] text-muted-foreground">
                        .csv
                      </span>
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>

                <p className="text-[11px] text-muted-foreground">
                  Saves the best-ever brain to the library (POST /api/brains).
                </p>
              </div>
            </CardContent>
          </Card>
        </div>
      </div>

      {/* --- evolution curve — best/avg score telemetry per generation
            (memoized component: skips the 4Hz identity-only history churn) --- */}
      <EvolutionChart history={history} bestEver={hud.best} running={running} />

      {/* --- champion lineage (family tree) --- */}
      <Card className="mt-4 gap-0 py-0" data-testid="lineage-card">
        <Collapsible open={lineageOpen} onOpenChange={toggleLineageOpen}>
          <CollapsibleTrigger asChild>
            <button
              type="button"
              data-testid="lineage-toggle"
              aria-controls="dino-lineage-panel"
              className="flex w-full items-center gap-3 px-6 py-4 text-left transition-colors hover:bg-muted/30"
            >
              <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-amber-500/30 bg-amber-500/10 text-amber-400">
                <GitBranch className="h-4 w-4" aria-hidden />
              </span>
              <span className="min-w-0 flex-1">
                <span className="flex items-center gap-2 text-sm font-semibold">
                  Champion lineage
                </span>
                <span
                  className="mt-1 block truncate text-xs text-muted-foreground"
                  data-testid="lineage-summary"
                >
                  {lineageSummary}
                </span>
              </span>
              <ChevronDown
                className={`h-4 w-4 shrink-0 text-muted-foreground transition-transform duration-200 ${
                  lineageOpen ? "rotate-180" : ""
                }`}
                aria-hidden
              />
            </button>
          </CollapsibleTrigger>
          <CollapsibleContent id="dino-lineage-panel">
            <CardContent className="border-t border-border/60 px-4 pb-5 pt-4 sm:px-6">
              {lineage.view ? (
                <>
                  <div
                    className="overflow-x-auto pb-1 [&::-webkit-scrollbar]:h-2 [&::-webkit-scrollbar-track]:bg-transparent [&::-webkit-scrollbar-thumb]:rounded-full [&::-webkit-scrollbar-thumb]:bg-border"
                  >
                    <LineageTreeSvg view={lineage.view} />
                  </div>
                  <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1.5 text-[11px] text-muted-foreground">
                    <span className="flex items-center gap-1.5">
                      <span
                        className="h-2 w-2 rounded-full bg-amber-500/80"
                        aria-hidden
                      />
                      main line
                    </span>
                    <span className="flex items-center gap-1.5">
                      <span
                        className="h-2 w-2 rounded-full bg-rose-400/60"
                        aria-hidden
                      />
                      crossover parent
                    </span>
                    <span className="flex items-center gap-1.5 text-emerald-300">
                      <span aria-hidden>★</span>
                      champion
                    </span>
                  </div>
                </>
              ) : (
                <div
                  data-testid="lineage-empty"
                  className="flex h-[120px] items-center justify-center rounded-lg border border-dashed border-border px-4 text-center text-xs text-muted-foreground"
                >
                  No champion yet — finish a generation to start the family line.
                </div>
              )}
              <p className="mt-2.5 text-[10px] leading-snug text-muted-foreground/70">
                Breeding history of the all-time champion — elitism clones inherit one parent,
                crossover children merge two. Session memory only: the line resets with the
                population (Reset or loading a brain starts a fresh family).
              </p>
            </CardContent>
          </CollapsibleContent>
        </Collapsible>
      </Card>
    </section>
  );
}
