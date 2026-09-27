"use client";

/**
 * BrainLab — interactive explorer for the fruit fly brain.
 *
 * Owns a live demo FlyBrain (DEFAULT_ARCH_LAB, 926 neurons, 4 motors).
 * - animated visual stimulus (sweeping bars / sparkle / dark) fed to the
 *   retina at ~30 ticks/sec, drawn into a "what the fly sees" canvas
 * - Sugar (+dopamine) and Shock (−dopamine) buttons → classical conditioning
 * - stats row (ticks, spikes/s, dopamine, rewards/punishments) + motor bars
 * - click neurons in the 3D view to poke them (handled by BrainVisualizer3D)
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Slider } from "@/components/ui/slider";
import { Switch } from "@/components/ui/switch";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { BrainVisualizer3D } from "./BrainVisualizer3D";
import { BrainActivityPanel } from "./BrainActivityPanel";
import { FlyBrain } from "@/lib/flybrain/engine";
import { DEFAULT_ARCH_LAB } from "@/lib/flybrain/types";
import { cn } from "@/lib/utils";
import {
  Activity,
  Candy,
  Eye,
  FlaskConical,
  Pause,
  Play,
  RotateCcw,
  Zap,
} from "lucide-react";

export type BrainLabProps = Record<string, never>;

type Pattern = "sweep" | "two" | "sparkle" | "dark";

const TICK_RATE = 30; // brain ticks per second
const MOTOR_LABELS = ["Jump", "Duck", "Left", "Right"];
const PATTERN_LABELS: Record<Pattern, string> = {
  sweep: "Sweep bar",
  two: "Two bars",
  sparkle: "Random sparkle",
  dark: "Dark (silence)",
};

const RET_COLS = DEFAULT_ARCH_LAB.retinaCols;
const RET_ROWS = DEFAULT_ARCH_LAB.retinaRows;

function fmtInt(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return `${Math.round(n)}`;
}

function Stat({
  label,
  value,
  tone,
}: {
  label: string;
  value: string;
  tone?: "emerald" | "rose" | "amber";
}) {
  return (
    <div className="rounded-lg border border-border/60 bg-muted/30 px-2 py-1.5 text-center">
      <div
        className={cn(
          "font-mono text-sm tabular-nums",
          tone === "emerald" && "text-emerald-300",
          tone === "rose" && "text-rose-300",
          tone === "amber" && "text-amber-300",
          !tone && "text-foreground",
        )}
      >
        {value}
      </div>
      <div className="text-[10px] uppercase tracking-wide text-muted-foreground">{label}</div>
    </div>
  );
}

export function BrainLab(_props: BrainLabProps = {}) {
  // ---- React-visible state (low-frequency sync from the sim loop) ----
  // brain created with a lazy initializer — FlyBrain construction is pure,
  // deterministic and DOM-free, so it is safe during render (SSR included).
  const [brain, setBrain] = useState<FlyBrain>(() => new FlyBrain(DEFAULT_ARCH_LAB));
  const [running, setRunning] = useState(true);
  const [pattern, setPattern] = useState<Pattern>("sweep");
  const [speed, setSpeed] = useState(1);
  const [autoRotate, setAutoRotate] = useState(true);
  const [showSynapses, setShowSynapses] = useState(true);
  const [ui, setUi] = useState({
    ticks: 0,
    spikes: 0,
    da: 0,
    rewards: 0,
    punishments: 0,
  });
  const [motors, setMotors] = useState<number[]>([0, 0, 0, 0]);

  // ---- sim state that must NOT trigger re-renders (refs) ----
  const brainRef = useRef<FlyBrain>(brain);
  const runningRef = useRef(true);
  const patternRef = useRef<Pattern>("sweep");
  const speedRef = useRef(1);
  const pendingDaRef = useRef(0);
  const phaseRef = useRef(0);
  const sparkleRef = useRef(new Float32Array(RET_COLS * RET_ROWS));
  const spikeEmaRef = useRef(0);
  const retCanvasRef = useRef<HTMLCanvasElement | null>(null);

  // ---- brain lifecycle (reset button / brain swap) ----
  const bootBrain = useCallback(() => {
    const b = new FlyBrain(DEFAULT_ARCH_LAB);
    brainRef.current = b;
    setBrain(b);
    phaseRef.current = 0;
    sparkleRef.current.fill(0);
    pendingDaRef.current = 0;
    spikeEmaRef.current = 0;
    setUi({ ticks: 0, spikes: 0, da: 0, rewards: 0, punishments: 0 });
    setMotors(new Array(b.sizes.motor).fill(0));
  }, []);

  // ---- controls ----
  const toggleRunning = useCallback(() => {
    const next = !runningRef.current;
    runningRef.current = next;
    setRunning(next);
  }, []);

  const onPatternChange = useCallback((v: string) => {
    const p = (Object.keys(PATTERN_LABELS) as Pattern[]).includes(v as Pattern)
      ? (v as Pattern)
      : "sweep";
    patternRef.current = p;
    setPattern(p);
    if (p === "sparkle") sparkleRef.current.fill(0);
  }, []);

  const onSpeedChange = useCallback((v: number[]) => {
    const s = v[0] ?? 1;
    speedRef.current = s;
    setSpeed(s);
  }, []);

  const giveSugar = useCallback(() => {
    pendingDaRef.current = 1;
  }, []);

  const giveShock = useCallback(() => {
    pendingDaRef.current = -1;
  }, []);

  // ---- simulation loop: rAF accumulator at TICK_RATE ----
  useEffect(() => {
    if (!brain) return;
    const COLS = brain.arch.retinaCols;
    const ROWS = brain.arch.retinaRows;
    const input = new Float32Array(COLS * ROWS);
    const STEP_MS = 1000 / TICK_RATE;
    let raf = 0;
    let last = performance.now();
    let acc = 0;
    let lastUi = 0;
    let lastDraw = 0;

    const paintBar = (cx: number, w: number) => {
      for (let c = cx; c < cx + w; c++) {
        if (c < 0 || c >= COLS) continue;
        for (let r = 0; r < ROWS; r++) input[r * COLS + c] = 1;
      }
    };

    const computeInput = (dtSec: number) => {
      input.fill(0);
      const pat = patternRef.current;
      if (pat === "sweep" || pat === "two") {
        phaseRef.current = (phaseRef.current + dtSec * 0.3 * speedRef.current) % 1;
        paintBar(Math.floor(phaseRef.current * COLS), 2);
        if (pat === "two") {
          const p2 = COLS - 1 - Math.floor(((phaseRef.current + 0.5) % 1) * COLS);
          paintBar(p2 - 1, 2);
        }
        // sparse random dots (visual "noise" the fly also sees)
        for (let d = 0; d < 3; d++) {
          const i = Math.floor(Math.random() * input.length);
          input[i] = Math.max(input[i], 0.35 + Math.random() * 0.3);
        }
      } else if (pat === "sparkle") {
        const sp = sparkleRef.current;
        for (let i = 0; i < sp.length; i++) sp[i] *= 0.85;
        const n = 2 + Math.floor(Math.random() * 4);
        for (let d = 0; d < n; d++) {
          sp[Math.floor(Math.random() * sp.length)] = 0.75 + Math.random() * 0.25;
        }
        for (let i = 0; i < input.length; i++) input[i] = sp[i];
      }
      // "dark" → all zeros
    };

    const drawRetina = () => {
      const cv = retCanvasRef.current;
      if (!cv) return;
      const ctx = cv.getContext("2d");
      if (!ctx) return;
      ctx.fillStyle = "#07060a";
      ctx.fillRect(0, 0, COLS, ROWS);
      for (let r = 0; r < ROWS; r++) {
        for (let c = 0; c < COLS; c++) {
          const v = input[r * COLS + c];
          if (v <= 0.03) continue;
          const rr = Math.round(18 + 233 * v);
          const gg = Math.round(10 + 181 * v);
          const bb = Math.round(6 + 30 * v);
          ctx.fillStyle = `rgb(${rr},${gg},${bb})`;
          ctx.fillRect(c, r, 1, 1);
        }
      }
    };

    const tick = (dtSec: number) => {
      computeInput(dtSec);
      const da = pendingDaRef.current;
      pendingDaRef.current = 0;
      brain.step(input, da);
      let sum = 0;
      for (let i = 0; i < brain.spiked.length; i++) sum += brain.spiked[i];
      spikeEmaRef.current = spikeEmaRef.current * 0.9 + sum * 0.1;
    };

    const loop = (now: number) => {
      raf = requestAnimationFrame(loop);
      const dt = Math.min(120, now - last);
      last = now;
      if (runningRef.current) {
        acc += dt;
        let guard = 0;
        while (acc >= STEP_MS && guard < 6) {
          acc -= STEP_MS;
          tick(STEP_MS / 1000);
          guard++;
        }
        if (guard >= 6) acc = 0; // don't spiral after a background tab
        if (now - lastDraw > 33) {
          lastDraw = now;
          drawRetina();
        }
      }
      if (now - lastUi > 90) {
        lastUi = now;
        setUi({
          ticks: brain.steps,
          spikes: Math.round(spikeEmaRef.current * TICK_RATE),
          da: brain.getDopamine(),
          rewards: brain.rewards,
          punishments: brain.punishments,
        });
        setMotors(Array.from(brain.motorRates));
      }
    };
    raf = requestAnimationFrame(loop);
    drawRetina();
    return () => cancelAnimationFrame(raf);
  }, [brain]);

  const da = ui.da;

  return (
    <div className="space-y-4">
      {/* ---------- heading ---------- */}
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 className="flex items-center gap-2 text-lg font-semibold tracking-tight sm:text-xl">
            <FlaskConical className="h-5 w-5 text-primary" />
            Brain Lab
          </h2>
          <p className="mt-1 max-w-2xl text-sm text-muted-foreground">
            A live {brain ? brain.total : 926}-neuron fruit-fly connectome. Light flows from the
            retina sheets (front) through the optic lobes into the mushroom bodies (magenta) and
            out to the motor neurons (rear). Click neurons to inject current; teach the fly with
            sugar &amp; shock.
          </p>
        </div>
        <div className="flex shrink-0 gap-2">
          <Button
            variant="secondary"
            className="h-11 min-w-28 gap-2"
            onClick={toggleRunning}
            data-testid="btn-pause"
          >
            {running ? <Pause className="h-4 w-4" /> : <Play className="h-4 w-4" />}
            {running ? "Pause" : "Play"}
          </Button>
          <Button
            variant="outline"
            className="h-11 gap-2"
            onClick={bootBrain}
            data-testid="btn-reset"
          >
            <RotateCcw className="h-4 w-4" />
            Reset brain
          </Button>
        </div>
      </div>

      <div className="flex flex-col gap-4 lg:flex-row">
        {/* ---------- main column ---------- */}
        <div className="min-w-0 flex-1 space-y-4">
          <BrainVisualizer3D
            brain={brain}
            height="clamp(360px, 52vh, 500px)"
            autoRotate={autoRotate}
            showSynapses={showSynapses}
          />

          <Card className="gap-4 rounded-xl p-4">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div className="flex items-center gap-2 text-sm font-medium">
                <Activity className="h-4 w-4 text-primary" />
                Neuron activity — every cell, live
              </div>
              <div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-xs text-muted-foreground">
                <label className="flex cursor-pointer items-center gap-2">
                  <Switch checked={autoRotate} onCheckedChange={setAutoRotate} />
                  Auto-rotate
                </label>
                <label className="flex cursor-pointer items-center gap-2">
                  <Switch checked={showSynapses} onCheckedChange={setShowSynapses} />
                  Synapses
                </label>
              </div>
            </div>
            <BrainActivityPanel brain={brain} height={148} />
          </Card>
        </div>

        {/* ---------- right column ---------- */}
        <div className="w-full space-y-4 lg:w-80">
          {/* what the fly sees */}
          <Card className="gap-4 rounded-xl p-4">
            <div className="flex items-center gap-2 text-sm font-medium">
              <Eye className="h-4 w-4 text-primary" />
              What the fly sees
            </div>
            <canvas
              ref={retCanvasRef}
              width={RET_COLS}
              height={RET_ROWS}
              className="w-full rounded-md border border-border/60 bg-[#07060a] [image-rendering:pixelated]"
              style={{ aspectRatio: `${RET_COLS} / ${RET_ROWS}` }}
              role="img"
              aria-label="Retinal input — 24 by 9 pixel view of the fly's visual world"
            />
            <div className="space-y-3">
              <div className="space-y-1.5">
                <div className="text-xs text-muted-foreground">Pattern</div>
                <Select value={pattern} onValueChange={onPatternChange}>
                  <SelectTrigger className="h-11 w-full" aria-label="Stimulus pattern">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {(Object.keys(PATTERN_LABELS) as Pattern[]).map((p) => (
                      <SelectItem key={p} value={p} className="py-2">
                        {PATTERN_LABELS[p]}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-2">
                <div className="flex items-center justify-between text-xs text-muted-foreground">
                  <span>Pattern speed</span>
                  <span className="font-mono text-foreground/80">{speed.toFixed(1)}×</span>
                </div>
                <Slider
                  value={[speed]}
                  onValueChange={onSpeedChange}
                  min={0.2}
                  max={3}
                  step={0.1}
                  aria-label="Pattern speed"
                />
              </div>
            </div>
          </Card>

          {/* reward & punishment */}
          <Card className="gap-4 rounded-xl p-4">
            <div className="flex items-center justify-between gap-2">
              <div className="flex items-center gap-2 text-sm font-medium">
                <Candy className="h-4 w-4 text-primary" />
                Reward &amp; punishment
              </div>
              <Badge variant="outline" className="text-[10px] text-muted-foreground">
                dopamine-gated
              </Badge>
            </div>
            <div className="grid grid-cols-2 gap-2">
              <Button
                className="h-11 gap-1.5 border-emerald-500/40 bg-emerald-500/15 text-emerald-300 hover:bg-emerald-500/25"
                onClick={giveSugar}
                data-testid="btn-sugar"
              >
                <Candy className="h-4 w-4" />
                Sugar +1
              </Button>
              <Button
                className="h-11 gap-1.5 border-rose-500/40 bg-rose-500/15 text-rose-300 hover:bg-rose-500/25"
                onClick={giveShock}
                data-testid="btn-shock"
              >
                <Zap className="h-4 w-4" />
                Shock −1
              </Button>
            </div>
            {/* dopamine meter */}
            <div className="space-y-1.5">
              <div className="flex items-center justify-between text-xs text-muted-foreground">
                <span>Dopamine tone</span>
                <span
                  className={cn(
                    "font-mono tabular-nums",
                    da > 0.004 && "text-emerald-300",
                    da < -0.004 && "text-rose-300",
                  )}
                >
                  {da >= 0 ? "+" : ""}
                  {da.toFixed(2)}
                </span>
              </div>
              <div className="relative h-3 overflow-hidden rounded-full bg-muted/70">
                <div className="absolute inset-y-0 left-1/2 w-px bg-foreground/25" />
                <div
                  className="absolute inset-y-0 transition-all duration-100 ease-linear"
                  style={{
                    left: da >= 0 ? "50%" : `${50 + Math.max(-1, da) * 50}%`,
                    width: `${Math.min(50, Math.abs(da) * 50)}%`,
                    background: da >= 0 ? "#34d399" : "#fb7185",
                  }}
                />
              </div>
            </div>
            <p className="text-[11px] leading-relaxed text-muted-foreground">
              Tip: pair <span className="text-emerald-300">sugar</span> with a stimulus and watch
              the output neurons change — press Sugar just as the bar sweeps past the same spot;
              after ~10 pairings the motor bars below shift. Pair{" "}
              <span className="text-rose-300">shock</span> to teach avoidance.
            </p>
          </Card>

          {/* stats + motor output */}
          <Card className="gap-4 rounded-xl p-4">
            <div className="flex items-center gap-2 text-sm font-medium">
              <Activity className="h-4 w-4 text-primary" />
              Live stats &amp; motor output
            </div>
            <div className="grid grid-cols-3 gap-2">
              <Stat label="ticks" value={fmtInt(ui.ticks)} />
              <Stat label="spikes/s" value={fmtInt(ui.spikes)} />
              <Stat
                label="dopamine"
                value={`${da >= 0 ? "+" : ""}${da.toFixed(2)}`}
                tone={da > 0.004 ? "emerald" : da < -0.004 ? "rose" : undefined}
              />
              <Stat label="sugar Σ" value={fmtInt(ui.rewards)} tone="emerald" />
              <Stat label="shock Σ" value={fmtInt(ui.punishments)} tone="rose" />
              <Stat label="neurons" value={brain ? `${brain.total}` : "—"} tone="amber" />
            </div>
            <div className="space-y-2.5">
              {motors.map((v, i) => (
                <div key={i} className="flex items-center gap-2">
                  <span className="w-[84px] shrink-0 text-[11px] text-muted-foreground">
                    M{i + 1} · {MOTOR_LABELS[i] ?? "—"}
                  </span>
                  <div className="h-2.5 min-w-0 flex-1 overflow-hidden rounded-full bg-muted/70">
                    <div
                      className="h-full rounded-full bg-gradient-to-r from-amber-500 to-amber-300 transition-[width] duration-100 ease-linear"
                      style={{ width: `${Math.max(1.5, Math.min(100, v * 100))}%` }}
                    />
                  </div>
                  <span className="w-8 shrink-0 text-right font-mono text-[11px] tabular-nums">
                    {Math.round(v * 100)}
                  </span>
                </div>
              ))}
            </div>
            <p className="text-[11px] text-muted-foreground">
              Motor output = smoothed firing rates of the 4 motor neurons. In the wild these would
              drive jump / duck / turn maneuvers.
            </p>
          </Card>
        </div>
      </div>
    </div>
  );
}
