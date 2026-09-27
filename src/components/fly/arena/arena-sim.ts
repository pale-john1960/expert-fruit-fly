/**
 * Dino Arena — head-to-head race engine (pure TypeScript, no React).
 *
 * 2–4 SAVED brains run the SAME dino world simultaneously so users can see
 * how differently their trained connectomes behave. The loop mirrors the
 * proven DinoTrainer generation engine exactly:
 *
 *   stepWorld(dt) → per-racer avatar physics → shared vision (world drawn
 *   WITHOUT flies → 240×90 → 24×9 retina, ONE input array for everyone —
 *   identical eyes = a fair race) → per-racer brain step → motor mapping
 *   (jump / duck with the same thresholds + cooldown) → per-racer collision.
 *
 * All flies physically sit at the SAME x (FLY_X) and collide there — the
 * race is perfectly fair; only the VISUAL x is staggered per lane so the
 * sprites don't overlap on screen (see `visualX`).
 *
 * Scoring: a racer's score is the world score at its death moment; alive
 * racers track the live world score. Ranking = score desc, then obstacles
 * cleared desc, then shared ranks on full ties.
 *
 * Learning: default "frozen showcase" — dopamine delta is always 0, a pure
 * behavior readout. With `learning = true` racers receive the exact training
 * signal (REWARD_CLEAR when the world clears obstacles, -PUNISH_CRASH on
 * death), so users can watch brains adapt mid-race. Fresh brains are always
 * rebuilt from snapshots (`FlyBrain.fromJSON`), so learning never leaks
 * between races.
 */

import {
  createWorld,
  drawWorld,
  drawFly,
  freshFly,
  stepWorld,
  stepAvatarPhysics,
  hitObstacle,
  GAME_W,
  GAME_H,
  GROUND_Y,
  FLY_X,
  RETINA_W,
  RETINA_H,
  RETINA_COLS,
  RETINA_ROWS,
  JUMP_THRESHOLD,
  DUCK_THRESHOLD,
  JUMP_V,
  JUMP_COOLDOWN_MS,
  REWARD_CLEAR,
  PUNISH_CRASH,
  type DeathCause,
  type FlyAvatar,
  type World,
} from "@/components/fly/dino/game";
import { FlyBrain, retinaFromImageData } from "@/lib/flybrain/engine";
import type { BrainSnapshot } from "@/lib/flybrain/types";
import { playSound } from "@/lib/sound";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** hard race cap, game-time seconds (trainer generations use 180) */
export const ARENA_TIME_CAP_S = 120;
export const ARENA_MIN_RACERS = 2;
export const ARENA_MAX_RACERS = 4;

/** fixed sim step — identical to the trainer's STEP_DT (accumulator driven) */
export const STEP_DT = 1 / 60;
export const MAX_STEPS_PER_FRAME = 60;

/** Where a racer's sprite is painted. PHYSICALLY every fly sits at FLY_X
 *  (collisions + vision are identical); this is purely a visual stagger so
 *  2–4 sprites don't stack on one spot. Lane 0 leftmost … lane 3 rightmost. */
export function visualX(lane: number): number {
  return FLY_X - 24 + lane * 18;
}

export type RacerSource = "library" | "builtin" | "newborn";

/** A chosen racer, resolved to a full snapshot at Start time. */
export interface RacerSpec {
  /** stable unique key ("lib:<id>" / "demo:<id>" / "newborn") */
  key: string;
  name: string;
  snapshot: BrainSnapshot;
  source: RacerSource;
  /** 0–3 — lane index = pick order (also the lane color index) */
  lane: number;
}

/** Per-lane identity colors: emerald / amber / rose / teal (in that order). */
export interface LaneColor {
  name: string;
  /** drawFly marker ring override */
  ring: string;
  /** drawFly label color override */
  label: string;
  /** UI dot background class */
  dot: string;
  /** UI chip classes (light + dark scopes) */
  chip: string;
  /** border + tint classes for a SELECTED picker row / leaderboard row */
  row: string;
}

export const LANE_COLORS: LaneColor[] = [
  {
    name: "emerald",
    ring: "rgba(52,211,153,0.95)",
    label: "#34d399",
    dot: "bg-emerald-500",
    chip: "border-emerald-500/40 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300",
    row: "border-emerald-500/50 bg-emerald-500/10",
  },
  {
    name: "amber",
    ring: "rgba(251,191,36,0.95)",
    label: "#fbbf24",
    dot: "bg-amber-500",
    chip: "border-amber-500/40 bg-amber-500/10 text-amber-700 dark:text-amber-300",
    row: "border-amber-500/50 bg-amber-500/10",
  },
  {
    name: "rose",
    ring: "rgba(251,113,133,0.95)",
    label: "#fb7185",
    dot: "bg-rose-500",
    chip: "border-rose-500/40 bg-rose-500/10 text-rose-700 dark:text-rose-300",
    row: "border-rose-500/50 bg-rose-500/10",
  },
  {
    name: "teal",
    ring: "rgba(45,212,191,0.95)",
    label: "#2dd4bf",
    dot: "bg-teal-500",
    chip: "border-teal-500/40 bg-teal-500/10 text-teal-700 dark:text-teal-300",
    row: "border-teal-500/50 bg-teal-500/10",
  },
];

export function laneColor(lane: number): LaneColor {
  return LANE_COLORS[Math.min(Math.max(lane, 0), LANE_COLORS.length - 1)];
}

// ---------------------------------------------------------------------------
// Live / result views (plain data pushed into React at the 4 Hz flush)
// ---------------------------------------------------------------------------

export interface RacerLive {
  key: string;
  name: string;
  lane: number;
  source: RacerSource;
  alive: boolean;
  /** live world score while alive; frozen death score once dead */
  score: number;
  obstaclesCleared: number;
  deathCause: DeathCause | null;
}

export interface ArenaHud {
  elapsed: number;
  speed: number;
  score: number;
  finished: boolean;
  racers: RacerLive[];
}

export interface RankedRacer {
  rank: number;
  key: string;
  name: string;
  lane: number;
  source: RacerSource;
  score: number;
  obstaclesCleared: number;
  /** still alive when the time cap ended (vs killed by an obstacle) */
  survived: boolean;
  deathCause: DeathCause | null;
}

/** Rank a racer list: score desc → obstacles cleared desc → shared rank on
 *  full ties (competition ranking, "1 2 2 4"). Pure — used by the UI on the
 *  final HUD snapshot so render never touches the sim. */
export function rankRacers(racers: RacerLive[]): RankedRacer[] {
  const list: RankedRacer[] = racers.map((r) => ({
    rank: 0,
    key: r.key,
    name: r.name,
    lane: r.lane,
    source: r.source,
    score: r.score,
    obstaclesCleared: r.obstaclesCleared,
    survived: r.alive,
    deathCause: r.deathCause,
  }));
  list.sort(
    (a, b) =>
      b.score - a.score ||
      b.obstaclesCleared - a.obstaclesCleared ||
      a.lane - b.lane
  );
  let currentRank = 0;
  for (let i = 0; i < list.length; i++) {
    const tied =
      i > 0 &&
      list[i].score === list[i - 1].score &&
      list[i].obstaclesCleared === list[i - 1].obstaclesCleared;
    currentRank = tied ? currentRank : i + 1;
    list[i].rank = currentRank;
  }
  return list;
}

// ---------------------------------------------------------------------------
// The race
// ---------------------------------------------------------------------------

interface ArenaRacer {
  spec: RacerSpec;
  brain: FlyBrain;
  fly: FlyAvatar;
  alive: boolean;
  deathScore: number;
  deathCause: DeathCause | null;
  obstaclesCleared: number;
}

/** Short canvas label — first ~10 chars of the racer name. */
function shortLabel(name: string): string {
  return name.length > 10 ? `${name.slice(0, 9)}…` : name;
}

export class ArenaRace {
  readonly world: World;
  readonly racers: ArenaRacer[];
  readonly specs: RacerSpec[];
  /** dopamine switch — false (default) = frozen showcase, true = keep learning */
  learning: boolean;
  finished = false;

  private game: HTMLCanvasElement;
  private gameCtx: CanvasRenderingContext2D;
  private retina: HTMLCanvasElement;
  private retinaCtx: CanvasRenderingContext2D;

  constructor(specs: RacerSpec[], learning: boolean) {
    this.specs = specs;
    this.learning = learning;
    this.world = createWorld();

    // offscreen vision pipeline — identical to DinoTrainer's createArt()
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
    this.game = game;
    this.gameCtx = gameCtx;
    this.retina = retina;
    this.retinaCtx = retinaCtx;

    // fresh brains from snapshots — a race NEVER inherits learned state from
    // a previous race (or from the trainer session the snapshot came from)
    this.racers = specs.map((spec) => ({
      spec,
      brain: FlyBrain.fromJSON(spec.snapshot),
      fly: freshFly(),
      alive: true,
      deathScore: 0,
      deathCause: null,
      obstaclesCleared: 0,
    }));

    drawWorld(this.gameCtx, this.world); // first paint so pause view isn't blank

    // TEMP DEBUG HOOK (removed before delivery) — lets the devtools console
    // inspect the live race while verifying the pipeline.
    if (typeof window !== "undefined") {
      (window as unknown as { __arenaRace?: ArenaRace }).__arenaRace = this;
    }
  }

  /** One fixed sim step (dt seconds of game-time). Mirrors stepSim(). */
  step(dt: number): void {
    if (this.finished) return;
    const w = this.world;
    const cleared = stepWorld(w, dt);

    // avatar physics (dead racers are parked on the ground, faded ghosts)
    for (const r of this.racers) {
      if (!r.alive) continue;
      stepAvatarPhysics(r.fly, dt);
      r.fly.ducking = false; // re-decided by the brain every step
    }

    // vision: world without flies → 240×90 → 24×9 retina — ONE shared input
    // array for every racer (identical eyes = a fair race)
    drawWorld(this.gameCtx, w);
    this.retinaCtx.drawImage(this.game, 0, 0, RETINA_W, RETINA_H);
    const img = this.retinaCtx.getImageData(0, 0, RETINA_W, RETINA_H);
    const input = retinaFromImageData(
      img.data,
      RETINA_W,
      RETINA_H,
      RETINA_COLS,
      RETINA_ROWS,
      false
    );

    // brains + motors (thresholds copied verbatim from the trainer loop)
    const reward = this.learning && cleared.length > 0 ? REWARD_CLEAR : 0;
    for (const r of this.racers) {
      if (!r.alive) continue;
      const m = r.brain.step(input, reward);
      const f = r.fly;
      if (!f.airborne && f.jumpCooldownMs <= 0 && m[0] > JUMP_THRESHOLD) {
        f.vy = -JUMP_V;
        f.airborne = true;
        f.jumpCooldownMs = JUMP_COOLDOWN_MS;
      }
      if (m[1] > DUCK_THRESHOLD) f.ducking = true;
      if (cleared.length > 0) r.obstaclesCleared += cleared.length;
    }

    // collisions — every fly physically occupies the same box at FLY_X, so
    // the race is decided purely by the brains' jump/duck timing
    for (const r of this.racers) {
      if (!r.alive) continue;
      const hit = hitObstacle(w, r.fly);
      if (hit) {
        r.alive = false;
        r.deathScore = w.score;
        r.deathCause = hit.type;
        // park the corpse on the ground for the faded ghost rendering
        r.fly.y = GROUND_Y;
        r.fly.vy = 0;
        r.fly.airborne = false;
        r.fly.ducking = false;
        if (this.learning) r.brain.step(input, -PUNISH_CRASH);
        playSound("crash", 0.3); // sound.ts rate-limits this itself
      }
    }

    const anyAlive = this.racers.some((r) => r.alive);
    if (!anyAlive || w.t >= ARENA_TIME_CAP_S) this.finish();
  }

  private finish(): void {
    this.finished = true;
    for (const r of this.racers) {
      if (r.alive) {
        r.deathScore = this.world.score;
        r.deathCause = "timeout"; // survived to the cap — didn't crash
      }
    }
  }

  /** Paint world + every racer (dead ones faded at ground level). */
  render(canvas: HTMLCanvasElement, tNow: number): void {
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    if (canvas.width > 0 && canvas.height > 0) {
      ctx.imageSmoothingEnabled = true;
      ctx.drawImage(this.game, 0, 0, GAME_W, GAME_H, 0, 0, canvas.width, canvas.height);
    }
    const sx = canvas.width / GAME_W;
    const sy = canvas.height / GAME_H;
    ctx.setTransform(sx, 0, 0, sy, 0, 0);

    for (const r of this.racers) {
      const color = laneColor(r.spec.lane);
      drawFly(ctx, {
        // purely visual lane stagger — physics/vision stay at FLY_X
        x: visualX(r.spec.lane),
        feetY: r.alive ? r.fly.y : GROUND_Y,
        airborne: r.alive ? r.fly.airborne : false,
        ducking: r.alive ? r.fly.ducking : false,
        wingPhase: r.fly.wingPhase,
        alpha: r.alive ? 1 : 0.35,
        // drawFly only renders the marker ring + label in "best" mode, so
        // isBest:true is how the duel/arena tint every avatar (ringColor /
        // labelColor overrides carry each lane's identity color)
        isBest: true,
        // NB: no `label` here — drawFly pins labels a fixed 27px above the
        // feet, so 2–4 lane-staggered sprites would print their names on top
        // of each other. The lane names are drawn below at lane-staggered
        // heights instead (same font + lane label color as the trainer's
        // "BEST" marker, so the look stays consistent).
        ringColor: color.ring,
        labelColor: color.label,
        t: tNow,
      });
    }

    // lane name tags — a vertical cascade above the ground so 2–4 names
    // never collide (each pinned to its lane's visual column)
    for (const r of this.racers) {
      const color = laneColor(r.spec.lane);
      ctx.globalAlpha = r.alive ? 0.95 : 0.4;
      ctx.fillStyle = color.label;
      ctx.font = "bold 6px ui-monospace, SFMono-Regular, monospace";
      ctx.textAlign = "center";
      ctx.fillText(
        shortLabel(r.spec.name),
        visualX(r.spec.lane) + 4,
        GROUND_Y - 34 - r.spec.lane * 8
      );
    }
    ctx.globalAlpha = 1;
  }

  /** Plain-data snapshot for React (called ~4 Hz, never during render). */
  hud(): ArenaHud {
    return {
      elapsed: this.world.t,
      speed: this.world.speed,
      score: this.world.score,
      finished: this.finished,
      racers: this.racers.map((r) => ({
        key: r.spec.key,
        name: r.spec.name,
        lane: r.spec.lane,
        source: r.spec.source,
        alive: r.alive,
        score: r.alive ? this.world.score : r.deathScore,
        obstaclesCleared: r.obstaclesCleared,
        deathCause: r.deathCause,
      })),
    };
  }
}
