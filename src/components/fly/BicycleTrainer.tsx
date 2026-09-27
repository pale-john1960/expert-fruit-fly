"use client";

/**
 * BicycleTrainer — a fly learns to ride a bicycle in a 3D dusk world.
 *
 * Owns the whole "Bicycle Training" tab: the R3F canvas with the training
 * simulation running inside useFrame, the HUD overlay, the fly's retina
 * mini-canvas, live brain activity, the event feed, evolution controls,
 * save/load integration and the distance-history chart.
 */

import { useEffect, useMemo, useRef, useState } from "react";
import { Canvas } from "@react-three/fiber";
import { toast } from "sonner";
import { Toaster } from "@/components/ui/sonner";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Slider } from "@/components/ui/slider";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import { BrainActivityPanel } from "./BrainActivityPanel";
import {
  BicycleTrainerCore,
  type HudSnapshot,
  type TrainerEvent,
} from "./bicycle/trainer";
import { DuskScene } from "./bicycle/scene";
import { useBrainStore } from "@/lib/flybrain/store";
import { playSound } from "@/lib/sound";
import type { BrainSnapshot } from "@/lib/flybrain/types";
import type { FlyBrain } from "@/lib/flybrain/engine";
import {
  Bike,
  Play,
  Pause,
  RotateCcw,
  Zap,
  TriangleAlert,
  Sparkles,
  Flag,
  Trophy,
  Info,
  Save,
  Eye,
  FastForward,
  History,
  X,
} from "lucide-react";
import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  Legend,
} from "recharts";

const MAX_RIDERS = 8;

function eventIcon(kind: TrainerEvent["kind"]) {
  switch (kind) {
    case "fall":
      return <Zap className="h-3.5 w-3.5 text-rose-400" />;
    case "offroad":
      return <TriangleAlert className="h-3.5 w-3.5 text-amber-400" />;
    case "milestone":
      return <Sparkles className="h-3.5 w-3.5 text-amber-300" />;
    case "gen":
      return <Flag className="h-3.5 w-3.5 text-rose-300" />;
    case "best":
      return <Trophy className="h-3.5 w-3.5 text-emerald-400" />;
    case "load":
      return <Eye className="h-3.5 w-3.5 text-emerald-400" />;
    default:
      return <Info className="h-3.5 w-3.5 text-muted-foreground" />;
  }
}

function TurboControl({
  turbo,
  onChange,
  size = "sm",
}: {
  turbo: number;
  onChange: (t: number) => void;
  size?: "sm" | "md";
}) {
  return (
    <div
      className="flex items-center gap-0.5 rounded-lg border border-white/10 bg-black/45 p-0.5 backdrop-blur-md"
      role="group"
      aria-label="Simulation speed"
    >
      {[1, 3, 10].map((t) => (
        <button
          key={t}
          onClick={() => onChange(t)}
          aria-pressed={turbo === t}
          className={`flex items-center gap-1 rounded-md font-medium transition-colors ${
            size === "md" ? "h-10 px-3 text-sm" : "h-8 px-2.5 text-xs"
          } ${
            turbo === t
              ? "bg-amber-500/90 text-black"
              : "text-amber-200/80 hover:bg-white/10 hover:text-amber-100"
          }`}
        >
          {t === 1 ? null : <FastForward className={size === "md" ? "h-3.5 w-3.5" : "h-3 w-3"} />}
          ×{t}
        </button>
      ))}
    </div>
  );
}

function StatChip({
  label,
  value,
  accent,
}: {
  label: string;
  value: string;
  accent?: string;
}) {
  return (
    <div className="rounded-lg border border-white/10 bg-black/40 px-2.5 py-1.5 backdrop-blur-md">
      <div className="text-[10px] uppercase tracking-wide text-white/50">{label}</div>
      <div className={`text-sm font-semibold tabular-nums ${accent ?? "text-white"}`}>{value}</div>
    </div>
  );
}

export function BicycleTrainer() {
  const [core] = useState(() => new BicycleTrainerCore(5));
  const retinaCanvas = useRef<HTMLCanvasElement | null>(null);
  const [hud, setHud] = useState<HudSnapshot | null>(null);
  const [leaderBrain, setLeaderBrain] = useState<FlyBrain | null>(null);
  const [running, setRunning] = useState(true);
  const [turbo, setTurbo] = useState(1);
  const [popQueued, setPopQueued] = useState(5);
  const [mutation, setMutation] = useState(0.3);
  const [watchBest, setWatchBest] = useState(false);
  const [brainName, setBrainName] = useState("Dusk Rider");
  const [saving, setSaving] = useState(false);
  const [session, setSession] = useState<{
    generation: number;
    bestDistance: number;
    history: { gen: number; best: number; avg: number }[];
    snapshot: BrainSnapshot;
  } | null>(null);

  // ---- HUD polling (keeps React renders at ~6 Hz, the scene stays 60 fps)
  useEffect(() => {
    const iv = setInterval(() => {
      setHud(core.hudSnapshot());
      const lead = core.leader;
      if (lead) {
        setLeaderBrain((prev) => (prev === lead.brain ? prev : lead.brain));
      }
    }, 160);
    return () => clearInterval(iv);
  }, [core]);

  // ---- brain-library load integration + session resume banner
  useEffect(() => {
    const tryConsume = () => {
      const snap = useBrainStore.getState().pending.bicycle;
      if (snap) {
        useBrainStore.getState().consumeLoad("bicycle");
        core.adoptSnapshot(snap);
        setSession(null);
        toast.success(`Loaded "${snap.name}"`, {
          description: `Gen ${snap.generation} champion (${snap.score.toFixed(0)} m) now seeds the whole population.`,
        });
      }
    };
    tryConsume();
    const unsub = useBrainStore.subscribe(tryConsume);
    const sess = BicycleTrainerCore.loadSession();
    if (sess && sess.bestDistance > 1) setSession(sess);
    return () => unsub();
  }, [core]);

  // ---- keep the R3F subtree out of the HUD re-render loop
  const canvasElement = useMemo(
    () => (
      <Canvas
        dpr={[1, 1.75]}
        camera={{ fov: 55, near: 0.1, far: 2200, position: [0, 2.8, -8] }}
        gl={{ antialias: true, powerPreference: "high-performance" }}
        style={{ position: "absolute", inset: 0 }}
      >
        <DuskScene core={core} retinaCanvas={retinaCanvas} maxRiders={MAX_RIDERS} />
      </Canvas>
    ),
    [core]
  );

  // ------------------------------------------------------------- controls
  const toggleRun = () => {
    const next = !running;
    setRunning(next);
    core.setRunning(next);
    playSound("click");
  };

  const doReset = () => {
    core.reset();
    setWatchBest(false);
    setHud(core.hudSnapshot());
    toast.info("Fresh start", { description: "New random brains — Generation 1 rolls out." });
  };

  const changeTurbo = (t: number) => {
    setTurbo(t);
    core.setTurbo(t);
  };

  const changePopulation = (v: number[]) => {
    const n = v[0];
    setPopQueued(n);
    core.setQueuedPopulation(n);
  };

  const changeMutation = (v: number[]) => {
    const s = v[0];
    setMutation(s);
    core.setMutationStrength(s);
  };

  const toggleWatchBest = (on: boolean) => {
    setWatchBest(on);
    core.setWatchBest(on);
  };

  const resumeSession = () => {
    if (!session) return;
    playSound("click");
    core.adoptSnapshot(session.snapshot);
    core.history = session.history;
    core.generation = session.generation;
    setSession(null);
    setHud(core.hudSnapshot());
    toast.success("Session resumed", {
      description: `Continuing from generation ${session.generation} (best ${session.bestDistance.toFixed(0)} m).`,
    });
  };

  const saveBest = async () => {
    const brain = core.bestBrain ?? core.leader?.brain;
    if (!brain) {
      toast.error("Nothing to save yet", { description: "Let at least one generation finish." });
      return;
    }
    const name = brainName.trim() || "Dusk Rider";
    const score = core.bestEverDistance;
    setSaving(true);
    try {
      const snapshot = brain.toJSON("bicycle", name, core.generation, score);
      const res = await fetch("/api/brains", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name,
          task: "bicycle",
          generation: core.generation,
          score,
          snapshot,
        }),
      });
      if (!res.ok) {
        const detail = await res.text().catch(() => "");
        throw new Error(detail || `HTTP ${res.status}`);
      }
      toast.success(`Saved "${name}"`, {
        description: `Generation ${core.generation} champion · ${score.toFixed(0)} m — find it in the Brain Library.`,
      });
      playSound("ding");
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      toast.error("Save failed", {
        description: msg.includes("404")
          ? "The brain library API is not available yet — try again in a moment."
          : msg,
      });
    } finally {
      setSaving(false);
    }
  };

  // ----------------------------------------------------------------- HUD
  const alive = hud?.alive ?? 0;
  const total = hud?.total ?? 5;
  const gen = hud?.gen ?? 1;
  const bestEver = hud?.bestEver ?? 0;
  const leaderS = hud?.leaderS ?? 0;
  const leaderV = hud?.leaderV ?? 0;
  const leaderPhi = hud?.leaderPhi ?? 0;
  const dop = hud?.leaderDop ?? 0;
  const dopPct = Math.min(1, Math.abs(dop));
  const events = hud?.events ?? [];
  const history = hud?.history ?? [];
  const popApplied = (hud?.popSize ?? popQueued) === popQueued;

  return (
    <section className="flex flex-col gap-4">
      <Toaster theme="dark" position="bottom-right" closeButton />

      {/* ------------------------------------------------------- header */}
      <Card className="border-border/70 bg-gradient-to-br from-[#2a1224] via-card to-[#241a20]">
        <CardHeader className="pb-3">
          <div className="flex flex-wrap items-center gap-3">
            <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-gradient-to-br from-rose-500 to-amber-500 text-white shadow-lg shadow-rose-900/40">
              <Bike className="h-5 w-5" />
            </div>
            <div className="min-w-0 flex-1">
              <CardTitle className="text-lg">Bicycle Training</CardTitle>
              <CardDescription className="mt-0.5 text-sm">
                Each fly rides the same dusk road. Distance = sugar. Falling or
                leaving the road = shock. The best riders breed, generation by
                generation.
              </CardDescription>
            </div>
            <div className="flex items-center gap-2">
              <Badge variant="secondary" className="gap-1.5 border-amber-500/30 bg-amber-500/10 text-amber-300">
                <Sparkles className="h-3 w-3" /> reward +0.03 / m
              </Badge>
              <Badge variant="secondary" className="gap-1.5 border-rose-500/30 bg-rose-500/10 text-rose-300">
                <Zap className="h-3 w-3" /> shock −0.5 on fall
              </Badge>
            </div>
          </div>
        </CardHeader>
      </Card>

      {/* ------------------------------------------------ resume banner */}
      {session && (
        <div className="flex flex-wrap items-center gap-3 rounded-xl border border-amber-500/40 bg-amber-500/10 px-4 py-3 text-sm text-amber-200">
          <History className="h-4 w-4 shrink-0" />
          <span className="min-w-0 flex-1">
            Previous dusk ride found — generation {session.generation}, best{" "}
            {session.bestDistance.toFixed(0)} m. Continue breeding from that champion?
          </span>
          <Button
            size="sm"
            onClick={resumeSession}
            className="h-9 bg-amber-500 text-black hover:bg-amber-400"
          >
            Resume last session
          </Button>
          <button
            onClick={() => setSession(null)}
            className="rounded-md p-1.5 opacity-60 hover:opacity-100"
            aria-label="Dismiss session banner"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
      )}

      {/* ------------------------------------------------- main + side */}
      <div className="flex flex-col gap-4 lg:flex-row">
        {/* 3D canvas card */}
        <Card className="min-w-0 flex-1 overflow-hidden p-0">
          <div className="relative aspect-video min-h-[420px] w-full bg-[#150a1e]">
            {canvasElement}

            {/* HUD overlay */}
            <div className="pointer-events-none absolute inset-0 select-none">
              <div className="absolute left-3 top-3 flex flex-wrap items-center gap-2">
                <StatChip
                  label="Generation"
                  value={`#${gen}`}
                  accent="text-rose-300"
                />
                <StatChip
                  label="Alive"
                  value={`${alive} / ${total}`}
                  accent={alive > 0 ? "text-emerald-300" : "text-rose-300"}
                />
                {watchBest && (
                  <StatChip label="Mode" value="watch best" accent="text-amber-300" />
                )}
              </div>
              <div className="absolute right-3 top-3 flex flex-col items-end gap-2">
                <StatChip
                  label="Best ever"
                  value={`${bestEver.toFixed(0)} m`}
                  accent="text-amber-300"
                />
                <StatChip label="Leader" value={`${leaderS.toFixed(0)} m`} />
                <StatChip label="Speed" value={`${leaderV.toFixed(1)} m/s`} />
              </div>

              {/* lean + dopamine bottom-left */}
              <div className="absolute bottom-3 left-3 flex items-end gap-3">
                <div className="rounded-lg border border-white/10 bg-black/40 px-2.5 py-2 backdrop-blur-md">
                  <div className="mb-1 text-[10px] uppercase tracking-wide text-white/50">
                    Lean
                  </div>
                  <div className="flex h-12 w-16 items-center justify-center">
                    <div
                      className="h-1.5 w-14 rounded-full bg-gradient-to-r from-rose-400 via-white/80 to-amber-300 shadow"
                      style={{
                        transform: `rotate(${(leaderPhi * (180 / Math.PI)).toFixed(1)}deg)`,
                      }}
                    />
                  </div>
                </div>
                <div className="w-36 rounded-lg border border-white/10 bg-black/40 px-2.5 py-2 backdrop-blur-md">
                  <div className="mb-1 flex items-center justify-between text-[10px] uppercase tracking-wide text-white/50">
                    <span>Dopamine</span>
                    <span className={dop >= 0 ? "text-emerald-300" : "text-rose-300"}>
                      {dop >= 0 ? "+" : ""}
                      {dop.toFixed(2)}
                    </span>
                  </div>
                  <div className="relative h-2 w-full overflow-hidden rounded-full bg-white/10">
                    <div className="absolute left-1/2 top-0 h-full w-px bg-white/40" />
                    <div
                      className={`absolute top-0 h-full ${
                        dop >= 0 ? "bg-emerald-400" : "bg-rose-400"
                      }`}
                      style={
                        dop >= 0
                          ? { left: "50%", width: `${dopPct * 50}%` }
                          : { right: "50%", width: `${dopPct * 50}%` }
                      }
                    />
                  </div>
                </div>
              </div>

              {/* turbo bottom-right */}
              <div className="pointer-events-auto absolute bottom-3 right-3">
                <TurboControl turbo={turbo} onChange={changeTurbo} />
              </div>

              {/* paused veil */}
              {!running && (
                <div className="absolute inset-0 flex items-center justify-center bg-black/35 backdrop-blur-[2px]">
                  <div className="flex items-center gap-2 rounded-full border border-white/15 bg-black/60 px-5 py-2.5 text-sm font-medium text-white/90">
                    <Pause className="h-4 w-4" /> Paused — the flies are resting
                  </div>
                </div>
              )}
            </div>
          </div>
        </Card>

        {/* right column */}
        <div className="flex w-full flex-col gap-4 lg:w-96">
          {/* what the fly sees */}
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="flex items-center gap-2 text-sm">
                <Eye className="h-4 w-4 text-rose-300" />
                What the fly sees
              </CardTitle>
              <CardDescription className="text-xs">
                The 24×9 retina — road stripe, edge lines, glow posts. Lean
                shifts the whole view.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <div className="overflow-hidden rounded-lg border border-white/10 bg-[#0d0610] p-1.5">
                <canvas
                  ref={retinaCanvas}
                  width={24}
                  height={9}
                  className="block w-full"
                  style={{ imageRendering: "pixelated" }}
                  aria-label="Live view of the fly's 24 by 9 retina"
                  role="img"
                />
              </div>
              <div className="mt-1.5 flex justify-between text-[10px] uppercase tracking-wide text-muted-foreground">
                <span>28 m ahead</span>
                <span>4 m ahead</span>
              </div>
            </CardContent>
          </Card>

          {/* brain activity */}
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm">Leader's brain activity</CardTitle>
              <CardDescription className="text-xs">
                Retina → optic lobe → mushroom body → motor, live.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <BrainActivityPanel brain={leaderBrain} height={150} />
            </CardContent>
          </Card>

          {/* event feed */}
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="flex items-center gap-2 text-sm">
                <Flag className="h-4 w-4 text-amber-300" />
                Event feed
              </CardTitle>
            </CardHeader>
            <CardContent>
              <div
                className="flex max-h-56 flex-col gap-1 overflow-y-auto pr-1 text-xs [scrollbar-color:var(--border)_transparent] [scrollbar-width:thin]"
                aria-live="polite"
              >
                {events.length === 0 && (
                  <div className="py-4 text-center text-muted-foreground">
                    Waiting for the first fall…
                  </div>
                )}
                {events.map((e) => (
                  <div
                    key={e.id}
                    className="flex items-center gap-2 rounded-md border border-border/50 bg-muted/25 px-2 py-1.5"
                  >
                    {eventIcon(e.kind)}
                    <span className="min-w-0 flex-1 truncate text-muted-foreground">
                      {e.text}
                    </span>
                  </div>
                ))}
              </div>
            </CardContent>
          </Card>

          {/* controls */}
          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-sm">Training controls</CardTitle>
            </CardHeader>
            <CardContent className="flex flex-col gap-4">
              <div className="flex gap-2">
                <Button
                  onClick={toggleRun}
                  className="h-11 flex-1 gap-2 text-sm"
                  variant={running ? "secondary" : "default"}
                  aria-label={running ? "Pause training" : "Resume training"}
                >
                  {running ? <Pause className="h-4 w-4" /> : <Play className="h-4 w-4" />}
                  {running ? "Pause" : "Play"}
                </Button>
                <Button
                  onClick={doReset}
                  className="h-11 flex-1 gap-2 text-sm"
                  variant="outline"
                  aria-label="Reset training"
                >
                  <RotateCcw className="h-4 w-4" /> Reset
                </Button>
              </div>

              <div>
                <div className="mb-2 flex items-center justify-between">
                  <Label className="text-xs text-muted-foreground">Turbo</Label>
                  <TurboControl turbo={turbo} onChange={changeTurbo} />
                </div>
              </div>

              <Separator />

              <div className="flex flex-col gap-2">
                <div className="flex items-center justify-between">
                  <Label htmlFor="pop-slider" className="text-xs text-muted-foreground">
                    Population
                  </Label>
                  <span className="text-xs font-medium tabular-nums">
                    {popQueued} riders
                    {!popApplied && (
                      <span className="ml-1 text-amber-400">(next gen)</span>
                    )}
                  </span>
                </div>
                <Slider
                  id="pop-slider"
                  min={3}
                  max={8}
                  step={1}
                  value={[popQueued]}
                  onValueChange={changePopulation}
                />
              </div>

              <div className="flex flex-col gap-2">
                <div className="flex items-center justify-between">
                  <Label htmlFor="mut-slider" className="text-xs text-muted-foreground">
                    Mutation strength
                  </Label>
                  <span className="text-xs font-medium tabular-nums">
                    {mutation.toFixed(2)}
                  </span>
                </div>
                <Slider
                  id="mut-slider"
                  min={0.1}
                  max={0.5}
                  step={0.05}
                  value={[mutation]}
                  onValueChange={changeMutation}
                />
              </div>

              <Separator />

              <div className="flex items-center justify-between gap-3">
                <div className="min-w-0">
                  <Label htmlFor="watch-best" className="flex items-center gap-1.5 text-sm">
                    <Eye className="h-4 w-4 text-amber-300" /> Watch best rider
                  </Label>
                  <p className="mt-0.5 text-xs text-muted-foreground">
                    Exhibition ride with the all-time champion brain.
                  </p>
                </div>
                <Switch
                  id="watch-best"
                  checked={watchBest}
                  onCheckedChange={toggleWatchBest}
                  aria-label="Watch best rider mode"
                />
              </div>
            </CardContent>
          </Card>

          {/* save */}
          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-sm">Save the champion</CardTitle>
              <CardDescription className="text-xs">
                {hud?.hasBest
                  ? `Best brain so far: ${bestEver.toFixed(0)} m — worth keeping?`
                  : "Finish a generation to have a champion worth saving."}
              </CardDescription>
            </CardHeader>
            <CardContent className="flex gap-2">
              <Input
                value={brainName}
                onChange={(e) => setBrainName(e.target.value)}
                placeholder="Brain name"
                maxLength={40}
                className="h-11"
                aria-label="Name for the saved brain"
              />
              <Button
                onClick={saveBest}
                disabled={saving || !hud?.hasBest}
                className="h-11 gap-2 whitespace-nowrap"
                aria-label="Save best brain to the library"
              >
                <Save className="h-4 w-4" />
                {saving ? "Saving…" : "Save best brain"}
              </Button>
            </CardContent>
          </Card>
        </div>
      </div>

      {/* -------------------------------------------------- history chart */}
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="flex items-center gap-2 text-sm">
            <Flag className="h-4 w-4 text-emerald-300" />
            Distance by generation
          </CardTitle>
          <CardDescription className="text-xs">
            Best and average distance per generation — the learning curve of a
            evolving fly colony.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="h-48 w-full">
            {history.length === 0 ? (
              <div className="flex h-full items-center justify-center rounded-lg border border-dashed border-border/60 text-sm text-muted-foreground">
                The curve begins after the first generation finishes…
              </div>
            ) : (
              <ResponsiveContainer width="100%" height="100%">
                <LineChart data={history} margin={{ top: 8, right: 16, bottom: 0, left: -8 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.08)" />
                  <XAxis
                    dataKey="gen"
                    stroke="rgba(255,255,255,0.35)"
                    tick={{ fontSize: 11 }}
                    tickLine={false}
                    label={{ value: "gen", position: "insideBottomRight", offset: -2, fontSize: 10, fill: "rgba(255,255,255,0.35)" }}
                  />
                  <YAxis
                    stroke="rgba(255,255,255,0.35)"
                    tick={{ fontSize: 11 }}
                    tickLine={false}
                    width={54}
                    tickFormatter={(v: number) => `${v} m`}
                  />
                  <Tooltip
                    contentStyle={{
                      background: "rgba(20,10,20,0.92)",
                      border: "1px solid rgba(255,255,255,0.12)",
                      borderRadius: 8,
                      fontSize: 12,
                    }}
                    labelFormatter={(g) => `Generation ${g}`}
                    formatter={(value: number | string, name) => [
                      `${Number(value).toFixed(0)} m`,
                      name as string,
                    ]}
                  />
                  <Legend wrapperStyle={{ fontSize: 11 }} />
                  <Line
                    type="monotone"
                    dataKey="best"
                    name="Best"
                    stroke="#34d399"
                    strokeWidth={2}
                    dot={{ r: 2.5, fill: "#34d399" }}
                    isAnimationActive={false}
                  />
                  <Line
                    type="monotone"
                    dataKey="avg"
                    name="Average"
                    stroke="#fbbf24"
                    strokeWidth={1.6}
                    strokeDasharray="4 3"
                    dot={false}
                    isAnimationActive={false}
                  />
                </LineChart>
              </ResponsiveContainer>
            )}
          </div>
        </CardContent>
      </Card>
    </section>
  );
}
