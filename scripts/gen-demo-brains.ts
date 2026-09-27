#!/usr/bin/env bun
/**
 * gen-demo-brains.ts — deterministic generator for the three built-in demo
 * brains shipped with the app (see src/lib/demo-brains.ts + BrainLibrary).
 *
 *   1. "Dino champion"   — headless neuroevolution replicating DinoTrainer's
 *      exact generation loop (createWorld → stepWorld → stepAvatarPhysics →
 *      retina → brain.step → jump/duck → hitObstacle → evolvePopulation),
 *      with a canvas-free SIMPLIFIED RASTERIZER that renders the world into a
 *      240×90 RGBA buffer approximating drawWorld's perceptual output (sky
 *      gradient + night cycle, stars, clouds, ground line + pebbles, cacti,
 *      birds) and feeds it through the engine's real retinaFromImageData.
 *
 *      ⚠ The demo brain was TRAINED on this simplified rasterizer; the live
 *      game renders with the full Canvas2D drawWorld. Colors/luminances are
 *      matched closely so the champion's behavior transfers (verified
 *      in-browser by the 13-b task report).
 *
 *   2. "Dusk Rider"      — the real BicycleTrainerCore (React-free class),
 *      driven headlessly via core.advance() at high turbo, fixed seed.
 *
 *   3. "Conditioned lab fly" — new FlyBrain(DEFAULT_ARCH_LAB) run through the
 *      BrainLab conditioning wizard's exact schedule (24 trials, 30 Hz ticks,
 *      bar-left + sugar vs bar-right + shock, reward at t=1.5 s of each 3.0 s
 *      stimulus, 0.5 s dark pause). Verified: A vs B motor responses diverge.
 *
 * Determinism: Math.random is patched to a seeded mulberry32 stream BEFORE
 * any simulation code runs (createWorld, FlyBrain.mutate/crossover, tournament
 * selection and makeBikeState all draw from it). No Date.now / crypto random
 * anywhere in the training paths; `createdAt` is a fixed constant. Re-running
 * this script produces a byte-identical JSON.
 *
 * Run:  bun scripts/gen-demo-brains.ts
 * Out:  src/lib/generated/demo-brains.json   (≤ ~250 KB)
 */

import { mkdir } from "node:fs/promises";
import { FlyBrain, retinaFromImageData } from "@/lib/flybrain/engine";
import {
  DEFAULT_ARCH_BICYCLE,
  DEFAULT_ARCH_DINO,
  DEFAULT_ARCH_LAB,
  type BrainSnapshot,
} from "@/lib/flybrain/types";
import { mulberry32 } from "@/lib/flybrain/rng";
import {
  createWorld,
  stepWorld,
  stepAvatarPhysics,
  hitObstacle,
  freshFly,
  nightFactor,
  GROUND_Y,
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
  GEN_TIME_CAP_S,
  type World,
  type FlyAvatar,
} from "@/components/fly/dino/game";
import { evolvePopulation } from "@/components/fly/dino/evolution";
import { BicycleTrainerCore } from "@/components/fly/bicycle/trainer";

// ---------------------------------------------------------------------------
// deterministic environment — patch Math.random BEFORE any sim runs
// ---------------------------------------------------------------------------
const SCRIPT_SEED = 0x13b_d310; // fixed forever: changing it retrains every brain
const seededRandom = mulberry32(SCRIPT_SEED);
Math.random = () => seededRandom();

/** fixed "shipped at" timestamp (toJSON would stamp wall-clock otherwise) */
const SHIPPED_AT = "2026-09-27T00:00:00.000Z";

// budgets (deterministic; wall-clock is only an emergency brake)
// The dino trainer runs the app-faithful loop across a fixed list of restart
// seeds and keeps the champion with the best MEDIAN fresh-world score —
// selecting for reliability instead of single-run luck (the in-app trainer
// keeps its lucky "all-time best"; a shipped demo brain must behave well
// every time it is loaded).
const DINO_RESTART_SEEDS = [
  0x13b_d310, 0xdeadbeef, 0xc0ffee, 0x1234567,
  0xfeedface, 0x0badca7, 0x5eed1234, 0x7ea51ed,
] as const;
const DINO_GENS_PER_RESTART = 30;
const DINO_SIM_BUDGET_S = 1600; // total game-time across restarts
const DINO_WALL_BRAKE_S = 90; // should never trigger
const DINO_PROBE_WORLDS = 5;
const DINO_PROBE_SIM_S = 60;
const BIKE_MAX_GENS = 800;
const BIKE_SIM_BUDGET_S = 2600;
const BIKE_WALL_BRAKE_S = 60;

const wallStart = performance.now();
const wallSeconds = () => (performance.now() - wallStart) / 1000;
const fmt = (n: number, d = 1) => n.toFixed(d);

function log(tag: string, msg: string) {
  console.log(`[${tag}] ${msg}`);
}

// ---------------------------------------------------------------------------
// 1) DINO — canvas-free simplified rasterizer (perceptual clone of drawWorld)
// ---------------------------------------------------------------------------
// 240×90 RGBA buffer (exactly RETINA_W × RETINA_H). World coordinates are
// halved (480×140 → 240×90). Only what the retina can see matters:
// luminance per pixel — sky gradient w/ night cycle, stars (night), faint
// clouds, ground fill + line + pebbles, cactus bodies/arms, bird silhouettes.
// drawWorld's exact palette is used so luminances match.
const W2 = RETINA_W; // 240
const H2 = RETINA_H; // 90
const frame = new Uint8ClampedArray(W2 * H2 * 4);

type RGB = readonly [number, number, number];
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
const mixRGB = (a: RGB, b: RGB, t: number): RGB => [
  lerp(a[0], b[0], t),
  lerp(a[1], b[1], t),
  lerp(a[2], b[2], t),
];

function setPx(x: number, y: number, c: RGB, a = 1) {
  if (x < 0 || x >= W2 || y < 0 || y >= H2) return;
  const i = (y * W2 + x) * 4;
  // alpha-composite onto the existing pixel (a ∈ 0..1)
  const prev = 1 - a;
  frame[i] = frame[i] * prev + c[0] * a;
  frame[i + 1] = frame[i + 1] * prev + c[1] * a;
  frame[i + 2] = frame[i + 2] * prev + c[2] * a;
  frame[i + 3] = 255;
}

function fillRect(x0: number, y0: number, x1: number, y1: number, c: RGB, a = 1) {
  const xa = Math.max(0, Math.round(x0));
  const xb = Math.min(W2, Math.round(x1));
  const ya = Math.max(0, Math.round(y0));
  const yb = Math.min(H2, Math.round(y1));
  for (let y = ya; y < yb; y++) for (let x = xa; x < xb; x++) setPx(x, y, c, a);
}

/** filled axis-aligned ellipse (halved world coords) */
function fillEllipse(cx: number, cy: number, rx: number, ry: number, c: RGB, a = 1) {
  const xa = Math.max(0, Math.floor(cx - rx));
  const xb = Math.min(W2 - 1, Math.ceil(cx + rx));
  const ya = Math.max(0, Math.floor(cy - ry));
  const yb = Math.min(H2 - 1, Math.ceil(cy + ry));
  for (let y = ya; y <= yb; y++) {
    for (let x = xa; x <= xb; x++) {
      const dx = (x + 0.5 - cx) / rx;
      const dy = (y + 0.5 - cy) / ry;
      if (dx * dx + dy * dy <= 1) setPx(x, y, c, a);
    }
  }
}

// drawWorld palette
const C_SKY_TOP_D: RGB = [27, 24, 19];
const C_SKY_BOT_D: RGB = [39, 34, 26];
const C_SKY_TOP_N: RGB = [11, 9, 8];
const C_SKY_BOT_N: RGB = [21, 18, 15];
const C_STAR: RGB = [239, 232, 216];
const C_CLOUD: RGB = [232, 222, 205];
const C_GND_D: RGB = [41, 36, 28];
const C_GND_N: RGB = [26, 23, 19];
const C_GND_LINE: RGB = [87, 80, 63]; // #57503f
const C_PEBBLE: RGB = [107, 98, 82]; // #6b6252
const C_CACTUS: RGB = [94, 122, 79]; // #5e7a4f
const C_CACTUS_HI: RGB = [147, 181, 119]; // #93b577 (outline)
const C_BIRD: RGB = [201, 189, 169]; // #c9bda9
const C_BIRD_DARK: RGB = [179, 168, 147]; // #b3a893 (beak/wing)

/**
 * Render one world into `frame` (240×90 RGBA). Faithful to drawWorld's
 * luminance structure; ignores the fly sprites (the game canvas never
 * contains flies — a fly cannot see itself).
 */
function rasterizeWorld(w: World): Uint8ClampedArray {
  const night = nightFactor(w.score);
  const gy = GROUND_Y / 2; // 59
  const skyTop = mixRGB(C_SKY_TOP_D, C_SKY_TOP_N, night);
  const skyBot = mixRGB(C_SKY_BOT_D, C_SKY_BOT_N, night);
  const gnd = mixRGB(C_GND_D, C_GND_N, night);

  // sky: vertical gradient, computed per row (90 rows)
  for (let y = 0; y < gy; y++) {
    const t = y / (gy - 1);
    const c = mixRGB(skyTop, skyBot, t);
    const i0 = y * W2 * 4;
    for (let x = 0; x < W2; x++) {
      const i = i0 + x * 4;
      frame[i] = c[0];
      frame[i + 1] = c[1];
      frame[i + 2] = c[2];
      frame[i + 3] = 255;
    }
  }
  // ground fill below the horizon
  for (let y = gy; y < H2; y++) {
    const i0 = y * W2 * 4;
    for (let x = 0; x < W2; x++) {
      const i = i0 + x * 4;
      frame[i] = gnd[0];
      frame[i + 1] = gnd[1];
      frame[i + 2] = gnd[2];
      frame[i + 3] = 255;
    }
  }
  // horizon line (#57503f, 1 px stroke at GROUND_Y+0.5 in world → row 59)
  for (let x = 0; x < W2; x++) setPx(x, Math.round(gy), C_GND_LINE);

  // stars (only once night falls) — same twinkle math as drawWorld
  if (night > 0.12) {
    for (const s of w.stars) {
      const tw = 0.35 + 0.65 * Math.abs(Math.sin(w.t * 1.3 + s.phase));
      setPx(Math.round(s.x / 2), Math.round(s.y / 2), C_STAR, night * tw * 0.8);
    }
  }
  // clouds — three-lobe ellipse clusters at the trainer's alphas
  for (const c of w.clouds) {
    const s = c.s / 2; // halved scale
    const a = c.layer === 0 ? 0.055 : 0.085;
    const x = c.x / 2;
    const y = c.y / 2;
    fillEllipse(x, y, 16 * s, 5 * s, C_CLOUD, a);
    fillEllipse(x + 10 * s, y + 2 * s, 10 * s, 4 * s, C_CLOUD, a);
    fillEllipse(x - 11 * s, y + 2 * s, 8 * s, 3.5 * s, C_CLOUD, a);
  }
  // pebbles scrolling on the ground
  for (const p of w.pebbles) {
    fillRect(p.x / 2, gy + p.o / 2, p.x / 2 + Math.max(1, p.s / 2), gy + p.o / 2 + Math.max(0.5, (p.s * 0.6) / 2), C_PEBBLE);
  }

  // obstacles — cacti (body + variant arms + light outline), birds (silhouette)
  for (const o of w.obstacles) {
    const x = o.x / 2;
    const y = o.top / 2;
    const ow = o.w / 2;
    const oh = o.h / 2;
    if (x + ow < 0 || x > W2) continue;
    if (o.type === "bird") {
      // body + head + wing (flap), approximating drawBird's silhouette
      fillEllipse(x + ow * 0.42, y + oh * 0.55, ow * 0.3, oh * 0.42, C_BIRD);
      fillEllipse(x + ow * 0.78, y + oh * 0.5, oh * 0.32, oh * 0.32, C_BIRD);
      const flapUp = Math.sin(w.t * 9 + o.flap) > 0;
      fillEllipse(
        x + ow * 0.42,
        flapUp ? y - 0.5 : y + oh * 0.85,
        ow * (flapUp ? 0.22 : 0.24),
        oh * (flapUp ? 0.55 : 0.4),
        C_BIRD_DARK,
      );
    } else {
      fillRect(x, y, x + ow, y + oh, C_CACTUS);
      if (o.variant === 2) {
        // cluster: second lobe
        fillRect(x + ow * 0.45, y + 2, x + ow, y + oh, mixRGB(C_CACTUS, [85, 112, 71], 0.5));
      } else if (o.variant === 1) {
        // tall cactus arms
        fillRect(x - 3, y + oh * 0.3, x, y + oh * 0.65, C_CACTUS);
        fillRect(x + ow - 0.5, y + oh * 0.2, x + ow + 3, y + oh * 0.6, C_CACTUS);
      }
      // light outline (#93b577, 1 px)
      for (let xx = Math.max(0, Math.round(x)); xx < Math.min(W2, Math.round(x + ow)); xx++) {
        setPx(xx, Math.max(0, Math.round(y)), C_CACTUS_HI);
        setPx(xx, Math.min(H2 - 1, Math.round(y + oh) - 1), C_CACTUS_HI);
      }
      for (let yy = Math.max(0, Math.round(y)); yy < Math.min(H2, Math.round(y + oh)); yy++) {
        setPx(Math.max(0, Math.round(x)), yy, C_CACTUS_HI);
        setPx(Math.min(W2 - 1, Math.round(x + ow) - 1), yy, C_CACTUS_HI);
      }
    }
  }
  return frame;
}

// ---------------------------------------------------------------------------
// 1) DINO — headless generation loop (step-for-step DinoTrainer.stepSim logic)
// ---------------------------------------------------------------------------
interface DinoRunner {
  brain: FlyBrain;
  fly: FlyAvatar;
  alive: boolean;
  deathScore: number;
  idx: number;
}

function makeDinoRunner(brain: FlyBrain, idx: number): DinoRunner {
  return { brain, fly: freshFly(), alive: true, deathScore: 0, idx };
}

/** one full 60 Hz generation; returns when all runners die or the cap hits */
function runDinoGeneration(
  world: World,
  runners: DinoRunner[],
  render: (w: World) => Uint8ClampedArray,
): number {
  for (;;) {
    const cleared = stepWorld(world, 1 / 60);

    for (const r of runners) {
      stepAvatarPhysics(r.fly, 1 / 60);
      r.fly.ducking = false; // re-decided by the brain every step
    }

    const input = retinaFromImageData(
      render(world),
      RETINA_W,
      RETINA_H,
      RETINA_COLS,
      RETINA_ROWS,
      false,
    );

    for (const r of runners) {
      if (!r.alive) continue;
      const delta = cleared.length > 0 ? REWARD_CLEAR : 0;
      const m = r.brain.step(input, delta);
      const f = r.fly;
      if (!f.airborne && f.jumpCooldownMs <= 0 && m[0] > JUMP_THRESHOLD) {
        f.vy = -JUMP_V;
        f.airborne = true;
        f.jumpCooldownMs = JUMP_COOLDOWN_MS;
      }
      if (m[1] > DUCK_THRESHOLD) f.ducking = true;
    }

    for (const r of runners) {
      if (!r.alive) continue;
      if (hitObstacle(world, r.fly)) {
        r.alive = false;
        r.deathScore = world.score;
        r.brain.step(input, -PUNISH_CRASH); // death shock (same tick, like the app)
      }
    }

    if (!runners.some((r) => r.alive) || world.t >= GEN_TIME_CAP_S) {
      return world.t;
    }
  }
}

/** reseed the patched global Math.random (fixed stream per restart) */
function setGlobalRandom(seed: number) {
  const rnd = mulberry32(seed);
  Math.random = () => rnd();
}

function trainDinoChampion(): {
  snapshot: BrainSnapshot;
  bestEver: number;
  bestGen: number;
  generations: number;
  simSeconds: number;
  probe: { scores: number[]; clears: number[]; median: number };
} {
  log(
    "dino",
    `training: popSize 6, mutStrength 0.3, ${DINO_RESTART_SEEDS.length} restarts × ≤${DINO_GENS_PER_RESTART} generations, sim budget ${DINO_SIM_BUDGET_S}s`,
  );
  const POP = 6;
  const MUT = 0.3;

  interface Candidate {
    brain: FlyBrain;
    bestEver: number;
    bestGen: number;
    generations: number;
    seed: number;
  }
  const candidates: Candidate[] = [];
  let simSeconds = 0;

  for (const restartSeed of DINO_RESTART_SEEDS) {
    if (simSeconds > DINO_SIM_BUDGET_S || wallSeconds() > DINO_WALL_BRAKE_S) {
      log("dino", `⚠ budget brake before restart 0x${restartSeed.toString(16)}`);
      break;
    }
    setGlobalRandom(restartSeed);
    let world = createWorld();
    world.birdPractice = false;
    let runners: DinoRunner[] = Array.from({ length: POP }, (_, i) =>
      makeDinoRunner(new FlyBrain({ ...DEFAULT_ARCH_DINO, seed: (Math.random() * 0x7fffffff) | 0 }), i),
    );
    let generation = 1;
    let bestEver = 0;
    let bestGen = 0;
    let bestBrain: FlyBrain | null = null;

    while (generation <= DINO_GENS_PER_RESTART) {
      const genLen = runDinoGeneration(world, runners, rasterizeWorld);
      simSeconds += genLen;

      // endGeneration (DinoTrainer semantics)
      for (const r of runners) {
        if (r.alive) r.deathScore = world.score; // timeout survivors
      }
      const scores = runners.map((r) => r.deathScore);
      const best = Math.max(...scores);
      let bi = 0;
      for (let i = 1; i < scores.length; i++) if (scores[i] > scores[bi]) bi = i;
      if (best > bestEver) {
        bestEver = best;
        bestGen = generation;
        bestBrain = runners[bi].brain.clone();
      }
      if (generation % 10 === 0) {
        log(
          "dino",
          `restart 0x${restartSeed.toString(16)} gen ${String(generation).padStart(2)}: best ${String(best).padStart(3)} · all-time ${bestEver}`,
        );
      }
      const brains = evolvePopulation(
        runners.map((r) => r.brain),
        scores,
        POP,
        MUT,
      );
      generation += 1;
      runners = brains.map((b, i) => makeDinoRunner(b, i));
      world = createWorld();
      world.birdPractice = false;
    }
    if (bestBrain) {
      candidates.push({ brain: bestBrain, bestEver, bestGen, generations: generation - 1, seed: restartSeed });
    }
  }

  if (candidates.length === 0) throw new Error("dino training produced no champion");

  // --- reliability probe: each champion in DINO_PROBE_WORLDS fresh worlds --
  // (full-fidelity raster, usual dopamine on a CLONE so the shipped weights
  // stay untouched — same conditions as the real trainer's "watch best")
  setGlobalRandom(SCRIPT_SEED ^ 0xabc123);
  const probed = candidates.map((c) => {
    const scores: number[] = [];
    const clears: number[] = [];
    for (let j = 0; j < DINO_PROBE_WORLDS; j++) {
      const w = createWorld();
      const r = makeDinoRunner(c.brain.clone(), 0);
      let cleared = 0;
      for (let i = 0; i < 60 * DINO_PROBE_SIM_S; i++) {
        const cl = stepWorld(w, 1 / 60);
        stepAvatarPhysics(r.fly, 1 / 60);
        r.fly.ducking = false;
        const input = retinaFromImageData(
          rasterizeWorld(w),
          RETINA_W,
          RETINA_H,
          RETINA_COLS,
          RETINA_ROWS,
          false,
        );
        const m = r.brain.step(input, cl.length > 0 ? REWARD_CLEAR : 0);
        if (!r.fly.airborne && r.fly.jumpCooldownMs <= 0 && m[0] > JUMP_THRESHOLD) {
          r.fly.vy = -JUMP_V;
          r.fly.airborne = true;
          r.fly.jumpCooldownMs = JUMP_COOLDOWN_MS;
        }
        if (m[1] > DUCK_THRESHOLD) r.fly.ducking = true;
        cleared += cl.length;
        if (hitObstacle(w, r.fly)) break;
      }
      scores.push(w.score);
      clears.push(cleared);
    }
    const sorted = [...scores].sort((a, b) => a - b);
    const median = sorted[Math.floor(sorted.length / 2)];
    log(
      "dino",
      `probe restart 0x${c.seed.toString(16)}: scores [${scores.join(", ")}] clears [${clears.join(", ")}] → median ${median}`,
    );
    return { c, scores, clears, median };
  });

  // selection: best median fresh-world score, tie-break total clears, then
  // the training best-ever score
  let pick = probed[0];
  for (const p of probed.slice(1)) {
    const clearsP = p.clears.reduce((a, b) => a + b, 0);
    const clearsK = pick.clears.reduce((a, b) => a + b, 0);
    if (
      p.median > pick.median ||
      (p.median === pick.median && clearsP > clearsK) ||
      (p.median === pick.median && clearsP === clearsK && p.c.bestEver > pick.c.bestEver)
    ) {
      pick = p;
    }
  }
  const { c: champ, scores: probeScores, clears: probeClears, median } = pick;
  log(
    "dino",
    `champion: restart 0x${champ.seed.toString(16)} gen ${champ.bestGen}, score ${champ.bestEver} pts · probe median ${median} (clears [${probeClears.join(", ")}]) · sim ${fmt(simSeconds)}s, wall ${fmt(wallSeconds())}s`,
  );

  const snap = champ.brain.toJSON("dino", "Dino Champion", champ.bestGen, champ.bestEver);
  snap.createdAt = SHIPPED_AT;
  snap.meta.note = `${champ.generations} generations of neuroevolution (best of ${candidates.length} seeded restarts) · headless trainer, simplified renderer`;
  return {
    snapshot: snap,
    bestEver: champ.bestEver,
    bestGen: champ.bestGen,
    generations: candidates.reduce((a, c) => a + c.generations, 0),
    simSeconds,
    probe: { scores: probeScores, clears: probeClears, median },
  };
}

// ---------------------------------------------------------------------------
// 2) BICYCLE — the real BicycleTrainerCore, driven headlessly
// ---------------------------------------------------------------------------
function trainBicycleChampion(): {
  snapshot: BrainSnapshot;
  bestEver: number;
  generations: number;
  simSeconds: number;
} {
  log("bike", `training via BicycleTrainerCore: popSize 5, mutStrength 0.3, ≤${BIKE_MAX_GENS} generations, sim budget ${BIKE_SIM_BUDGET_S}s`);
  setGlobalRandom(SCRIPT_SEED ^ 0xb1c1e);
  const core = new BicycleTrainerCore(5); // default popSize + standard preset
  core.setTurbo(600); // advance(1) → 600 ticks = 10 sim-seconds per call
  const bikeStart = wallSeconds();
  let simSeconds = 0;
  let lastGen = 1;
  while (core.generation <= BIKE_MAX_GENS && simSeconds < BIKE_SIM_BUDGET_S) {
    if (wallSeconds() - bikeStart > BIKE_WALL_BRAKE_S) {
      log("bike", `⚠ wall-clock brake at gen ${core.generation} (deterministic caps not reached)`);
      break;
    }
    core.advance(1);
    simSeconds += 10;
    if (core.generation !== lastGen) {
      lastGen = core.generation;
      if (core.generation % 50 === 0 || core.generation <= 5) {
        const h = core.history[core.history.length - 1];
        log(
          "bike",
          `gen ${core.generation}: best ${fmt(h?.best ?? 0)} m avg ${fmt(h?.avg ?? 0)} m · all-time ${fmt(core.bestEverDistance)} m · sim ${simSeconds}s wall ${fmt(wallSeconds())}s`,
        );
      }
    }
  }
  if (!core.bestBrain) throw new Error("bicycle training produced no champion");
  log(
    "bike",
    `champion: gen ${core.generation}, best ${fmt(core.bestEverDistance)} m, sim ${simSeconds}s, wall ${fmt(wallSeconds())}s`,
  );

  const snap = core.bestBrain.toJSON(
    "bicycle",
    "Dusk Rider",
    core.generation,
    Math.round(core.bestEverDistance * 10) / 10,
  );
  snap.createdAt = SHIPPED_AT;
  snap.meta.note = `${core.generation} generations of dusk-road balancing · trained headlessly through the real BicycleTrainerCore`;
  return { snapshot: snap, bestEver: core.bestEverDistance, generations: core.generation, simSeconds };
}

// ---------------------------------------------------------------------------
// 3) LAB — the BrainLab conditioning wizard, replicated tick-for-tick
// ---------------------------------------------------------------------------
const LAB_TRIALS = 24;
const LAB_STIM_S = 3.0;
const LAB_PAUSE_S = 0.5;
const LAB_REWARD_AT_S = 1.5;
const LAB_SAMPLE_FROM_S = 2.0;
const LAB_TICK = 1 / 30; // BrainLab TICK_RATE = 30

function labInput(
  input: Float32Array,
  letter: "A" | "B" | "dark",
): void {
  const COLS = DEFAULT_ARCH_LAB.retinaCols; // 24
  const ROWS = DEFAULT_ARCH_LAB.retinaRows; // 9
  input.fill(0);
  if (letter === "dark") return;
  const third = Math.max(1, Math.round(COLS / 3)); // 8 columns
  const cx = letter === "A" ? 0 : COLS - third;
  for (let c = cx; c < cx + third; c++) {
    if (c < 0 || c >= COLS) continue;
    for (let r = 0; r < ROWS; r++) input[r * COLS + c] = 1;
  }
}

function trainLabBrain(): {
  snapshot: BrainSnapshot;
  dA: number;
  dB: number;
  aIndex: number;
  bIndex: number;
  aMotors: number[];
  bMotors: number[];
} {
  log("lab", "conditioning: 24 trials, A = bar-left + sugar, B = bar-right + shock");
  const brain = new FlyBrain(DEFAULT_ARCH_LAB);
  const COLS = DEFAULT_ARCH_LAB.retinaCols;
  const ROWS = DEFAULT_ARCH_LAB.retinaRows;
  const input = new Float32Array(COLS * ROWS);
  let pendingDa = 0;
  let trial = 0;
  let t = 0;
  let delivered = false;

  // per-trial measurement (same windows as the wizard's demoPost)
  const points: { trial: number; letter: "A" | "B"; index: number }[] = [];
  let apprSum = 0;
  let n = 0;

  // the wizard's exact tick order: demoPre → computeInput → brain.step → demoPost
  for (;;) {
    // demoPre
    t += LAB_TICK;
    const letter: "A" | "B" = trial % 2 === 0 ? "A" : "B";
    if (!delivered && t >= LAB_REWARD_AT_S && t < LAB_STIM_S) {
      delivered = true;
      pendingDa = letter === "A" ? 1 : -1;
    }
    if (t >= LAB_STIM_S + LAB_PAUSE_S) {
      points.push({ trial: trial + 1, letter, index: apprSum / Math.max(1, n) });
      trial += 1;
      t = 0;
      delivered = false;
      apprSum = 0;
      n = 0;
      if (trial >= LAB_TRIALS) break; // finishDemo — stop before the stray post-demo tick
    }
    // computeInput
    labInput(input, t < LAB_STIM_S ? letter : "dark");
    // tick
    const da = pendingDa;
    pendingDa = 0;
    brain.step(input, da);
    // demoPost — sample the final 1 s of the stimulus
    if (t >= LAB_SAMPLE_FROM_S && t < LAB_STIM_S) {
      let ms = 0;
      for (let i = 0; i < brain.motorRates.length; i++) ms += brain.motorRates[i];
      apprSum += ms / brain.motorRates.length;
      n++;
    }
  }

  const meanIdx = (xs: { index: number }[]) =>
    xs.length ? xs.reduce((a, p) => a + p.index, 0) / xs.length : 0;
  const aPts = points.filter((p) => p.letter === "A");
  const bPts = points.filter((p) => p.letter === "B");
  const dA = meanIdx(aPts.slice(-4)) - meanIdx(aPts.slice(0, 4));
  const dB = meanIdx(bPts.slice(-4)) - meanIdx(bPts.slice(0, 4));
  log("lab", `learning index: A trials ${meanIdx(aPts.slice(0, 4)).toFixed(3)} → ${meanIdx(aPts.slice(-4)).toFixed(3)} (Δ ${fmt(dA, 3)}), B trials ${meanIdx(bPts.slice(0, 4)).toFixed(3)} → ${meanIdx(bPts.slice(-4)).toFixed(3)} (Δ ${fmt(dB, 3)})`);

  // --- verification probe: present A and B cold (no dopamine) -------------
  const probe = (letter: "A" | "B") => {
    labInput(input, "dark");
    for (let i = 0; i < Math.round(LAB_PAUSE_S / LAB_TICK); i++) brain.step(input, 0);
    const motors = new Array(brain.motorRates.length).fill(0);
    let cnt = 0;
    for (let i = 0; i < Math.round(LAB_STIM_S / LAB_TICK); i++) {
      labInput(input, letter);
      brain.step(input, 0);
      if (i + 1 >= Math.round((LAB_STIM_S - 1) / LAB_TICK)) {
        // final 1 s window
        for (let m = 0; m < brain.motorRates.length; m++) motors[m] += brain.motorRates[m];
        cnt++;
      }
    }
    return { motors: motors.map((x) => x / Math.max(1, cnt)), index: motors.reduce((a, b) => a + b, 0) / Math.max(1, cnt) / brain.motorRates.length };
  };
  const a = probe("A");
  const b = probe("B");
  log("lab", `verification — A motor rates: [${a.motors.map((x) => x.toFixed(3)).join(", ")}] (index ${fmt(a.index, 3)})`);
  log("lab", `verification — B motor rates: [${b.motors.map((x) => x.toFixed(3)).join(", ")}] (index ${fmt(b.index, 3)})`);
  const gap = a.index - b.index;
  log("lab", `A − B approach gap: ${fmt(gap, 3)}`);

  // gate: the conditioning must have landed
  if (!(gap > 0.015) || !(dA > 0) || !(dB < dA)) {
    throw new Error(
      `lab conditioning failed to land (gap ${fmt(gap, 3)}, dA ${fmt(dA, 3)}, dB ${fmt(dB, 3)}) — refuse to ship a non-learning snapshot`,
    );
  }

  const score = Math.round(gap * 100 * 10) / 10; // "conditioning index" (0..~50)
  const snap = brain.toJSON("lab", "Conditioned Lab Fly", 0, score);
  snap.createdAt = SHIPPED_AT;
  snap.meta.note = `24-trial classical conditioning (bar-left+sugar vs bar-right+shock) · approach gap ${fmt(gap, 2)}`;
  return { snapshot: snap, dA, dB, aIndex: a.index, bIndex: b.index, aMotors: a.motors, bMotors: b.motors };
}

// ---------------------------------------------------------------------------
// serialize + write
// ---------------------------------------------------------------------------
function shrinkSnapshot(snap: BrainSnapshot): BrainSnapshot {
  // kenyonToMbon is the payload (~2880 numbers); 4 decimals is plenty — the
  // engine stores Float32 and its own toJSON rounds to 5.
  snap.weights.kenyonToMbon = snap.weights.kenyonToMbon.map((x) => Math.round(x * 1e4) / 1e4);
  return snap;
}

async function main() {
  console.log("=== Expert Fruit Fly — demo brain generator ===");
  console.log(`seed 0x${SCRIPT_SEED.toString(16)} · shipped-at ${SHIPPED_AT}`);

  const dino = trainDinoChampion();
  const bike = trainBicycleChampion();
  const lab = trainLabBrain();

  const payload = {
    v: 1,
    generator: "scripts/gen-demo-brains.ts",
    seed: SCRIPT_SEED,
    createdAt: SHIPPED_AT,
    brains: [
      {
        id: "demo-dino-champion",
        name: "Dino Champion",
        task: "dino",
        generation: dino.bestGen,
        score: dino.bestEver,
        note: "Neuroevolution champion — dodges cacti, ducks pterodactyls. Trained headlessly on a simplified renderer.",
        builtIn: true,
        snapshot: shrinkSnapshot(dino.snapshot),
      },
      {
        id: "demo-dusk-rider",
        name: "Dusk Rider",
        task: "bicycle",
        generation: bike.generations,
        score: Math.round(bike.bestEver * 10) / 10,
        note: "Dusk-road balance champion — steers by the glowing centreline and marker posts.",
        builtIn: true,
        snapshot: shrinkSnapshot(bike.snapshot),
      },
      {
        id: "demo-lab-conditioned",
        name: "Conditioned Lab Fly",
        task: "lab",
        generation: 0,
        score: Math.round((lab.aIndex - lab.bIndex) * 100 * 10) / 10,
        note: "Classical conditioning — approaches the sugar-paired bar, avoids the shock-paired one.",
        builtIn: true,
        snapshot: shrinkSnapshot(lab.snapshot),
      },
    ],
  };

  const json = JSON.stringify(payload);
  await mkdir("src/lib/generated", { recursive: true });
  await Bun.write("src/lib/generated/demo-brains.json", json);

  const bytes = new TextEncoder().encode(json).byteLength;
  console.log("");
  console.log("=== summary ===");
  console.log(`dino : gen ${dino.bestGen}, score ${dino.bestEver} pts (${dino.generations} generations, ${fmt(dino.simSeconds)}s sim)`);
  console.log(`bike : gen ${bike.generations}, score ${fmt(bike.bestEver)} m (${fmt(bike.simSeconds)}s sim)`);
  console.log(`lab  : A index ${fmt(lab.aIndex, 3)} vs B index ${fmt(lab.bIndex, 3)} (gap ${fmt(lab.aIndex - lab.bIndex, 3)}, dA ${fmt(lab.dA, 3)}, dB ${fmt(lab.dB, 3)})`);
  console.log(`wrote src/lib/generated/demo-brains.json — ${(bytes / 1024).toFixed(1)} KB`);
  console.log(`total wall time ${fmt(wallSeconds())}s`);
}

main().catch((err) => {
  console.error("GENERATOR FAILED:", err);
  process.exit(1);
});
