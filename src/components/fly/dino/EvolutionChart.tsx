"use client";

/**
 * EvolutionChart — the Dino trainer's telemetry card: best & average score
 * (obstacles cleared) per generation, drawn with recharts.
 *
 * Polish beyond the plain chart the tab used to have:
 *  - range selector (10 / 25 / All, default 25) over the generation history
 *  - dashed emerald reference line at the all-time best ("best ever")
 *  - custom tooltip (dark card, amber/muted value dots, "Gen N" header)
 *  - mode-aware axes/grid via CSS vars (var(--muted-foreground), var(--border))
 *  - line animation that disables itself under prefers-reduced-motion
 *  - compact empty state ("No generations yet — press Start training")
 *
 * PERFORMANCE (read before touching):
 * DinoTrainer re-renders ~4×/s while training, and each 4 Hz HUD flush mirrors
 * `sim.history` into React state with a FRESH array identity
 * (`setHistory(s.history.slice())`). A plain child would re-render — and
 * re-run the whole recharts layout — on every flush. Two guards keep this
 * card out of that churn:
 *  1. React.memo with a CONTENT comparator (see `propsEqual`): the component
 *     re-renders only when the data actually changed (length, first/last
 *     stat, bestEver) or `running` flipped — never on identity-only churn.
 *  2. the visible slice is derived with useMemo on [history, range], so
 *     recharts receives a stable `data` array between real changes.
 */

import { memo, useEffect, useMemo, useState } from "react";
import {
  CartesianGrid,
  Line,
  LineChart,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { ChartLine } from "lucide-react";
import { playSound } from "@/lib/sound";
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";

/** one finished generation of the training run (structurally identical to
 *  DinoTrainer's GenStat — declared here so the card owns its contract) */
export interface EvolutionStat {
  /** generation number (1-based) */
  gen: number;
  /** best score of that generation (obstacles cleared) */
  best: number;
  /** population-average score of that generation */
  avg: number;
}

export interface EvolutionChartProps {
  /** full per-generation history (append-only between resets) */
  history: EvolutionStat[];
  /** all-time best score — drawn as a dashed emerald reference line */
  bestEver: number;
  /** true while the training loop runs — only used for the empty-state hint */
  running: boolean;
}

/** amber = the dino tab accent; emerald = reward; muted = the population */
const AMBER = "#f59e0b";
const EMERALD = "#34d399";

const RANGE_OPTIONS = [10, 25, "all"] as const;
type RangeOption = (typeof RANGE_OPTIONS)[number];

// ---------------------------------------------------------------------------
// Custom tooltip — dark card, "Gen N" header, colored dots per series
// ---------------------------------------------------------------------------

interface TooltipEntry {
  dataKey?: string | number;
  name?: string | number;
  value?: number | string;
}

interface ChartTipProps {
  active?: boolean;
  payload?: TooltipEntry[];
  label?: string | number;
  bestEver?: number;
}

function ChartTip({ active, payload, label, bestEver = 0 }: ChartTipProps) {
  if (!active || !payload || payload.length === 0) return null;
  const best = payload.find((p) => p.dataKey === "best");
  const avg = payload.find((p) => p.dataKey === "avg");
  return (
    <div className="min-w-[128px] rounded-lg border border-border bg-popover/95 px-3 py-2 shadow-lg backdrop-blur-sm">
      <p className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
        Gen {String(label)}
      </p>
      <div className="mt-1 space-y-0.5 font-mono text-xs tabular-nums">
        {best ? (
          <p className="flex items-center justify-between gap-4 text-foreground">
            <span className="flex items-center gap-1.5">
              <span className="inline-block h-2 w-2 rounded-full bg-amber-400" aria-hidden />
              best
            </span>
            <span className="font-semibold text-amber-300">
              {Math.round(Number(best.value))}
            </span>
          </p>
        ) : null}
        {avg ? (
          <p className="flex items-center justify-between gap-4 text-foreground">
            <span className="flex items-center gap-1.5">
              <span
                className="inline-block h-2 w-2 rounded-full bg-muted-foreground/60"
                aria-hidden
              />
              avg
            </span>
            <span className="font-semibold">{Math.round(Number(avg.value))}</span>
          </p>
        ) : null}
        {bestEver > 0 ? (
          <p className="flex items-center justify-between gap-4 text-emerald-300">
            <span className="flex items-center gap-1.5">
              <span className="inline-block h-2 w-2 rounded-full bg-emerald-400" aria-hidden />
              best ever
            </span>
            <span className="font-semibold">{Math.round(bestEver)}</span>
          </p>
        ) : null}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Empty state — dashed box, pulsing skeleton lines, contextual hint
// ---------------------------------------------------------------------------

function EvolutionEmpty({ running }: { running: boolean }) {
  return (
    <div
      data-testid="evolution-empty"
      className="flex h-60 w-full flex-col items-center justify-center gap-4 rounded-lg border border-dashed border-border/70"
    >
      {/* skeleton "chart lines" — pulse only when motion is welcome */}
      <svg
        viewBox="0 0 160 48"
        className="h-12 w-44 motion-safe:animate-pulse"
        aria-hidden
      >
        <polyline
          points="4,40 34,33 64,36 94,22 124,26 152,10"
          fill="none"
          stroke="var(--muted-foreground)"
          strokeOpacity={0.4}
          strokeWidth={2}
        />
        <polyline
          points="4,44 34,42 64,43 94,38 124,40 152,34"
          fill="none"
          stroke="var(--muted-foreground)"
          strokeOpacity={0.22}
          strokeWidth={1.5}
          strokeDasharray="4 3"
        />
      </svg>
      <p className="max-w-[280px] px-4 text-center text-xs text-muted-foreground">
        {running
          ? "First generation in progress — the curve begins when it finishes."
          : "No generations yet — press Start training."}
      </p>
    </div>
  );
}

// ---------------------------------------------------------------------------
// The card
// ---------------------------------------------------------------------------

function EvolutionChartImpl({ history, bestEver, running }: EvolutionChartProps) {
  const [range, setRange] = useState<RangeOption>(25);

  // recharts line animation ON by default, OFF under prefers-reduced-motion
  const [reduceMotion, setReduceMotion] = useState(false);
  useEffect(() => {
    const mq = window.matchMedia("(prefers-reduced-motion: reduce)");
    const apply = () => setReduceMotion(mq.matches);
    apply();
    mq.addEventListener("change", apply);
    return () => mq.removeEventListener("change", apply);
  }, []);
  const animate = !reduceMotion;

  // visible slice — recomputed ONLY when this memoized component actually
  // re-renders (content change), never on the 4 Hz identity-only churn
  const data = useMemo(
    () => (range === "all" ? history : history.slice(-range)),
    [history, range]
  );

  const hasData = data.length > 0;
  // keep the reference line inside the Y domain even when the record was set
  // in an older, currently out-of-window generation
  const yTop = Math.max(1, bestEver, data.reduce((m, d) => Math.max(m, d.best), 0));

  const changeRange = (v: string) => {
    if (!v) return; // ToggleGroup type="single" fires "" on deselect
    const next: RangeOption = v === "all" ? "all" : Number(v);
    if (next === range) return;
    setRange(next);
    playSound("click");
  };

  const ariaLabel = hasData
    ? `Evolution curve: best and average obstacles cleared per generation, generation ${data[0].gen} to ${data[data.length - 1].gen}`
    : "Evolution curve: no generations finished yet";

  return (
    <Card className="mt-4" data-testid="evolution-card">
      <CardHeader className="pb-2">
        <CardTitle className="flex items-center gap-2 text-sm">
          <ChartLine className="h-4 w-4 text-amber-400" aria-hidden />
          Evolution curve
          <span
            data-testid="evolution-count"
            className="rounded bg-muted/70 px-1.5 py-0.5 font-mono text-[10px] font-normal tabular-nums text-muted-foreground"
          >
            {history.length > 0 ? `${history.length} gens` : "no gens yet"}
          </span>
        </CardTitle>
        <CardDescription className="text-xs">
          Best and average score per generation — the learning history of this
          lineage.
        </CardDescription>
        <CardAction>
          <ToggleGroup
            type="single"
            variant="outline"
            value={String(range)}
            onValueChange={changeRange}
            aria-label="Chart range — generations shown"
            data-testid="evolution-range"
          >
            <ToggleGroupItem
              value="10"
              className="h-7 min-w-9 px-2 font-mono text-[11px] data-[state=on]:border-amber-500/50 data-[state=on]:bg-amber-500/15 data-[state=on]:text-amber-200 hover:text-amber-100"
            >
              10
            </ToggleGroupItem>
            <ToggleGroupItem
              value="25"
              className="h-7 min-w-9 px-2 font-mono text-[11px] data-[state=on]:border-amber-500/50 data-[state=on]:bg-amber-500/15 data-[state=on]:text-amber-200 hover:text-amber-100"
            >
              25
            </ToggleGroupItem>
            <ToggleGroupItem
              value="all"
              className="h-7 min-w-9 px-2 font-mono text-[11px] data-[state=on]:border-amber-500/50 data-[state=on]:bg-amber-500/15 data-[state=on]:text-amber-200 hover:text-amber-100"
            >
              All
            </ToggleGroupItem>
          </ToggleGroup>
        </CardAction>
      </CardHeader>
      <CardContent>
        {hasData ? (
          <div className="h-60 w-full" data-testid="evolution-chart" role="img" aria-label={ariaLabel}>
            <ResponsiveContainer width="100%" height="100%">
              <LineChart
                data={data}
                margin={{ top: 10, right: 12, bottom: 0, left: -14 }}
                accessibilityLayer
              >
                <CartesianGrid
                  stroke="var(--border)"
                  strokeDasharray="3 3"
                  vertical={false}
                />
                <XAxis
                  dataKey="gen"
                  type="number"
                  domain={["dataMin", "dataMax"]}
                  allowDecimals={false}
                  tick={{ fontSize: 10, fill: "var(--muted-foreground)" }}
                  axisLine={{ stroke: "var(--border)" }}
                  tickLine={false}
                  label={{
                    value: "gen",
                    position: "insideBottomRight",
                    offset: -2,
                    fontSize: 9,
                    fill: "var(--muted-foreground)",
                  }}
                />
                <YAxis
                  width={38}
                  allowDecimals={false}
                  domain={[0, Math.ceil(yTop * 1.05)]}
                  tick={{ fontSize: 10, fill: "var(--muted-foreground)" }}
                  axisLine={{ stroke: "var(--border)" }}
                  tickLine={false}
                />
                {bestEver > 0 ? (
                  <ReferenceLine
                    y={bestEver}
                    stroke={EMERALD}
                    strokeDasharray="5 4"
                    strokeOpacity={0.7}
                    label={{
                      value: "best ever",
                      position: "insideTopRight",
                      fontSize: 9,
                      fill: EMERALD,
                    }}
                  />
                ) : null}
                <Tooltip
                  cursor={{
                    stroke: "var(--muted-foreground)",
                    strokeOpacity: 0.3,
                    strokeDasharray: "3 3",
                  }}
                  content={<ChartTip bestEver={bestEver} />}
                  animationDuration={120}
                />
                <Line
                  type="monotone"
                  dataKey="best"
                  name="Best"
                  stroke={AMBER}
                  strokeWidth={2.5}
                  dot={false}
                  activeDot={{ r: 4.5, fill: AMBER, stroke: "var(--card)", strokeWidth: 2 }}
                  isAnimationActive={animate}
                  animationDuration={300}
                />
                <Line
                  type="monotone"
                  dataKey="avg"
                  name="Average"
                  stroke="var(--muted-foreground)"
                  strokeOpacity={0.4}
                  strokeWidth={1.5}
                  strokeDasharray="4 3"
                  dot={false}
                  activeDot={{ r: 3, fill: "var(--muted-foreground)", strokeWidth: 0 }}
                  isAnimationActive={animate}
                  animationDuration={300}
                />
              </LineChart>
            </ResponsiveContainer>
          </div>
        ) : (
          <EvolutionEmpty running={running} />
        )}

        {/* compact legend row */}
        <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-[10px] text-muted-foreground">
          <span className="flex items-center gap-1.5">
            <span className="inline-block h-[2px] w-4 rounded-full bg-amber-400" aria-hidden />
            best per gen
          </span>
          <span className="flex items-center gap-1.5">
            <span
              className="inline-block h-[2px] w-4 rounded-full bg-muted-foreground/40"
              aria-hidden
            />
            population average
          </span>
          <span className="flex items-center gap-1.5">
            <span
              className="inline-block h-[2px] w-4 rounded-full border-t-2 border-dashed border-emerald-400/70"
              aria-hidden
            />
            best ever{bestEver > 0 ? ` ${bestEver}` : ""}
          </span>
        </div>
      </CardContent>
    </Card>
  );
}

/**
 * Content-based memo comparator. The 4 Hz flush copies `history` on every
 * flush (`slice()`), so the array identity churns even when nothing changed —
 * identity comparison would re-render this subtree (and recharts) 4×/s.
 * History is append-only between resets, so length + first/last stat is a
 * faithful change signal; `bestEver` (moves the reference line) and `running`
 * (empty-state hint) are compared directly.
 */
function propsEqual(prev: EvolutionChartProps, next: EvolutionChartProps): boolean {
  if (prev.running !== next.running) return false;
  if (prev.bestEver !== next.bestEver) return false;
  const a = prev.history;
  const b = next.history;
  if (a === b) return true;
  if (a.length !== b.length) return false;
  if (a.length === 0) return true; // both empty → same render
  const fa = a[0];
  const fb = b[0];
  const la = a[a.length - 1];
  const lb = b[b.length - 1];
  return (
    fa.gen === fb.gen &&
    fa.best === fb.best &&
    fa.avg === fb.avg &&
    la.gen === lb.gen &&
    la.best === lb.best &&
    la.avg === lb.avg
  );
}

export const EvolutionChart = memo(EvolutionChartImpl, propsEqual);
