/**
 * Dino game world — the Chrome offline Dino runner, restyled as a dark
 * neuro-lab fruit-fly playground. Pure TypeScript + Canvas2D, no React.
 *
 * Logical resolution is a fixed 480×140 world (independent of the display
 * size, so the simulation never depends on CSS layout). Each sim step the
 * world is drawn WITHOUT any flies onto an offscreen "game" canvas; that
 * frame is downscaled to 240×90 and fed to every fly's 24×9 retina via
 * `retinaFromImageData`. Flies are painted afterwards, only on the visible
 * canvas — a fly can never see itself, just the obstacles racing at it.
 */

import { mulberry32, clamp } from "@/lib/flybrain/rng";

// ---------------------------------------------------------------------------
// Geometry / tuning constants
// ---------------------------------------------------------------------------
export const GAME_W = 480;
export const GAME_H = 140;
export const GROUND_Y = 118;
export const FLY_X = 64;

/** offscreen low-res frame the retina samples from (exactly half of game res) */
export const RETINA_W = 240;
export const RETINA_H = 90;
export const RETINA_COLS = 24;
export const RETINA_ROWS = 9;

// physics (world units: px, s)
export const GRAVITY = 2600;
export const JUMP_V = 560; // apex ≈ 60px, airtime ≈ 0.43s
export const BASE_SPEED = 165;
export const MAX_SPEED = 360;
export const SPEED_RAMP = 0.55; // px/s per score point
export const SCORE_METERS_PER_POINT = 16;

// brain ↔ game coupling (validated thresholds from the engine agent)
export const JUMP_THRESHOLD = 0.12;
export const DUCK_THRESHOLD = 0.15;
export const REWARD_CLEAR = 0.4; // sugar
export const PUNISH_CRASH = 0.3; // shock
export const JUMP_COOLDOWN_MS = 500; // game-time
export const GEN_TIME_CAP_S = 180; // 3 min hard cap per generation

// fly silhouette (visual + forgiving hitbox heights)
export const STAND_BOX_H = 21;
export const DUCK_BOX_H = 11;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------
export type ObstacleType = "cactus" | "bird";

export interface Obstacle {
  type: ObstacleType;
  x: number;
  w: number;
  h: number;
  top: number;
  cleared: boolean;
  variant: number;
  flap: number;
}

export interface Cloud {
  x: number;
  y: number;
  s: number;
  layer: number;
}

export interface Star {
  x: number;
  y: number;
  r: number;
  phase: number;
}

export interface Pebble {
  x: number;
  o: number;
  s: number;
}

export interface World {
  t: number; // game-time seconds
  dist: number; // scrolled px
  speed: number; // px/s
  score: number;
  obstacles: Obstacle[];
  clouds: Cloud[];
  stars: Star[];
  pebbles: Pebble[];
  nextSpawn: number; // px until the next obstacle
  rng: () => number;
}

export interface FlyAvatar {
  y: number; // feet position (GROUND_Y when grounded)
  vy: number;
  airborne: boolean;
  ducking: boolean;
  jumpCooldownMs: number;
  wingPhase: number;
}

// ---------------------------------------------------------------------------
// World construction
// ---------------------------------------------------------------------------
export function createWorld(): World {
  const seed = (Math.random() * 0x7fffffff) | 0;
  const rng = mulberry32(seed);
  const world: World = {
    t: 0,
    dist: 0,
    speed: BASE_SPEED,
    score: 0,
    obstacles: [],
    clouds: [],
    stars: [],
    pebbles: [],
    nextSpawn: 260 + rng() * 140,
    rng,
  };
  for (let i = 0; i < 5; i++) {
    world.clouds.push({
      x: rng() * GAME_W,
      y: 12 + rng() * 52,
      s: 0.7 + rng() * 0.8,
      layer: rng() < 0.5 ? 0 : 1,
    });
  }
  for (let i = 0; i < 14; i++) {
    world.stars.push({
      x: rng() * GAME_W,
      y: 3 + rng() * 68,
      r: 0.5 + rng() * 0.7,
      phase: rng() * Math.PI * 2,
    });
  }
  for (let i = 0; i < 24; i++) {
    world.pebbles.push({
      x: rng() * GAME_W,
      o: 2 + rng() * 5,
      s: 0.8 + rng() * 1.6,
    });
  }
  return world;
}

export function freshFly(): FlyAvatar {
  return {
    y: GROUND_Y,
    vy: 0,
    airborne: false,
    ducking: false,
    jumpCooldownMs: 0,
    wingPhase: Math.random() * Math.PI * 2,
  };
}

// ---------------------------------------------------------------------------
// Simulation
// ---------------------------------------------------------------------------
function spawnObstacle(w: World): void {
  // Birds (pterodactyl silhouettes) only appear once the run speeds up.
  // They fly LOW — ducking is mandatory, jumping does not clear them.
  if (w.score > 100 && w.rng() < 0.22) {
    const h = 12;
    w.obstacles.push({
      type: "bird",
      x: GAME_W + 12,
      w: 52,
      h,
      top: GROUND_Y - 16 - h,
      cleared: false,
      variant: 0,
      flap: w.rng() * 10,
    });
    return;
  }
  const roll = w.rng();
  let ow: number;
  let oh: number;
  let variant: number;
  if (roll < 0.45) {
    // small cactus — 2 retina columns wide, ~1 row tall
    ow = 40 + w.rng() * 10;
    oh = 18 + w.rng() * 8;
    variant = 0;
  } else if (roll < 0.8) {
    // tall cactus with arms — still jumpable
    ow = 42 + w.rng() * 14;
    oh = 26 + w.rng() * 8;
    variant = 1;
  } else {
    // cactus cluster — 3+ retina columns
    ow = 54 + w.rng() * 14;
    oh = 20 + w.rng() * 8;
    variant = 2;
  }
  w.obstacles.push({
    type: "cactus",
    x: GAME_W + 12,
    w: ow,
    h: oh,
    top: GROUND_Y - oh,
    cleared: false,
    variant,
    flap: 0,
  });
}

/** Advance the shared world by dt seconds. Returns obstacles cleared this step. */
export function stepWorld(w: World, dt: number): Obstacle[] {
  w.t += dt;
  w.score = Math.floor(w.dist / SCORE_METERS_PER_POINT);
  w.speed = Math.min(MAX_SPEED, BASE_SPEED + w.score * SPEED_RAMP);
  const dx = w.speed * dt;
  w.dist += dx;

  for (const c of w.clouds) {
    c.x -= dx * (c.layer === 0 ? 0.16 : 0.32);
    if (c.x < -70) {
      c.x = GAME_W + 40 + w.rng() * 60;
      c.y = 10 + w.rng() * 55;
    }
  }
  for (const p of w.pebbles) {
    p.x -= dx;
    if (p.x < -6) {
      p.x += GAME_W + 10 + w.rng() * 40;
      p.o = 2 + w.rng() * 5;
      p.s = 0.8 + w.rng() * 1.6;
    }
  }

  w.nextSpawn -= dx;
  if (w.nextSpawn <= 0) {
    spawnObstacle(w);
    w.nextSpawn = clamp(w.speed * (0.95 + w.rng() * 0.85), 230, 660);
  }

  const cleared: Obstacle[] = [];
  for (const o of w.obstacles) {
    o.x -= dx + (o.type === "bird" ? 26 * dt : 0);
    if (!o.cleared && o.x + o.w < FLY_X - 14) {
      o.cleared = true;
      cleared.push(o);
    }
  }
  w.obstacles = w.obstacles.filter((o) => o.x + o.w > -30);
  return cleared;
}

export function flyBox(f: FlyAvatar): { x: number; y: number; w: number; h: number } {
  const top = f.y - (f.ducking && !f.airborne ? DUCK_BOX_H : STAND_BOX_H);
  return { x: FLY_X - 7, y: top, w: 16, h: f.y - 1 - top };
}

/** AABB collision, obstacle boxes shrunk a few px for forgiveness. */
export function collides(w: World, f: FlyAvatar): boolean {
  const b = flyBox(f);
  for (const o of w.obstacles) {
    const ox = o.x + 3;
    const oy = o.top + 3;
    const ow = o.w - 6;
    const oh = o.h - 6;
    if (b.x < ox + ow && b.x + b.w > ox && b.y < oy + oh && b.y + b.h > oy) {
      return true;
    }
  }
  return false;
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------
type RGB = [number, number, number];

function lerpColor(a: RGB, b: RGB, t: number): string {
  const r = Math.round(a[0] + (b[0] - a[0]) * t);
  const g = Math.round(a[1] + (b[1] - a[1]) * t);
  const bl = Math.round(a[2] + (b[2] - a[2]) * t);
  return `rgb(${r},${g},${bl})`;
}

function rrect(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number
) {
  const rr = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.arcTo(x + w, y, x + w, y + h, rr);
  ctx.arcTo(x + w, y + h, x, y + h, rr);
  ctx.arcTo(x, y + h, x, y, rr);
  ctx.arcTo(x, y, x + w, y, rr);
  ctx.closePath();
}

/** Day/night factor 0 (day) .. 1 (deep night), cycling slowly with score. */
export function nightFactor(score: number): number {
  return 0.5 - 0.5 * Math.cos((score / 500) * Math.PI * 2);
}

/**
 * Draw the shared world (sky, stars, clouds, ground, obstacles) —
 * NO flies: the game canvas is the flies' visual field.
 */
export function drawWorld(ctx: CanvasRenderingContext2D, w: World): void {
  const night = nightFactor(w.score);

  const g = ctx.createLinearGradient(0, 0, 0, GROUND_Y);
  g.addColorStop(0, lerpColor([27, 24, 19], [11, 9, 8], night));
  g.addColorStop(1, lerpColor([39, 34, 26], [21, 18, 15], night));
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, GAME_W, GAME_H);

  if (night > 0.12) {
    ctx.fillStyle = "#efe8d8";
    for (const s of w.stars) {
      const tw = 0.35 + 0.65 * Math.abs(Math.sin(w.t * 1.3 + s.phase));
      ctx.globalAlpha = night * tw * 0.8;
      ctx.beginPath();
      ctx.arc(s.x, s.y, s.r, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.globalAlpha = 1;
  }

  for (const c of w.clouds) {
    const s = c.s;
    ctx.fillStyle = `rgba(232,222,205,${c.layer === 0 ? 0.055 : 0.085})`;
    ctx.beginPath();
    ctx.ellipse(c.x, c.y, 16 * s, 5 * s, 0, 0, Math.PI * 2);
    ctx.ellipse(c.x + 10 * s, c.y + 2 * s, 10 * s, 4 * s, 0, 0, Math.PI * 2);
    ctx.ellipse(c.x - 11 * s, c.y + 2 * s, 8 * s, 3.5 * s, 0, 0, Math.PI * 2);
    ctx.fill();
  }

  // ground: soft dark fill + line + scattered pebbles scrolling by
  ctx.fillStyle = lerpColor([41, 36, 28], [26, 23, 19], night);
  ctx.fillRect(0, GROUND_Y, GAME_W, GAME_H - GROUND_Y);
  ctx.strokeStyle = "#57503f";
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(0, GROUND_Y + 0.5);
  ctx.lineTo(GAME_W, GROUND_Y + 0.5);
  ctx.stroke();
  ctx.fillStyle = "#6b6252";
  for (const p of w.pebbles) {
    ctx.fillRect(p.x, GROUND_Y + p.o, p.s, Math.max(1, p.s * 0.6));
  }

  for (const o of w.obstacles) {
    if (o.type === "bird") drawBird(ctx, o, w.t);
    else drawCactus(ctx, o);
  }
}

function drawCactus(ctx: CanvasRenderingContext2D, o: Obstacle): void {
  const { x, top: y, w: w2, h: h2 } = o;
  ctx.fillStyle = "#5e7a4f";
  rrect(ctx, x, y, w2, h2, 3);
  ctx.fill();
  if (o.variant === 2) {
    ctx.fillStyle = "#557047";
    rrect(ctx, x + w2 * 0.45, y + 4, w2 * 0.55, h2 - 4, 3);
    ctx.fill();
  } else if (o.variant === 1) {
    ctx.fillStyle = "#5e7a4f";
    rrect(ctx, x - 6, y + h2 * 0.3, 7, h2 * 0.35, 2);
    ctx.fill();
    rrect(ctx, x + w2 - 1, y + h2 * 0.2, 6, h2 * 0.4, 2);
    ctx.fill();
  }
  ctx.strokeStyle = "#93b577";
  ctx.lineWidth = 1;
  rrect(ctx, x + 0.5, y + 0.5, w2 - 1, h2 - 1, 3);
  ctx.stroke();
}

function drawBird(ctx: CanvasRenderingContext2D, o: Obstacle, t: number): void {
  const { x, top: y, w: w2, h: h2 } = o;
  const flapUp = Math.sin(t * 9 + o.flap) > 0;
  ctx.fillStyle = "#c9bda9";
  ctx.beginPath();
  ctx.ellipse(x + w2 * 0.42, y + h2 * 0.55, w2 * 0.3, h2 * 0.42, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.beginPath();
  ctx.arc(x + w2 * 0.78, y + h2 * 0.5, h2 * 0.32, 0, Math.PI * 2);
  ctx.fill();
  // beak
  ctx.fillStyle = "#b3a893";
  ctx.beginPath();
  ctx.moveTo(x + w2 * 0.9, y + h2 * 0.42);
  ctx.lineTo(x + w2 + 2, y + h2 * 0.5);
  ctx.lineTo(x + w2 * 0.9, y + h2 * 0.6);
  ctx.closePath();
  ctx.fill();
  // wing
  ctx.beginPath();
  if (flapUp) {
    ctx.ellipse(x + w2 * 0.42, y - 1, w2 * 0.22, h2 * 0.55, -0.5, 0, Math.PI * 2);
  } else {
    ctx.ellipse(x + w2 * 0.42, y + h2 * 0.85, w2 * 0.24, h2 * 0.4, 0.4, 0, Math.PI * 2);
  }
  ctx.fill();
  // eye
  ctx.fillStyle = "#f59e0b";
  ctx.beginPath();
  ctx.arc(x + w2 * 0.82, y + h2 * 0.45, 1.1, 0, Math.PI * 2);
  ctx.fill();
}

export interface FlyDrawOpts {
  x: number;
  feetY: number;
  airborne: boolean;
  ducking: boolean;
  wingPhase: number;
  alpha: number;
  isBest: boolean;
  label?: string;
  t: number;
}

/**
 * The star of the show: a cute little Drosophila.
 * Tan body, red compound eye, translucent wings; poses change for
 * jump (wings flapping, legs tucked) and duck (squashed, wings flat).
 */
export function drawFly(ctx: CanvasRenderingContext2D, o: FlyDrawOpts): void {
  const { x, airborne } = o;
  const duck = o.ducking && !airborne;
  const y = o.feetY;
  ctx.save();
  ctx.globalAlpha = o.alpha;

  // shadow on the ground (shrinks/fades with altitude)
  const hgt = Math.max(0, GROUND_Y - y);
  ctx.fillStyle = `rgba(0,0,0,${0.28 * (1 - Math.min(hgt / 90, 0.85))})`;
  ctx.beginPath();
  ctx.ellipse(x + 1, GROUND_Y + 2.5, Math.max(3, 9 - hgt * 0.05), 2.2, 0, 0, Math.PI * 2);
  ctx.fill();

  // legs
  ctx.strokeStyle = "#8a6f4a";
  ctx.lineWidth = 1;
  ctx.beginPath();
  const legTop = y - 7;
  if (airborne) {
    ctx.moveTo(x - 2, legTop);
    ctx.lineTo(x - 7, y - 3);
    ctx.moveTo(x + 2, legTop);
    ctx.lineTo(x - 2, y - 2);
  } else {
    for (let i = -1; i <= 1; i++) {
      ctx.moveTo(x + i * 4, legTop);
      ctx.lineTo(x + i * 5 + (duck ? 2 : 3), y - 0.5);
    }
  }
  ctx.stroke();

  // wings (two, behind the body). angle sweeps up from the rear axis
  let angle: number;
  if (airborne) {
    angle = 0.15 + (Math.sin(o.wingPhase * 2) + 1) * 0.55; // frantic flapping
  } else if (duck) {
    angle = 0.08; // swept flat over the abdomen
  } else {
    angle = 0.3 + Math.sin(o.t * 2.2) * 0.07; // idle flutter
  }
  const anchorX = x - 1;
  const anchorY = y - (duck ? 9 : 15);
  for (const side of [0, 1]) {
    ctx.save();
    ctx.translate(anchorX, anchorY);
    ctx.rotate(-(angle + side * 0.38));
    ctx.fillStyle = "rgba(255,246,228,0.26)";
    ctx.strokeStyle = "rgba(255,246,228,0.5)";
    ctx.lineWidth = 0.5;
    ctx.beginPath();
    ctx.ellipse(-7, 0, 8, 3, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
    ctx.restore();
  }

  // abdomen with stripes
  ctx.fillStyle = "#c9a26b";
  ctx.beginPath();
  ctx.ellipse(x - 8, y - (duck ? 7 : 11), 6.2, duck ? 3.6 : 4.6, -0.12, 0, Math.PI * 2);
  ctx.fill();
  ctx.strokeStyle = "#8f6f43";
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(x - 6, y - (duck ? 10.5 : 15.5));
  ctx.lineTo(x - 6, y - (duck ? 3.5 : 7));
  ctx.moveTo(x - 9.5, y - (duck ? 10 : 14.5));
  ctx.lineTo(x - 9.5, y - (duck ? 4 : 8));
  ctx.stroke();

  // thorax
  ctx.fillStyle = "#d9b380";
  ctx.beginPath();
  ctx.ellipse(x - 1, y - (duck ? 8.5 : 12.5), 7.2, duck ? 3.8 : 5.6, -0.08, 0, Math.PI * 2);
  ctx.fill();
  ctx.strokeStyle = "#a8834f";
  ctx.beginPath();
  ctx.moveTo(x - 2, y - (duck ? 11.5 : 17));
  ctx.lineTo(x - 1, y - (duck ? 4 : 8));
  ctx.stroke();

  // head + red compound eye + antennae
  const headY = y - (duck ? 9.5 : 13.5);
  ctx.fillStyle = "#e0bd8c";
  ctx.beginPath();
  ctx.arc(x + 6.2, headY, 4.3, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = "#d94f4f";
  ctx.beginPath();
  ctx.arc(x + 7.3, headY - 0.7, 2.6, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = "rgba(255,255,255,0.85)";
  ctx.beginPath();
  ctx.arc(x + 8.1, headY - 1.5, 0.8, 0, Math.PI * 2);
  ctx.fill();
  ctx.strokeStyle = "#8a6f4a";
  ctx.lineWidth = 0.7;
  ctx.beginPath();
  ctx.moveTo(x + 8.5, headY - 3.3);
  ctx.lineTo(x + 10.5, headY - 5.5);
  ctx.moveTo(x + 7.5, headY - 3.8);
  ctx.lineTo(x + 8.5, headY - 6.3);
  ctx.stroke();

  // best-fly marker ring + label
  if (o.isBest) {
    ctx.strokeStyle = "rgba(52,211,153,0.9)";
    ctx.lineWidth = 1;
    ctx.setLineDash([3, 2.5]);
    ctx.beginPath();
    ctx.arc(x, y - (duck ? 8 : 12), 17, 0, Math.PI * 2);
    ctx.stroke();
    ctx.setLineDash([]);
    if (o.label) {
      ctx.fillStyle = "#34d399";
      ctx.font = "bold 6px ui-monospace, SFMono-Regular, monospace";
      ctx.textAlign = "center";
      ctx.fillText(o.label, x, y - (duck ? 20 : 27));
    }
  }
  ctx.restore();
}
