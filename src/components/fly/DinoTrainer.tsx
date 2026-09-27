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
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { FlyBrain, retinaFromImageData } from "@/lib/flybrain/engine";
import { DEFAULT_ARCH_DINO } from "@/lib/flybrain/types";
import type { BrainSnapshot } from "@/lib/flybrain/types";
import { useBrainStore } from "@/lib/flybrain/store";
import { BrainActivityPanel } from "./BrainActivityPanel";
import { evolvePopulation } from "./dino/evolution";
import {
  BASE_SPEED,
  DUCK_THRESHOLD,
  FLY_X,
  GAME_H,
  GAME_W,
  GEN_TIME_CAP_S,
  GRAVITY,
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
  collides,
  createWorld,
  drawFly,
  drawWorld,
  freshFly,
  stepWorld,
} from "./dino/game";
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
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Separator } from "@/components/ui/separator";
import { Slider } from "@/components/ui/slider";
import { Switch } from "@/components/ui/switch";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import {
  Activity,
  Eye,
  Gamepad2,
  History,
  Loader2,
  Pause,
  Play,
  RotateCcw,
  Save,
  Sparkles,
  Trophy,
  Users,
  X,
  Zap,
} from "lucide-react";
import {
  CartesianGrid,
  Legend,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";

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
}

interface Sim {
  world: ReturnType<typeof createWorld>;
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
}

interface Art {
  game: HTMLCanvasElement;
  gameCtx: CanvasRenderingContext2D;
  retina: HTMLCanvasElement;
  retinaCtx: CanvasRenderingContext2D;
}

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
  return { brain, fly: freshFly(), alive: true, deathScore: 0, idx };
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
  for (const r of sim.runners) if (r.alive) r.deathScore = sim.world.score;
  const scores = sim.runners.map((r) => r.deathScore);
  const best = Math.max(...scores);
  const avg = scores.reduce((a, b) => a + b, 0) / Math.max(1, scores.length);
  sim.history.push({ gen: sim.generation, best, avg });

  let bi = 0;
  for (let i = 1; i < scores.length; i++) if (scores[i] > scores[bi]) bi = i;
  if (best > sim.bestEver) {
    sim.bestEver = best;
    sim.bestGen = sim.generation;
    sim.bestBrain = sim.runners[bi].brain.clone();
  }
  pushEvent(
    sim,
    `Generation ${sim.generation} ended — best ${best}, avg ${avg.toFixed(1)}`,
    0,
    "info",
    sim.world.t
  );
  autosave(sim);

  const brains = evolvePopulation(
    sim.runners.map((r) => r.brain),
    scores,
    popSize,
    mutStrength
  );
  sim.generation += 1;
  sim.runners = brains.map((b, i) => makeRunner(b, i));
  sim.world = createWorld();
}

/** One 60Hz simulation step: world → vision → brains → action → collisions. */
function stepSim(
  sim: Sim,
  art: Art,
  dt: number,
  popSize: number,
  mutStrength: number
): void {
  const w = sim.world;
  const cleared = stepWorld(w, dt);

  // fly avatar physics
  for (const r of sim.runners) {
    const f = r.fly;
    f.wingPhase += dt * 36;
    if (f.jumpCooldownMs > 0) {
      f.jumpCooldownMs = Math.max(0, f.jumpCooldownMs - dt * 1000);
    }
    if (f.airborne) {
      // duck input while airborne = fast fall, like the real game
      f.vy += GRAVITY * (f.ducking ? 2.6 : 1) * dt;
      f.y += f.vy * dt;
      if (f.y >= GROUND_Y) {
        f.y = GROUND_Y;
        f.vy = 0;
        f.airborne = false;
      }
    }
    f.ducking = false; // re-decided by the brain every step
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
  if (cleared.length > 0) {
    pushEvent(sim, "Obstacle cleared", REWARD_CLEAR, "reward", w.t);
  }

  // collisions → death shock
  for (const r of sim.runners) {
    if (!r.alive) continue;
    if (collides(w, r.fly)) {
      r.alive = false;
      r.deathScore = w.score;
      r.brain.step(input, -PUNISH_CRASH);
      pushEvent(sim, `Fly #${r.idx + 1} crashed`, -PUNISH_CRASH, "punish", w.t);
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
        sim.world = createWorld();
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
// Component
// ---------------------------------------------------------------------------
export function DinoTrainer() {
  // --- UI state -------------------------------------------------------------
  const [running, setRunning] = useState(false);
  const [turbo, setTurbo] = useState(1);
  const [popSize, setPopSize] = useState(6);
  const [mutStrength, setMutStrength] = useState(0.3);
  const [watchBest, setWatchBest] = useState(false);
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
  });
  const [feed, setFeed] = useState<FeedEvent[]>([]);
  const [history, setHistory] = useState<GenStat[]>([]);
  const [panelBrain, setPanelBrain] = useState<FlyBrain | null>(null);
  const [hasBest, setHasBest] = useState(false);
  const [resume, setResume] = useState<{
    gen: number;
    best: number;
    snap: BrainSnapshot;
    history: GenStat[];
  } | null>(null);

  // --- refs (read inside the rAF loop without restarting it) ----------------
  const runningRef = useRef(running);
  const turboRef = useRef(turbo);
  const popSizeRef = useRef(popSize);
  const mutStrengthRef = useRef(mutStrength);
  const adoptedRef = useRef(false);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const simRef = useRef<Sim | null>(null);
  const artRef = useRef<Art | null>(null);

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
    setHud({
      gen: s.generation,
      alive: s.runners.filter((r) => r.alive).length,
      total: s.runners.length,
      score: s.world.score,
      best: s.bestEver,
      speed: s.world.speed,
      watch: s.watchMode,
    });
    setFeed(s.events.slice(-8).reverse());
    setHistory(s.history.slice());
    setHasBest(Boolean(s.bestBrain));
    setPanelBrain((prev) => {
      const next = s.watchMode
        ? (s.runners[0]?.brain ?? null)
        : bestAliveBrain(s);
      return next === prev ? prev : next;
    });
  }, []);

  // --- mount: build the sim + the animation loop ----------------------------
  useEffect(() => {
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
    };
    simRef.current = sim;
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
      if (runningRef.current) {
        acc += dt * turboRef.current;
        let n = 0;
        while (acc >= STEP_DT && n < MAX_STEPS_PER_FRAME) {
          stepSim(s, art, STEP_DT, popSizeRef.current, mutStrengthRef.current);
          acc -= STEP_DT;
          n += 1;
        }
        if (acc > 0.2) acc = 0.2; // never spiral after a long stall
      }
      const canvas = canvasRef.current;
      if (canvas) renderVisible(canvas, art.game, s, ts / 1000);
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

  // --- adopt a snapshot (library load / session resume) ---------------------
  const adoptSnapshot = useCallback(
    (snap: BrainSnapshot, restoreHistory?: GenStat[]) => {
      adoptedRef.current = true;
      setResume(null);
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
      const n = popSizeRef.current;
      s.runners = Array.from({ length: n }, (_, i) => makeRunner(base.clone(), i));
      s.world = createWorld();
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
    if (snap) adoptSnapshot(snap);
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
  const toggleWatchMode = (on: boolean) => {
    const s = simRef.current;
    if (!s) return;
    if (on) {
      if (!s.bestBrain) {
        toast.error("No best brain yet — let at least one generation finish.");
        setWatchBest(false);
        return;
      }
      s.savedRunners = s.runners;
      s.watchMode = true;
      s.watchCooldown = null;
      s.runners = [makeRunner(s.bestBrain.clone(), 0)];
      s.world = createWorld();
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
        }));
      }
      s.savedRunners = null;
      s.world = createWorld();
    }
    flush(s);
  };

  const resetPopulation = () => {
    const s = simRef.current;
    if (!s) return;
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
    const n = popSizeRef.current;
    s.runners = Array.from({ length: n }, (_, i) =>
      makeRunner(
        new FlyBrain({ ...DEFAULT_ARCH_DINO, seed: (Math.random() * 0x7fffffff) | 0 }),
        i
      )
    );
    s.world = createWorld();
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
          snapshot: s.bestBrain.toJSON("dino", name, s.bestGen, s.bestEver),
        }),
      });
      if (!res.ok) {
        throw new Error(`HTTP ${res.status}`);
      }
      toast.success(`Saved "${name}" to the brain library`);
      setBrainName("");
    } catch (err) {
      toast.error(`Save failed: ${err instanceof Error ? err.message : "unknown error"}`);
    } finally {
      setSaving(false);
    }
  };

  const lastGenAvg = history.length > 0 ? history[history.length - 1].avg : null;

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
            onClick={() => adoptSnapshot(resume.snap, resume.history)}
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
                  aria-label="Dino runner game view — population of flies"
                  role="img"
                />

                {/* HUD overlay */}
                <div className="pointer-events-none absolute inset-0 flex flex-col justify-between p-2.5 sm:p-3">
                  <div className="flex items-start justify-between gap-2">
                    <div className="flex flex-wrap items-center gap-1.5">
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
                    </div>
                    <div className="text-right leading-none">
                      <div className="font-mono text-lg font-bold tabular-nums text-amber-200 [text-shadow:0_0_12px_rgba(245,158,11,0.35)] sm:text-2xl">
                        {String(hud.score).padStart(5, "0")}
                      </div>
                      <div className="mt-1 font-mono text-[10px] tabular-nums text-muted-foreground sm:text-xs">
                        HI {String(Math.max(hud.best, hud.score)).padStart(5, "0")}
                      </div>
                    </div>
                  </div>
                  <div className="flex items-center justify-between">
                    <Badge className="border-border/60 bg-black/50 font-mono text-[10px] tabular-nums backdrop-blur-sm">
                      SPD {(hud.speed / BASE_SPEED).toFixed(1)}×
                    </Badge>
                    <span className="font-mono text-[9px] text-muted-foreground/80 sm:text-[10px]">
                      retina 24×9 · {hud.total} brains
                    </span>
                  </div>
                </div>

                {/* start overlay */}
                {!running && (
                  <button
                    type="button"
                    onClick={() => setRunning(true)}
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
              </div>
            </CardContent>
          </Card>

          {/* turbo */}
          <div className="flex flex-wrap items-center justify-between gap-3">
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
            <p className="text-xs text-muted-foreground">
              Turbo runs extra simulation steps per rendered frame.
            </p>
          </div>
        </div>

        {/* --- right: instruments --- */}
        <div className="w-full shrink-0 space-y-4 lg:w-96">
          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="flex items-center gap-2 text-sm">
                <Sparkles className="h-4 w-4 text-amber-400" aria-hidden />
                Best alive fly — live brain
              </CardTitle>
              <CardDescription className="text-xs">
                Retina → optic lobe → mushroom body → motor of the current leader.
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
                  onClick={() => setRunning((r) => !r)}
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
                <p className="text-[11px] text-muted-foreground">
                  Saves the best-ever brain to the library (POST /api/brains).
                </p>
              </div>
            </CardContent>
          </Card>
        </div>
      </div>

      {/* --- score history chart --- */}
      <Card className="mt-4">
        <CardHeader className="pb-2">
          <CardTitle className="flex items-center gap-2 text-sm">
            <History className="h-4 w-4 text-emerald-400" aria-hidden />
            Score by generation
          </CardTitle>
          <CardDescription className="text-xs">
            Best (emerald) and population average (amber) per generation — watch evolution
            climb.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {history.length === 0 ? (
            <div className="flex h-[200px] items-center justify-center rounded-lg border border-dashed border-border text-xs text-muted-foreground">
              No generations finished yet — scores will appear here.
            </div>
          ) : (
            <div className="h-[200px] w-full">
              <ResponsiveContainer width="100%" height="100%">
                <LineChart data={history} margin={{ top: 8, right: 12, bottom: 0, left: -14 }}>
                  <CartesianGrid stroke="rgba(255,255,255,0.06)" vertical={false} />
                  <XAxis
                    dataKey="gen"
                    tick={{ fontSize: 10, fill: "#a8a29e" }}
                    stroke="rgba(255,255,255,0.15)"
                    tickLine={false}
                  />
                  <YAxis
                    tick={{ fontSize: 10, fill: "#a8a29e" }}
                    stroke="rgba(255,255,255,0.15)"
                    tickLine={false}
                    width={40}
                  />
                  <Tooltip
                    contentStyle={{
                      background: "#1c1917",
                      border: "1px solid rgba(255,255,255,0.12)",
                      borderRadius: 8,
                      fontSize: 12,
                      color: "#e7e5e4",
                    }}
                    labelStyle={{ color: "#a8a29e" }}
                    itemStyle={{ color: "#e7e5e4" }}
                    cursor={{ stroke: "rgba(255,255,255,0.15)" }}
                  />
                  <Legend wrapperStyle={{ fontSize: 11 }} />
                  <Line
                    type="monotone"
                    dataKey="best"
                    name="Best"
                    stroke="#10b981"
                    strokeWidth={2}
                    dot={false}
                    isAnimationActive={false}
                  />
                  <Line
                    type="monotone"
                    dataKey="avg"
                    name="Average"
                    stroke="#f59e0b"
                    strokeWidth={2}
                    strokeDasharray="4 3"
                    dot={false}
                    isAnimationActive={false}
                  />
                </LineChart>
              </ResponsiveContainer>
            </div>
          )}
        </CardContent>
      </Card>
    </section>
  );
}
