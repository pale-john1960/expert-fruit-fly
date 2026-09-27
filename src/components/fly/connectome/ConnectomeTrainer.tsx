"use client";

/**
 * ConnectomeTrainer — the "Connectome Ride" tab (7th room, teal accent).
 *
 * ONE real 166,700-neuron MaleCNS brain learns to ride the dusk road for its
 * whole lifetime: LIF spiking after Shiu et al. 2024, real LC visual
 * neurons on the 24×9 retina, steering read from real descending neurons,
 * and the real KC→MBON synapses reshaped by dopamine-gated 3-factor
 * plasticity. No evolution, no population — one brain, many episodes.
 *
 * Layout mirrors the bicycle trainer (Round-14 manual start, HUD chips,
 * controls card, event feed, paused veil + start overlay) and REUSES its
 * 3D dusk world via the core's DuskScene adapter (see trainer.ts).
 *
 * Data: MaleCNS v1.0 (Janelia/HHMI + Google) CC BY 4.0 · reference sim:
 * Xenova/fruit-fly-simulation (MIT).
 */

import { useEffect, useMemo, useRef, useState } from "react";
import { Canvas } from "@react-three/fiber";
import { toast } from "sonner";
import { Toaster } from "@/components/ui/sonner";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Slider } from "@/components/ui/slider";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import { Progress } from "@/components/ui/progress";
import { DuskScene } from "@/components/fly/bicycle/scene";
import {
  ConnectomeRideCore,
  DEFAULT_TUNING,
  getRideCore,
  type ConHudSnapshot,
  type RideTuning,
  type TrainerEvent,
} from "@/lib/connectome/trainer";
import type { LoadProgress } from "@/lib/connectome/loader";
import { downloadTextFile } from "@/lib/session-export";
import { playSound } from "@/lib/sound";
import {
  Activity,
  BrainCircuit,
  FastForward,
  FileJson,
  FileText,
  Flag,
  Info,
  Play,
  Pause,
  RotateCcw,
  SlidersHorizontal,
  Sparkles,
  TriangleAlert,
  Trophy,
  Zap,
} from "lucide-react";

function eventIcon(kind: TrainerEvent["kind"]) {
  switch (kind) {
    case "fall":
      return <Zap className="h-3.5 w-3.5 text-rose-400" />;
    case "offroad":
      return <TriangleAlert className="h-3.5 w-3.5 text-amber-400" />;
    case "milestone":
      return <Sparkles className="h-3.5 w-3.5 text-teal-300" />;
    case "episode":
      return <Flag className="h-3.5 w-3.5 text-teal-300" />;
    case "best":
      return <Trophy className="h-3.5 w-3.5 text-emerald-400" />;
    case "tune":
      return <SlidersHorizontal className="h-3.5 w-3.5 text-teal-400" />;
    default:
      return <Info className="h-3.5 w-3.5 text-muted-foreground" />;
  }
}

/** Teal turbo group — ×1/×2/×5 multiplies BOTH physics and neural rate. */
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
      {[1, 2, 5].map((t) => (
        <button
          key={t}
          onClick={() => onChange(t)}
          aria-pressed={turbo === t}
          className={`flex items-center gap-1 rounded-md font-medium transition-colors ${
            size === "md" ? "h-11 px-3 text-sm" : "h-10 px-2.5 text-xs"
          } ${
            turbo === t
              ? "bg-teal-500/90 text-black"
              : "text-teal-200/80 hover:bg-white/10 hover:text-teal-100"
          }`}
        >
          {t === 1 ? null : (
            <FastForward className={size === "md" ? "h-3.5 w-3.5" : "h-3 w-3"} />
          )}
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
  labelAccent,
}: {
  label: string;
  value: string;
  accent?: string;
  labelAccent?: string;
}) {
  return (
    <div className="rounded-lg border border-white/10 bg-black/40 px-2.5 py-1.5 backdrop-blur-md">
      <div className={`text-[10px] uppercase tracking-wide ${labelAccent ?? "text-white/50"}`}>
        {label}
      </div>
      <div className={`text-sm font-semibold tabular-nums ${accent ?? "text-white"}`}>{value}</div>
    </div>
  );
}

function StatTile({
  label,
  value,
  accent,
  sub,
}: {
  label: string;
  value: string;
  accent?: string;
  sub?: string;
}) {
  return (
    <div className="rounded-lg border border-border/60 bg-muted/30 px-3 py-2.5">
      <div className="text-[10px] uppercase tracking-wide text-muted-foreground">{label}</div>
      <div className={`mt-0.5 text-sm font-semibold tabular-nums ${accent ?? ""}`}>{value}</div>
      {sub && <div className="mt-0.5 text-[10px] leading-snug text-muted-foreground/80">{sub}</div>}
    </div>
  );
}

function phaseLabel(p: LoadProgress): string {
  switch (p.phase) {
    case "download":
      return "Downloading";
    case "verify":
      return "Verifying checksum";
    case "decompress":
      return "Decompressing";
    case "parse":
      return "Parsing neurons";
    case "wire":
      return "Wiring the brain";
  }
}

function fileStamp(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}`;
}

export function ConnectomeTrainer() {
  const [core, setCore] = useState<ConnectomeRideCore | null>(null);
  const [progress, setProgress] = useState<LoadProgress | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [retryKey, setRetryKey] = useState(0);
  const retinaCanvas = useRef<HTMLCanvasElement | null>(null);
  const [hud, setHud] = useState<ConHudSnapshot | null>(null);
  const [running, setRunning] = useState(false);
  const [turbo, setTurbo] = useState(1);
  // single source of truth for the sliders; core.tuningSnapshot() is the echo
  const [tuning, setTuning] = useState<RideTuning>(DEFAULT_TUNING);

  // ---- one-time load of the real connectome (76 MB, sha-verified, cached
  // in CacheStorage — the download happens once, ever). The singleton core
  // survives tab switches, so the brain's lifetime learning persists.
  useEffect(() => {
    let cancelled = false;
    getRideCore((p) => {
      // microtask defer: the loader fires the first event synchronously,
      // and set-state-in-effect is error-level in this repo's lint config
      queueMicrotask(() => setProgress(p));
    })
      .then((c) => {
        if (cancelled) return;
        c.setRunning(false); // Round-14 manual start — never auto-run
        setCore(c);
        setTuning(c.tuningSnapshot());
      })
      .catch((e: unknown) => {
        if (cancelled) return;
        setError(e instanceof Error ? e.message : String(e));
      });
    return () => {
      cancelled = true;
    };
  }, [retryKey]);

  // ---- HUD polling (keeps React renders at ~6 Hz, the scene stays 60 fps)
  useEffect(() => {
    if (!core) return;
    const iv = setInterval(() => setHud(core.hudSnapshot()), 160);
    return () => clearInterval(iv);
  }, [core]);

  // ---- keep the R3F subtree out of the HUD re-render loop
  const canvasElement = useMemo(() => {
    if (!core) return null;
    return (
      <Canvas
        dpr={[1, 1.75]}
        camera={{ fov: 55, near: 0.1, far: 2200, position: [0, 2.8, -8] }}
        gl={{ antialias: true, powerPreference: "high-performance" }}
        style={{ position: "absolute", inset: 0 }}
      >
        <DuskScene core={core.sceneCore()} retinaCanvas={retinaCanvas} maxRiders={1} />
      </Canvas>
    );
  }, [core]);

  // ------------------------------------------------------------- controls
  const toggleRun = () => {
    const next = !running;
    setRunning(next);
    core?.setRunning(next);
    playSound("click");
  };

  const doReset = () => {
    if (!core) return;
    core.reset(); // fresh newborn brain — and it parks
    setRunning(false);
    setHud(core.hudSnapshot());
    setTuning(core.tuningSnapshot());
    playSound("click");
    toast.info("Fresh newborn brain", {
      description:
        "All 61,210 plastic synapses are back to newborn strength — episode 1 is ready. Press Start when you are.",
    });
  };

  const changeTurbo = (t: number) => {
    setTurbo(t);
    core?.setTurbo(t);
  };

  const changeTuning = (patch: Partial<RideTuning>) => {
    if (!core) return;
    core.setTuning(patch);
    setTuning(core.tuningSnapshot());
  };

  const resetTuning = () => {
    if (!core) return;
    core.setTuning(DEFAULT_TUNING);
    setTuning(core.tuningSnapshot());
    playSound("click");
    toast.info("Tuning reset", {
      description:
        "Back to the defaults — +0.05 sugar per metre, −0.6 PPL shock, η 0.04, sensory gain 50 Hz.",
    });
  };

  // ----------------------------------------------------------------- HUD
  const h = hud ?? (core ? core.hudSnapshot() : null);
  const episode = h?.episode ?? 1;
  const dist = h?.dist ?? 0;
  const best = h?.best ?? 0;
  const speed = h?.speed ?? 0;
  const lean = h?.lean ?? 0;
  const emaL = h?.emaL ?? 0;
  const emaR = h?.emaR ?? 0;
  const spikes = h?.spikesPerSec ?? 0;
  const active = h?.activeNeurons ?? 0;
  const dopamine = h?.dopamine ?? 0;
  const plastic = h?.plastic;
  const events = h?.events ?? [];
  const simSpeed = h?.simSpeed ?? 0;
  const neverStarted = h ? !h.everRan : true;
  const hasLearning = (plastic?.absDw ?? 0) > 0;
  const dopPct = Math.min(1, Math.abs(dopamine) / 3);

  // ------------------------------------------------------------- exports
  const exportMarkdown = () => {
    if (!core || !h) return;
    const p = h.plastic;
    const strongest = p.strongest
      ? `${core.circuit.labels.get(p.strongest.src) ?? `neuron ${p.strongest.src}`} → ${
          core.circuit.labels.get(p.strongest.dst) ?? `neuron ${p.strongest.dst}`
        } (w ${p.strongest.w.toFixed(3)})`
      : "none yet";
    const md = [
      "# Expert Fruit Fly — Connectome Ride report",
      "",
      `Generated: ${new Date().toISOString()}`,
      "",
      "One real MaleCNS brain, one bicycle, lifetime 3-factor learning — no evolution.",
      "",
      "## Session",
      "",
      "| Stat | Value |",
      "| --- | --- |",
      `| Episodes ridden | ${h.episode} |`,
      `| Best distance | ${h.best.toFixed(1)} m |`,
      `| Current distance | ${h.dist.toFixed(1)} m |`,
      `| Speed | ${h.speed.toFixed(2)} m/s |`,
      `| Active neurons | ${h.activeNeurons.toLocaleString()} / ${core.n.toLocaleString()} |`,
      `| KC spikes | ${h.kcPerSec.toFixed(1)} /s |`,
      `| MBON activity | ${h.mbon.toFixed(1)} Hz |`,
      "",
      "## Plastic synapses (KC→MBON)",
      "",
      "| Stat | Value |",
      "| --- | --- |",
      `| Plastic edges | ${core.circuit.plastic.edgeCount.toLocaleString()} |`,
      `| Synapses spanned | ${core.circuit.plastic.synapses.toLocaleString()} |`,
      `| Σ|Δw| learned | ${p.absDw.toFixed(3)} |`,
      `| Mean multiplier | ${p.meanW.toFixed(4)} |`,
      `| Potentiated (w > 1.01) | ${p.potentiated} |`,
      `| Depressed (w < 0.99) | ${p.depressed} |`,
      `| Heaviest change | ${strongest} |`,
      "",
      "## Tuning",
      "",
      `sugar ${h.tuning.sugarPerM}/m · PPL shock ${h.tuning.punishPPL} · η ${h.tuning.learningRate} · sensory gain ${h.tuning.sensoryGain} Hz · steer gain ${h.tuning.steerGain} · pedal gain ${h.tuning.pedalGain}`,
      "",
      "Data: MaleCNS v1.0 (Janelia) CC BY 4.0 · reference sim: Xenova/fruit-fly-simulation (MIT)",
    ].join("\n");
    const ok = downloadTextFile(
      `expert-fruit-fly-connectome-${fileStamp()}.md`,
      md,
      "text/markdown"
    );
    if (ok) {
      playSound("ding");
      toast.success("Report downloaded", {
        description: `${h.episode} episodes · Σ|Δw| ${p.absDw.toFixed(2)} of lifetime learning.`,
      });
    } else {
      toast.error("Download blocked", { description: "The browser refused the file download." });
    }
  };

  const exportWeightsJson = () => {
    if (!core || !h) return;
    const p = h.plastic;
    const payload = {
      kind: "connectome-ride-plasticity",
      neurons: core.n,
      edges: core.graph.edges,
      plasticEdges: core.circuit.plastic.edgeCount,
      episodes: h.episode,
      bestDistance: h.best,
      tuning: h.tuning,
      plastic: {
        absDw: p.absDw,
        meanW: p.meanW,
        potentiated: p.potentiated,
        depressed: p.depressed,
      },
      /** one multiplier per plastic KC→MBON edge (index-aligned with the
       *  circuit's per-KC CSR — see circuit.ts for the layout) */
      w: Array.from(core.circuit.plastic.w, (v) => Math.round(v * 10000) / 10000),
    };
    const ok = downloadTextFile(
      `expert-fruit-fly-connectome-weights-${fileStamp()}.json`,
      JSON.stringify(payload),
      "application/json"
    );
    if (ok) {
      playSound("ding");
      toast.success("Plastic weights exported", {
        description: `${core.circuit.plastic.edgeCount.toLocaleString()} KC→MBON multipliers as JSON.`,
      });
    } else {
      toast.error("Download blocked", { description: "The browser refused the file download." });
    }
  };

  // ---------------------------------------------------------------- render
  if (error) {
    return (
      <section className="flex flex-col gap-4">
        <Toaster theme="dark" position="bottom-right" closeButton />
        <Card className="border-rose-500/40">
          <CardHeader className="pb-3">
            <CardTitle className="flex items-center gap-2 text-lg">
              <BrainCircuit className="h-5 w-5 text-teal-400" aria-hidden />
              Connectome Ride — the brain didn&apos;t load
            </CardTitle>
            <CardDescription className="text-sm">
              The 76 MB connectome bundle failed to arrive. Completed chunks
              were kept, so retrying is cheap.
            </CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-3">
            <p className="rounded-lg border border-border/60 bg-muted/40 px-3 py-2 font-mono text-xs text-muted-foreground">
              {error}
            </p>
            <Button
              className="h-11 w-full gap-2 bg-teal-500 text-black hover:bg-teal-400 sm:w-auto"
              onClick={() => {
                setError(null);
                setProgress(null);
                setRetryKey((k) => k + 1);
              }}
              aria-label="Retry the connectome download"
            >
              <RotateCcw className="h-4 w-4" aria-hidden /> Retry download
            </Button>
          </CardContent>
        </Card>
      </section>
    );
  }

  if (!core) {
    const pct = progress && progress.total > 0
      ? Math.round((progress.done / progress.total) * 100)
      : 0;
    return (
      <section className="flex flex-col gap-4">
        <Toaster theme="dark" position="bottom-right" closeButton />
        <Card
          className="border-teal-500/30 bg-gradient-to-br from-[#0c2321] via-card to-[#14201f]"
          data-testid="con-loading"
        >
          <CardHeader className="pb-4">
            <div className="flex items-center gap-3">
              <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-gradient-to-br from-teal-500 to-emerald-600 text-white shadow-lg shadow-teal-900/40">
                <BrainCircuit className="h-5 w-5" aria-hidden />
              </div>
              <div className="min-w-0">
                <CardTitle className="text-lg">Connectome Ride — loading the real brain</CardTitle>
                <CardDescription className="mt-0.5 text-sm">
                  The complete MaleCNS connectome: 166,700 neurons, 25.5 million
                  synapses, checksum-verified.
                </CardDescription>
              </div>
            </div>
          </CardHeader>
          <CardContent className="flex flex-col gap-3">
            <Progress
              value={pct}
              className="h-2.5 bg-white/10 [&>div]:bg-teal-400"
              aria-label="Connectome download progress"
            />
            <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-muted-foreground">
              <span className="truncate">
                {progress
                  ? `${phaseLabel(progress)} · ${progress.file}`
                  : "Preparing…"}
              </span>
              <span className="font-mono tabular-nums">
                {progress ? `${progress.done} / ${progress.total} files · ${pct}%` : "…"}
              </span>
            </div>
            <p className="text-xs leading-relaxed text-muted-foreground">
              One-time download of 76 MB — every part is sha256-verified and
              cached in the browser, so future visits start instantly. The
              whole brain then lives in this tab&apos;s memory (~410 MB) and is
              reused for the rest of the session.
            </p>
          </CardContent>
        </Card>
      </section>
    );
  }

  return (
    <section className="flex flex-col gap-4">
      <Toaster theme="dark" position="bottom-right" closeButton />

      {/* ------------------------------------------------------- header */}
      <Card className="border-border/70 bg-gradient-to-br from-[#0c2321] via-card to-[#14201f]">
        <CardHeader className="pb-3">
          <div className="flex flex-wrap items-center gap-3">
            <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-gradient-to-br from-teal-500 to-emerald-600 text-white shadow-lg shadow-teal-900/40">
              <BrainCircuit className="h-5 w-5" aria-hidden />
            </div>
            <div className="min-w-0 flex-1">
              <CardTitle className="text-lg">Connectome Ride</CardTitle>
              <CardDescription className="mt-0.5 text-sm">
                One real fruit-fly brain — all 166,700 neurons — learns to ride
                the dusk road for its whole life. No evolution: only its{" "}
                {core.circuit.plastic.edgeCount.toLocaleString()} KC→MBON
                synapses change, gated by real dopamine.
              </CardDescription>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <Badge
                variant="secondary"
                className="gap-1.5 border-teal-500/30 bg-teal-500/10 font-mono text-teal-300"
              >
                <BrainCircuit className="h-3 w-3" aria-hidden /> 166,700 neurons
              </Badge>
              <Badge
                variant="secondary"
                className="gap-1.5 border-border/60 bg-black/40 font-mono text-foreground/80"
              >
                25.5M synapses
              </Badge>
              <Badge
                variant="secondary"
                className="gap-1.5 border-emerald-500/30 bg-emerald-500/10 font-mono text-emerald-300"
              >
                {core.circuit.plastic.edgeCount.toLocaleString()} plastic
              </Badge>
            </div>
          </div>
        </CardHeader>
      </Card>

      {/* ------------------------------------------------- main + side */}
      <div className="flex flex-col gap-4 lg:flex-row">
        {/* 3D canvas card — the SAME dusk world as the bicycle tab */}
        <Card className="min-w-0 flex-1 overflow-hidden p-0" data-testid="con-canvas-card">
          <div className="relative aspect-video min-h-[420px] w-full bg-[#150a1e]">
            {canvasElement}

            {/* HUD overlay */}
            <div className="pointer-events-none absolute inset-0 select-none">
              <div
                className="absolute left-3 top-3 flex flex-wrap items-center gap-2"
                data-testid="con-hud"
                data-con={`running:${running ? 1 : 0}|phase:${h?.phase ?? "riding"}|ep:${episode}|dist:${dist.toFixed(1)}|v:${speed.toFixed(2)}|emaL:${emaL.toFixed(1)}|emaR:${emaR.toFixed(1)}|spikes:${Math.round(spikes)}|active:${active}|dw:${(plastic?.absDw ?? 0).toFixed(3)}|dop:${dopamine.toFixed(3)}`}
              >
                <StatChip
                  label="Episode"
                  value={`#${episode}`}
                  accent="text-teal-300"
                  labelAccent="text-teal-300/90"
                />
                <StatChip label="Distance" value={`${dist.toFixed(0)} m`} />
                <StatChip label="Speed" value={`${speed.toFixed(1)} m/s`} />
              </div>
              <div className="absolute right-3 top-3 flex flex-col items-end gap-2">
                <StatChip
                  label="Best ever"
                  value={`${best.toFixed(0)} m`}
                  accent="text-teal-300"
                />
                <StatChip label="Spikes / s" value={spikes.toFixed(0)} />
                <StatChip
                  label="Active neurons"
                  value={active.toLocaleString()}
                />
              </div>

              {/* DN readout + lean + dopamine, bottom-left */}
              <div className="absolute bottom-3 left-3 flex items-end gap-3">
                <div className="rounded-lg border border-white/10 bg-black/40 px-2.5 py-2 backdrop-blur-md">
                  <div className="mb-1 text-[10px] uppercase tracking-wide text-teal-300/90">
                    DN readout
                  </div>
                  <div className="font-mono text-xs tabular-nums text-white/90">
                    <span className="text-teal-200/80">L</span>{" "}
                    {emaL.toFixed(1)} · <span className="text-teal-200/80">R</span>{" "}
                    {emaR.toFixed(1)} <span className="text-white/40">Hz</span>
                  </div>
                  <div className="mt-1.5 text-[10px] uppercase tracking-wide text-white/50">
                    Steer
                  </div>
                  <div className="relative h-1.5 w-14 rounded-full bg-white/10">
                    <div className="absolute left-1/2 top-0 h-full w-px bg-white/40" />
                    <div
                      className="absolute top-0 h-full rounded-full bg-teal-300"
                      style={(() => {
                        const total = emaR + emaL + 1e-6;
                        const asym = (emaR - emaL) / total; // +1 = hard right
                        return asym >= 0
                          ? { left: "50%", width: `${Math.min(1, asym) * 50}%` }
                          : { right: "50%", width: `${Math.min(1, -asym) * 50}%` };
                      })()}
                    />
                  </div>
                </div>
                <div className="rounded-lg border border-white/10 bg-black/40 px-2.5 py-2 backdrop-blur-md">
                  <div className="mb-1 text-[10px] uppercase tracking-wide text-white/50">
                    Lean
                  </div>
                  <div className="flex h-12 w-16 items-center justify-center">
                    <div
                      className="h-1.5 w-14 rounded-full bg-gradient-to-r from-rose-400 via-white/80 to-teal-300 shadow"
                      style={{
                        transform: `rotate(${(lean * (180 / Math.PI)).toFixed(1)}deg)`,
                      }}
                    />
                  </div>
                </div>
                <div className="w-36 rounded-lg border border-white/10 bg-black/40 px-2.5 py-2 backdrop-blur-md">
                  <div className="mb-1 flex items-center justify-between text-[10px] uppercase tracking-wide text-white/50">
                    <span>Dopamine</span>
                    <span className={dopamine >= 0 ? "text-emerald-300" : "text-rose-300"}>
                      {dopamine >= 0 ? "+" : ""}
                      {dopamine.toFixed(2)}
                    </span>
                  </div>
                  <div className="relative h-2 w-full overflow-hidden rounded-full bg-white/10">
                    <div className="absolute left-1/2 top-0 h-full w-px bg-white/40" />
                    <div
                      className={`absolute top-0 h-full ${
                        dopamine >= 0 ? "bg-teal-400" : "bg-rose-400"
                      }`}
                      style={
                        dopamine >= 0
                          ? { left: "50%", width: `${dopPct * 50}%` }
                          : { right: "50%", width: `${dopPct * 50}%` }
                      }
                    />
                  </div>
                </div>
              </div>

              {/* sim speed + turbo, bottom-right */}
              <div className="pointer-events-auto absolute bottom-3 right-3 flex items-center gap-2">
                <StatChip
                  label="Sim speed"
                  value={`×${simSpeed.toFixed(2)}`}
                  labelAccent="text-teal-300/90"
                />
                <TurboControl turbo={turbo} onChange={changeTurbo} />
              </div>

              {/* paused veil / start gate */}
              {!running && (
                <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 bg-black/35 p-4 backdrop-blur-[2px]">
                  <div className="flex items-center gap-2 rounded-full border border-white/15 bg-black/60 px-5 py-2.5 text-sm font-medium text-white/90">
                    {neverStarted ? (
                      <>
                        <Play className="h-4 w-4 text-teal-300" aria-hidden />
                        The real brain is wired — start when you are
                      </>
                    ) : (
                      <>
                        <Pause className="h-4 w-4" aria-hidden /> Paused — the
                        brain keeps its synapses
                      </>
                    )}
                  </div>
                  {neverStarted && (
                    <Button
                      onClick={toggleRun}
                      data-testid="con-start-overlay"
                      className="h-11 gap-2 bg-teal-500 text-black hover:bg-teal-400"
                      aria-label="Start riding"
                    >
                      <Play className="h-4 w-4" aria-hidden /> Start the ride
                    </Button>
                  )}
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
                <Activity className="h-4 w-4 text-teal-300" aria-hidden />
                What the fly sees
              </CardTitle>
              <CardDescription className="text-xs">
                The 24×9 retina — road stripe, edge lines, glow posts. Real LC4 /
                LC9 / LPLC2 neurons watch its columns.
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

          {/* controls */}
          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-sm">Ride controls</CardTitle>
              <CardDescription className="text-xs">
                One brain, many episodes — falls teach through the real PPL
                cluster, metres reward through the real PAM cluster.
              </CardDescription>
            </CardHeader>
            <CardContent className="flex flex-col gap-4">
              <div className="flex gap-2">
                <Button
                  onClick={toggleRun}
                  className="h-11 flex-1 gap-2 text-sm"
                  variant={running ? "secondary" : "default"}
                  data-testid="con-run-toggle"
                  aria-label={
                    running ? "Pause the ride" : neverStarted ? "Start the ride" : "Resume the ride"
                  }
                >
                  {running ? <Pause className="h-4 w-4" /> : <Play className="h-4 w-4" />}
                  {running ? "Pause" : neverStarted ? "Start" : "Play"}
                </Button>
                <Button
                  onClick={doReset}
                  className="h-11 flex-1 gap-2 text-sm"
                  variant="outline"
                  data-testid="con-reset"
                  aria-label="Reset to a fresh newborn brain"
                >
                  <RotateCcw className="h-4 w-4" /> Reset brain
                </Button>
              </div>

              <div>
                <div className="mb-2 flex items-center justify-between">
                  <Label className="text-xs text-muted-foreground">Turbo</Label>
                  <TurboControl turbo={turbo} onChange={changeTurbo} size="md" />
                </div>
                <p className="text-[11px] leading-snug text-muted-foreground">
                  Speeds up physics AND brain time together — capped by a ~8 ms
                  per-frame neural budget (the sim-speed chip shows what it
                  actually achieves).
                </p>
              </div>

              <Separator />

              {/* --- live tuning --------------------------------------- */}
              <div className="flex flex-col gap-3" data-testid="con-tuning-panel">
                <div className="flex items-center justify-between gap-2">
                  <Label className="flex items-center gap-1.5 text-sm">
                    <SlidersHorizontal className="h-4 w-4 text-teal-300" aria-hidden />{" "}
                    Tuning
                  </Label>
                  <button
                    type="button"
                    onClick={resetTuning}
                    data-testid="con-tuning-reset"
                    className="rounded-md border border-border/70 px-2.5 py-1 text-[11px] text-muted-foreground transition-colors hover:border-teal-500/50 hover:text-teal-200"
                    aria-label="Reset tuning to the validated defaults"
                  >
                    Reset defaults
                  </button>
                </div>
                <p className="text-[11px] leading-relaxed text-muted-foreground">
                  Every dopamine value and gain the brain feels — applied live,
                  mid-episode. The LIF wiring itself never changes.
                </p>

                <div className="flex flex-col gap-3 rounded-lg border border-border/60 bg-black/25 p-3">
                  <div className="flex flex-col gap-1.5">
                    <div className="flex items-center justify-between">
                      <Label htmlFor="con-tune-sugar" className="text-xs text-muted-foreground">
                        Sugar per metre
                      </Label>
                      <span className="font-mono text-xs tabular-nums text-teal-300">
                        +{tuning.sugarPerM.toFixed(3)}
                      </span>
                    </div>
                    <Slider
                      id="con-tune-sugar"
                      data-testid="con-tuning-sugar"
                      min={0}
                      max={0.2}
                      step={0.005}
                      value={[tuning.sugarPerM]}
                      onValueChange={(v) => changeTuning({ sugarPerM: v[0] })}
                    />
                    <p className="text-[10px] leading-snug text-muted-foreground/80">
                      PAM-cluster dopamine for every metre ridden — the
                      appetitive signal that potentiates recently-fired KC→MBON
                      synapses.
                    </p>
                  </div>

                  <div className="flex flex-col gap-1.5">
                    <div className="flex items-center justify-between">
                      <Label htmlFor="con-tune-shock" className="text-xs text-muted-foreground">
                        PPL shock
                      </Label>
                      <span className="font-mono text-xs tabular-nums text-rose-300">
                        {tuning.punishPPL.toFixed(2)}
                      </span>
                    </div>
                    <Slider
                      id="con-tune-shock"
                      data-testid="con-tuning-shock"
                      min={-2}
                      max={0}
                      step={0.05}
                      value={[tuning.punishPPL]}
                      onValueChange={(v) => changeTuning({ punishPPL: v[0] })}
                    />
                    <p className="text-[10px] leading-snug text-muted-foreground/80">
                      Aversive dopamine from the real PPL1/PPL2 cluster the
                      moment the rider falls (leaving the road costs ~70% of
                      it).
                    </p>
                  </div>

                  <div className="flex flex-col gap-1.5">
                    <div className="flex items-center justify-between">
                      <Label htmlFor="con-tune-lr" className="text-xs text-muted-foreground">
                        Learning rate η
                      </Label>
                      <span className="font-mono text-xs tabular-nums text-teal-300">
                        {tuning.learningRate.toFixed(3)}
                      </span>
                    </div>
                    <Slider
                      id="con-tune-lr"
                      data-testid="con-tuning-lr"
                      min={0}
                      max={0.2}
                      step={0.005}
                      value={[tuning.learningRate]}
                      onValueChange={(v) => changeTuning({ learningRate: v[0] })}
                    />
                    <p className="text-[10px] leading-snug text-muted-foreground/80">
                      Δw = η · dopamine · eligibility, clamped to [0, 2] — how
                      strongly each event rewrites the plastic synapses.
                    </p>
                  </div>

                  <div className="flex flex-col gap-1.5">
                    <div className="flex items-center justify-between">
                      <Label htmlFor="con-tune-sensory" className="text-xs text-muted-foreground">
                        Sensory gain
                      </Label>
                      <span className="font-mono text-xs tabular-nums text-teal-300">
                        {Math.round(tuning.sensoryGain)} Hz
                      </span>
                    </div>
                    <Slider
                      id="con-tune-sensory"
                      data-testid="con-tuning-sensory"
                      min={20}
                      max={400}
                      step={10}
                      value={[tuning.sensoryGain]}
                      onValueChange={(v) => changeTuning({ sensoryGain: v[0] })}
                    />
                    <p className="text-[10px] leading-snug text-muted-foreground/80">
                      Retina brightness → LC firing rate (plus an 8 Hz baseline).
                      Brighter road, louder visual neurons.
                    </p>
                  </div>

                  <div className="flex flex-col gap-1.5">
                    <div className="flex items-center justify-between">
                      <Label htmlFor="con-tune-steer" className="text-xs text-muted-foreground">
                        Steer gain
                      </Label>
                      <span className="font-mono text-xs tabular-nums text-teal-300">
                        {tuning.steerGain.toFixed(1)}
                      </span>
                    </div>
                    <Slider
                      id="con-tune-steer"
                      data-testid="con-tuning-steer"
                      min={0.2}
                      max={4}
                      step={0.1}
                      value={[tuning.steerGain]}
                      onValueChange={(v) => changeTuning({ steerGain: v[0] })}
                    />
                    <p className="text-[10px] leading-snug text-muted-foreground/80">
                      Handlebar authority from the left/right descending-neuron
                      asymmetry (clamped ±0.5 rad, exactly like the bicycle
                      tab).
                    </p>
                  </div>

                  <div className="flex flex-col gap-1.5">
                    <div className="flex items-center justify-between">
                      <Label htmlFor="con-tune-pedal" className="text-xs text-muted-foreground">
                        Pedal gain
                      </Label>
                      <span className="font-mono text-xs tabular-nums text-teal-300">
                        {tuning.pedalGain.toFixed(3)}
                      </span>
                    </div>
                    <Slider
                      id="con-tune-pedal"
                      data-testid="con-tuning-pedal"
                      min={0}
                      max={0.02}
                      step={0.001}
                      value={[tuning.pedalGain]}
                      onValueChange={(v) => changeTuning({ pedalGain: v[0] })}
                    />
                    <p className="text-[10px] leading-snug text-muted-foreground/80">
                      Extra pedal drive per Hz of mean descending activity — on
                      top of a 0.07 cruise floor, so the fly always rolls.
                    </p>
                  </div>
                </div>
              </div>
            </CardContent>
          </Card>

          {/* event feed */}
          <Card data-testid="con-event-feed">
            <CardHeader className="pb-2">
              <CardTitle className="flex items-center gap-2 text-sm">
                <Flag className="h-4 w-4 text-teal-300" aria-hidden />
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
                    Waiting for the first ride…
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

          {/* export */}
          <Card data-testid="con-export-card">
            <CardHeader className="pb-3">
              <CardTitle className="text-sm">Export the learning</CardTitle>
              <CardDescription className="text-xs">
                {hasLearning
                  ? `Σ|Δw| ${plastic?.absDw.toFixed(2)} of lifetime learning, ${plastic?.potentiated ?? 0} potentiated / ${plastic?.depressed ?? 0} depressed synapses.`
                  : "Ride a few metres first — then the plastic state is worth exporting."}
              </CardDescription>
            </CardHeader>
            <CardContent className="flex flex-col gap-2">
              <Button
                variant="outline"
                onClick={exportMarkdown}
                disabled={!hasLearning}
                data-testid="con-export-md"
                className="h-11 w-full gap-2"
                aria-label="Export a markdown report of this brain's session"
              >
                <FileText className="h-4 w-4" aria-hidden /> Markdown report
              </Button>
              <Button
                variant="outline"
                onClick={exportWeightsJson}
                disabled={!hasLearning}
                data-testid="con-export-json"
                className="h-11 w-full gap-2"
                aria-label="Export the plastic KC to MBON multipliers as JSON"
              >
                <FileJson className="h-4 w-4" aria-hidden /> Plastic weights JSON
              </Button>
            </CardContent>
          </Card>
        </div>
      </div>

      {/* --------------------------------------------- inside the brain */}
      <Card data-testid="con-stats">
        <CardHeader className="pb-2">
          <CardTitle className="flex items-center gap-2 text-sm">
            <Activity className="h-4 w-4 text-teal-300" aria-hidden />
            Inside the real brain
          </CardTitle>
          <CardDescription className="text-xs">
            Live activity of the actual circuit — Kenyon-cell spiking, MBON
            output, dopamine and the plastic synapses it flows through.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 xl:grid-cols-6">
            <StatTile
              label="KC spikes / s"
              value={(h?.kcPerSec ?? 0).toFixed(1)}
              accent="text-teal-300"
              sub={`${core.circuit.kc.length.toLocaleString()} Kenyon cells`}
            />
            <StatTile
              label="MBON activity"
              value={`${(h?.mbon ?? 0).toFixed(1)} Hz`}
              accent="text-teal-300"
              sub={`${core.circuit.mbon.length} output neurons`}
            />
            <StatTile
              label="Active neurons"
              value={active.toLocaleString()}
              sub={`of ${core.n.toLocaleString()}`}
            />
            <StatTile
              label="Plastic Σ|Δw|"
              value={(plastic?.absDw ?? 0).toFixed(3)}
              accent="text-teal-300"
              sub="total weight change"
            />
            <StatTile
              label="Potentiated"
              value={String(plastic?.potentiated ?? 0)}
              accent="text-emerald-400"
              sub="w &gt; 1.01"
            />
            <StatTile
              label="Depressed"
              value={String(plastic?.depressed ?? 0)}
              accent="text-rose-400"
              sub="w &lt; 0.99"
            />
          </div>

          {/* dopamine + heaviest synapse */}
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
            <div className="w-full sm:max-w-xs">
              <div className="mb-1 flex items-center justify-between text-[10px] uppercase tracking-wide text-muted-foreground">
                <span>Dopamine (PAM sugar / PPL shock)</span>
                <span className={dopamine >= 0 ? "text-emerald-400" : "text-rose-400"}>
                  {dopamine >= 0 ? "+" : ""}
                  {dopamine.toFixed(3)}
                </span>
              </div>
              <div className="relative h-2.5 w-full overflow-hidden rounded-full bg-muted/60">
                <div className="absolute left-1/2 top-0 h-full w-px bg-border" />
                <div
                  className={`absolute top-0 h-full ${dopamine >= 0 ? "bg-teal-400" : "bg-rose-400"}`}
                  style={
                    dopamine >= 0
                      ? { left: "50%", width: `${dopPct * 50}%` }
                      : { right: "50%", width: `${dopPct * 50}%` }
                  }
                />
              </div>
            </div>
            <p className="min-w-0 flex-1 text-xs text-muted-foreground">
              {plastic?.strongest ? (
                <>
                  Heaviest change:{" "}
                  <span className="font-mono text-teal-300">
                    {core.circuit.labels.get(plastic.strongest.src) ?? "?"} →{" "}
                    {core.circuit.labels.get(plastic.strongest.dst) ?? "?"}
                  </span>{" "}
                  (w {plastic.strongest.w.toFixed(3)}) · mean multiplier{" "}
                  {(plastic?.meanW ?? 1).toFixed(4)} across{" "}
                  {core.circuit.plastic.edgeCount.toLocaleString()} edges
                </>
              ) : (
                <>
                  No synapse has moved yet — ride a few metres and the first
                  KC→MBON multipliers will drift off newborn (mean w ={" "}
                  {(plastic?.meanW ?? 1).toFixed(4)}).
                </>
              )}
            </p>
          </div>
        </CardContent>
      </Card>

      {/* ------------------------------------------------- what's real */}
      <Card data-testid="con-explainer">
        <CardHeader className="pb-2">
          <CardTitle className="flex items-center gap-2 text-sm">
            <Info className="h-4 w-4 text-teal-300" aria-hidden />
            What&apos;s real here
          </CardTitle>
          <CardDescription className="text-xs">
            No random weights, no toy network — this tab runs the actual wiring
            of a real fly.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <ul className="flex flex-col gap-2 text-xs leading-relaxed text-muted-foreground">
            {[
              "Every neuron and every synapse comes from the real MaleCNS connectome (Janelia/HHMI + Google) — 166,700 neurons, 25.5 million directed edges, downloaded once and checksum-verified.",
              "Spiking is leaky-integrate-and-fire after Shiu et al. 2024 (Nature) — mV/ms units, parameters straight from the paper, nothing fitted to this task.",
              "The 61,210 Kenyon-cell → MBON synapses are the only plastic part: a three-factor rule (KC firing × dopamine × η) reshapes them over the fly's whole lifetime. No evolution, no population, no resets between episodes. Kenyon cells fire sparsely and spontaneously (~1 Hz, as in a real resting fly) — that sparse background is what the dopamine signal sculpts; the visual LC drive provably never reaches this (olfactory) mushroom body in the real wiring.",
              "Reward and punishment flow through the brain's real dopamine clusters: the PAM cluster (316 cells) fires for sugar, PPL1/PPL2 (24 cells) fire for falls — the same circuit a real fly learns with.",
              "Vision: LC4 / LC9 / LPLC2 neurons watch the 24×9 retina (left columns → left-side cells). The handlebars are steered by the left/right asymmetry of real descending neurons (DNa02, DNp09, DNg100, DNg97, DNa11, DNg13, MDN, DNp01).",
            ].map((text) => (
              <li key={text} className="flex items-start gap-2">
                <span
                  aria-hidden="true"
                  className="mt-1.5 inline-block h-1.5 w-1.5 shrink-0 rounded-full bg-teal-400/70"
                />
                <span>{text}</span>
              </li>
            ))}
          </ul>
          <p className="mt-3 border-t border-border/60 pt-3 text-[11px] leading-relaxed text-muted-foreground/80">
            Data: MaleCNS v1.0 (Janelia) CC BY 4.0 · reference sim:{" "}
            <span className="font-mono">Xenova/fruit-fly-simulation</span> (MIT)
            — the LIF engine is a faithful TypeScript port of its brain.js.
          </p>
        </CardContent>
      </Card>
    </section>
  );
}
