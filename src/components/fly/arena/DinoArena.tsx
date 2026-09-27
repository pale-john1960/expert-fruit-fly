"use client";

/**
 * DinoArena — head-to-head race where 2–4 SAVED brains run the SAME dino
 * world simultaneously (6th tab, lime accent, hotkey "6").
 *
 * Racer sources: (a) library brains (/api/brains?task=dino → metadata;
 * snapshots fetched per-brain at Start), (b) built-in demo brains
 * (DEMO_BRAINS — possibly empty until they land), (c) an always-available
 * "Newborn fly" pseudo-racer grown locally from seed 7.
 *
 * rAF lifecycle: the component only mounts when its tab is active (Radix
 * unmounts inactive panels) — the loop + every listener are cleaned up on
 * unmount, and an in-flight race is preserved in a module-level singleton so
 * switching tabs mid-race and coming back restores it PAUSED (no leaked
 * rAF, no dead listeners, StrictMode double-mount safe).
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import { toast } from "sonner";
import {
  ArenaRace,
  ARENA_MAX_RACERS,
  ARENA_MIN_RACERS,
  ARENA_TIME_CAP_S,
  LANE_COLORS,
  MAX_STEPS_PER_FRAME,
  STEP_DT,
  laneColor,
  rankRacers,
  type ArenaHud,
  type RacerLive,
  type RacerSource,
  type RacerSpec,
} from "./arena-sim";
import { GAME_H, GAME_W, BASE_SPEED, type DeathCause } from "@/components/fly/dino/game";
import { DEMO_BRAINS } from "@/lib/demo-brains";
import { FlyBrain } from "@/lib/flybrain/engine";
import { DEFAULT_ARCH_DINO, type BrainSnapshot } from "@/lib/flybrain/types";
import { hydrateSoundMuted, playSound } from "@/lib/sound";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import {
  AlertTriangle,
  Bird,
  DoorOpen,
  Flag,
  Gamepad2,
  Loader2,
  Medal,
  Pause,
  Play,
  RotateCcw,
  Sparkles,
  Sprout,
  Swords,
  Trophy,
  Users,
} from "lucide-react";

// ---------------------------------------------------------------------------
// Module-level live race — survives Radix tab unmounts + HMR remounts
// (same pattern as DinoTrainer's module-level duel sim). Cleared when the
// user leaves the podium or starts over.
// ---------------------------------------------------------------------------

type Phase = "idle" | "countdown" | "racing" | "paused" | "finished";

interface LiveRace {
  specs: RacerSpec[];
  race: ArenaRace;
  learning: boolean;
  phase: Phase;
}

let liveRace: LiveRace | null = null;

const NEWBORN_KEY = "newborn";
const NEWBORN_NAME = "Newborn fly";
const NEWBORN_SEED = 7;

/** Deterministic untrained dino fly (seed 7) — the same trick the genome
 *  diff's "progress vs newborn" view uses: toJSON → fromJSON normalizes the
 *  pseudo-racer into a snapshot shaped exactly like a saved library brain. */
function newbornSnapshot(): BrainSnapshot {
  return new FlyBrain({ ...DEFAULT_ARCH_DINO, seed: NEWBORN_SEED }).toJSON(
    "dino",
    NEWBORN_NAME,
    0,
    0,
  );
}

// ---------------------------------------------------------------------------
// Picker rows
// ---------------------------------------------------------------------------

interface LibBrainRow {
  id: string;
  name: string;
  generation: number;
  score: number;
  note: string | null;
}

interface PickRow {
  key: string;
  name: string;
  generation: number;
  score: number;
  source: RacerSource;
  note: string | null;
}

const SOURCE_BADGE: Record<RacerSource, { label: string; className: string }> =
  {
    library: {
      label: "library",
      className:
        "border-teal-500/30 bg-teal-500/10 text-teal-700 dark:text-teal-300",
    },
    builtin: {
      label: "built-in",
      className:
        "border-lime-500/30 bg-lime-500/10 text-lime-700 dark:text-lime-300",
    },
    newborn: {
      label: "newborn",
      className: "border-border/60 bg-muted/60 text-muted-foreground",
    },
  };

const COUNTDOWN_BEAT_MS = 600;

function ordinal(n: number): string {
  return n === 1 ? "1st" : n === 2 ? "2nd" : n === 3 ? "3rd" : `${n}th`;
}

function deathChip(r: {
  survived: boolean;
  deathCause: DeathCause | null;
}): {
  label: string;
  className: string;
} {
  if (!r.survived) {
    return {
      label: r.deathCause === "bird" ? "✕ bird" : "✕ cactus",
      className:
        "border-rose-500/40 bg-rose-500/10 text-rose-700 dark:text-rose-300",
    };
  }
  if (r.deathCause === "timeout") {
    return {
      label: "survived",
      className:
        "border-teal-500/40 bg-teal-500/10 text-teal-700 dark:text-teal-300",
    };
  }
  return {
    label: "racing",
    className:
      "border-emerald-500/40 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300",
  };
}

/** Jump to the Dino Training room using the app's public hotkey contract
 *  (window keydown "2") — zero page.tsx edits, same trick as the playground
 *  → lab deep link. */
function gotoDinoTraining(): void {
  playSound("click");
  window.dispatchEvent(
    new KeyboardEvent("keydown", { key: "2", bubbles: true }),
  );
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function DinoArena() {
  const reduceMotion = useReducedMotion();

  // --- picker state ---------------------------------------------------------
  const [libRows, setLibRows] = useState<LibBrainRow[] | null>(null); // null = loading
  const [libFailed, setLibFailed] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);
  const [selected, setSelected] = useState<string[]>([]); // keys in pick order
  const [starting, setStarting] = useState(false);
  const [startError, setStartError] = useState<string | null>(null);

  // --- race state -----------------------------------------------------------
  const [race, setRace] = useState<ArenaRace | null>(null);
  const [specs, setSpecs] = useState<RacerSpec[] | null>(null);
  const [phase, setPhase] = useState<Phase>("idle");
  const [countdown, setCountdown] = useState(3); // 3 → 2 → 1 → 0 ("GO!")
  const [hud, setHud] = useState<ArenaHud | null>(null);
  const [learning, setLearning] = useState(false);

  const phaseRef = useRef<Phase>("idle");
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  /** Set the phase everywhere at once: ref (rAF reads it without waiting a
   *  render), React state, and the module-level singleton. */
  const applyPhase = useCallback((p: Phase) => {
    phaseRef.current = p;
    setPhase(p);
    if (liveRace) liveRace.phase = p;
  }, []);

  // --- mount: hydrate sound + restore an in-flight race ---------------------
  // (deferred via queueMicrotask — react-hooks/set-state-in-effect is
  //  error-level in this repo)
  useEffect(() => {
    hydrateSoundMuted();
    const saved = liveRace;
    if (saved) {
      queueMicrotask(() => {
        setSpecs(saved.specs);
        setRace(saved.race);
        setLearning(saved.learning);
        setHud(saved.race.hud());
        // a countdown can't resume mid-beat — restore as paused instead
        applyPhase(saved.phase === "countdown" ? "paused" : saved.phase);
      });
    }
  }, [applyPhase]);

  // --- library list (metadata only; snapshots load at Start) ----------------
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch("/api/brains?task=dino");
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = (await res.json()) as { brains?: LibBrainRow[] };
        if (cancelled) return;
        setLibRows(data.brains ?? []);
        setLibFailed(false);
      } catch {
        if (cancelled) return;
        setLibRows([]);
        setLibFailed(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [reloadKey]);

  const demoDinoRows = useMemo(
    () => DEMO_BRAINS.filter((d) => d.task === "dino"),
    [],
  );

  const pickerRows = useMemo<PickRow[]>(() => {
    const lib = (libRows ?? []).map((b) => ({
      key: `lib:${b.id}`,
      name: b.name,
      generation: b.generation,
      score: b.score,
      source: "library" as const,
      note: b.note,
    }));
    const demo = demoDinoRows.map((d) => ({
      key: `demo:${d.id}`,
      name: d.name,
      generation: d.generation,
      score: d.score,
      source: "builtin" as const,
      note: d.note,
    }));
    const newborn: PickRow = {
      key: NEWBORN_KEY,
      name: NEWBORN_NAME,
      generation: 0,
      score: 0,
      source: "newborn",
      note: "untrained connectome — seeded baseline",
    };
    return [...lib, ...demo, newborn];
  }, [libRows, demoDinoRows]);

  /** Only the newborn exists → min 2 racers impossible → empty state. */
  const isEmpty =
    libRows !== null && !libFailed && libRows.length === 0 && demoDinoRows.length === 0;

  // --- selection ------------------------------------------------------------
  const toggleRacer = useCallback(
    (key: string) => {
      setSelected((prev) => {
        if (prev.includes(key)) return prev.filter((k) => k !== key);
        if (prev.length >= ARENA_MAX_RACERS) return prev;
        return [...prev, key];
      });
    },
    [],
  );

  const onPickerRowClick = useCallback(
    (key: string) => {
      const picking = !selected.includes(key);
      if (picking && selected.length >= ARENA_MAX_RACERS) {
        toast.info(
          `Arena races field at most ${ARENA_MAX_RACERS} flies — uncheck one first`,
        );
        return;
      }
      playSound("click");
      toggleRacer(key);
    },
    [selected, toggleRacer],
  );

  // --- learning toggle (usable before AND during a race) --------------------
  const onLearningChange = useCallback(
    (v: boolean) => {
      setLearning(v);
      playSound("click");
      if (race) race.learning = v;
      if (liveRace) liveRace.learning = v;
    },
    [race],
  );

  // --- start / again / quit -------------------------------------------------
  const startRace = useCallback(async () => {
    if (selected.length < ARENA_MIN_RACERS || starting) return;
    setStarting(true);
    setStartError(null);
    try {
      const nextSpecs: RacerSpec[] = [];
      for (let lane = 0; lane < selected.length; lane++) {
        const key = selected[lane];
        if (key === NEWBORN_KEY) {
          nextSpecs.push({
            key,
            name: NEWBORN_NAME,
            snapshot: newbornSnapshot(),
            source: "newborn",
            lane,
          });
        } else if (key.startsWith("demo:")) {
          const demo = demoDinoRows.find((d) => `demo:${d.id}` === key);
          if (!demo) throw new Error("That built-in racer is no longer available");
          nextSpecs.push({
            key,
            name: demo.name,
            snapshot: demo.snapshot,
            source: "builtin",
            lane,
          });
        } else {
          const id = key.slice("lib:".length);
          const res = await fetch(`/api/brains/${id}`);
          if (!res.ok) {
            throw new Error(`Could not load racer ${lane + 1} (HTTP ${res.status})`);
          }
          const data = (await res.json()) as {
            brain?: { name?: string };
            snapshot?: BrainSnapshot;
          };
          const snap = data.snapshot;
          if (!snap?.arch || snap.arch.motorCount < 2) {
            throw new Error(
              `"${data.brain?.name ?? key}" is not compatible with the Dino task`,
            );
          }
          nextSpecs.push({
            key,
            name: data.brain?.name ?? snap.name ?? `Brain ${id}`,
            snapshot: snap,
            source: "library",
            lane,
          });
        }
      }
      const nextRace = new ArenaRace(nextSpecs, learning);
      liveRace = { specs: nextSpecs, race: nextRace, learning, phase: "countdown" };
      setSpecs(nextSpecs);
      setRace(nextRace);
      setCountdown(3);
      applyPhase("countdown");
      setHud(nextRace.hud());
      playSound("click");
    } catch (err) {
      setStartError(
        err instanceof Error ? err.message : "Failed to load the racers",
      );
      toast.error("Could not start the race — see the picker for details");
    } finally {
      setStarting(false);
    }
  }, [selected, starting, learning, demoDinoRows, applyPhase]);

  /** Same racers, brains RELOADED fresh from their snapshots — nothing
   *  learned in the previous race carries over. */
  const raceAgain = useCallback(() => {
    if (!specs) return;
    const nextRace = new ArenaRace(specs, learning);
    liveRace = { specs, race: nextRace, learning, phase: "countdown" };
    setRace(nextRace);
    setCountdown(3);
    applyPhase("countdown");
    setHud(nextRace.hud());
    playSound("click");
  }, [specs, learning, applyPhase]);

  const newRace = useCallback(() => {
    liveRace = null;
    setRace(null);
    setSpecs(null);
    setHud(null);
    setStartError(null);
    applyPhase("idle");
    playSound("click");
  }, [applyPhase]);

  const togglePause = useCallback(() => {
    if (!race || race.finished) return;
    if (phaseRef.current === "racing") {
      applyPhase("paused");
      playSound("click");
    } else if (
      phaseRef.current === "paused" ||
      phaseRef.current === "countdown"
    ) {
      applyPhase("racing");
      playSound("click");
    }
  }, [race, applyPhase]);

  // --- 3-2-1-GO countdown (one beat per effect run) -------------------------
  useEffect(() => {
    if (phase !== "countdown" || !race) return;
    playSound(countdown > 0 ? "jump" : "ding", countdown > 0 ? 0.3 : 0.35);
    const id = setTimeout(
      () => {
        if (countdown > 0) setCountdown(countdown - 1);
        else applyPhase("racing");
      },
      reduceMotion ? Math.min(COUNTDOWN_BEAT_MS, 200) : COUNTDOWN_BEAT_MS,
    );
    return () => clearTimeout(id);
  }, [phase, countdown, race, reduceMotion, applyPhase]);

  // --- the race loop (mirrors DinoTrainer's rAF/accumulator loop) -----------
  useEffect(() => {
    if (!race) return;
    let raf = 0;
    let last = performance.now();
    let acc = 0;
    let lastFlush = 0;
    let finishPlayed = false;
    const frame = (ts: number) => {
      raf = requestAnimationFrame(frame);
      const dt = Math.min((ts - last) / 1000, 0.25);
      last = ts;
      if (phaseRef.current === "racing" && !race.finished) {
        acc += dt;
        let n = 0;
        while (acc >= STEP_DT && n < MAX_STEPS_PER_FRAME) {
          race.step(STEP_DT);
          acc -= STEP_DT;
          n += 1;
        }
        if (acc > 0.2) acc = 0.2; // never spiral after a long stall
      } else {
        acc = 0;
      }
      const canvas = canvasRef.current;
      if (canvas) race.render(canvas, ts / 1000);
      if (race.finished && phaseRef.current !== "finished") {
        applyPhase("finished");
        setHud(race.hud());
        if (!finishPlayed) {
          finishPlayed = true;
          playSound("ding", 0.5); // finish fanfare
        }
      }
      if (ts - lastFlush >= 250) {
        lastFlush = ts;
        setHud(race.hud()); // ~4 Hz flush — rendering stays pure canvas
      }
    };
    raf = requestAnimationFrame(frame);
    return () => cancelAnimationFrame(raf);
  }, [race, applyPhase]);

  // --- responsive canvas backing store (DinoTrainer's exact recipe) ---------
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
  }, [race]);

  // --- Space = pause/resume (scoped to an active race, never steals typing) -
  useEffect(() => {
    if (!race || race.finished) return;
    if (phase !== "racing" && phase !== "paused") return;
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
      if (isEditable(e.target)) return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key === " ") {
        e.preventDefault(); // stop page scroll
        if (e.repeat) return; // ignore held-key repeats
        togglePause();
      }
    };
    window.addEventListener("keydown", down);
    return () => window.removeEventListener("keydown", down);
  }, [race, phase, togglePause]);

  // --- auto-pause when the page is hidden ------------------------------------
  useEffect(() => {
    if (!race || phase !== "racing") return;
    const onVis = () => {
      if (document.visibilityState === "hidden") applyPhase("paused");
    };
    document.addEventListener("visibilitychange", onVis);
    return () => document.removeEventListener("visibilitychange", onVis);
  }, [race, phase, applyPhase]);

  // --- derived views ---------------------------------------------------------
  const ranked = useMemo(
    () => (hud ? rankRacers(hud.racers) : []),
    [hud],
  );
  const finalRanking = phase === "finished" ? ranked : null;
  const nRacers = specs?.length ?? 0;

  // ===========================================================================
  // PICKER VIEW
  // ===========================================================================
  if (!race) {
    return (
      <div className="space-y-4">
        {/* header */}
        <div className="flex items-start gap-3">
          <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg border border-lime-500/30 bg-lime-500/10">
            <Swords
              className="h-5 w-5 text-lime-700 dark:text-lime-400"
              aria-hidden
            />
          </div>
          <div className="min-w-0">
            <h2 className="text-lg font-semibold tracking-tight">Dino Arena</h2>
            <p className="mt-0.5 text-sm leading-relaxed text-muted-foreground">
              Race 2–4 saved brains in one shared dino world — same obstacles,
              same eyes, different connectomes. Watch who jumps, who ducks, who
              face-plants into the first cactus.
            </p>
          </div>
        </div>

        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <Flag className="h-4 w-4 text-lime-700 dark:text-lime-400" aria-hidden />
              Choose your racers
            </CardTitle>
            <CardDescription>
              Pick 2 to 4 brains. Lane colors are assigned in pick order —
              emerald, amber, rose, teal.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            {/* learning toggle */}
            <div className="flex items-start justify-between gap-3 rounded-lg border border-border/60 bg-muted/40 px-3 py-3">
              <div className="min-w-0">
                <Label
                  htmlFor="arena-learning"
                  className="cursor-pointer text-sm font-medium"
                >
                  Let them keep learning mid-race
                </Label>
                <p className="mt-0.5 text-xs leading-relaxed text-muted-foreground">
                  Off (default): frozen showcase — a pure behavior readout,
                  zero dopamine. On: racers get sugar per cleared obstacle and
                  a shock on death, exactly like training.
                </p>
              </div>
              <Switch
                id="arena-learning"
                data-testid="arena-learning-toggle"
                checked={learning}
                onCheckedChange={onLearningChange}
                aria-label="Let racers keep learning during the race"
              />
            </div>

            {/* list / loading / error / empty */}
            {libFailed && (
              <div
                role="alert"
                className="flex flex-wrap items-center gap-2 rounded-lg border border-rose-500/30 bg-rose-500/10 px-3 py-2.5 text-sm text-rose-700 dark:text-rose-300"
              >
                <AlertTriangle className="h-4 w-4 shrink-0" aria-hidden />
                <span className="min-w-0 flex-1">
                  Couldn&apos;t load your library brains. The newborn fly and
                  built-ins below still work.
                </span>
                <Button
                  variant="outline"
                  size="sm"
                  className="h-9 border-rose-500/40 bg-rose-500/10 text-rose-700 hover:bg-rose-500/20 hover:text-rose-800 dark:text-rose-300 dark:border-rose-500/40 dark:bg-rose-500/10 dark:hover:bg-rose-500/20 dark:hover:text-rose-200"
                  onClick={() => {
                    playSound("click");
                    setReloadKey((k) => k + 1);
                  }}
                >
                  <RotateCcw className="h-3.5 w-3.5" aria-hidden />
                  Retry
                </Button>
              </div>
            )}

            {isEmpty ? (
              <div
                data-testid="arena-empty"
                className="flex flex-col items-start gap-3 rounded-xl border border-dashed border-border bg-muted/30 px-4 py-8 text-center sm:items-center sm:px-6"
              >
                <div className="flex h-12 w-12 items-center justify-center rounded-full border border-lime-500/30 bg-lime-500/10">
                  <Gamepad2 className="h-6 w-6 text-lime-700 dark:text-lime-400" />
                </div>
                <div className="space-y-1">
                  <h3 className="text-base font-semibold">
                    No dino brains to race yet
                  </h3>
                  <p className="mx-auto max-w-md text-sm leading-relaxed text-muted-foreground">
                    The arena races saved dino connectomes head-to-head. Train
                    flies in the Dino Training room and save a champion — it
                    will appear here instantly.
                  </p>
                  <p className="mx-auto max-w-md text-xs leading-relaxed text-muted-foreground">
                    Built-in demo racers are landing soon; until then the
                    newborn fly needs at least one opponent from your library.
                  </p>
                </div>
                <Button
                  onClick={gotoDinoTraining}
                  className="h-11 bg-lime-500 text-lime-950 hover:bg-lime-400 dark:bg-lime-500 dark:text-lime-950 dark:hover:bg-lime-400"
                >
                  <Gamepad2 className="h-4 w-4" aria-hidden />
                  Open Dino Training
                  <span className="ml-1 rounded border border-lime-900/20 bg-lime-950/10 px-1 font-mono text-[10px]">
                    2
                  </span>
                </Button>
              </div>
            ) : (
              <ul
                aria-label="Racer candidates"
                className="max-h-96 space-y-1.5 overflow-y-auto pr-1"
              >
                {libRows === null && !libFailed
                  ? Array.from({ length: 4 }, (_, i) => (
                      <li
                        key={`skel-${i}`}
                        className="flex min-h-11 items-center gap-3 rounded-lg border border-border/60 bg-muted/30 px-3 py-2"
                      >
                        <Skeleton className="h-4 w-4 rounded-[4px]" />
                        <div className="flex-1 space-y-1.5">
                          <Skeleton className="h-4 w-40" />
                          <Skeleton className="h-3 w-24" />
                        </div>
                        <Skeleton className="h-5 w-16 rounded-full" />
                      </li>
                    ))
                  : pickerRows.map((row) => {
                      const lane = selected.indexOf(row.key);
                      const picked = lane >= 0;
                      const blocked =
                        !picked && selected.length >= ARENA_MAX_RACERS;
                      const src = SOURCE_BADGE[row.source];
                      const cbId = `arena-pick-${row.key.replace(/[^a-zA-Z0-9-]/g, "-")}`;
                      return (
                        <li key={row.key}>
                          <label
                            htmlFor={cbId}
                            className={cn(
                              "flex min-h-11 cursor-pointer items-center gap-3 rounded-lg border px-3 py-2 transition-colors",
                              picked
                                ? laneColor(lane).row
                                : "border-border/60 bg-muted/30 hover:bg-muted/60",
                              blocked && "cursor-not-allowed opacity-55",
                            )}
                          >
                            <Checkbox
                              id={cbId}
                              checked={picked}
                              disabled={blocked}
                              onCheckedChange={() => onPickerRowClick(row.key)}
                              aria-label={`Racer: ${row.name}`}
                            />
                            <span className="min-w-0 flex-1">
                              <span className="flex items-center gap-2">
                                <span className="truncate text-sm font-medium text-foreground">
                                  {row.name}
                                </span>
                                {picked && (
                                  <span
                                    className={cn(
                                      "h-2.5 w-2.5 shrink-0 rounded-full",
                                      laneColor(lane).dot,
                                    )}
                                    title={`Lane ${lane + 1} · ${laneColor(lane).name}`}
                                    aria-hidden
                                  />
                                )}
                              </span>
                              <span className="mt-0.5 flex flex-wrap items-center gap-x-1.5 text-xs text-muted-foreground">
                                <span className="tabular-nums">
                                  gen {row.generation}
                                </span>
                                <span aria-hidden>·</span>
                                <span className="tabular-nums">
                                  best {row.score} pt
                                </span>
                                {row.note && (
                                  <>
                                <span aria-hidden>·</span>
                                <span className="truncate">{row.note}</span>
                                  </>
                                )}
                              </span>
                            </span>
                            <Badge
                              className={cn(
                                "shrink-0 font-mono text-[10px]",
                                src.className,
                              )}
                            >
                              {src.label}
                            </Badge>
                          </label>
                        </li>
                      );
                    })}
              </ul>
            )}

            {/* footer: count + start */}
            {!isEmpty && (
              <div className="flex flex-col gap-3 border-t border-border/60 pt-3 sm:flex-row sm:items-center sm:justify-between">
                <div className="flex flex-wrap items-center gap-2">
                  <Badge
                    className={cn(
                      "font-mono text-[10px] tabular-nums",
                      "border-lime-500/30 bg-lime-500/10 text-lime-700 dark:text-lime-300",
                    )}
                    data-testid="arena-count"
                  >
                    {selected.length}/{ARENA_MAX_RACERS} picked
                  </Badge>
                  {selected.length < ARENA_MIN_RACERS && (
                    <span className="text-xs text-muted-foreground">
                      pick at least {ARENA_MIN_RACERS} racers to start
                    </span>
                  )}
                </div>
                <div className="flex items-center gap-2">
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <span tabIndex={-1} className="inline-flex">
                        <Button
                          data-testid="arena-start"
                          size="lg"
                          aria-busy={starting}
                          disabled={starting || selected.length < ARENA_MIN_RACERS}
                          onClick={() => void startRace()}
                          className="h-11 bg-lime-500 text-lime-950 hover:bg-lime-400 dark:bg-lime-500 dark:text-lime-950 dark:hover:bg-lime-400"
                        >
                          {starting ? (
                            <>
                              <Loader2
                                className="h-4 w-4 animate-spin"
                                aria-hidden
                              />
                              Loading brains…
                            </>
                          ) : (
                            <>
                              <Flag className="h-4 w-4" aria-hidden />
                              Start race
                            </>
                          )}
                        </Button>
                      </span>
                    </TooltipTrigger>
                    {selected.length < ARENA_MIN_RACERS && (
                      <TooltipContent>
                        Pick at least {ARENA_MIN_RACERS} racers (max{" "}
                        {ARENA_MAX_RACERS})
                      </TooltipContent>
                    )}
                  </Tooltip>
                </div>
              </div>
            )}

            {startError && (
              <div
                role="alert"
                className="flex flex-wrap items-center gap-2 rounded-lg border border-rose-500/30 bg-rose-500/10 px-3 py-2.5 text-sm text-rose-700 dark:text-rose-300"
              >
                <AlertTriangle className="h-4 w-4 shrink-0" aria-hidden />
                <span className="min-w-0 flex-1">{startError}</span>
                <Button
                  variant="outline"
                  size="sm"
                  className="h-9 border-rose-500/40 bg-rose-500/10 text-rose-700 hover:bg-rose-500/20 hover:text-rose-800 dark:border-rose-500/40 dark:bg-rose-500/10 dark:text-rose-300 dark:hover:bg-rose-500/20 dark:hover:text-rose-200"
                  onClick={() => void startRace()}
                >
                  <RotateCcw className="h-3.5 w-3.5" aria-hidden />
                  Retry
                </Button>
              </div>
            )}
          </CardContent>
        </Card>
      </div>
    );
  }

  // ===========================================================================
  // RACE VIEW
  // ===========================================================================
  return (
    <div className="space-y-4">
      {/* header */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-3">
          <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg border border-lime-500/30 bg-lime-500/10">
            <Swords
              className="h-5 w-5 text-lime-700 dark:text-lime-400"
              aria-hidden
            />
          </div>
          <div className="min-w-0">
            <h2 className="text-lg font-semibold tracking-tight">Dino Arena</h2>
            <p className="mt-0.5 text-xs text-muted-foreground">
              {nRacers} connectomes · one world · identical eyes — a perfectly
              fair race
            </p>
          </div>
          <Badge
            className={cn(
              "hidden font-mono text-[10px] sm:inline-flex",
              learning
                ? "border-lime-500/40 bg-lime-500/15 text-lime-700 dark:text-lime-300"
                : "border-border/60 bg-muted/60 text-muted-foreground",
            )}
          >
            {learning ? "LEARNING LIVE" : "FROZEN SHOWCASE"}
          </Badge>
        </div>
        <Button
          variant="outline"
          size="sm"
          className="h-9 dark:bg-input/30 dark:border-input dark:hover:bg-input/50"
          onClick={newRace}
          aria-label="Abandon the race and pick new racers"
          data-testid="arena-quit"
        >
          <DoorOpen className="h-4 w-4" aria-hidden />
          New racers
        </Button>
      </div>

      {/* race + leaderboard */}
      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_320px]">
        {/* --- the game --- */}
        <Card className="gap-0 overflow-hidden py-0">
          <CardContent className="px-0 pb-0">
            <div className="relative w-full">
              <canvas
                ref={canvasRef}
                data-testid="arena-canvas"
                className="block w-full bg-[#14110d]"
                style={{ aspectRatio: "480 / 140" }}
                role="img"
                aria-label={`Dino arena race view — ${nRacers} saved brains racing in one world`}
              />

              {/* shared HUD overlay */}
              {hud && (
                <div className="pointer-events-none absolute inset-0 flex flex-col justify-between p-2.5 sm:p-3">
                  <div className="flex items-start justify-between gap-2">
                    <div className="flex flex-wrap items-center gap-1.5">
                      <Badge className="border-border/60 bg-black/50 font-mono text-[10px] tabular-nums backdrop-blur-sm sm:text-xs">
                        ⏱ {hud.elapsed.toFixed(0)}s / {ARENA_TIME_CAP_S}s
                      </Badge>
                      <Badge className="border-border/60 bg-black/50 font-mono text-[10px] tabular-nums backdrop-blur-sm sm:text-xs">
                        SPD {(hud.speed / BASE_SPEED).toFixed(1)}×
                      </Badge>
                      <Badge className="gap-1 border-border/60 bg-black/50 font-mono text-[10px] tabular-nums backdrop-blur-sm sm:text-xs">
                        <Users className="h-3 w-3" aria-hidden />
                        {hud.racers.filter((r) => r.alive).length}/{nRacers} alive
                      </Badge>
                    </div>
                    <div className="text-right leading-none">
                      <div className="font-mono text-lg font-bold tabular-nums text-lime-300 [text-shadow:0_0_12px_rgba(163,230,53,0.35)] sm:text-2xl">
                        {String(hud.score).padStart(5, "0")}
                      </div>
                      <div className="mt-1 font-mono text-[10px] tabular-nums text-muted-foreground sm:text-xs">
                        WORLD SCORE
                      </div>
                    </div>
                  </div>
                  <div className="flex items-center justify-between">
                    <Badge className="border-border/60 bg-black/50 font-mono text-[10px] backdrop-blur-sm">
                      {phase === "finished"
                        ? "FINISH"
                        : phase === "paused"
                          ? "PAUSED"
                          : "ARENA"}
                    </Badge>
                    {phase === "racing" || phase === "paused" ? (
                      <span className="font-mono text-[9px] text-muted-foreground sm:text-[10px]">
                        Space = pause
                      </span>
                    ) : null}
                  </div>
                </div>
              )}

              {/* 3-2-1-GO countdown overlay */}
              <AnimatePresence>
                {phase === "countdown" && (
                  <motion.div
                    key="countdown-scrim"
                    initial={reduceMotion ? false : { opacity: 0 }}
                    animate={{ opacity: 1 }}
                    exit={reduceMotion ? undefined : { opacity: 0 }}
                    transition={{ duration: 0.2 }}
                    className="absolute inset-0 z-10 flex items-center justify-center bg-black/55 backdrop-blur-[2px]"
                    aria-hidden
                  >
                    <AnimatePresence mode="popLayout">
                      <motion.span
                        key={countdown}
                        initial={
                          reduceMotion ? false : { scale: 1.9, opacity: 0 }
                        }
                        animate={{ scale: 1, opacity: 1 }}
                        exit={reduceMotion ? undefined : { scale: 0.6, opacity: 0 }}
                        transition={{ duration: 0.25, ease: "easeOut" }}
                        className="font-mono text-6xl font-bold text-lime-300 [text-shadow:0_0_24px_rgba(163,230,53,0.45)]"
                      >
                        {countdown > 0 ? countdown : "GO!"}
                      </motion.span>
                    </AnimatePresence>
                    <span className="sr-only" role="status">
                      {countdown > 0
                        ? `Race starts in ${countdown}`
                        : "Go!"}
                    </span>
                  </motion.div>
                )}
              </AnimatePresence>

              {/* paused overlay — click anywhere to resume */}
              {phase === "paused" && (
                <button
                  type="button"
                  onClick={togglePause}
                  className="absolute inset-0 z-10 flex flex-col items-center justify-center gap-3 bg-black/50 backdrop-blur-[1px] transition-colors hover:bg-black/40"
                  aria-label="Resume the race"
                  data-testid="arena-resume-overlay"
                >
                  <span className="flex h-14 w-14 items-center justify-center rounded-full bg-lime-500 text-lime-950 shadow-lg shadow-lime-500/30">
                    <Play className="h-6 w-6 translate-x-0.5" fill="currentColor" aria-hidden />
                  </span>
                  <span className="text-sm font-medium text-lime-100">
                    Paused — click or press Space to resume
                  </span>
                </button>
              )}
            </div>
          </CardContent>
        </Card>

        {/* --- live leaderboard --- */}
        <Card data-testid="arena-leaderboard" className="self-start">
          <CardHeader className="pb-3">
            <CardTitle className="flex items-center justify-between gap-2 text-base">
              <span className="flex items-center gap-2">
                <Trophy className="h-4 w-4 text-lime-700 dark:text-lime-400" aria-hidden />
                Leaderboard
              </span>
              <Badge
                className={cn(
                  "font-mono text-[10px] tabular-nums",
                  "border-lime-500/30 bg-lime-500/10 text-lime-700 dark:text-lime-300",
                )}
              >
                {phase === "finished" ? "FINAL" : "LIVE"}
              </Badge>
            </CardTitle>
            {/* compact mid-race learning toggle */}
            <div className="flex items-center justify-between gap-2 pt-1">
              <Label
                htmlFor="arena-learning-race"
                className="cursor-pointer text-xs text-muted-foreground"
              >
                Keep learning mid-race
              </Label>
              <Switch
                id="arena-learning-race"
                checked={learning}
                onCheckedChange={onLearningChange}
                aria-label="Let racers keep learning during the race"
              />
            </div>
          </CardHeader>
          <CardContent className="pt-0">
            <ul className="space-y-1.5">
              {ranked.map((r) => {
                const chip = deathChip(r);
                return (
                  <motion.li
                    layout={!reduceMotion}
                    key={r.key}
                    data-testid={`racer-row-${r.lane}`}
                    transition={{ type: "spring", stiffness: 420, damping: 34 }}
                    className={cn(
                      "flex min-h-11 items-center gap-2.5 rounded-lg border px-2.5 py-2",
                      "border-border/60 bg-muted/30",
                    )}
                  >
                    <span className="w-5 shrink-0 text-center font-mono text-xs tabular-nums text-muted-foreground">
                      {r.rank}
                    </span>
                    <span
                      className={cn(
                        "h-2.5 w-2.5 shrink-0 rounded-full",
                        laneColor(r.lane).dot,
                      )}
                      aria-hidden
                    />
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-sm font-medium text-foreground">
                        {r.name}
                      </div>
                      <div className="text-[11px] tabular-nums text-muted-foreground">
                        {r.obstaclesCleared} cleared
                      </div>
                    </div>
                    <div className="shrink-0 text-right">
                      <div className="font-mono text-sm font-semibold tabular-nums text-foreground">
                        {r.score}
                      </div>
                    </div>
                    <Badge
                      className={cn(
                        "shrink-0 font-mono text-[9px] sm:text-[10px]",
                        chip.className,
                      )}
                    >
                      {chip.label}
                    </Badge>
                  </motion.li>
                );
              })}
            </ul>
            <p className="mt-3 text-[11px] leading-relaxed text-muted-foreground">
              Every fly physically runs at the same spot — sprites are staggered
              per lane only so you can tell them apart. Highest world score at
              death wins.
            </p>
          </CardContent>
        </Card>
      </div>

      {/* controls */}
      <div className="flex flex-wrap items-center gap-2">
        <Button
          variant="outline"
          size="lg"
          className="h-11 dark:bg-input/30 dark:border-input dark:hover:bg-input/50"
          onClick={togglePause}
          disabled={race.finished || phase === "countdown"}
          aria-label={
            phase === "paused" ? "Resume the race" : "Pause the race"
          }
          data-testid="arena-pause"
        >
          {phase === "paused" ? (
            <>
              <Play className="h-4 w-4" aria-hidden />
              Resume
            </>
          ) : (
            <>
              <Pause className="h-4 w-4" aria-hidden />
              Pause
            </>
          )}
        </Button>
        <span className="text-xs text-muted-foreground">
          or press <span className="font-mono">Space</span> · race auto-pauses
          when the tab hides
        </span>
      </div>

      {/* --- podium --- */}
      {finalRanking && hud && (
        <section
          data-testid="arena-podium"
          aria-label="Race results"
          className="space-y-3"
        >
          <div className="flex flex-wrap items-center gap-2">
            <Trophy className="h-5 w-5 text-amber-400" aria-hidden />
            <h3 className="text-base font-semibold tracking-tight">
              Race results
            </h3>
            <Badge
              className={cn(
                "font-mono text-[10px] tabular-nums",
                "border-lime-500/30 bg-lime-500/10 text-lime-700 dark:text-lime-300",
              )}
            >
              {hud.elapsed.toFixed(0)}s · world {hud.score} pt
            </Badge>
          </div>

          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
            {finalRanking.map((r, i) => {
              const tieBelow =
                i < finalRanking.length - 1 &&
                finalRanking[i + 1].rank === r.rank;
              const podiumStyle =
                r.rank === 1
                  ? "border-amber-500/40 bg-amber-500/10 shadow-[0_0_28px_rgba(245,158,11,0.14)]"
                  : r.rank === 2
                    ? "border-slate-400/30 bg-slate-400/10"
                    : r.rank === 3
                      ? "border-amber-700/30 bg-amber-700/10 dark:border-amber-600/30 dark:bg-amber-600/10"
                      : "border-border/60 bg-muted/30";
              const src = SOURCE_BADGE[r.source];
              return (
                <motion.div
                  key={r.key}
                  initial={reduceMotion ? false : { opacity: 0, y: 16 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{
                    duration: 0.3,
                    delay: reduceMotion ? 0 : i * 0.09,
                  }}
                  className={cn(
                    "rounded-xl border p-4",
                    podiumStyle,
                  )}
                >
                  <div className="flex items-center justify-between gap-2">
                    <span className="flex items-center gap-1.5 text-sm font-semibold text-foreground">
                      {r.rank === 1 && (
                        <Trophy className="h-4 w-4 text-amber-400" aria-hidden />
                      )}
                      {r.rank === 2 && (
                        <Medal className="h-4 w-4 text-slate-300 dark:text-slate-400" aria-hidden />
                      )}
                      {r.rank === 3 && (
                        <Medal className="h-4 w-4 text-amber-700 dark:text-amber-600" aria-hidden />
                      )}
                      {r.rank > 3 && (
                        <span className="grid h-4 w-4 place-items-center font-mono text-xs text-muted-foreground">
                          {r.rank}
                        </span>
                      )}
                      {ordinal(r.rank)}
                      {tieBelow && (
                        <span className="text-xs font-normal text-muted-foreground">
                          · tied
                        </span>
                      )}
                    </span>
                    <span
                      className={cn(
                        "h-2.5 w-2.5 rounded-full",
                        laneColor(r.lane).dot,
                      )}
                      title={`Lane ${r.lane + 1} · ${laneColor(r.lane).name}`}
                      aria-hidden
                    />
                  </div>
                  <div
                    className="mt-2 truncate text-sm font-medium text-foreground"
                    title={r.name}
                  >
                    {r.name}
                  </div>
                  <div className="mt-1 font-mono text-2xl font-bold tabular-nums text-foreground">
                    {r.score}
                    <span className="ml-1 text-xs font-normal text-muted-foreground">
                      pt
                    </span>
                  </div>
                  <div className="mt-2.5 flex flex-wrap items-center gap-1.5">
                    <Badge
                      variant="outline"
                      className="gap-1 font-mono text-[10px] tabular-nums"
                    >
                      <Sprout className="h-3 w-3" aria-hidden />
                      {r.obstaclesCleared} obstacles
                    </Badge>
                    {r.deathCause === "bird" && (
                      <Badge
                        variant="outline"
                        className="gap-1 border-rose-500/40 bg-rose-500/10 font-mono text-[10px] text-rose-700 dark:text-rose-300"
                      >
                        <Bird className="h-3 w-3" aria-hidden />
                        bird
                      </Badge>
                    )}
                    {r.survived && (
                      <Badge
                        variant="outline"
                        className="gap-1 border-teal-500/40 bg-teal-500/10 font-mono text-[10px] text-teal-700 dark:text-teal-300"
                      >
                        <Sparkles className="h-3 w-3" aria-hidden />
                        survived
                      </Badge>
                    )}
                    <Badge
                      className={cn(
                        "font-mono text-[10px]",
                        src.className,
                      )}
                    >
                      {src.label}
                    </Badge>
                  </div>
                </motion.div>
              );
            })}
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <Button
              data-testid="arena-again"
              size="lg"
              className="h-11 bg-lime-500 text-lime-950 hover:bg-lime-400 dark:bg-lime-500 dark:text-lime-950 dark:hover:bg-lime-400"
              onClick={raceAgain}
            >
              <RotateCcw className="h-4 w-4" aria-hidden />
              Race again
            </Button>
            <Button
              data-testid="arena-new-race"
              size="lg"
              variant="outline"
              className="h-11 dark:bg-input/30 dark:border-input dark:hover:bg-input/50"
              onClick={newRace}
            >
              <Users className="h-4 w-4" aria-hidden />
              New racers
            </Button>
          </div>
          <p className="text-xs leading-relaxed text-muted-foreground">
            &ldquo;Race again&rdquo; reloads every brain fresh from its saved
            snapshot — nothing learned in this race carries over to the next.
          </p>
        </section>
      )}
    </div>
  );
}
