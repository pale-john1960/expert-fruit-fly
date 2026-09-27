"use client";

/**
 * BicycleTrainer — a fly learns to ride a bicycle in a 3D dusk world.
 *
 * Owns the whole "Bicycle Training" tab: the R3F canvas with the training
 * simulation running inside useFrame, the HUD overlay, the fly's retina
 * mini-canvas, live brain activity, the event feed, evolution controls,
 * save/load integration and the distance-history chart.
 *
 * Also owns the "You vs the fly" CHALLENGE UI: the human balances a bike
 * with ← / → (or A / D — held keys ramp to full lock) while the champion
 * fly brain rides beside it on the same road. Falls lose; the survivor
 * gets 30 s to run up the score. Population training is parked during a
 * challenge and resumes untouched on exit; the W/L tally persists across
 * challenges in component state.
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
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { BrainActivityPanel } from "./BrainActivityPanel";
import {
  BicycleTrainerCore,
  type ChallengeResult,
  type HudSnapshot,
  type TrainerEvent,
} from "./bicycle/trainer";
import { DuskScene } from "./bicycle/scene";
import {
  buildLineageView,
  nodeIdOf,
  type LineageOrigin,
  type LineageView,
  type LineageViewNode,
} from "./bicycle/lineage";
import { useBrainStore } from "@/lib/flybrain/store";
import { playSound } from "@/lib/sound";
import {
  downloadTextFile,
  sessionExportFilename,
  toHistoryCsv,
  toSessionMarkdown,
} from "@/lib/session-export";
import type { BrainLineage, BrainSnapshot } from "@/lib/flybrain/types";
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
  Swords,
  ArrowLeft,
  X,
  GitBranch,
  ChevronDown,
  Download,
  FileText,
} from "lucide-react";
import {
  Tooltip as UITooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
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

/** Challenge slice pushed into React at the existing ~6 Hz HUD cadence. */
interface ChallengeHud {
  you: number; // metres ridden (frozen at fall)
  fly: number;
  youAlive: boolean;
  flyAlive: boolean;
  phi: number; // human lean (rad)
  steer: number; // human steer delta (rad, ±0.5)
  flyDop: number; // champion's live dopamine (it's learning!)
  ended: boolean;
  result: ChallengeResult | null;
  wins: number;
  losses: number;
  best: number; // your best challenge distance this session
}

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
  labelAccent,
}: {
  label: string;
  value: string;
  accent?: string;
  labelAccent?: string;
}) {
  return (
    <div className="rounded-lg border border-white/10 bg-black/40 px-2.5 py-1.5 backdrop-blur-md">
      <div className={`text-[10px] uppercase tracking-wide ${labelAccent ?? "text-white/50"}`}>{label}</div>
      <div className={`text-sm font-semibold tabular-nums ${accent ?? "text-white"}`}>{value}</div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Champion lineage ("family tree") rendering — mirrors the dino trainer's
// tree (Task 9-b) with the bicycle's ROSE accent: main-line circles are rose,
// sized/tinted by distance in metres; crossover parents merge in diagonally
// from smaller amber side nodes; the champion wears a dashed emerald ring.
// ---------------------------------------------------------------------------
const L_SPACING = 72; // px between main-line generations
const L_MAIN_Y = 52; // baseline of the main line
const L_SIDE_DY = 38; // side-branch offset above/below the baseline
const L_HEIGHT = 112;

const fmtM = (v: number) => `${Math.round(v)} m`;

function lineageOriginText(o: LineageOrigin): string {
  return o === "crossover"
    ? "crossover child"
    : o === "clone"
      ? "elite clone"
      : "founding fly";
}

/** Compact hand-rolled SVG tree — no chart library. Oldest ancestor on the
 *  left, current champion on the right. Every node carries a native <title>
 *  tooltip ("Gen 6 · 27 m · crossover child"); the fixed viewBox scales with
 *  the overflow-x-auto wrapper so it stays readable down to ~360 px. */
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
  const mainR = (score: number) =>
    5 + 6 * Math.min(1, Math.max(0, score / maxScore));

  return (
    <svg
      data-testid="bike-lineage-svg"
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
        stroke="rgba(251,113,133,0.28)"
        strokeWidth={1.5}
      />

      {/* collapsed older ancestry chip */}
      {hasChip && (
        <g>
          <title>{`Older ancestry collapsed — the full line goes back ${view.breedGens} generations to gen ${view.rootGen} (${fmtM(view.rootScore)})`}</title>
          <rect
            x={8}
            y={L_MAIN_Y - 9}
            width={chipW}
            height={18}
            rx={9}
            fill="rgba(251,113,133,0.06)"
            stroke="rgba(251,113,133,0.3)"
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
            stroke="rgba(251,113,133,0.3)"
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
              stroke="rgba(245,158,11,0.5)"
              strokeWidth={1.2}
            />
            <circle
              cx={sx}
              cy={sy}
              r={sideR}
              fill="rgba(245,158,11,0.28)"
              stroke="rgba(245,158,11,0.55)"
              strokeWidth={1}
              className="cursor-help"
            >
              <title>{`Gen ${side.gen} · ${fmtM(side.score)} · crossover parent`}</title>
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
              fill={`rgba(251,113,133,${(0.3 + 0.65 * ratio).toFixed(3)})`}
              stroke="rgba(251,113,133,0.75)"
              strokeWidth={1.2}
              className="cursor-help"
            >
              <title>{`Gen ${m.gen} · ${fmtM(m.score)} · ${lineageOriginText(m.origin)}`}</title>
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
            {/* distance labels under the first + last (champion) nodes */}
            {i === 0 && n > 1 && (
              <text
                x={xs[0]}
                y={L_MAIN_Y + 43}
                textAnchor="middle"
                fontSize={8.5}
                fill="#a8a29e"
                className="font-mono"
              >
                {fmtM(m.score)}
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
                  fill="#fda4af"
                  className="font-mono"
                >
                  {fmtM(m.score)}
                </text>
              </>
            )}
          </g>
        );
      })}
    </svg>
  );
}

export function BicycleTrainer() {
  const [core] = useState(() => new BicycleTrainerCore(5));
  const retinaCanvas = useRef<HTMLCanvasElement | null>(null);
  const [hud, setHud] = useState<HudSnapshot | null>(null);
  const [leaderBrain, setLeaderBrain] = useState<FlyBrain | null>(null);
  const [running, setRunning] = useState(true);
  const [turbo, setTurbo] = useState(1);
  const [preset, setPresetState] = useState<"steady" | "standard" | "frisky">("standard");
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

  // --- "You vs the fly" challenge (sim lives on the core; React mirrors) ---
  const [challengeActive, setChallengeActive] = useState(false);
  const [challengeHud, setChallengeHud] = useState<ChallengeHud | null>(null);
  /** session W/L tally — persists across challenges AND population resets */
  const tallyRef = useRef({ wins: 0, losses: 0, best: 0 });
  const tallyCountedRef = useRef(false);

  // --- Task 13-c lineage bookkeeping (read only inside the save handler) ---
  /** wall-clock training-clock start — reset on fresh populations / adoptions */
  const trainStartRef = useRef(Date.now());
  /** name of the saved library brain this session continued from (null = fresh) */
  const parentNameRef = useRef<string | null>(null);

  // --- champion lineage (family tree) -------------------------------------
  const [lineageOpen, setLineageOpen] = useState(false);
  /** recomputed only when a new champion is crowned (keyed — the ~6 Hz flush
   *  is a no-op for this state between crowns; the ≤20-node walk is cheap) */
  const [lineage, setLineage] = useState<{ key: string; view: LineageView | null }>({
    key: "none",
    view: null,
  });

  // ---- HUD polling (keeps React renders at ~6 Hz, the scene stays 60 fps)
  useEffect(() => {
    const iv = setInterval(() => {
      setHud(core.hudSnapshot());
      const ch = core.challenge;
      if (ch) {
        // count the tally exactly once per finished challenge
        if (ch.result && !tallyCountedRef.current) {
          tallyCountedRef.current = true;
          if (ch.result.winner === "you") tallyRef.current.wins += 1;
          else if (ch.result.winner === "fly") tallyRef.current.losses += 1;
          if (ch.result.youS > tallyRef.current.best) {
            tallyRef.current.best = ch.result.youS;
            playSound("milestone"); // new challenge best distance
          }
        }
        const t = tallyRef.current;
        setChallengeHud({
          you: ch.human.st.alive ? ch.human.st.s : ch.human.st.finalS,
          fly: ch.fly.st.alive ? ch.fly.st.s : ch.fly.st.finalS,
          youAlive: ch.human.st.alive,
          flyAlive: ch.fly.st.alive,
          phi: ch.human.st.phi,
          steer: ch.humanSteer,
          flyDop: ch.fly.brain.getDopamine(),
          ended: ch.ended,
          result: ch.result,
          wins: t.wins,
          losses: t.losses,
          best: t.best,
        });
        // the brain panel shows the champion you're racing, not the human
        setLeaderBrain((prev) => (prev === ch.fly.brain ? prev : ch.fly.brain));
      } else {
        setChallengeHud(null);
        const lead = core.leader;
        if (lead) {
          setLeaderBrain((prev) => (prev === lead.brain ? prev : lead.brain));
        }
      }
      // champion lineage: rebuild the family-tree view ONLY when a new
      // champion is crowned (or the record resets) — never per tick
      const champId = nodeIdOf(core.lineage, core.bestBrain);
      const lKey =
        champId > 0
          ? `${core.lineage.version}:${champId}:${Math.floor(core.bestEverDistance)}`
          : "none";
      setLineage((prev) => {
        if (prev.key === lKey) return prev; // Object-identical → no re-render
        return {
          key: lKey,
          view:
            champId > 0
              ? buildLineageView(
                  core.lineage,
                  champId,
                  Math.floor(core.bestEverDistance)
                )
              : null,
        };
      });
    }, 160);
    return () => clearInterval(iv);
  }, [core]);

  // ---- brain-library load integration + session resume banner
  useEffect(() => {
    const tryConsume = () => {
      const snap = useBrainStore.getState().pending.bicycle;
      if (snap) {
        useBrainStore.getState().consumeLoad("bicycle");
        if (core.challenge) {
          // adopting replaces the population — leave the challenge first
          core.endChallenge();
          setChallengeActive(false);
          setChallengeHud(null);
        }
        core.adoptSnapshot(snap);
        setSession(null);
        // Task 13-c: adopting a saved brain starts a fresh training clock and
        // records the parent for the next save's pedigree
        trainStartRef.current = Date.now();
        parentNameRef.current = snap.name;
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
    // fresh random population = a fresh training session (Task 13-c clock)
    trainStartRef.current = Date.now();
    parentNameRef.current = null;
    core.reset();
    setWatchBest(false);
    setHud(core.hudSnapshot());
    toast.info("Fresh start", { description: "New random brains — Generation 1 rolls out." });
  };

  const changeTurbo = (t: number) => {
    setTurbo(t);
    core.setTurbo(t);
  };

  const changePreset = (p: "steady" | "standard" | "frisky") => {
    if (p === preset) return;
    setPresetState(p);
    core.setPreset(p);
    playSound("click");
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

  // ---------------------------------------------- "You vs the fly" challenge

  const enterChallenge = () => {
    if (!core.bestBrain) return;
    playSound("click");
    if (watchBest) {
      // leave watch-best first so the parked population comes back intact
      setWatchBest(false);
      core.setWatchBest(false);
    }
    core.startChallenge();
    tallyCountedRef.current = false;
    setChallengeActive(true);
    toast.info("You vs the fly — balance!", {
      description:
        "← / → (or A / D) steer · pedal is automatic. Last one rolling wins.",
    });
  };

  const rematchChallenge = () => {
    if (!core.challenge) return;
    playSound("click");
    core.startChallenge(); // keeps the parked training population
    tallyCountedRef.current = false;
  };

  const exitChallenge = () => {
    if (!core.challenge) return;
    playSound("click");
    core.endChallenge(); // folds the champion's learning back in
    setChallengeActive(false);
    setChallengeHud(null);
  };

  // --- challenge keyboard: window listeners active ONLY while challenging ---
  useEffect(() => {
    if (!challengeActive) return;
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
    const apply = (key: string, down: boolean) => {
      const ch = core.challenge;
      if (!ch || ch.ended) return;
      if (key === "ArrowLeft" || key === "a" || key === "A") ch.keys.left = down;
      else if (key === "ArrowRight" || key === "d" || key === "D")
        ch.keys.right = down;
    };
    const down = (e: KeyboardEvent) => {
      if (isEditable(e.target)) return; // never steal typing
      if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
        e.preventDefault(); // stop page scroll (held keys → repeat is fine)
      }
      apply(e.key, true);
    };
    const up = (e: KeyboardEvent) => apply(e.key, false);
    const blur = () => {
      // alt-tab mid-steer would otherwise stick the key down forever
      const ch = core.challenge;
      if (ch) {
        ch.keys.left = false;
        ch.keys.right = false;
      }
    };
    window.addEventListener("keydown", down);
    window.addEventListener("keyup", up);
    window.addEventListener("blur", blur);
    return () => {
      window.removeEventListener("keydown", down);
      window.removeEventListener("keyup", up);
      window.removeEventListener("blur", blur);
    };
  }, [challengeActive, core]);

  const resumeSession = () => {
    if (!session) return;
    playSound("click");
    if (core.challenge) {
      // resuming replaces the population — leave the challenge first
      core.endChallenge();
      setChallengeActive(false);
      setChallengeHud(null);
    }
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
    // Task 13-c — pedigree milestones from the champion family tree
    // (lineage.view): Founder → First champion (only when crowned strictly
    // between the founder and this generation) → This brain.
    const view = lineage.view;
    const pedigree: { gen: number; score: number; label: string }[] = [];
    if (view) {
      pedigree.push({ gen: view.rootGen, score: view.rootScore, label: "Founder" });
      if (view.champion.gen > view.rootGen && view.champion.gen < core.generation) {
        pedigree.push({
          gen: view.champion.gen,
          score: view.champion.score,
          label: "First champion",
        });
      }
    }
    pedigree.push({ gen: core.generation, score, label: "This brain" });
    // a founder that IS this brain (saved before any breeding) → single chip
    if (
      pedigree.length === 2 &&
      pedigree[0].gen === pedigree[1].gen &&
      Math.abs(pedigree[0].score - pedigree[1].score) < 0.5
    ) {
      pedigree.shift();
    }
    const lineageMeta: BrainLineage = {
      trainer: "bicycle",
      generations: core.generation,
      trainedMs: Math.max(0, Date.now() - trainStartRef.current),
      pedigree,
    };
    if (parentNameRef.current) lineageMeta.parentName = parentNameRef.current;
    setSaving(true);
    try {
      const snapshot = brain.toJSON("bicycle", name, core.generation, score, lineageMeta);
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

  // one-line summary for the lineage card header
  const lineageSummary = lineage.view
    ? lineage.view.breedGens > 0
      ? `${lineage.view.breedGens} generations of breeding — from gen ${lineage.view.rootGen}'s ${fmtM(
          lineage.view.rootScore
        )} to gen ${lineage.view.champion.gen}'s ${fmtM(lineage.view.champion.score)}`
      : `The champion is an original fly — gen ${lineage.view.champion.gen}, ${fmtM(
          lineage.view.champion.score
        )}. Bred descendants will grow its family line.`
    : "No champion yet — finish a generation to start the family line.";

  // --- session export (Task 12-b) --------------------------------------------
  // Pure click-time work: snapshots the CURRENT React state (hud slice +
  // lineage view + the challenge tally ref) and hands it to the pure helpers
  // in @/lib/session-export. Never touches the ~6Hz HUD poll or the sim.
  const exportSession = (kind: "md" | "csv") => {
    if (history.length === 0) {
      toast.error("Nothing to export yet", {
        description: "Finish a generation first — then this session has a story to share.",
      });
      return;
    }
    if (kind === "csv") {
      const ok = downloadTextFile(
        sessionExportFilename("bicycle", "csv"),
        toHistoryCsv(history),
        "text/csv"
      );
      if (ok) {
        playSound("ding");
        toast.success("History CSV downloaded", {
          description: `${history.length} generations — best/avg metres per generation.`,
        });
      } else {
        toast.error("Download blocked", {
          description: "The browser refused the file download.",
        });
      }
      return;
    }
    const t = tallyRef.current;
    const challenged = t.wins + t.losses > 0;
    const lv = lineage.view;
    const md = toSessionMarkdown({
      task: "bicycle",
      history,
      unit: "m",
      stats: [
        { label: "Generation", value: `#${gen}` },
        { label: "Best ever", value: `${Math.round(bestEver)} m` },
        { label: "Leader", value: `${Math.round(leaderS)} m` },
        { label: "Leader speed", value: `${leaderV.toFixed(1)} m/s` },
        { label: "Population size", value: String(hud?.popSize ?? popQueued) },
        { label: "Mutation strength", value: mutation.toFixed(2) },
      ],
      lineage: lv
        ? {
            rootGen: lv.rootGen,
            rootScore: lv.rootScore,
            championGen: lv.champion.gen,
            championScore: lv.champion.score,
            breedGens: lv.breedGens,
          }
        : null,
      challenge: challenged
        ? { wins: t.wins, losses: t.losses, bestHuman: t.best }
        : null,
    });
    const ok = downloadTextFile(
      sessionExportFilename("bicycle", "md"),
      md,
      "text/markdown"
    );
    if (ok) {
      playSound("ding");
      toast.success("Markdown report downloaded", {
        description: `Generation #${gen} · best ever ${Math.round(bestEver)} m — ready to share.`,
      });
    } else {
      toast.error("Download blocked", {
        description: "The browser refused the file download.",
      });
    }
  };

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
              <div
                className="absolute left-3 top-3 flex flex-wrap items-center gap-2"
                data-duel={
                  challengeHud
                    ? `you:${challengeHud.you.toFixed(1)}|fly:${challengeHud.fly.toFixed(1)}|youAlive:${challengeHud.youAlive ? 1 : 0}|flyAlive:${challengeHud.flyAlive ? 1 : 0}|phi:${challengeHud.phi.toFixed(3)}|steer:${challengeHud.steer.toFixed(3)}|ended:${challengeHud.ended ? 1 : 0}${challengeHud.result ? `|winner:${challengeHud.result.winner}` : ""}`
                    : undefined
                }
              >
                {challengeHud ? (
                  <>
                    <StatChip
                      label="YOU"
                      labelAccent="text-amber-300/90"
                      value={`${challengeHud.you.toFixed(0)} m${challengeHud.youAlive ? "" : " ✕"}`}
                      accent="text-amber-200"
                    />
                    <StatChip
                      label="FLY"
                      labelAccent="text-emerald-300/90"
                      value={`${challengeHud.fly.toFixed(0)} m${challengeHud.flyAlive ? "" : " ✕"}`}
                      accent="text-emerald-200"
                    />
                    <StatChip
                      label="Session"
                      value={`You ${challengeHud.wins} · Fly ${challengeHud.losses}`}
                    />
                  </>
                ) : (
                  <>
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
                  </>
                )}
              </div>
              <div className="absolute right-3 top-3 flex flex-col items-end gap-2">
                {challengeHud ? (
                  <StatChip
                    label="Challenge best"
                    value={`${challengeHud.best.toFixed(0)} m`}
                    accent="text-amber-300"
                  />
                ) : (
                  <>
                    <StatChip
                      label="Best ever"
                      value={`${bestEver.toFixed(0)} m`}
                      accent="text-amber-300"
                    />
                    <StatChip label="Leader" value={`${leaderS.toFixed(0)} m`} />
                    <StatChip label="Speed" value={`${leaderV.toFixed(1)} m/s`} />
                  </>
                )}
              </div>

              {/* lean + steer + dopamine bottom-left */}
              <div className="absolute bottom-3 left-3 flex items-end gap-3">
                {challengeHud ? (
                  <>
                    <div className="rounded-lg border border-white/10 bg-black/40 px-2.5 py-2 backdrop-blur-md">
                      <div className="mb-1 text-[10px] uppercase tracking-wide text-amber-300/90">
                        Lean · you
                      </div>
                      <div className="flex h-9 w-16 items-center justify-center">
                        <div
                          className="h-1.5 w-14 rounded-full bg-gradient-to-r from-rose-400 via-white/80 to-amber-300 shadow"
                          style={{
                            transform: `rotate(${(challengeHud.phi * (180 / Math.PI)).toFixed(1)}deg)`,
                          }}
                        />
                      </div>
                      <div className="mb-1 mt-1.5 text-[10px] uppercase tracking-wide text-white/50">
                        Steer
                      </div>
                      <div className="relative h-1.5 w-14 rounded-full bg-white/10">
                        <div className="absolute left-1/2 top-0 h-full w-px bg-white/40" />
                        <div
                          className="absolute top-0 h-full rounded-full bg-amber-300"
                          style={
                            challengeHud.steer >= 0
                              ? {
                                  left: "50%",
                                  width: `${(Math.abs(challengeHud.steer) / 0.5) * 50}%`,
                                }
                              : {
                                  right: "50%",
                                  width: `${(Math.abs(challengeHud.steer) / 0.5) * 50}%`,
                                }
                          }
                        />
                      </div>
                    </div>
                    <div className="w-36 rounded-lg border border-white/10 bg-black/40 px-2.5 py-2 backdrop-blur-md">
                      <div className="mb-1 flex items-center justify-between text-[10px] uppercase tracking-wide text-white/50">
                        <span>Dopamine · fly</span>
                        <span
                          className={
                            challengeHud.flyDop >= 0
                              ? "text-emerald-300"
                              : "text-rose-300"
                          }
                        >
                          {challengeHud.flyDop >= 0 ? "+" : ""}
                          {challengeHud.flyDop.toFixed(2)}
                        </span>
                      </div>
                      <div className="relative h-2 w-full overflow-hidden rounded-full bg-white/10">
                        <div className="absolute left-1/2 top-0 h-full w-px bg-white/40" />
                        <div
                          className={`absolute top-0 h-full ${
                            challengeHud.flyDop >= 0
                              ? "bg-emerald-400"
                              : "bg-rose-400"
                          }`}
                          style={
                            challengeHud.flyDop >= 0
                              ? {
                                  left: "50%",
                                  width: `${Math.min(1, Math.abs(challengeHud.flyDop)) * 50}%`,
                                }
                              : {
                                  right: "50%",
                                  width: `${Math.min(1, Math.abs(challengeHud.flyDop)) * 50}%`,
                                }
                          }
                        />
                      </div>
                    </div>
                  </>
                ) : (
                  <>
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
                  </>
                )}
              </div>

              {/* steer hints (challenge) / turbo (training) bottom-right */}
              {challengeHud ? (
                <div
                  className="absolute bottom-3 right-3 flex items-center gap-2 rounded-lg border border-white/10 bg-black/50 px-3 py-2 backdrop-blur-md"
                  title="Steer with the arrow keys (or A / D) — pedal is automatic"
                >
                  <kbd className="inline-flex h-6 min-w-6 items-center justify-center rounded border border-border/80 bg-black/50 px-1.5 font-mono text-xs leading-none text-foreground/90">
                    ←
                  </kbd>
                  <kbd className="inline-flex h-6 min-w-6 items-center justify-center rounded border border-border/80 bg-black/50 px-1.5 font-mono text-xs leading-none text-foreground/90">
                    →
                  </kbd>
                  <span className="text-xs text-white/80">steer · balance!</span>
                </div>
              ) : (
                <div className="pointer-events-auto absolute bottom-3 right-3">
                  <TurboControl turbo={turbo} onChange={changeTurbo} />
                </div>
              )}

              {/* paused veil (training only — a challenge runs real-time) */}
              {!running && !challengeActive && (
                <div className="absolute inset-0 flex items-center justify-center bg-black/35 backdrop-blur-[2px]">
                  <div className="flex items-center gap-2 rounded-full border border-white/15 bg-black/60 px-5 py-2.5 text-sm font-medium text-white/90">
                    <Pause className="h-4 w-4" /> Paused — the flies are resting
                  </div>
                </div>
              )}
            </div>

            {/* challenge result overlay */}
            {challengeHud?.ended && challengeHud.result && (
              <div
                role="dialog"
                aria-label="Challenge result"
                data-testid="challenge-result"
                className="absolute inset-0 z-10 flex flex-col items-center justify-center gap-2.5 bg-black/60 p-4 backdrop-blur-[2px]"
              >
                <Trophy
                  className={
                    challengeHud.result.winner === "you"
                      ? "h-8 w-8 text-amber-400"
                      : "h-8 w-8 text-muted-foreground"
                  }
                  aria-hidden
                />
                <p
                  className={
                    challengeHud.result.winner === "you"
                      ? "text-center text-sm font-semibold text-amber-200 sm:text-base"
                      : "text-center text-sm font-semibold text-foreground/90 sm:text-base"
                  }
                >
                  {challengeHud.result.winner === "you"
                    ? `🏆 You out-balanced the fly, ${challengeHud.result.youS.toFixed(0)} m vs ${challengeHud.result.flyS.toFixed(0)} m`
                    : challengeHud.result.winner === "fly"
                      ? `The fly rides on — ${challengeHud.result.youS.toFixed(0)} m vs ${challengeHud.result.flyS.toFixed(0)} m. Keep breeding!`
                      : `Dead heat — ${challengeHud.result.youS.toFixed(0)} m each. Rematch?`}
                </p>
                <p className="font-mono text-xs tabular-nums text-muted-foreground">
                  You {challengeHud.wins} · Fly {challengeHud.losses} · your best{" "}
                  {challengeHud.best.toFixed(0)} m
                </p>
                <div className="mt-1.5 flex flex-wrap items-center justify-center gap-2">
                  <Button className="h-11" onClick={rematchChallenge}>
                    <RotateCcw aria-hidden />
                    Rematch
                  </Button>
                  <Button variant="outline" className="h-11" onClick={exitChallenge}>
                    <ArrowLeft aria-hidden />
                    Back to training
                  </Button>
                </div>
              </div>
            )}
          </div>
        </Card>

        {/* right column */}
        <div className="flex w-full flex-col gap-4 lg:w-96">
          {/* what the fly sees */}
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="flex items-center gap-2 text-sm">
                <Eye className="h-4 w-4 text-rose-300" />
                {challengeActive ? "What the champion sees" : "What the fly sees"}
              </CardTitle>
              <CardDescription className="text-xs">
                {challengeActive
                  ? "The 24×9 retina driving the brain you're racing — live, mid-challenge."
                  : "The 24×9 retina — road stripe, edge lines, glow posts. Lean shifts the whole view."}
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
              <CardTitle className="text-sm">
                {challengeActive
                  ? "Champion fly — live brain"
                  : "Leader's brain activity"}
              </CardTitle>
              <CardDescription className="text-xs">
                {challengeActive
                  ? "Retina → optic lobe → mushroom body → motor of the brain you're racing."
                  : "Retina → optic lobe → mushroom body → motor, live."}
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
              <CardTitle className="flex items-center gap-2 text-sm">
                {challengeActive ? (
                  <>
                    <Swords className="h-4 w-4 text-amber-400" aria-hidden />
                    You vs the fly
                  </>
                ) : (
                  "Training controls"
                )}
              </CardTitle>
            </CardHeader>
            {challengeActive ? (
              <CardContent className="flex flex-col gap-4">
                <div className="flex flex-wrap items-center gap-2">
                  <Badge
                    variant="outline"
                    className="border-amber-500/40 bg-amber-500/10 font-mono text-xs tabular-nums text-amber-200"
                  >
                    You {challengeHud?.wins ?? 0}
                  </Badge>
                  <Badge
                    variant="outline"
                    className="border-emerald-500/40 bg-emerald-500/10 font-mono text-xs tabular-nums text-emerald-200"
                  >
                    Fly {challengeHud?.losses ?? 0}
                  </Badge>
                  <Badge
                    variant="outline"
                    className="border-border/60 bg-black/40 font-mono text-xs tabular-nums"
                  >
                    your best {(challengeHud?.best ?? 0).toFixed(0)} m
                  </Badge>
                </div>
                <p className="text-xs leading-relaxed text-muted-foreground">
                  Balance with{" "}
                  <kbd className="inline-flex h-5 min-w-5 items-center justify-center rounded border border-border/80 bg-black/50 px-1 font-mono text-[10px] leading-none text-foreground/90">
                    ←
                  </kbd>{" "}
                  <kbd className="inline-flex h-5 min-w-5 items-center justify-center rounded border border-border/80 bg-black/50 px-1 font-mono text-[10px] leading-none text-foreground/90">
                    →
                  </kbd>{" "}
                  (or A / D) — pedal is automatic. Falls lose; the survivor
                  gets 30 s to run up the score.
                </p>
                <div className="flex gap-2">
                  <Button
                    onClick={exitChallenge}
                    variant="outline"
                    className="h-11 flex-1 gap-2 text-sm"
                    aria-label="Leave the challenge and return to population training"
                  >
                    <ArrowLeft className="h-4 w-4" /> Back to training
                  </Button>
                  <Button
                    onClick={rematchChallenge}
                    className="h-11 flex-1 gap-2 text-sm"
                    aria-label="Restart the challenge with fresh riders"
                  >
                    <RotateCcw className="h-4 w-4" /> Rematch
                  </Button>
                </div>
                <p className="text-[11px] leading-relaxed text-muted-foreground">
                  Challenges also train the champion — it still earns distance
                  sugar and fall shock, and hands its weights back afterwards.
                </p>
              </CardContent>
            ) : (
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

              <UITooltip>
                <TooltipTrigger asChild>
                  {/* span wrapper: browsers fire no pointer events on a
                      disabled <button>, so the "train a champion first"
                      tooltip needs a hoverable parent to appear */}
                  <span className="block">
                    <Button
                      onClick={enterChallenge}
                      disabled={!hud?.hasBest}
                      variant="outline"
                      className="h-11 w-full gap-2 border-amber-500/40 bg-amber-500/10 text-amber-200 hover:bg-amber-500/20 hover:text-amber-100"
                      aria-label="Challenge the champion fly to a balance duel"
                    >
                      <Swords className="h-4 w-4" aria-hidden /> You vs the fly
                    </Button>
                  </span>
                </TooltipTrigger>
                <TooltipContent side="top">
                  {hud?.hasBest
                    ? "Balance against the champion brain — same road, same curves"
                    : "Train a champion first, then challenge it"}
                </TooltipContent>
              </UITooltip>

              <div>
                <div className="mb-2 flex items-center justify-between">
                  <Label className="text-xs text-muted-foreground">Turbo</Label>
                  <TurboControl turbo={turbo} onChange={changeTurbo} />
                </div>
              </div>

              <div className="flex flex-col gap-2">
                <Label className="text-xs text-muted-foreground">
                  Bike personality
                </Label>
                <div
                  className="grid grid-cols-3 gap-1 rounded-lg bg-muted/60 p-1"
                  role="group"
                  aria-label="Bike personality preset"
                >
                  {(
                    [
                      { id: "steady", label: "Steady", hint: "Forgiving geometry, richer sugar — balance comes sooner" },
                      { id: "standard", label: "Standard", hint: "The validated default setup" },
                      { id: "frisky", label: "Frisky", hint: "Twitchy handling, leaner sugar — a real challenge" },
                    ] as const
                  ).map((p) => (
                    <button
                      key={p.id}
                      type="button"
                      title={p.hint}
                      aria-pressed={preset === p.id}
                      onClick={() => changePreset(p.id)}
                      className={`h-9 rounded-md px-2 text-xs font-medium transition-colors ${
                        preset === p.id
                          ? p.id === "steady"
                            ? "bg-emerald-500/20 text-emerald-300 ring-1 ring-emerald-500/40"
                            : p.id === "frisky"
                              ? "bg-rose-500/20 text-rose-300 ring-1 ring-rose-500/40"
                              : "bg-amber-500/20 text-amber-300 ring-1 ring-amber-500/40"
                          : "text-muted-foreground hover:text-foreground"
                      }`}
                    >
                      {p.label}
                    </button>
                  ))}
                </div>
                <p className="text-[11px] leading-relaxed text-muted-foreground">
                  Steady gives the handlebars more righting authority (+25%) and
                  pays 0.045 sugar per meter; Frisky dulls them (−20%) and pays
                  0.022. Applies live — no reset needed.
                </p>
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
            )}
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
            <CardContent className="space-y-2">
              <div className="flex gap-2">
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
                        disabled <button>, so the "finish a generation first"
                        tooltip needs a hoverable parent */}
                    <span className="flex w-full">
                      <DropdownMenuTrigger asChild>
                        <Button
                          variant="outline"
                          className="h-11 w-full gap-2 px-4"
                          disabled={history.length === 0}
                          data-testid="bike-export-trigger"
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
                    data-testid="bike-export-md"
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
                    data-testid="bike-export-csv"
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

      {/* --- champion lineage (family tree) --- */}
      <Card className="gap-0 py-0" data-testid="bike-lineage-card">
        <Collapsible open={lineageOpen} onOpenChange={setLineageOpen}>
          <CollapsibleTrigger asChild>
            <button
              type="button"
              data-testid="bike-lineage-toggle"
              aria-controls="bicycle-lineage-panel"
              className="flex w-full items-center gap-3 px-6 py-4 text-left transition-colors hover:bg-muted/30"
            >
              <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-rose-500/30 bg-rose-500/10 text-rose-400">
                <GitBranch className="h-4 w-4" aria-hidden />
              </span>
              <span className="min-w-0 flex-1">
                <span className="flex items-center gap-2 text-sm font-semibold">
                  Champion lineage
                </span>
                <span
                  className="mt-1 block truncate text-xs text-muted-foreground"
                  data-testid="bike-lineage-summary"
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
          <CollapsibleContent id="bicycle-lineage-panel">
            <CardContent className="border-t border-border/60 px-4 pb-5 pt-4 sm:px-6">
              {lineage.view ? (
                <>
                  <div className="overflow-x-auto pb-1 [&::-webkit-scrollbar]:h-2 [&::-webkit-scrollbar-track]:bg-transparent [&::-webkit-scrollbar-thumb]:rounded-full [&::-webkit-scrollbar-thumb]:bg-border">
                    <LineageTreeSvg view={lineage.view} />
                  </div>
                  <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1.5 text-[11px] text-muted-foreground">
                    <span className="flex items-center gap-1.5">
                      <span
                        className="h-2 w-2 rounded-full bg-rose-400/80"
                        aria-hidden
                      />
                      main line
                    </span>
                    <span className="flex items-center gap-1.5">
                      <span
                        className="h-2 w-2 rounded-full bg-amber-500/60"
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
                  data-testid="bike-lineage-empty"
                  className="flex h-[120px] items-center justify-center rounded-lg border border-dashed border-border px-4 text-center text-xs text-muted-foreground"
                >
                  No champion yet — finish a generation to start the family line.
                </div>
              )}
              <p className="mt-2.5 text-[10px] leading-snug text-muted-foreground/70">
                Breeding history of the all-time champion — elite clones inherit one parent,
                crossover children merge two. Session memory only: the line resets with the
                population (Reset or loading a brain starts a fresh family; challenges train
                the champion but never branch it).
              </p>
            </CardContent>
          </CollapsibleContent>
        </Collapsible>
      </Card>
    </section>
  );
}
