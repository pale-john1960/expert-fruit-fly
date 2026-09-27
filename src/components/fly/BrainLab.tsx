"use client";

/**
 * BrainLab — interactive explorer for the fruit fly brain.
 *
 * Owns a live demo FlyBrain (DEFAULT_ARCH_LAB, 928 neurons, 4 motors).
 * - animated visual stimulus fed to the retina at ~30 ticks/sec, drawn into
 *   a "what the fly sees" canvas (24×9): sweep / two bars / sparkle / dark,
 *   plus Bar left (A) / Bar right (B) conditioning stimuli, a looming
 *   shadow (expanding dark disc — escape stimulus) and optomotor drum
 *   stripes; all animated by the shared pattern-speed slider
 * - Sugar (+dopamine) and Shock (−dopamine) buttons → classical conditioning
 *   (with sound effects via @/lib/sound)
 * - Classical-conditioning demo wizard: 24 automatic A+/B− trials driven
 *   from the SAME rAF tick loop, with a per-trial learning index chart
 * - stats row (ticks, spikes/s, dopamine, rewards/punishments) + motor bars
 * - click neurons in the 3D view to poke + inspect them — the Neuron
 *   inspector card shows identity, live activity and the strongest
 *   outgoing/incoming synapses (plastic weights via the engine's public
 *   matrices, fixed wiring via getSampleEdges())
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
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
import { BrainVisualizer3D, REGION_META } from "./BrainVisualizer3D";
import { BrainActivityPanel } from "./BrainActivityPanel";
import { FlyBrain } from "@/lib/flybrain/engine";
import { DEFAULT_ARCH_LAB, type BrainRegion } from "@/lib/flybrain/types";
import { playSound } from "@/lib/sound";
import { cn } from "@/lib/utils";
import {
  CartesianGrid,
  Legend,
  ReferenceLine,
  ResponsiveContainer,
  Scatter,
  ScatterChart,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { motion } from "framer-motion";
import {
  Activity,
  Candy,
  Eye,
  FlaskConical,
  GraduationCap,
  Network,
  Pause,
  Play,
  RotateCcw,
  X,
  Zap,
} from "lucide-react";

export type BrainLabProps = Record<string, never>;

type Pattern =
  | "sweep"
  | "two"
  | "sparkle"
  | "dark"
  | "barLeft"
  | "barRight"
  | "loom"
  | "drum";

const TICK_RATE = 30; // brain ticks per second
const MOTOR_LABELS = ["Jump", "Duck", "Left", "Right"];
const PATTERN_LABELS: Record<Pattern, string> = {
  sweep: "Sweep bar",
  two: "Two bars",
  sparkle: "Random sparkle",
  dark: "Dark (silence)",
  barLeft: "Bar left (A)",
  barRight: "Bar right (B)",
  loom: "Looming shadow",
  drum: "Drum stripes",
};

/* ---- looming-shadow stimulus ---- */
const LOOM_PERIOD_S = 2; // one expand → reset cycle (at pattern speed 1×)
const LOOM_MAX_R = 9.5; // final radius ≈ 80 % of the 24×9 retina area

/* ---- optomotor drum stimulus ---- */
const DRUM_PERIOD = 6; // px per ON+OFF stripe pair at retina resolution
const DRUM_PX_S = 4; // scroll speed at pattern speed 1×

/* ---- classical-conditioning demo wizard ---- */
const DEMO_TRIALS = 24;
const DEMO_STIM_S = 3.0; // stimulus duration per trial (demo-time seconds)
const DEMO_PAUSE_S = 0.5; // dark inter-trial pause
const DEMO_REWARD_AT_S = 1.5; // sugar / shock lands mid-trial
const DEMO_SAMPLE_FROM_S = 2.0; // measurement window = final 1.0 s of stimulus

const RET_COLS = DEFAULT_ARCH_LAB.retinaCols;
const RET_ROWS = DEFAULT_ARCH_LAB.retinaRows;

function fmtInt(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return `${Math.round(n)}`;
}

function signed(n: number): string {
  return `${n >= 0 ? "+" : "−"}${Math.abs(n).toFixed(2)}`;
}

/* ------------------------------------------------------------------ */
/* neuron inspector                                                    */
/* ------------------------------------------------------------------ */

/** One plain-language line per region — the friendly science story. */
const REGION_DESC: Record<BrainRegion, string> = {
  retina: "Light sensor — graded, no spikes.",
  lamina: "First processing layer — contrast & adaptation.",
  medulla: "Feature extractor — 8 channels of motion/edge.",
  lobula: "Spiking pattern detector.",
  kenyon: "Mushroom body — sparse coincidence detector, where memories form.",
  mbon: "Mushroom body output — valence (appetitive/aversive) learned via dopamine.",
  motor: "Output — what the fly does.",
};

/** custom scrollbar, matching the app's list styling pattern */
const SCROLLBAR =
  "[&::-webkit-scrollbar]:w-2 [&::-webkit-scrollbar-track]:bg-transparent [&::-webkit-scrollbar-thumb]:rounded-full [&::-webkit-scrollbar-thumb]:bg-border";

/** rows shown in the inspector synapse list (strongest first; a kenyon cell's
 *  full 12-MBON column fits exactly) */
const INSP_MAX_ROWS = 12;

interface InspRow {
  toRegion: BrainRegion;
  toIdx: number; // index within the target region
  toGlobal: number;
  weight: number;
  plastic: boolean;
  /** MBON targets only: +1 appetitive / −1 aversive */
  valence?: number;
  /** retina → lamina 1:1 identity mapping */
  identity?: boolean;
}

interface InspData {
  rows: InspRow[];
  direction: "out" | "in";
  /** candidate count before the strongest-first cut */
  total: number;
  /** |weight| of the strongest row (bar scaling) */
  maxAbs: number;
  note: string;
  emptyText?: string;
}

function fmtW(w: number): string {
  const a = Math.abs(w);
  const digits = a >= 0.995 ? 1 : a < 0.01 ? 3 : 2;
  return `${w >= 0 ? "+" : "−"}${a.toFixed(digits)}`;
}

function regionIndexOf(
  brain: FlyBrain,
  gi: number,
): { region: BrainRegion; idx: number } | null {
  for (const rg of brain.regions) {
    if (gi >= rg.start && gi < rg.start + rg.count) {
      return { region: rg.region, idx: gi - rg.start };
    }
  }
  return null;
}

/** Build the inspector's synapse list for one neuron. Called on selection
 *  change / brain swap / dopamine event — never per tick (getSampleEdges is
 *  cached in the engine; filtering ~520 edges is trivial).
 *
 *  Plastic weights come from the engine's PUBLIC matrices
 *  (kenyonToMbon / mbonToMotor / lobulaToMotor — index math per the engine
 *  comments); the fixed wiring (retina→lamina identity, lamina→medulla,
 *  medulla→lobula, lobula→kenyon) is private and only visible through the
 *  sampled edges. */
function buildInspectorRows(brain: FlyBrain, gi: number): InspData | null {
  const loc = regionIndexOf(brain, gi);
  if (!loc) return null;
  const { region, idx } = loc;
  const s = brain.sizes;
  const rows: InspRow[] = [];
  const seen = new Set<number>();
  const push = (r: InspRow) => {
    if (seen.has(r.toGlobal)) return;
    seen.add(r.toGlobal);
    rows.push(r);
  };
  // the visualizer's fixed-wiring sample, filtered to this cell's outputs
  const sampled: InspRow[] = [];
  for (const e of brain.getSampleEdges()) {
    if (e.from !== gi) continue;
    const t = regionIndexOf(brain, e.to);
    if (!t) continue;
    sampled.push({
      toRegion: t.region,
      toIdx: t.idx,
      toGlobal: e.to,
      weight: e.weight,
      plastic: e.plastic,
      valence: t.region === "mbon" ? brain.mbonValence[t.idx] : undefined,
    });
  }

  const finalize = (direction: "out" | "in", note: string, emptyText?: string): InspData => {
    const total = rows.length;
    rows.sort((a, b) => Math.abs(b.weight) - Math.abs(a.weight));
    const shown = rows.slice(0, INSP_MAX_ROWS);
    let maxAbs = 1e-6;
    for (const r of shown) maxAbs = Math.max(maxAbs, Math.abs(r.weight));
    return { rows: shown, direction, total, maxAbs, note, emptyText };
  };

  if (region === "kenyon") {
    // the full Kenyon→MBON column: all 12 MBONs, plastic (the memory trace)
    const mb = brain.range("mbon");
    for (let m = 0; m < s.mbon; m++) {
      push({
        toRegion: "mbon",
        toIdx: m,
        toGlobal: mb.start + m,
        weight: brain.kenyonToMbon[m * s.kenyon + idx],
        plastic: true,
        valence: brain.mbonValence[m],
      });
    }
    return finalize(
      "out",
      "All 12 Kenyon→MBON synapses of this cell (its full column) — plastic, dopamine-gated: sugar and shock rewrite these weights. This is where the fly's memories live.",
    );
  }
  if (region === "mbon") {
    // its full row of mbonToMotor
    const mo = brain.range("motor");
    for (let o = 0; o < s.motor; o++) {
      push({
        toRegion: "motor",
        toIdx: o,
        toGlobal: mo.start + o,
        weight: brain.mbonToMotor[o * s.mbon + idx],
        plastic: true,
      });
    }
    return finalize(
      "out",
      "All MBON→motor synapses of this cell — plastic, dopamine-gated. Its valence decides whether the fly approaches or avoids.",
    );
  }
  if (region === "lobula") {
    // giant-fiber escape reflex (lobula→motor, plastic) + fixed wiring sample
    const mo = brain.range("motor");
    for (let o = 0; o < s.motor; o++) {
      push({
        toRegion: "motor",
        toIdx: o,
        toGlobal: mo.start + o,
        weight: brain.lobulaToMotor[o * s.lobula + idx],
        plastic: true,
      });
    }
    for (const r of sampled) push(r);
    return finalize(
      "out",
      "Giant-fiber escape reflex (lobula→motor, plastic — the 2-synapse jump path) plus its fixed wiring into the mushroom body (sampled).",
    );
  }
  if (region === "retina") {
    // retina→lamina is a clean 1:1 map — deterministic, no sampling needed
    const la = brain.range("lamina");
    push({
      toRegion: "lamina",
      toIdx: idx,
      toGlobal: la.start + idx,
      weight: 1,
      plastic: false,
      identity: true,
    });
    for (const r of sampled) push(r);
    return finalize(
      "out",
      "Retina→lamina is a 1:1 map: this cell feeds the lamina cell of the same index (weight 1, fixed for life).",
    );
  }
  if (region === "lamina" || region === "medulla") {
    for (const r of sampled) push(r);
    return finalize(
      "out",
      region === "lamina"
        ? "Fixed wiring, sampled — the full lamina→medulla fan-out is thousands of connections."
        : "Fixed wiring, sampled — medulla pools feed the lobula's spiking pattern detectors.",
      "This cell's exact wiring didn't make it into the 520-edge visual sample — the full fixed wiring lives inside the engine (thousands of edges).",
    );
  }
  if (region === "motor") {
    // motor neurons have no outgoing synapses → show incoming plastic drives
    const lo = brain.range("lobula");
    for (let l = 0; l < s.lobula; l++) {
      push({
        toRegion: "lobula",
        toIdx: l,
        toGlobal: lo.start + l,
        weight: brain.lobulaToMotor[idx * s.lobula + l],
        plastic: true,
      });
    }
    const mb = brain.range("mbon");
    for (let m = 0; m < s.mbon; m++) {
      push({
        toRegion: "mbon",
        toIdx: m,
        toGlobal: mb.start + m,
        weight: brain.mbonToMotor[idx * s.mbon + m],
        plastic: true,
        valence: brain.mbonValence[m],
      });
    }
    return finalize(
      "in",
      "Motor neurons have no outgoing synapses — they are the output. Shown: the strongest incoming plastic drives, lobula giant-fiber (escape) and MBON valence, both dopamine-gated.",
    );
  }
  return null;
}

/** region badge that matches the 3D legend colors (REGION_META is shared
 *  with the visualizer); MBON badges carry their valence */
function RegionBadge({ region, valence }: { region: BrainRegion; valence?: number }) {
  const meta = REGION_META[region];
  return (
    <span className="inline-flex items-center gap-1.5 rounded-md border border-border/60 bg-muted/30 px-1.5 py-0.5 text-[10px] font-medium text-foreground/90">
      <span className="h-1.5 w-1.5 shrink-0 rounded-full" style={{ background: meta.color }} />
      {meta.label}
      {valence != null && (
        <span className={valence > 0 ? "text-emerald-300" : "text-rose-300"}>
          {valence > 0 ? "appetitive" : "aversive"}
        </span>
      )}
    </span>
  );
}

/** one synapse row: target badge + centered-zero weight bar + plasticity chip */
function InspectorRowView({ row, maxAbs }: { row: InspRow; maxAbs: number }) {
  const mag = Math.min(1, Math.abs(row.weight) / maxAbs);
  const pos = row.weight >= 0;
  return (
    <div className="rounded-md border border-border/50 bg-muted/20 px-2 py-1.5">
      <div className="flex items-center justify-between gap-2">
        <span className="flex min-w-0 items-center gap-1 text-[11px]">
          <span
            className="h-1.5 w-1.5 shrink-0 rounded-full"
            style={{ background: REGION_META[row.toRegion].color }}
          />
          <span className="truncate">{REGION_META[row.toRegion].label}</span>
          <span className="font-mono text-muted-foreground">#{row.toIdx}</span>
        </span>
        <span className="flex shrink-0 items-center gap-1.5">
          {row.valence != null && (
            <span
              className={cn(
                "text-[9px] font-medium",
                row.valence > 0 ? "text-emerald-300" : "text-rose-300",
              )}
            >
              {row.valence > 0 ? "▲ appetitive" : "▼ aversive"}
            </span>
          )}
          <span
            className={cn(
              "font-mono text-[10px] tabular-nums",
              pos ? "text-emerald-300" : "text-rose-300",
            )}
          >
            {fmtW(row.weight)}
          </span>
        </span>
      </div>
      <div className="mt-1 flex items-center gap-2">
        <div className="relative h-1.5 min-w-0 flex-1 overflow-hidden rounded-full bg-muted/70">
          <div className="absolute inset-y-0 left-1/2 w-px bg-foreground/25" />
          <div
            className="absolute inset-y-0 rounded-full"
            style={{
              left: pos ? "50%" : `${50 - mag * 50}%`,
              width: `${Math.max(2, mag * 50)}%`,
              background: pos ? "#34d399" : "#fb7185",
            }}
          />
        </div>
        <span
          className={cn(
            "shrink-0 rounded border px-1 text-[9px] uppercase tracking-wide",
            row.plastic
              ? "border-amber-500/40 text-amber-300"
              : "border-border/60 text-muted-foreground",
          )}
        >
          {row.identity ? "1:1" : row.plastic ? "plastic ±" : "fixed"}
        </span>
      </div>
    </div>
  );
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

/* ------------------------------------------------------------------ */
/* demo wizard types                                                    */
/* ------------------------------------------------------------------ */

type DemoPhase = "stimulus" | "reward" | "pause";
type DemoLetter = "A" | "B";

/** One measured trial of the conditioning demo.
 *
 *  index    = MEASUREMENT (plotted): mean motor approach drive, i.e. the
 *             average of all 4 smoothed motorRates sampled across the final
 *             1 s of the 3 s stimulus. Validated against the real engine
 *             (see worklog 7-b): it is the sensitive readout — reward-paired
 *             A holds approach high while shock-paired B suppresses it, and
 *             the effect compounds on repeated runs. valence = secondary
 *             index: mean(appetitive MBON rates) − mean(aversive MBON rates)
 *             (region indices via brain.range("mbon") + brain.mbonValence);
 *             at only 12 pairings it stays within ±0.02 noise, so it is kept
 *             for the tooltip/record but not plotted. */
interface DemoTrialPoint {
  trial: number; // 1-based
  letter: DemoLetter;
  index: number;
  valence: number;
}

interface DemoResult {
  points: DemoTrialPoint[];
  /** first-4 → last-4 average change per stimulus (the "verdict" numbers) */
  dA: number;
  dB: number;
  gapEarly: number;
  gapLate: number;
  baseline: number;
  run: number;
}

interface DemoHud {
  status: "idle" | "running" | "done";
  trial: number; // 0-based
  phase: DemoPhase;
  letter: DemoLetter | null;
  progress: number; // 0..1
}

interface DemoRuntime {
  running: boolean;
  trial: number; // 0-based
  t: number; // demo-time seconds inside the current trial
  delivered: boolean;
  valSum: number;
  apprSum: number;
  n: number;
  points: DemoTrialPoint[];
}

const DEMO_HUD_IDLE: DemoHud = {
  status: "idle",
  trial: 0,
  phase: "stimulus",
  letter: null,
  progress: 0,
};

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
  const [demoHud, setDemoHud] = useState<DemoHud>(DEMO_HUD_IDLE);
  const [demoResult, setDemoResult] = useState<DemoResult | null>(null);

  // ---- neuron inspector (selection lives here; the visualizer renders the
  //      ring, this card renders the data) ----
  const [selNeuron, setSelNeuron] = useState<number | null>(null);
  /** live values for the selected cell, synced at the existing ~11 Hz cadence */
  const [selLive, setSelLive] = useState<{ rate: number; spiked: boolean } | null>(null);
  /** increment → the visualizer pokes the selected neuron (click-identical) */
  const [pokeNonce, setPokeNonce] = useState(0);

  // ---- sim state that must NOT trigger re-renders (refs) ----
  const brainRef = useRef<FlyBrain>(brain);
  const runningRef = useRef(true);
  const patternRef = useRef<Pattern>("sweep");
  const speedRef = useRef(1);
  const pendingDaRef = useRef(0);
  const phaseRef = useRef(0);
  const sparkleRef = useRef(new Float32Array(RET_COLS * RET_ROWS));
  const drumRef = useRef(0); // optomotor drum scroll offset (px)
  const spikeEmaRef = useRef(0);
  const retCanvasRef = useRef<HTMLCanvasElement | null>(null);

  // ---- demo wizard runtime (refs; HUD syncs at the existing ~11 Hz) ----
  const demoRef = useRef<DemoRuntime>({
    running: false,
    trial: 0,
    t: 0,
    delivered: false,
    valSum: 0,
    apprSum: 0,
    n: 0,
    points: [],
  });
  /** the user's stimulus selection before the wizard took over the projector */
  const demoPrevPatternRef = useRef<Pattern | null>(null);
  const demoRunsRef = useRef(0);

  // ---- neuron inspector runtime (refs; UI syncs at the existing ~11 Hz) ----
  const selRef = useRef<number | null>(null);
  /** show the SPIKED chip until this timestamp (spike flags last 1 tick) */
  const selSpikeUntilRef = useRef(0);

  // keep the loop's view of the selection current (live data resets happen
  // in the event handlers below — never setState inside this effect)
  useEffect(() => {
    selRef.current = selNeuron;
  }, [selNeuron]);

  // ---- demo wizard control ----
  const startDemo = useCallback(() => {
    const d = demoRef.current;
    if (d.running) return;
    d.running = true;
    d.trial = 0;
    d.t = 0;
    d.delivered = false;
    d.valSum = 0;
    d.apprSum = 0;
    d.n = 0;
    d.points = [];
    demoPrevPatternRef.current = patternRef.current;
    setDemoResult(null);
    setDemoHud({ status: "running", trial: 0, phase: "stimulus", letter: "A", progress: 0 });
    // a paused brain would stall the wizard — bring the sim back with it
    if (!runningRef.current) {
      runningRef.current = true;
      setRunning(true);
    }
    playSound("click", 0.6);
  }, []);

  const abortDemo = useCallback(() => {
    const d = demoRef.current;
    if (!d.running) return;
    d.running = false;
    const prev = demoPrevPatternRef.current;
    if (prev) {
      patternRef.current = prev;
      setPattern(prev);
      demoPrevPatternRef.current = null;
    }
    // brain state is about to change — old measurements are stale
    setDemoResult(null);
    setDemoHud(DEMO_HUD_IDLE);
  }, []);

  // ---- brain lifecycle (reset button / brain swap) ----
  const bootBrain = useCallback(() => {
    abortDemo(); // "Reset brain" during a demo aborts the wizard cleanly
    const b = new FlyBrain(DEFAULT_ARCH_LAB);
    brainRef.current = b;
    setBrain(b);
    phaseRef.current = 0;
    drumRef.current = 0;
    sparkleRef.current.fill(0);
    pendingDaRef.current = 0;
    spikeEmaRef.current = 0;
    demoRunsRef.current = 0;
    setDemoHud(DEMO_HUD_IDLE);
    setUi({ ticks: 0, spikes: 0, da: 0, rewards: 0, punishments: 0 });
    setMotors(new Array(b.sizes.motor).fill(0));
  }, [abortDemo]);

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
    playSound("sugar");
  }, []);

  const giveShock = useCallback(() => {
    pendingDaRef.current = -1;
    playSound("shock");
  }, []);

  // ---- neuron inspector controls ----
  const handleNeuronSelect = useCallback(
    (gi: number | null) => {
      setSelNeuron(gi);
      // a fresh cell never inherits the previous cell's SPIKED chip
      selSpikeUntilRef.current = 0;
      setSelLive(gi == null ? null : { rate: brain.rates[gi] ?? 0, spiked: false });
    },
    [brain],
  );

  const pokeSelected = useCallback(() => {
    // the visualizer performs the poke (current + pop) via pokeNonce — the
    // exact same path as clicking the neuron in the 3D view
    playSound("click", 0.5);
    setPokeNonce((n) => n + 1);
  }, []);

  const clearSelection = useCallback(() => {
    playSound("click", 0.4);
    selSpikeUntilRef.current = 0;
    setSelNeuron(null);
    setSelLive(null);
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

    // MBON compartment indices (global neuron ids) for the valence index
    const mb = brain.range("mbon");
    const mbonApp: number[] = [];
    const mbonAve: number[] = [];
    for (let m = 0; m < brain.sizes.mbon; m++) {
      (brain.mbonValence[m] === 1 ? mbonApp : mbonAve).push(mb.start + m);
    }

    const paintBar = (cx: number, w: number) => {
      for (let c = cx; c < cx + w; c++) {
        if (c < 0 || c >= COLS) continue;
        for (let r = 0; r < ROWS; r++) input[r * COLS + c] = 1;
      }
    };

    const computeInput = (dtSec: number) => {
      input.fill(0);
      let pat = patternRef.current;
      const d = demoRef.current;
      if (d.running) {
        // the wizard owns the projector while it runs: the trial's
        // conditioning stimulus, or darkness during the inter-trial pause
        pat =
          d.t < DEMO_STIM_S
            ? d.trial % 2 === 0
              ? "barLeft"
              : "barRight"
            : "dark";
      }
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
      } else if (pat === "barLeft" || pat === "barRight") {
        // conditioning stimuli A / B: a steady bright bar filling one
        // third of the retina (left or right)
        const third = Math.max(1, Math.round(COLS / 3));
        paintBar(pat === "barLeft" ? 0 : COLS - third, third);
      } else if (pat === "loom") {
        // looming shadow (classic fly escape stimulus): a bright field with
        // an expanding dark disc. Radius eases 0 → ~80 % coverage over
        // LOOM_PERIOD_S, then snaps back — the sweep + reset produce heavy
        // ON/OFF transients that light up the optic lobes. A thin bright
        // leading rim keeps the expanding edge visible at 24×9 pixels.
        phaseRef.current += (dtSec * speedRef.current) / LOOM_PERIOD_S;
        if (phaseRef.current >= 1) phaseRef.current -= 1;
        const R = LOOM_MAX_R * (1 - Math.pow(1 - phaseRef.current, 2));
        input.fill(0.85);
        const cx = (COLS - 1) / 2;
        const cy = (ROWS - 1) / 2;
        for (let r = 0; r < ROWS; r++) {
          const dy = r - cy;
          for (let c = 0; c < COLS; c++) {
            const dx = c - cx;
            const dist = Math.sqrt(dx * dx + dy * dy);
            if (dist <= R) input[r * COLS + c] = 0;
            else if (dist <= R + 1.3) input[r * COLS + c] = 1;
          }
        }
      } else if (pat === "drum") {
        // optomotor drum: alternating vertical stripes (~6 px period)
        // scrolling horizontally; speed follows the pattern-speed slider
        drumRef.current =
          (drumRef.current + dtSec * speedRef.current * DRUM_PX_S) % DRUM_PERIOD;
        const off = drumRef.current;
        for (let c = 0; c < COLS; c++) {
          if ((c + off) % DRUM_PERIOD < DRUM_PERIOD / 2) paintBar(c, 1);
        }
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

    // ---- demo wizard: clock / reward delivery (before brain.step) ----
    const finishDemo = () => {
      const d = demoRef.current;
      d.running = false;
      // hand the projector back to the user's previous stimulus choice
      const prev = demoPrevPatternRef.current;
      if (prev) {
        patternRef.current = prev;
        setPattern(prev);
        demoPrevPatternRef.current = null;
      }
      // verdict: first-4 vs last-4 trial averages per stimulus
      const pts = d.points;
      const meanIdx = (xs: DemoTrialPoint[]) =>
        xs.length ? xs.reduce((a, p) => a + p.index, 0) / xs.length : 0;
      const aPts = pts.filter((p) => p.letter === "A");
      const bPts = pts.filter((p) => p.letter === "B");
      setDemoResult({
        points: pts.slice(),
        dA: meanIdx(aPts.slice(-4)) - meanIdx(aPts.slice(0, 4)),
        dB: meanIdx(bPts.slice(-4)) - meanIdx(bPts.slice(0, 4)),
        gapEarly: meanIdx(aPts.slice(0, 4)) - meanIdx(bPts.slice(0, 4)),
        gapLate: meanIdx(aPts.slice(-4)) - meanIdx(bPts.slice(-4)),
        baseline: meanIdx(pts.slice(0, 4)),
        run: (demoRunsRef.current += 1),
      });
      setDemoHud({ status: "done", trial: DEMO_TRIALS, phase: "pause", letter: null, progress: 1 });
      playSound("milestone", 0.7);
    };

    const demoPre = (dtSec: number) => {
      const d = demoRef.current;
      if (!d.running) return;
      // the demo clock rides the same pattern-speed slider
      d.t += dtSec * speedRef.current;
      const letter: DemoLetter = d.trial % 2 === 0 ? "A" : "B";
      if (!d.delivered && d.t >= DEMO_REWARD_AT_S && d.t < DEMO_STIM_S) {
        d.delivered = true;
        // same mechanism as the Sugar / Shock buttons: pending dopamine
        pendingDaRef.current = letter === "A" ? 1 : -1;
        playSound(letter === "A" ? "sugar" : "shock", 0.8);
      }
      if (d.t >= DEMO_STIM_S + DEMO_PAUSE_S) {
        // trial over: freeze the measurement and move on
        const n = Math.max(1, d.n);
        d.points.push({
          trial: d.trial + 1,
          letter,
          index: d.apprSum / n,
          valence: d.valSum / n,
        });
        d.trial += 1;
        d.t = 0;
        d.delivered = false;
        d.valSum = 0;
        d.apprSum = 0;
        d.n = 0;
        if (d.trial >= DEMO_TRIALS) finishDemo();
      }
    };

    // ---- demo wizard: measurement sampling (after brain.step) ----
    const demoPost = () => {
      const d = demoRef.current;
      if (!d.running) return;
      if (d.t < DEMO_SAMPLE_FROM_S || d.t >= DEMO_STIM_S) return;
      let ms = 0;
      for (let i = 0; i < brain.motorRates.length; i++) ms += brain.motorRates[i];
      d.apprSum += ms / brain.motorRates.length;
      let va = 0;
      for (let i = 0; i < mbonApp.length; i++) va += brain.rates[mbonApp[i]];
      let vb = 0;
      for (let i = 0; i < mbonAve.length; i++) vb += brain.rates[mbonAve[i]];
      d.valSum += va / mbonApp.length - vb / mbonAve.length;
      d.n++;
    };

    const tick = (dtSec: number) => {
      demoPre(dtSec);
      computeInput(dtSec);
      const da = pendingDaRef.current;
      pendingDaRef.current = 0;
      brain.step(input, da);
      let sum = 0;
      for (let i = 0; i < brain.spiked.length; i++) sum += brain.spiked[i];
      spikeEmaRef.current = spikeEmaRef.current * 0.9 + sum * 0.1;
      // hold the inspected cell's SPIKED chip briefly so the ~11 Hz UI sync
      // can never miss a 1-tick spike flag
      const selTick = selRef.current;
      if (selTick != null && brain.spiked[selTick]) {
        selSpikeUntilRef.current = performance.now() + 300;
      }
      demoPost();
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
        // neuron inspector live values ride the same cadence (never per frame)
        const selUi = selRef.current;
        if (selUi != null) {
          setSelLive({
            rate: brain.rates[selUi] ?? 0,
            spiked: performance.now() < selSpikeUntilRef.current,
          });
        }
        // demo HUD joins the existing ~11 Hz UI cadence (no extra renders)
        const d = demoRef.current;
        if (d.running) {
          const phase: DemoPhase =
            d.t >= DEMO_STIM_S
              ? "pause"
              : d.t >= DEMO_REWARD_AT_S && d.t < DEMO_REWARD_AT_S + 0.7
                ? "reward"
                : "stimulus";
          const progress = Math.min(
            1,
            (d.trial + d.t / (DEMO_STIM_S + DEMO_PAUSE_S)) / DEMO_TRIALS
          );
          setDemoHud({
            status: "running",
            trial: d.trial,
            phase,
            letter: d.trial % 2 === 0 ? "A" : "B",
            progress,
          });
        }
      }
    };
    raf = requestAnimationFrame(loop);
    drawRetina();
    return () => cancelAnimationFrame(raf);
  }, [brain]);

  const da = ui.da;

  // ---- demo result block (memoized: the 11 Hz stat re-renders must not
  //      churn the recharts tree) ----
  const demoResultBlock = useMemo(() => {
    if (!demoResult) return null;
    const aPts = demoResult.points
      .filter((p) => p.letter === "A")
      .map((p) => ({ x: p.trial, y: p.index, valence: p.valence }));
    const bPts = demoResult.points
      .filter((p) => p.letter === "B")
      .map((p) => ({ x: p.trial, y: p.index, valence: p.valence }));
    const aPhrase =
      demoResult.dA >= 0
        ? `A now excites approach (${signed(demoResult.dA)})`
        : `A now dampens approach (${signed(demoResult.dA)})`;
    const bPhrase =
      demoResult.dB <= 0
        ? `B suppresses it (${signed(demoResult.dB)})`
        : `B excites it (${signed(demoResult.dB)})`;
    return (
      <motion.div
        key={demoResult.run}
        initial={{ opacity: 0, y: 6 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.35, ease: "easeOut" }}
        className="space-y-2.5"
      >
        <div
          className="rounded-lg border border-border/60 bg-[#07060a]/60 p-2"
          data-testid="demo-chart"
          role="img"
          aria-label="Learning index per trial: A trials in emerald, B trials in rose"
        >
          <div className="h-[150px] w-full">
            <ResponsiveContainer width="100%" height="100%">
              <ScatterChart margin={{ top: 6, right: 6, bottom: 0, left: -22 }}>
                <CartesianGrid stroke="rgba(255,255,255,0.05)" />
                <XAxis
                  type="number"
                  dataKey="x"
                  domain={[0.5, DEMO_TRIALS + 0.5]}
                  allowDecimals={false}
                  ticks={[1, 4, 8, 12, 16, 20, 24]}
                  tick={{ fill: "#71717a", fontSize: 10 }}
                  tickLine={false}
                  axisLine={{ stroke: "rgba(255,255,255,0.15)" }}
                  label={{
                    value: "trial",
                    position: "insideBottomRight",
                    offset: -2,
                    fill: "#71717a",
                    fontSize: 9,
                  }}
                />
                <YAxis
                  type="number"
                  dataKey="y"
                  domain={[0, "auto"]}
                  tick={{ fill: "#71717a", fontSize: 10 }}
                  tickLine={false}
                  axisLine={{ stroke: "rgba(255,255,255,0.15)" }}
                  width={38}
                />
                <Tooltip
                  cursor={{ strokeDasharray: "3 3", stroke: "rgba(255,255,255,0.2)" }}
                  contentStyle={{
                    background: "#0d0c14",
                    border: "1px solid rgba(255,255,255,0.12)",
                    borderRadius: 8,
                    fontSize: 11,
                    color: "#e4e4e7",
                  }}
                  labelStyle={{ color: "#a1a1aa" }}
                  itemStyle={{ color: "#e4e4e7" }}
                />
                <ReferenceLine
                  y={demoResult.baseline}
                  stroke="#fbbf24"
                  strokeDasharray="4 4"
                  strokeOpacity={0.45}
                />
                <Scatter
                  name="A (+sugar)"
                  data={aPts}
                  fill="#34d399"
                  fillOpacity={0.95}
                  line={{ stroke: "#34d399", strokeWidth: 1, strokeOpacity: 0.45 }}
                  isAnimationActive={false}
                />
                <Scatter
                  name="B (+shock)"
                  data={bPts}
                  fill="#fb7185"
                  fillOpacity={0.95}
                  line={{ stroke: "#fb7185", strokeWidth: 1, strokeOpacity: 0.45 }}
                  isAnimationActive={false}
                />
              </ScatterChart>
            </ResponsiveContainer>
          </div>
          <div className="flex items-center justify-between px-1 pt-1 text-[10px] text-muted-foreground">
            <span>
              <span className="text-emerald-300">●</span> Bar left + sugar
            </span>
            <span>
              <span className="text-amber-300">┄</span> naive baseline
            </span>
            <span>
              <span className="text-rose-300">●</span> Bar right + shock
            </span>
          </div>
        </div>
        <p className="text-xs leading-relaxed" data-testid="demo-verdict">
          <span className="font-medium text-foreground">Learned:</span>{" "}
          <span className="text-emerald-300">{aPhrase}</span>,{" "}
          <span className="text-rose-300">{bPhrase}</span> — the A−B gap went from{" "}
          {demoResult.gapEarly.toFixed(2)} to{" "}
          <span className="text-amber-300">{demoResult.gapLate.toFixed(2)}</span> over 24 trials.
        </p>
        <p className="text-[11px] leading-relaxed text-muted-foreground">
          Run #{demoResult.run} on this brain. Index = mean motor drive (all 4 motors) sampled
          over the last second of each trial. Run again — weights persist, so learning
          compounds; <span className="text-foreground/80">Reset brain</span> clears it.
        </p>
      </motion.div>
    );
  }, [demoResult]);

  // ---- neuron inspector: identity + synapse rows. Recomputed on selection
  //      change / brain swap / dopamine event (learning rewrites the plastic
  //      weights, so the snapshot must refresh then) — never per tick. ----
  const daEvents = ui.rewards + ui.punishments;
  const selInfo = useMemo(() => {
    if (selNeuron == null) return null;
    const loc = regionIndexOf(brain, selNeuron);
    if (!loc) return null;
    const data = buildInspectorRows(brain, selNeuron);
    if (!data) return null;
    return {
      region: loc.region,
      idx: loc.idx,
      gi: selNeuron,
      valence: loc.region === "mbon" ? brain.mbonValence[loc.idx] : undefined,
      ...data,
    };
    // daEvents (total reward+punishment count) is a deliberate extra dep: it
    // re-triggers this enumeration after every dopamine event, because plastic
    // weights changed — never per tick.
  }, [selNeuron, brain, daEvents]);

  const demoRunning = demoHud.status === "running";
  const phaseDot =
    demoHud.phase === "pause"
      ? "bg-muted-foreground/50"
      : demoHud.phase === "reward"
        ? demoHud.letter === "A"
          ? "bg-emerald-400"
          : "bg-rose-400"
        : "bg-amber-400";

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
            onNeuronSelect={handleNeuronSelect}
            selectedNeuron={selNeuron}
            pokeNonce={pokeNonce}
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
                <Select
                  value={pattern}
                  onValueChange={onPatternChange}
                  disabled={demoRunning}
                >
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
                {demoRunning && (
                  <p className="text-[10px] leading-snug text-amber-300/80">
                    The conditioning demo is driving the stimulus — your selection is restored
                    when it finishes.
                  </p>
                )}
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
                <p className="text-[10px] leading-snug text-muted-foreground">
                  Scales every animation — and fast-forwards the conditioning demo.
                </p>
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

          {/* classical conditioning demo wizard */}
          <Card className="gap-4 rounded-xl p-4">
            <div className="flex items-center justify-between gap-2">
              <div className="flex items-center gap-2 text-sm font-medium">
                <GraduationCap className="h-4 w-4 text-primary" />
                Classical conditioning demo
              </div>
              <Badge variant="outline" className="text-[10px] text-muted-foreground">
                A+ / B− × {DEMO_TRIALS}
              </Badge>
            </div>
            <p className="text-xs leading-relaxed text-muted-foreground">
              Watch the fly learn to love A and hate B — automatically:{" "}
              <span className="text-emerald-300">Bar left (A) + sugar</span> vs{" "}
              <span className="text-rose-300">Bar right (B) + shock</span>, reward landing
              mid-trial, 24 trials.
            </p>

            {demoHud.status === "idle" && (
              <Button
                className="h-11 gap-2 border-amber-500/40 bg-amber-500/15 text-amber-300 hover:bg-amber-500/25"
                onClick={startDemo}
                data-testid="btn-demo"
              >
                <Play className="h-4 w-4" />
                Run demo ({DEMO_TRIALS} trials)
              </Button>
            )}

            {demoRunning && (
              <div className="space-y-3" data-testid="demo-hud">
                <div className="flex items-end justify-between gap-3">
                  <div
                    className={cn(
                      "font-mono text-3xl font-bold leading-none tracking-tight",
                      demoHud.letter === "A" ? "text-emerald-300" : "text-rose-300",
                    )}
                    data-testid="demo-letter"
                  >
                    {demoHud.letter} {demoHud.letter === "A" ? "+" : "−"}
                  </div>
                  <div className="text-right">
                    <div
                      className="font-mono text-sm tabular-nums text-foreground"
                      data-testid="demo-count"
                    >
                      {Math.min(demoHud.trial + 1, DEMO_TRIALS)} / {DEMO_TRIALS}
                    </div>
                    <div
                      className="flex items-center justify-end gap-1.5 text-[10px] uppercase tracking-wide text-muted-foreground"
                      data-testid="demo-phase"
                    >
                      <span className={cn("h-1.5 w-1.5 rounded-full", phaseDot)} />
                      {demoHud.phase}
                    </div>
                  </div>
                </div>
                <div
                  className="h-1.5 overflow-hidden rounded-full bg-muted/70"
                  data-testid="demo-progress"
                >
                  <div
                    className="h-full rounded-full bg-gradient-to-r from-emerald-500 via-amber-400 to-rose-400 transition-[width] duration-150 ease-linear"
                    style={{ width: `${Math.min(100, demoHud.progress * 100)}%` }}
                  />
                </div>
                <p className="text-[11px] leading-relaxed text-muted-foreground">
                  {demoHud.letter === "A"
                    ? "Bar left (A) on screen — sugar lands mid-trial."
                    : "Bar right (B) on screen — shock lands mid-trial."}{" "}
                  Pause also pauses the demo; Reset brain aborts it.
                </p>
              </div>
            )}

            {demoHud.status === "done" && (
              <>
                {demoResultBlock}
                <Button
                  className="h-11 gap-2 border-amber-500/40 bg-amber-500/15 text-amber-300 hover:bg-amber-500/25"
                  onClick={startDemo}
                  data-testid="btn-demo-again"
                >
                  <RotateCcw className="h-4 w-4" />
                  Run again (same brain)
                </Button>
              </>
            )}
          </Card>

          {/* neuron inspector */}
          <Card className="gap-4 rounded-xl p-4" data-testid="neuron-inspector">
            <div className="flex items-center justify-between gap-2">
              <div className="flex items-center gap-2 text-sm font-medium">
                <Network className="h-4 w-4 text-primary" />
                Neuron inspector
              </div>
              {selInfo && (
                <Badge variant="outline" className="shrink-0 text-[10px] text-muted-foreground">
                  live
                </Badge>
              )}
            </div>

            {!selInfo ? (
              <div className="flex flex-col items-center gap-2 rounded-lg border border-dashed border-border/60 bg-muted/20 px-3 py-5 text-center">
                <Network className="h-6 w-6 text-muted-foreground/60" />
                <p className="text-xs text-muted-foreground">
                  Click a neuron in the 3D brain to inspect it.
                </p>
                <p className="text-[10px] leading-snug text-muted-foreground/70">
                  You&apos;ll see what the cell is, what it connects to, and its live
                  activity. Click empty space to deselect.
                </p>
              </div>
            ) : (
              <div className="space-y-3">
                {/* identity */}
                <div className="space-y-1.5">
                  <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                    <RegionBadge region={selInfo.region} valence={selInfo.valence} />
                    <span className="font-mono text-xs text-foreground">
                      cell #{selInfo.idx}
                    </span>
                    <span className="text-[10px] text-muted-foreground">
                      · global #{selInfo.gi} of {brain.total}
                    </span>
                  </div>
                  <p className="text-[11px] leading-relaxed text-muted-foreground">
                    {REGION_DESC[selInfo.region]}
                  </p>
                </div>

                {/* live activity */}
                <div className="space-y-1.5">
                  <div className="flex items-center justify-between text-xs text-muted-foreground">
                    <span>Activity</span>
                    <span className="flex items-center gap-1.5">
                      {selLive?.spiked && (
                        <span
                          className="rounded border border-amber-500/50 bg-amber-500/15 px-1 py-px text-[9px] font-semibold uppercase tracking-wide text-amber-300"
                          data-testid="insp-spiked"
                        >
                          ⚡ spiked
                        </span>
                      )}
                      <span className="font-mono tabular-nums" data-testid="insp-rate-val">
                        {Math.round((selLive?.rate ?? 0) * 100)}%
                      </span>
                    </span>
                  </div>
                  <div className="h-2.5 overflow-hidden rounded-full bg-muted/70">
                    <div
                      className="h-full rounded-full bg-gradient-to-r from-emerald-500 to-emerald-300 transition-[width] duration-100 ease-linear"
                      data-testid="insp-rate"
                      style={{
                        width: `${Math.max(1.5, Math.min(100, (selLive?.rate ?? 0) * 100))}%`,
                      }}
                    />
                  </div>
                </div>

                {/* synapses */}
                <div className="space-y-1.5">
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-xs text-muted-foreground">
                      {selInfo.direction === "in" ? "Incoming synapses" : "Outgoing synapses"}{" "}
                      · strongest first
                    </span>
                    <Badge
                      variant="outline"
                      className="shrink-0 text-[10px] text-muted-foreground"
                    >
                      {selInfo.rows.length} of {selInfo.total}
                    </Badge>
                  </div>
                  {selInfo.rows.length === 0 ? (
                    <p className="rounded-md border border-dashed border-border/60 bg-muted/20 px-2.5 py-3 text-[11px] leading-relaxed text-muted-foreground">
                      {selInfo.emptyText}
                    </p>
                  ) : (
                    <div
                      className={cn("max-h-72 space-y-1 overflow-y-auto pr-1", SCROLLBAR)}
                      data-testid="insp-synapses"
                    >
                      {selInfo.rows.map((r) => (
                        <InspectorRowView key={r.toGlobal} row={r} maxAbs={selInfo.maxAbs} />
                      ))}
                    </div>
                  )}
                  <p className="text-[10px] leading-snug text-muted-foreground">
                    {selInfo.note}
                  </p>
                </div>

                {/* actions */}
                <div className="grid grid-cols-2 gap-2">
                  <Button
                    className="h-11 gap-1.5 border-amber-500/40 bg-amber-500/15 text-amber-300 hover:bg-amber-500/25"
                    onClick={pokeSelected}
                    data-testid="btn-insp-poke"
                  >
                    <Zap className="h-4 w-4" />
                    Poke +2.0
                  </Button>
                  <Button
                    variant="outline"
                    className="h-11 gap-1.5"
                    onClick={clearSelection}
                    data-testid="btn-insp-clear"
                  >
                    <X className="h-4 w-4" />
                    Clear
                  </Button>
                </div>
              </div>
            )}
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
