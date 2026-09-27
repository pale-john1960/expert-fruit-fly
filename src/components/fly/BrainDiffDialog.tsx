"use client";

/**
 * BrainDiffDialog — "Genome diff" compare dialog for the Brain Library.
 * Opened from the library's compare bar once the user has toggled exactly
 * two brains for comparison:
 *
 *   1. Header strip      — A name · TaskBadge ⇄ TaskBadge · B name
 *   2. Identity          — compact side-by-side panels (name, task, gen,
 *                          score, created, note) for both brains
 *   3. Aligned           — 12-compartment MBON personality fingerprint,
 *      fingerprint        stacked: A lean strip, B lean strip (shared
 *                          normalization scale so intensities are directly
 *                          comparable) + a third Δ strip (A lean − B lean:
 *                          emerald = A stronger, rose = B stronger) over a
 *                          shared M1…M12 axis. The biggest single-compartment
 *                          gap is annotated below (amber).
 *   4. Stats deltas      — synapse budget (plastic/innate), strongest channel
 *                          per brain, valence balance per brain + who is more
 *                          reward-shaped, channel agreement count
 *   5. Verdict           — 1–2 sentence plain-language summary
 *   6. Export actions    — "Copy diff" (clipboard + .txt fallback) and
 *                          "Download PNG" (SVG → 2× canvas raster), with
 *                          2-second "Copied ✓" / "Saved ✓" feedback chips
 *
 * The per-brain fingerprint math is the report card's exported
 * deriveStats() — never duplicated here.
 *
 * Sounds: playSound("click") when the dialog opens; "ding" on export success.
 *
 * Colors: TEAL/AMBER are library accents; emerald = reward / A-side, rose =
 * punishment / B-side. No indigo/blue/purple. The SVG uses explicit hex
 * fills (like the report card) so the PNG raster stays faithful and the
 * panel reads well in BOTH light and dark themes.
 */

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { motion, useReducedMotion } from "framer-motion";
import {
  ArrowLeftRight,
  Calendar,
  ClipboardCopy,
  Download,
  GitCompareArrows,
  Loader2,
  Network,
  RefreshCw,
  Scale,
  Sparkles,
  StickyNote,
  Trophy,
  Zap,
} from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Separator } from "@/components/ui/separator";
import { playSound } from "@/lib/sound";
import type { BrainSnapshot } from "@/lib/flybrain/types";
import { cn } from "@/lib/utils";

// Shared with (and exported by) BrainLibrary — the documented safe module
// cycle (hoisted function declarations / types only).
import {
  fetchBrain,
  formatBytes,
  formatScore,
  relativeDate,
  TaskBadge,
  type BrainRow,
} from "./BrainLibrary";
// The fingerprint math lives in the report card (Task 10-b) — reuse, never
// re-derive, so both views agree byte-for-byte.
import { deriveStats, type FingerprintStats } from "./BrainReportCard";

export interface BrainDiffDialogProps {
  /** [A, B] — the two brains to compare, or null while incomplete. */
  rows: readonly [BrainRow, BrainRow] | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

// ---------------------------------------------------------------------------
// palette (explicit hex — the SVG panel and the PNG raster share it)
// ---------------------------------------------------------------------------

const INK = "#0d1512"; // panel background (also the PNG canvas fill)
const EM = "#34d399"; // emerald-400 — reward-shaped / A-side of Δ
const EM_SOFT = "#6ee7b7";
const ROSE = "#fb7185"; // rose-400 — punishment-shaped / B-side of Δ
const ROSE_SOFT = "#fda4af";
const AMBER = "#fbbf24"; // amber-400 — annotation / diff accent
const TEXT_MUT = "#a1a1aa";
const TEXT_DIM = "#71717a";
const UNWRITTEN_FILL = "#1c2622";
const UNWRITTEN_EDGE = "#3f3f46";

const SVG_W = 560;
const SVG_H = 212;

// ---------------------------------------------------------------------------
// tiny formatting helpers
// ---------------------------------------------------------------------------

function sanitizeFileName(name: string): string {
  const clean = name
    .toLowerCase()
    .replace(/[^a-z0-9-_]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return clean || "brain";
}

/** truncate a display name inside the SVG gutters (hard char cut + ellipsis) */
function svgName(name: string, max = 14): string {
  return name.length > max ? `${name.slice(0, max - 1)}…` : name;
}

function fmtLean(v: number): string {
  return `${v >= 0 ? "+" : "-"}${Math.abs(v).toFixed(3)}`;
}

function fmtDelta2(v: number): string {
  return `${v >= 0 ? "+" : "-"}${Math.abs(v).toFixed(2)}`;
}

const nums = (v: number) => v.toLocaleString("en-US");

const UNWRITTEN_EPS = 0.001;

// ---------------------------------------------------------------------------
// biggest single-compartment gap + verdict prose
// ---------------------------------------------------------------------------

export interface GenomeGap {
  index: number;
  label: string;
  /** full annotation sentence, e.g. `M4 — 2.3× stronger in "Lab Demo Fly"` */
  text: string;
}

/** Find the compartment with the largest |A lean − B lean| and describe it. */
function biggestGap(sa: FingerprintStats, sb: FingerprintStats, nameA: string, nameB: string): GenomeGap | null {
  const n = Math.min(sa.leans.length, sb.leans.length);
  let idx = -1;
  let best = 0;
  for (let i = 0; i < n; i++) {
    const d = Math.abs(sa.leans[i] - sb.leans[i]);
    if (d > best) {
      best = d;
      idx = i;
    }
  }
  if (idx < 0 || best < UNWRITTEN_EPS) return null; // identical fingerprints

  const a = sa.leans[idx];
  const b = sb.leans[idx];
  const label = `M${idx + 1}`;
  const magA = Math.abs(a);
  const magB = Math.abs(b);
  const aUnwritten = magA < UNWRITTEN_EPS;
  const bUnwritten = magB < UNWRITTEN_EPS;

  if (aUnwritten && bUnwritten) {
    return { index: idx, label, text: `${label} — effectively unwritten in both brains` };
  }
  if (aUnwritten || bUnwritten) {
    const writer = aUnwritten ? nameB : nameA;
    const lean = aUnwritten ? b : a;
    return {
      index: idx,
      label,
      text: `${label} — written only by “${writer}” (${fmtLean(lean)}, ${
        lean >= 0 ? "reward" : "punishment"
      }-shaped)`,
    };
  }
  if (a >= 0 === b >= 0) {
    // same valence → magnitude ratio
    const hi = Math.max(magA, magB);
    const lo = Math.min(magA, magB);
    const winner = magA >= magB ? nameA : nameB;
    return {
      index: idx,
      label,
      text: `${label} — ${(hi / lo).toFixed(1)}× stronger in “${winner}”`,
    };
  }
  // opposite signs → the compartment flips valence between the two brains
  return {
    index: idx,
    label,
    text: `${label} — flips valence: “${nameA}” writes it ${a >= 0 ? "reward" : "punishment"}-shaped, “${nameB}” ${
      b >= 0 ? "reward" : "punishment"
    }-shaped`,
  };
}

function buildVerdict(
  rowA: BrainRow,
  rowB: BrainRow,
  sa: FingerprintStats,
  sb: FingerprintStats,
  gap: GenomeGap | null,
): string {
  const parts: string[] = [];
  const dBal = sa.balance - sb.balance;
  if (sa.kmCount === 0 && sb.kmCount === 0) {
    parts.push("Neither brain carries learned Kenyon→MBON writes yet — there is nothing to diff.");
  } else if (Math.abs(dBal) <= 0.01) {
    parts.push(
      `“${rowA.name}” and “${rowB.name}” are evenly matched on valence — neither leans harder toward reward or punishment (balance ${fmtLean(
        sa.balance,
      )} vs ${fmtLean(sb.balance)}).`,
    );
  } else {
    // dBal > 0 → A leans reward harder (or punishment less hard) than B
    const winner = dBal > 0 ? rowA : rowB;
    const leanWord = (v: number) =>
      v > 0.01
        ? `leans reward ${fmtLean(v)}`
        : v < -0.01
          ? `leans punishment ${fmtLean(v)}`
          : `stays nearly balanced ${fmtLean(v)}`;
    parts.push(
      `“${rowA.name}” ${leanWord(sa.balance)}, while “${rowB.name}” ${leanWord(sb.balance)} — “${
        winner.name
      }” is the more reward-shaped of the two (difference ${fmtLean(Math.abs(dBal))}).`,
    );
  }
  if (gap) {
    parts.push(`Their sharpest wiring difference is ${gap.text.replace(/^(\w+) — /, "$1: ")}.`);
  }
  return parts.join(" ");
}

// ---------------------------------------------------------------------------
// plain-text diff (clipboard / fallback download)
// ---------------------------------------------------------------------------

function buildDiffText(
  rowA: BrainRow,
  rowB: BrainRow,
  snapA: BrainSnapshot,
  snapB: BrainSnapshot,
  sa: FingerprintStats,
  sb: FingerprintStats,
  gap: GenomeGap | null,
): string {
  const n = Math.min(sa.leans.length, sb.leans.length);
  const balanceWord = (s: FingerprintStats) =>
    Math.abs(s.balance) < 0.002 ? "balanced (naive)" : s.balance > 0 ? "leans reward" : "leans punishment";

  const L: string[] = [];
  L.push("EXPERT FRUIT FLY — GENOME DIFF");
  L.push("=".repeat(40));
  L.push("");
  L.push("IDENTITY");
  L.push(`  A  ${rowA.name} — ${rowA.task} · gen ${rowA.generation} · ${formatScore(rowA.task, rowA.score)} · ${formatBytes(rowA.snapshotBytes)} · ${relativeDate(rowA.createdAt)}`);
  if (rowA.note) L.push(`     note: ${rowA.note}`);
  L.push(`  B  ${rowB.name} — ${rowB.task} · gen ${rowB.generation} · ${formatScore(rowB.task, rowB.score)} · ${formatBytes(rowB.snapshotBytes)} · ${relativeDate(rowB.createdAt)}`);
  if (rowB.note) L.push(`     note: ${rowB.note}`);
  L.push("");
  L.push("LEARNED WRITES BY MEMORY CHANNEL (mean Kenyon→MBON × valence)");
  L.push("  Channel        A         B         Δ (A−B)");
  for (let i = 0; i < n; i++) {
    const a = sa.leans[i];
    const b = sb.leans[i];
    L.push(
      `  M${String(i + 1).padEnd(11)} ${(a >= 0 ? "+" : "-") + Math.abs(a).toFixed(3).padStart(6)}  ${
        (b >= 0 ? "+" : "-") + Math.abs(b).toFixed(3).padStart(6)
      }  ${(a - b >= 0 ? "+" : "-") + Math.abs(a - b).toFixed(3).padStart(6)}`,
    );
  }
  if (gap) L.push(`  Biggest gap  ${gap.text}`);
  L.push("");
  L.push("WIRING");
  L.push(`  A  ${nums(sa.total)} total — plastic ${nums(sa.plastic)} (K→M ${nums(sa.kmCount)} · M→motor ${nums(sa.mmCount)} · giant-fiber ${nums(sa.gfCount)} · biases ${nums(sa.biasCount)}) / innate ${nums(sa.innate)}`);
  L.push(`  B  ${nums(sb.total)} total — plastic ${nums(sb.plastic)} (K→M ${nums(sb.kmCount)} · M→motor ${nums(sb.mmCount)} · giant-fiber ${nums(sb.gfCount)} · biases ${nums(sb.biasCount)}) / innate ${nums(sb.innate)}`);
  L.push(`  Training     A ${nums(snapA.meta?.steps ?? 0)} steps · ${snapA.meta?.rewards ?? 0} rewards / ${snapA.meta?.punishments ?? 0} punishments`);
  L.push(`              B ${nums(snapB.meta?.steps ?? 0)} steps · ${snapB.meta?.rewards ?? 0} rewards / ${snapB.meta?.punishments ?? 0} punishments`);
  L.push("");
  L.push("VALENCE");
  L.push(`  A  balance ${fmtLean(sa.balance)} — ${balanceWord(sa)} (reward mass ${sa.rewardMass.toFixed(3)} vs punishment ${sa.punishMass.toFixed(3)})`);
  L.push(`  B  balance ${fmtLean(sb.balance)} — ${balanceWord(sb)} (reward mass ${sb.rewardMass.toFixed(3)} vs punishment ${sb.punishMass.toFixed(3)})`);
  const dBal = sa.balance - sb.balance;
  if (Math.abs(dBal) <= 0.01) {
    L.push("     → evenly matched on valence");
  } else {
    L.push(`     → “${dBal > 0 ? rowA.name : rowB.name}” is the more reward-shaped brain`);
  }
  L.push("");
  L.push("VERDICT");
  L.push(`  ${buildVerdict(rowA, rowB, sa, sb, gap)}`);
  L.push("");
  L.push(`— Expert Fruit Fly genome diff · generated ${new Date().toISOString()}`);
  return L.join("\n");
}

// ---------------------------------------------------------------------------
// aligned fingerprint SVG — strips for A, B and Δ over a shared M axis
// ---------------------------------------------------------------------------

function DiffFingerprintChart({
  nameA,
  nameB,
  sa,
  sb,
  gap,
}: {
  nameA: string;
  nameB: string;
  sa: FingerprintStats;
  sb: FingerprintStats;
  gap: GenomeGap | null;
}) {
  const n = Math.min(sa.leans.length, sb.leans.length);
  const appHalf = Math.ceil(n / 2);
  // ONE shared normalization scale across both brains, so cell intensities
  // are directly comparable between the A and B strips.
  const maxAbs = Math.max(UNWRITTEN_EPS, ...sa.leans.map(Math.abs), ...sb.leans.map(Math.abs));
  const deltas = sa.leans.slice(0, n).map((v, i) => v - (sb.leans[i] ?? 0));
  const maxDelta = Math.max(UNWRITTEN_EPS, ...deltas.map(Math.abs));

  // geometry — shared by all three strips so columns align exactly
  const x0 = 118;
  const cellW = 34;
  const cellGap = 2;
  const step = cellW + cellGap;
  const cellX = (i: number) => x0 + i * step;
  const rowA_Y = 29;
  const rowB_Y = 57;
  const rowD_Y = 95;
  const rowH = 22;

  const opa = (mag: number, max: number) => 0.14 + 0.78 * Math.min(1, mag / max);

  return (
    <svg
      viewBox={`0 0 ${SVG_W} ${SVG_H}`}
      className="h-auto w-full"
      role="img"
      aria-label={`Genome diff fingerprint: rows A (${nameA}) and B (${nameB}) show each memory channel's learned lean — green is reward-shaped, red punishment-shaped. The third row is the per-channel difference: green means A is stronger, red means B is stronger.`}
      fontFamily="system-ui, -apple-system, 'Segoe UI', sans-serif"
    >
      {/* panel */}
      <rect x={0} y={0} width={SVG_W} height={SVG_H} rx={10} fill={INK} />

      {/* compartment group headers + washes (reward-side left, punishment-side right) */}
      <text x={x0 + (appHalf * step - cellGap) / 2} y={15} textAnchor="middle" fontSize={9} fontWeight={600} letterSpacing={0.6} fill={EM_SOFT} opacity={0.9}>
        REWARD-SIDE (M1–M{appHalf})
      </text>
      <text x={cellX(appHalf) + (appHalf * step - cellGap) / 2} y={15} textAnchor="middle" fontSize={9} fontWeight={600} letterSpacing={0.6} fill={ROSE_SOFT} opacity={0.9}>
        PUNISHMENT-SIDE (M{appHalf + 1}–M{n})
      </text>
      <rect x={x0 - 2} y={21} width={appHalf * step} height={58} rx={6} fill={EM} opacity={0.06} />
      <rect x={cellX(appHalf) - 2} y={21} width={(n - appHalf) * step} height={58} rx={6} fill={ROSE} opacity={0.06} />

      {/* ---- left gutter labels ---- */}
      <rect x={4} y={rowA_Y + 3} width={14} height={14} rx={4} fill={EM} opacity={0.85} />
      <text x={23} y={rowA_Y + 14.5} fontSize={9.5} fontWeight={600} fill="#d4d4d8">
        {svgName(nameA)}
      </text>
      <rect x={4} y={rowB_Y + 3} width={14} height={14} rx={4} fill={ROSE} opacity={0.85} />
      <text x={23} y={rowB_Y + 14.5} fontSize={9.5} fontWeight={600} fill="#d4d4d8">
        {svgName(nameB)}
      </text>
      <text x={5} y={rowD_Y + 14.5} fontSize={11} fontWeight={700} fill={AMBER}>
        Δ
      </text>
      <text x={21} y={rowD_Y + 14.5} fontSize={8.5} fill={TEXT_MUT}>
        A − B
      </text>

      {/* ---- row A strip ---- */}
      {sa.leans.slice(0, n).map((lean, i) => {
        const unwritten = Math.abs(lean) < UNWRITTEN_EPS;
        return (
          <rect
            key={`a-${i}`}
            data-testid="diff-cell-a"
            x={cellX(i)}
            y={rowA_Y}
            width={cellW}
            height={rowH}
            rx={4}
            fill={unwritten ? UNWRITTEN_FILL : lean >= 0 ? EM : ROSE}
            opacity={unwritten ? 1 : opa(Math.abs(lean), maxAbs)}
            stroke={unwritten ? UNWRITTEN_EDGE : "none"}
            strokeWidth={unwritten ? 0.75 : 0}
          >
            <title>{`A · M${i + 1} — ${
              unwritten ? "unwritten (no learned lean)" : `lean ${fmtLean(lean)} (${lean >= 0 ? "reward" : "punishment"}-shaped)`
            }`}</title>
          </rect>
        );
      })}

      {/* ---- row B strip ---- */}
      {sb.leans.slice(0, n).map((lean, i) => {
        const unwritten = Math.abs(lean) < UNWRITTEN_EPS;
        return (
          <rect
            key={`b-${i}`}
            data-testid="diff-cell-b"
            x={cellX(i)}
            y={rowB_Y}
            width={cellW}
            height={rowH}
            rx={4}
            fill={unwritten ? UNWRITTEN_FILL : lean >= 0 ? EM : ROSE}
            opacity={unwritten ? 1 : opa(Math.abs(lean), maxAbs)}
            stroke={unwritten ? UNWRITTEN_EDGE : "none"}
            strokeWidth={unwritten ? 0.75 : 0}
          >
            <title>{`B · M${i + 1} — ${
              unwritten ? "unwritten (no learned lean)" : `lean ${fmtLean(lean)} (${lean >= 0 ? "reward" : "punishment"}-shaped)`
            }`}</title>
          </rect>
        );
      })}

      {/* ---- Δ strip (A − B) ---- */}
      {deltas.map((d, i) => {
        const unwritten = Math.abs(d) < UNWRITTEN_EPS;
        const isGap = gap !== null && i === gap.index;
        return (
          <g key={`d-${i}`}>
            <rect
              data-testid="diff-cell-delta"
              x={cellX(i)}
              y={rowD_Y}
              width={cellW}
              height={rowH}
              rx={4}
              fill={unwritten ? UNWRITTEN_FILL : d >= 0 ? EM : ROSE}
              opacity={unwritten ? 1 : opa(Math.abs(d), maxDelta)}
              stroke={unwritten ? UNWRITTEN_EDGE : "none"}
              strokeWidth={unwritten ? 0.75 : 0}
            >
              <title>{`Δ M${i + 1} — ${fmtDelta2(d)} ${
                unwritten ? "(identical leans)" : d >= 0 ? "(A stronger)" : "(B stronger)"
              } · A ${fmtLean(sa.leans[i] ?? 0)} vs B ${fmtLean(sb.leans[i] ?? 0)}`}</title>
            </rect>
            {isGap ? (
              <rect
                x={cellX(i) - 1.5}
                y={rowD_Y - 1.5}
                width={cellW + 3}
                height={rowH + 3}
                rx={5}
                fill="none"
                stroke={AMBER}
                strokeWidth={1.25}
              />
            ) : null}
          </g>
        );
      })}

      {/* ---- shared M axis ---- */}
      {Array.from({ length: n }, (_, i) => (
        <text key={`m-${i}`} x={cellX(i) + cellW / 2} y={131} textAnchor="middle" fontSize={9} fill={TEXT_MUT}>
          M{i + 1}
        </text>
      ))}

      {/* ---- per-channel Δ values (readable on the ink background) ---- */}
      {deltas.map((d, i) => (
        <text key={`dv-${i}`} x={cellX(i) + cellW / 2} y={145} textAnchor="middle" fontSize={7.5} fill={TEXT_DIM}>
          {fmtDelta2(d)}
        </text>
      ))}

      {/* ---- legend ---- */}
      <rect x={6} y={156} width={8} height={8} rx={2} fill={EM} />
      <text x={18} y={163.5} fontSize={8.5} fill={TEXT_MUT}>
        A/B rows: reward-shaped
      </text>
      <rect x={138} y={156} width={8} height={8} rx={2} fill={ROSE} />
      <text x={150} y={163.5} fontSize={8.5} fill={TEXT_MUT}>
        punishment-shaped
      </text>
      <rect x={268} y={156} width={8} height={8} rx={2} fill={EM} />
      <text x={280} y={163.5} fontSize={8.5} fill={TEXT_MUT}>
        Δ row: A stronger
      </text>
      <rect x={376} y={156} width={8} height={8} rx={2} fill={ROSE} />
      <text x={388} y={163.5} fontSize={8.5} fill={TEXT_MUT}>
        B stronger
      </text>

      {/* ---- biggest-gap annotation ---- */}
      <text x={6} y={182} fontSize={9} fill={AMBER}>
        {gap ? `Biggest gap: ${gap.text}` : "These two genomes write identical channel leans — no differences found."}
      </text>

      <text x={6} y={200} fontSize={8} fill={TEXT_DIM}>
        Hover any cell for exact values (mean Kenyon→MBON weight × compartment valence). Deeper color = stronger write.
      </text>
    </svg>
  );
}

// ---------------------------------------------------------------------------
// small presentational helpers (report-card styling language)
// ---------------------------------------------------------------------------

const SCROLLBAR =
  "[&::-webkit-scrollbar]:w-2 [&::-webkit-scrollbar-track]:bg-transparent [&::-webkit-scrollbar-thumb]:rounded-full [&::-webkit-scrollbar-thumb]:bg-border";

const SIDE_CHIP = {
  a: "border-emerald-500/40 bg-emerald-500/15 text-emerald-600 dark:text-emerald-400",
  b: "border-rose-500/40 bg-rose-500/15 text-rose-600 dark:text-rose-400",
} as const;

function SideChip({ side }: { side: "a" | "b" }) {
  return (
    <span
      aria-hidden
      className={cn(
        "flex h-5 w-5 shrink-0 items-center justify-center rounded-md border text-[11px] font-bold",
        SIDE_CHIP[side],
      )}
    >
      {side.toUpperCase()}
    </span>
  );
}

function IdentityPanel({ side, row }: { side: "a" | "b"; row: BrainRow }) {
  return (
    <div
      data-testid={`diff-identity-${side}`}
      className={cn(
        "rounded-xl border p-3",
        side === "a"
          ? "border-emerald-500/25 bg-emerald-500/5"
          : "border-rose-500/25 bg-rose-500/5",
      )}
    >
      <div className="flex flex-wrap items-center gap-2">
        <SideChip side={side} />
        <span className="min-w-0 flex-1 truncate text-sm font-semibold" title={row.name}>
          {row.name}
        </span>
        <TaskBadge task={row.task} />
        <Badge variant="outline" className="border-border/60 bg-muted/40 text-muted-foreground">
          GEN {row.generation}
        </Badge>
      </div>
      <div className="mt-2 flex flex-col gap-1 text-xs text-muted-foreground">
        <span className="flex items-center gap-1.5">
          <Trophy className="h-3.5 w-3.5 shrink-0" aria-hidden />
          {formatScore(row.task, row.score)}
        </span>
        <span className="flex items-center gap-1.5">
          <Calendar className="h-3.5 w-3.5 shrink-0" aria-hidden />
          <span title={new Date(row.createdAt).toLocaleString()}>{relativeDate(row.createdAt)}</span>
        </span>
        <span className="flex items-start gap-1.5">
          <StickyNote className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />
          <span className={cn("min-w-0 line-clamp-2", row.note ? "italic" : null)}>
            {row.note ?? "no note"}
          </span>
        </span>
      </div>
    </div>
  );
}

function StatTile({
  icon: Icon,
  label,
  children,
}: {
  icon: typeof Network;
  label: string;
  children: ReactNode;
}) {
  return (
    <div className="rounded-xl border border-border/60 bg-muted/20 p-3">
      <p className="flex items-center gap-1.5 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
        <Icon className="h-3.5 w-3.5 shrink-0 text-amber-500 dark:text-amber-400" aria-hidden />
        {label}
      </p>
      <div className="mt-1.5 flex flex-col gap-1.5">{children}</div>
    </div>
  );
}

/** one A-or-B line inside a stat tile, with its side chip */
function SideLine({ side, children }: { side: "a" | "b"; children: ReactNode }) {
  return (
    <p className="flex items-start gap-2 text-sm">
      <SideChip side={side} />
      <span className="min-w-0 flex-1">{children}</span>
    </p>
  );
}

// ---------------------------------------------------------------------------
// main component
// ---------------------------------------------------------------------------

export function BrainDiffDialog({ rows, open, onOpenChange }: BrainDiffDialogProps) {
  const [snapshots, setSnapshots] = useState<{ a: BrainSnapshot; b: BrainSnapshot } | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [retryNonce, setRetryNonce] = useState(0);
  /** transient inline feedback: "Copied ✓" / "Saved ✓" */
  const [exported, setExported] = useState<null | "text" | "png">(null);
  const resetTimer = useRef<number | null>(null);
  const fingerprintRef = useRef<HTMLDivElement | null>(null);

  // sticky rows: keep the last non-null pair so the exit animation has
  // content. React's render-phase "adjust state when a prop changes" pattern
  // (see react.dev/learn/you-might-not-need-an-effect) — no effect needed.
  const [shown, setShown] = useState<readonly [BrainRow, BrainRow] | null>(rows);
  const [prevRows, setPrevRows] = useState<readonly [BrainRow, BrainRow] | null>(rows);
  if (rows !== prevRows) {
    setPrevRows(rows);
    if (rows) setShown(rows);
  }

  // click when the dialog opens (fires on every false → true transition)
  useEffect(() => {
    if (open) playSound("click");
  }, [open]);

  // ---- fetch BOTH snapshots on open (state resets happen inside the async
  // task so the effect body stays side-effect free until the microtask runs)
  useEffect(() => {
    if (!open || !shown) return;
    const [rowA, rowB] = shown;
    let cancelled = false;
    (async () => {
      setLoading(true);
      setError(null);
      setSnapshots(null);
      setExported(null);
      const [resA, resB] = await Promise.allSettled([fetchBrain(rowA.id), fetchBrain(rowB.id)]);
      if (cancelled) return;
      if (resA.status === "fulfilled" && resB.status === "fulfilled") {
        setSnapshots({ a: resA.value.snapshot, b: resB.value.snapshot });
      } else {
        const failedA = resA.status === "rejected";
        const name = failedA ? rowA.name : rowB.name;
        const reason = failedA
          ? (resA as PromiseRejectedResult).reason
          : (resB as PromiseRejectedResult).reason;
        const msg = reason instanceof Error ? reason.message : "fetch failed";
        setError(`Couldn't load “${name}” — ${msg}`);
      }
      setLoading(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [open, shown, retryNonce]);

  const stats = useMemo(() => {
    if (!snapshots) return null;
    return { a: deriveStats(snapshots.a), b: deriveStats(snapshots.b) };
  }, [snapshots]);

  const gap = useMemo(
    () =>
      stats && shown ? biggestGap(stats.a, stats.b, shown[0].name, shown[1].name) : null,
    [stats, shown],
  );

  const verdict = useMemo(
    () => (stats && shown ? buildVerdict(shown[0], shown[1], stats.a, stats.b, gap) : null),
    [stats, shown, gap],
  );

  // ---- inline feedback chip helper ---------------------------------------
  const queueReset = useCallback(() => {
    if (resetTimer.current) window.clearTimeout(resetTimer.current);
    resetTimer.current = window.setTimeout(() => setExported(null), 2000);
  }, []);
  useEffect(() => {
    return () => {
      if (resetTimer.current) window.clearTimeout(resetTimer.current);
    };
  }, []);

  // ---- export 1: copy diff (clipboard with file-download fallback) -------
  const copyDiff = useCallback(async () => {
    if (!shown || !snapshots || !stats) return;
    const text = buildDiffText(
      shown[0],
      shown[1],
      snapshots.a,
      snapshots.b,
      stats.a,
      stats.b,
      gap,
    );
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      // clipboard API unavailable (or denied) → fall back to a file download
      const a = document.createElement("a");
      a.href = URL.createObjectURL(new Blob([text], { type: "text/plain;charset=utf-8" }));
      a.download = `fly-genomediff-${sanitizeFileName(shown[0].name)}-vs-${sanitizeFileName(shown[1].name)}.txt`;
      a.click();
      URL.revokeObjectURL(a.href);
    }
    setExported("text");
    playSound("ding");
    queueReset();
  }, [shown, snapshots, stats, gap, queueReset]);

  // ---- export 2: fingerprint PNG (SVG → 2× canvas raster → download) -----
  const exportPng = useCallback(() => {
    if (!shown) return;
    const svg = fingerprintRef.current?.querySelector("svg");
    if (!svg) return;
    try {
      const clone = svg.cloneNode(true) as SVGSVGElement;
      clone.setAttribute("width", String(SVG_W));
      clone.setAttribute("height", String(SVG_H));
      clone.setAttribute("xmlns", "http://www.w3.org/2000/svg");
      const xml = new XMLSerializer().serializeToString(clone);
      const url = URL.createObjectURL(new Blob([xml], { type: "image/svg+xml;charset=utf-8" }));
      const img = new Image();
      img.onload = () => {
        const scale = 2;
        const canvas = document.createElement("canvas");
        canvas.width = SVG_W * scale;
        canvas.height = SVG_H * scale;
        const c = canvas.getContext("2d");
        if (c) {
          c.fillStyle = INK;
          c.fillRect(0, 0, canvas.width, canvas.height);
          c.drawImage(img, 0, 0, canvas.width, canvas.height);
          canvas.toBlob((blob) => {
            if (!blob) return;
            const a = document.createElement("a");
            a.href = URL.createObjectURL(blob);
            a.download = `fly-genomediff-${sanitizeFileName(shown[0].name)}-vs-${sanitizeFileName(shown[1].name)}.png`;
            a.click();
            URL.revokeObjectURL(a.href);
          });
        }
        URL.revokeObjectURL(url);
        setExported("png");
        playSound("ding");
        queueReset();
      };
      img.onerror = () => URL.revokeObjectURL(url);
      img.src = url;
    } catch {
      /* rasterization unsupported — ignore */
    }
  }, [shown, queueReset]);

  const reduceMotion = useReducedMotion();

  // ---- derived comparison values for rendering ---------------------------
  const dBal = stats ? stats.a.balance - stats.b.balance : 0;
  const balanceVerdict =
    Math.abs(dBal) <= 0.01
      ? { text: "evenly matched", cls: "border-border/60 bg-muted/40 text-muted-foreground" }
      : dBal > 0
        ? {
            text: `“${shown?.[0].name ?? "A"}” is more reward-shaped`,
            cls: "border-emerald-500/40 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400",
          }
        : {
            text: `“${shown?.[1].name ?? "B"}” is more reward-shaped`,
            cls: "border-rose-500/40 bg-rose-500/10 text-rose-600 dark:text-rose-400",
          };

  const channelAgreement = useMemo(() => {
    if (!stats) return null;
    const n = Math.min(stats.a.leans.length, stats.b.leans.length);
    let agree = 0;
    let flips = 0;
    let bothUnwritten = 0;
    for (let i = 0; i < n; i++) {
      const a = stats.a.leans[i];
      const b = stats.b.leans[i];
      const au = Math.abs(a) < UNWRITTEN_EPS;
      const bu = Math.abs(b) < UNWRITTEN_EPS;
      if (au && bu) bothUnwritten++;
      else if (au || bu) agree++; // one writes it — no sign conflict
      else if (a >= 0 === b >= 0) agree++;
      else flips++;
    }
    return { n, agree, flips, bothUnwritten };
  }, [stats]);

  const totalDelta = stats ? stats.a.total - stats.b.total : 0;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        data-testid="genome-diff"
        className={cn("max-h-[85vh] overflow-y-auto p-4 sm:max-w-2xl sm:p-6", SCROLLBAR)}
      >
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-left">
            <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border border-amber-500/30 bg-amber-500/10">
              <GitCompareArrows className="h-4 w-4 text-amber-500 dark:text-amber-400" aria-hidden />
            </span>
            Genome diff
          </DialogTitle>
          <DialogDescription>
            {shown ? (
              <>
                How two learned connectomes differ — A&nbsp;&ldquo;{shown[0].name}&rdquo; vs
                B&nbsp;&ldquo;{shown[1].name}&rdquo;.
              </>
            ) : (
              "Loading the comparison…"
            )}
          </DialogDescription>
        </DialogHeader>

        {loading ? (
          <div className="flex flex-col items-center gap-4 py-10 text-center" data-testid="diff-loading">
            <Loader2 className="h-6 w-6 animate-spin text-amber-500" aria-hidden />
            <p className="text-sm text-muted-foreground">Fetching two connectomes…</p>
            <div className="grid w-full gap-3 sm:grid-cols-2" aria-hidden>
              <div className="h-28 animate-pulse rounded-xl border border-border/40 bg-muted/30" />
              <div className="h-28 animate-pulse rounded-xl border border-border/40 bg-muted/30" />
              <div className="h-32 animate-pulse rounded-xl border border-border/40 bg-muted/20 sm:col-span-2" />
            </div>
          </div>
        ) : error ? (
          <div className="flex flex-col items-center gap-3 rounded-xl border border-rose-500/30 bg-rose-500/5 px-4 py-8 text-center">
            <p className="text-sm text-rose-500 dark:text-rose-400">{error}</p>
            <Button
              variant="outline"
              className="h-11"
              onClick={() => setRetryNonce((v) => v + 1)}
              data-testid="diff-retry"
            >
              <RefreshCw className="h-4 w-4" /> Try again
            </Button>
          </div>
        ) : shown && snapshots && stats ? (
          <motion.div
            initial={{ opacity: 0, y: reduceMotion ? 0 : 10 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.3, ease: "easeOut" }}
            className="space-y-4"
          >
            {/* 1 — header strip: A ⇄ B with task badges */}
            <div
              data-testid="diff-header"
              className="flex flex-wrap items-center justify-center gap-x-2 gap-y-1.5 rounded-xl border border-border/60 bg-muted/30 px-3 py-2.5"
            >
              <span className="flex min-w-0 items-center gap-1.5 text-sm font-medium">
                <SideChip side="a" />
                <span className="max-w-[12rem] truncate" title={shown[0].name}>
                  {shown[0].name}
                </span>
              </span>
              <TaskBadge task={shown[0].task} />
              <ArrowLeftRight className="h-4 w-4 shrink-0 text-amber-500 dark:text-amber-400" aria-hidden />
              <TaskBadge task={shown[1].task} />
              <span className="flex min-w-0 items-center gap-1.5 text-sm font-medium">
                <span className="max-w-[12rem] truncate" title={shown[1].name}>
                  {shown[1].name}
                </span>
                <SideChip side="b" />
              </span>
            </div>

            {/* 2 — side-by-side identity */}
            <section aria-label="Brain identities" data-testid="diff-identity">
              <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                <IdentityPanel side="a" row={shown[0]} />
                <IdentityPanel side="b" row={shown[1]} />
              </div>
            </section>

            <Separator className="bg-border/60" />

            {/* 3 — aligned personality fingerprint + Δ strip */}
            <section aria-label="Aligned personality fingerprint">
              <h4 className="flex items-center gap-1.5 text-sm font-semibold">
                <Sparkles className="h-4 w-4 text-amber-500 dark:text-amber-400" aria-hidden />
                Personality fingerprint, aligned
              </h4>
              <div
                ref={fingerprintRef}
                data-testid="diff-fingerprint"
                className="mt-2 overflow-hidden rounded-xl border border-border/60"
              >
                <DiffFingerprintChart nameA={shown[0].name} nameB={shown[1].name} sa={stats.a} sb={stats.b} gap={gap} />
              </div>
              <p className="mt-2 text-xs leading-relaxed text-muted-foreground">
                Both brains share one color scale, so cell intensity is directly comparable.{" "}
                <span className="text-emerald-500 dark:text-emerald-400">Green</span> cells in the A/B
                rows lean reward, <span className="text-rose-500 dark:text-rose-400">red</span> lean
                punishment; in the Δ row green means{" "}
                <span className="font-medium">A writes that channel stronger</span>, red means B does.
                Faint outlined cells are unwritten.
              </p>
              {stats.a.kmCount === 0 || stats.b.kmCount === 0 ? (
                <p
                  data-testid="diff-km-warning"
                  className="mt-2 rounded-lg border border-amber-500/30 bg-amber-500/5 px-3 py-2 text-xs text-amber-700 dark:text-amber-400"
                >
                  {stats.a.kmCount === 0 ? `“${shown[0].name}”` : `“${shown[1].name}”`} has no learned
                  Kenyon→MBON weights in its snapshot — its fingerprint reads as flat.
                </p>
              ) : null}
            </section>

            <Separator className="bg-border/60" />

            {/* 4 — stats deltas */}
            <section aria-label="Wiring statistic deltas" data-testid="diff-stats" className="space-y-2">
              <h4 className="text-sm font-semibold">Wiring deltas</h4>
              <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                <StatTile icon={Network} label="Synapse budget">
                  <SideLine side="a">
                    {nums(stats.a.total)} total — {nums(stats.a.plastic)} plastic /{" "}
                    {nums(stats.a.innate)} innate
                  </SideLine>
                  <SideLine side="b">
                    {nums(stats.b.total)} total — {nums(stats.b.plastic)} plastic /{" "}
                    {nums(stats.b.innate)} innate
                  </SideLine>
                  <p className="text-[11px] leading-snug text-muted-foreground">
                    {totalDelta === 0
                      ? "identical wiring budget (plastic sizes track motor layout)"
                      : `Δ ${totalDelta > 0 ? "+" : ""}${nums(totalDelta)} synapses — plastic sizes track each brain's motor layout`}
                  </p>
                </StatTile>

                <StatTile icon={Zap} label="Strongest channel">
                  <SideLine side="a">
                    {stats.a.strongest ? (
                      <span
                        className={
                          stats.a.strongest.lean >= 0
                            ? "text-emerald-600 dark:text-emerald-400"
                            : "text-rose-600 dark:text-rose-400"
                        }
                      >
                        {stats.a.strongest.label} · {fmtLean(stats.a.strongest.lean)} (
                        {stats.a.strongest.lean >= 0 ? "reward" : "punishment"}-shaped)
                      </span>
                    ) : (
                      "none — untrained"
                    )}
                  </SideLine>
                  <SideLine side="b">
                    {stats.b.strongest ? (
                      <span
                        className={
                          stats.b.strongest.lean >= 0
                            ? "text-emerald-600 dark:text-emerald-400"
                            : "text-rose-600 dark:text-rose-400"
                        }
                      >
                        {stats.b.strongest.label} · {fmtLean(stats.b.strongest.lean)} (
                        {stats.b.strongest.lean >= 0 ? "reward" : "punishment"}-shaped)
                      </span>
                    ) : (
                      "none — untrained"
                    )}
                  </SideLine>
                  <p className="text-[11px] leading-snug text-muted-foreground">
                    mean Kenyon→MBON weight per channel, signed by compartment valence
                  </p>
                </StatTile>

                <StatTile icon={Scale} label="Valence balance">
                  <SideLine side="a">
                    <span className={stats.a.balance >= 0 ? "text-emerald-600 dark:text-emerald-400" : "text-rose-600 dark:text-rose-400"}>
                      {fmtLean(stats.a.balance)}
                    </span>
                    <span className="text-muted-foreground">
                      {" "}
                      — reward mass {stats.a.rewardMass.toFixed(3)} vs punish{" "}
                      {stats.a.punishMass.toFixed(3)}
                    </span>
                  </SideLine>
                  <SideLine side="b">
                    <span className={stats.b.balance >= 0 ? "text-emerald-600 dark:text-emerald-400" : "text-rose-600 dark:text-rose-400"}>
                      {fmtLean(stats.b.balance)}
                    </span>
                    <span className="text-muted-foreground">
                      {" "}
                      — reward mass {stats.b.rewardMass.toFixed(3)} vs punish{" "}
                      {stats.b.punishMass.toFixed(3)}
                    </span>
                  </SideLine>
                  <span
                    className={cn(
                      "inline-flex w-fit items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11px] font-medium",
                      balanceVerdict.cls,
                    )}
                  >
                    <Trophy className="h-3 w-3" aria-hidden />
                    {balanceVerdict.text}
                  </span>
                </StatTile>

                <StatTile icon={ArrowLeftRight} label="Channel agreement">
                  {channelAgreement ? (
                    <>
                      <p className="text-sm font-semibold">
                        {channelAgreement.agree}/{channelAgreement.n} channels lean the same way
                      </p>
                      <p className="text-[11px] leading-snug text-muted-foreground">
                        {channelAgreement.flips > 0
                          ? `${channelAgreement.flips} flip${channelAgreement.flips === 1 ? "" : "s"} valence between the two brains`
                          : "no channel flips valence"}
                        {channelAgreement.bothUnwritten > 0
                          ? ` · ${channelAgreement.bothUnwritten} unwritten in both`
                          : ""}
                      </p>
                    </>
                  ) : null}
                </StatTile>
              </div>
            </section>

            {/* 5 — verdict */}
            {verdict ? (
              <section
                aria-label="Plain-language verdict"
                data-testid="diff-verdict"
                className="rounded-xl border border-amber-500/30 bg-amber-500/5 border-l-4 border-l-amber-500/70 px-4 py-3"
              >
                <p className="flex items-start gap-2 text-sm leading-relaxed">
                  <Sparkles className="mt-0.5 h-4 w-4 shrink-0 text-amber-500 dark:text-amber-400" aria-hidden />
                  <span>{verdict}</span>
                </p>
              </section>
            ) : null}

            {/* 6 — export actions (inline feedback chips, no toasts) */}
            <div className="flex flex-col gap-2 sm:flex-row">
              <Button
                variant="outline"
                size="sm"
                data-testid="diff-copy"
                className="h-11 flex-1 gap-1.5 px-4"
                onClick={() => void copyDiff()}
              >
                <ClipboardCopy className="h-4 w-4" />
                {exported === "text" ? "Copied ✓" : "Copy diff"}
              </Button>
              <Button
                variant="outline"
                size="sm"
                data-testid="diff-png"
                className="h-11 flex-1 gap-1.5 px-4"
                onClick={exportPng}
              >
                <Download className="h-4 w-4" />
                {exported === "png" ? "Saved ✓" : "Download PNG"}
              </Button>
            </div>
            <p className="text-[11px] leading-relaxed text-muted-foreground">
              The diff copies as a plain-text report (falls back to a .txt download if the clipboard
              is blocked). The PNG is a 2× raster of the aligned fingerprint above.
            </p>
          </motion.div>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}
