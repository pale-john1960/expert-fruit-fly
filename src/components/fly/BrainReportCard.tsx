"use client";

/**
 * BrainReportCard — shareable per-brain "report card" dialog for the
 * Brain Library. Opened from a row's "Report card" button:
 *
 *   1. Identity block     — name, task badge, generation, score (task units),
 *                           created date, snapshot size, note, training totals
 *   2. Personality         — a 12-column MBON "fingerprint" derived from the
 *      fingerprint          ACTUAL snapshot weights (fetchBrain → snapshot):
 *                           per-MBON mean Kenyon→MBON weight × compartment
 *                           valence = the channel's learned lean
 *                           (emerald = reward-shaped / rose = punishment-shaped)
 *   3. Stats row           — total synapses, strongest channel, valence balance,
 *                           plastic vs innate synapse counts (innate counts
 *                           replicate FlyBrain.buildFixedWiring() formulas —
 *                           engine stays locked, this only READS its math)
 *   4. Export actions      — "Copy summary" (clipboard with file-download
 *                           fallback) + "Download PNG" (SVG → 2× canvas raster),
 *                           with inline "Copied ✓" / "Saved ✓" feedback chips
 *                           (no toasts) — same patterns as BrainLab's demo
 *                           chart-PNG / results-JSON exports (Task 9-c)
 *
 * Sounds: playSound("ding") on successful copy/export; the "click" on open is
 * fired by BrainLibrary's row button.
 *
 * Colors: TEAL is the library accent; emerald/rose are reserved for
 * valence semantics (appetitive vs aversive). No indigo/blue/purple.
 */

import { Fragment, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { motion } from "framer-motion";
import {
  Activity,
  Calendar,
  ClipboardCopy,
  Dna,
  Download,
  GitBranch,
  GraduationCap,
  Loader2,
  MoveRight,
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
import { playSound } from "@/lib/sound";
import type { BrainArchitecture, BrainLineage, BrainSnapshot } from "@/lib/flybrain/types";
import { cn } from "@/lib/utils";

// Shared with (and exported by) BrainLibrary. This is a safe module cycle:
// everything imported below is a hoisted function declaration (or type) that
// is only *called* at render time, long after both modules are initialized.
import {
  fetchBrain,
  formatBytes,
  formatScore,
  relativeDate,
  TaskBadge,
  type BrainRow,
} from "./BrainLibrary";

export interface BrainReportCardProps {
  row: BrainRow | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

// ---------------------------------------------------------------------------
// fingerprint derivation — pure math on the ACTUAL snapshot weights
// ---------------------------------------------------------------------------

export interface FingerprintStats {
  /** per-MBON learned lean: mean Kenyon→MBON weight × compartment valence.
   *  > 0 = reward-shaped (approach-leaning), < 0 = punishment-shaped. */
  leans: number[];
  /** per-MBON net motor effect: mean MBON→motor weight over motors */
  drives: number[];
  /** +1 for reward-side (appetitive) MBONs, −1 for punishment-side (aversive) */
  valences: number[];
  strongest: { label: string; index: number; lean: number; valenceLabel: string } | null;
  rewardMass: number;
  punishMass: number;
  balance: number;
  plastic: number;
  innate: number;
  total: number;
  kmCount: number;
  mmCount: number;
  gfCount: number;
  biasCount: number;
  neurons: number;
  seed: number;
  arch: BrainArchitecture;
}

/** MBON compartment rule, read from the engine: the first ceil(mbon/2) MBONs
 *  are appetitive (+1), the rest aversive (−1) — like real mushroom-body
 *  compartments. kenyonToMbon is MBON-major: [m * kenyonCount + k].
 *  mbonToMotor is motor-major: [motor * mbonCount + m]. */
export function deriveStats(snapshot: BrainSnapshot): FingerprintStats {
  const arch = snapshot.arch;
  const mbonCount = arch.mbonCount;
  const appHalf = Math.ceil(mbonCount / 2);
  const km = snapshot.weights.kenyonToMbon ?? [];
  const mm = snapshot.weights.mbonToMotor ?? [];
  // the giant-fiber (lobula→motor) escape reflex is present in every
  // snapshot the engine serializes, but older type declarations omit it
  const gf = (snapshot.weights as { lobulaToMotor?: number[] }).lobulaToMotor ?? [];
  const mbonBias = snapshot.weights.mbonBias ?? [];
  const motorBias = snapshot.weights.motorBias ?? [];

  const leans: number[] = [];
  const drives: number[] = [];
  const valences: number[] = [];
  for (let m = 0; m < mbonCount; m++) {
    const valence = m < appHalf ? 1 : -1;
    valences.push(valence);
    // mean Kenyon→MBON weight for this memory channel
    const start = m * arch.kenyonCount;
    let sum = 0;
    let n = 0;
    for (let k = start; k < start + arch.kenyonCount && k < km.length; k++) {
      sum += km[k] ?? 0;
      n++;
    }
    const meanKm = n > 0 ? sum / n : 0;
    // sign by compartment: + = reward wrote this channel, − = punishment did
    leans.push(meanKm * valence);
    // net effect of this channel on the motors (mean over motor outputs)
    let dsum = 0;
    let dn = 0;
    for (let o = 0; o < arch.motorCount; o++) {
      const idx = o * mbonCount + m;
      if (idx < mm.length) {
        dsum += mm[idx] ?? 0;
        dn++;
      }
    }
    drives.push(dn > 0 ? dsum / dn : 0);
  }

  let strongest: FingerprintStats["strongest"] = null;
  for (let m = 0; m < leans.length; m++) {
    if (strongest === null || Math.abs(leans[m]) > Math.abs(leans[strongest.index])) {
      strongest = {
        label: `M${m + 1}`,
        index: m,
        lean: leans[m],
        valenceLabel: valences[m] > 0 ? "reward-side" : "punishment-side",
      };
    }
  }

  const rewardMass = leans.reduce((a, v) => a + Math.max(v, 0), 0);
  const punishMass = leans.reduce((a, v) => a + Math.max(-v, 0), 0);

  const plastic = km.length + mm.length + gf.length + mbonBias.length + motorBias.length;
  const innate = countInnateSynapses(arch);
  const neurons =
    arch.retinaCols * arch.retinaRows * 2 + // retina + lamina (1:1)
    arch.medullaChannels * arch.medullaPools +
    arch.lobulaCount +
    arch.kenyonCount +
    arch.mbonCount +
    arch.motorCount;

  return {
    leans,
    drives,
    valences,
    strongest,
    rewardMass,
    punishMass,
    balance: rewardMass - punishMass,
    plastic,
    innate,
    total: plastic + innate,
    kmCount: km.length,
    mmCount: mm.length,
    gfCount: gf.length,
    biasCount: mbonBias.length + motorBias.length,
    neurons,
    seed: arch.seed,
    arch,
  };
}

/** Count the brain's innate (hard-wired) synapses from the architecture alone.
 *  Replicates FlyBrain.buildFixedWiring()'s wiring sizes read-only — the
 *  engine itself is locked; these formulas are deterministic on the arch:
 *    retina→lamina (1:1 graded), lamina→medulla (nonzero kernel cells),
 *    medulla→lobula (lobulaCount × min(10, medulla cells)),
 *    lobula→kenyon (kenyonCount × min(6, lobulaCount)). */
function countInnateSynapses(arch: BrainArchitecture): number {
  const { retinaCols: C, retinaRows: R, medullaChannels: CH, medullaPools: P, lobulaCount, kenyonCount } = arch;
  const retina = C * R;
  const poolCols = P === 24 ? 8 : P === 12 ? 4 : Math.ceil(Math.sqrt(P));
  const poolRows = Math.max(1, Math.round(P / poolCols));
  const cellW = C / poolCols;
  const cellH = R / poolRows;

  let medullaNZ = 0;
  for (let ch = 0; ch < CH; ch++) {
    for (let p = 0; p < P; p++) {
      const pc = p % poolCols;
      const pr = Math.floor(p / poolCols);
      for (let r = 0; r < R; r++) {
        if (r < pr * cellH || r >= (pr + 1) * cellH) continue;
        for (let c = 0; c < C; c++) {
          if (c < pc * cellW || c >= (pc + 1) * cellW) continue;
          const lx = ((c - pc * cellW) / cellW) * 2 - 1;
          const ly = ((r - pr * cellH) / cellH) * 2 - 1;
          let w = 0;
          switch (ch) {
            case 0: w = (1 - Math.abs(lx) * 1.2) * (1 - Math.abs(ly) * 1.2) * 2 - 0.5; break;
            case 1: w = 0.5 - (1 - Math.abs(lx) * 1.2) * (1 - Math.abs(ly) * 1.2) * 2; break;
            case 2: w = -lx * 0.9; break;
            case 3: w = lx * 0.9; break;
            case 4: w = -ly * 0.9; break;
            case 5: w = ly * 0.9; break;
            case 6: w = Math.abs(lx) * Math.abs(ly) * 0.8 + 0.1; break;
            default: w = 0.35; break;
          }
          if (Math.abs(w) > 0.05) medullaNZ++;
        }
      }
    }
  }

  const lobulaFanIn = Math.min(10, CH * P);
  const kenyonFanIn = Math.min(6, lobulaCount);
  return retina + medullaNZ + lobulaCount * lobulaFanIn + kenyonCount * kenyonFanIn;
}

// ---------------------------------------------------------------------------
// plain-text report card (for the clipboard / fallback download)
// ---------------------------------------------------------------------------

function sanitizeFileName(name: string): string {
  const clean = name
    .toLowerCase()
    .replace(/[^a-z0-9-_]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return clean || "brain";
}

function fmtLean(v: number): string {
  return `${v >= 0 ? "+" : "-"}${Math.abs(v).toFixed(3)}`;
}

function buildSummaryText(row: BrainRow, snapshot: BrainSnapshot, stats: FingerprintStats): string {
  const taskLabel = row.task.charAt(0).toUpperCase() + row.task.slice(1);
  const dateStr = (() => {
    try {
      return new Date(row.createdAt).toLocaleString("en-US", { timeZone: "UTC", hour12: false });
    } catch {
      return row.createdAt;
    }
  })();
  const meta = snapshot.meta;
  const strongestLine = stats.strongest
    ? `${stats.strongest.label} · ${stats.strongest.valenceLabel} channel · lean ${fmtLean(stats.strongest.lean)} (${stats.strongest.lean >= 0 ? "reward" : "punishment"}-shaped)`
    : "none — an untrained brain";
  const balanceWord =
    Math.abs(stats.balance) < 0.002
      ? "balanced (naive)"
      : stats.balance > 0
        ? "leans reward"
        : "leans punishment";
  const nums = (n: number) => n.toLocaleString("en-US");

  const L: string[] = [];
  L.push("EXPERT FRUIT FLY — BRAIN REPORT CARD");
  L.push("=".repeat(40));
  L.push("");
  L.push("IDENTITY");
  L.push(`  Name          ${row.name}`);
  L.push(`  Task          ${taskLabel}`);
  L.push(`  Generation    ${row.generation}`);
  L.push(`  Score         ${formatScore(row.task, row.score)}`);
  L.push(`  Saved         ${dateStr} (${relativeDate(row.createdAt)})`);
  L.push(`  Snapshot      ${formatBytes(row.snapshotBytes)}`);
  L.push(
    `  Training      ${nums(meta?.steps ?? 0)} brain-steps · ${meta?.rewards ?? 0} rewards · ${meta?.punishments ?? 0} punishments`,
  );
  if (row.note) L.push(`  Note          ${row.note}`);
  L.push("");
  L.push("PERSONALITY FINGERPRINT");
  L.push(`  How this brain's ${stats.leans.length} memory channels lean — learned from`);
  L.push("  its training. + = reward-shaped (approach), - = punishment-shaped");
  L.push("  (avoid). M1–M6 are reward-side channels, the rest punishment-side.");
  const per = 4;
  for (let i = 0; i < stats.leans.length; i += per) {
    const cells = stats.leans
      .slice(i, i + per)
      .map((v, j) => `M${i + j + 1} ${fmtLean(v)}`.padEnd(14));
    L.push(`  ${cells.join("")}`.trimEnd());
  }
  L.push(`  Strongest channel  ${strongestLine}`);
  L.push(
    `  Valence balance    ${fmtLean(stats.balance)} — ${balanceWord} (reward mass ${stats.rewardMass.toFixed(3)} vs punishment mass ${stats.punishMass.toFixed(3)})`,
  );
  L.push("");
  L.push("WIRING");
  L.push(`  Total synapses     ${nums(stats.total)}`);
  L.push(
    `  Plastic (learned)  ${nums(stats.plastic)} — Kenyon→MBON ${nums(stats.kmCount)} · MBON→motor ${nums(stats.mmCount)} · giant-fiber ${nums(stats.gfCount)} · biases ${nums(stats.biasCount)}`,
  );
  L.push(`  Innate (fixed)     ${nums(stats.innate)} — rebuilt identically from seed ${stats.seed}`);
  L.push(
    `  Brain              ${nums(stats.neurons)} neurons · ${nums(stats.arch.kenyonCount)} Kenyon cells · ${stats.leans.length} memory channels · ${stats.arch.motorCount} motors · retina ${stats.arch.retinaCols}×${stats.arch.retinaRows}`,
  );
  L.push("");
  L.push(`— Expert Fruit Fly report card · generated ${new Date().toISOString()}`);
  return L.join("\n");
}

// ---------------------------------------------------------------------------
// fingerprint SVG — explicit hex fills so the PNG raster stays faithful
// (CSS classes / Tailwind tokens would be lost in the serialized clone)
// ---------------------------------------------------------------------------

const INK = "#0d1512"; // panel background (also the PNG canvas fill)
const EM = "#34d399"; // emerald-400 — appetitive / reward-shaped
const EM_SOFT = "#6ee7b7";
const ROSE = "#fb7185"; // rose-400 — aversive / punishment-shaped
const ROSE_SOFT = "#fda4af";
const TEXT_MUT = "#a1a1aa";
const TEXT_DIM = "#71717a";
const GRID = "#9ca3af";

const SVG_W = 560;
const SVG_H = 244;

function FingerprintChart({ stats }: { stats: FingerprintStats }) {
  const n = stats.leans.length;
  const appHalf = Math.ceil(n / 2);
  // wash zones
  const washY = 30;
  const washH = 152;
  const zeroY = washY + washH / 2; // 106
  const maxBar = 70;
  const maxAbsLean = Math.max(0.01, ...stats.leans.map((v) => Math.abs(v)));
  const maxAbsDrive = Math.max(0.01, ...stats.drives.map((v) => Math.abs(v)));

  // column centers: reward group in the left wash, punishment group right
  const centers: number[] = [];
  const groupCenters = (x0: number, w: number, count: number) => {
    const out: number[] = [];
    for (let i = 0; i < count; i++) out.push(x0 + (w * (i + 0.5)) / count);
    return out;
  };
  centers.push(...groupCenters(12, 266, appHalf), ...groupCenters(282, 266, n - appHalf));
  const spacing = n > 0 ? SVG_W / n : SVG_W;
  const barW = Math.max(10, Math.min(26, spacing * 0.58));
  const driveW = Math.max(14, Math.min(34, spacing * 0.76));
  const strongestIdx = stats.strongest?.index ?? -1;

  return (
    <svg
      viewBox={`0 0 ${SVG_W} ${SVG_H}`}
      className="h-auto w-full"
      role="img"
      aria-label={`Personality fingerprint: ${n} memory channels — reward-side channels 1–${appHalf}, punishment-side channels ${appHalf + 1}–${n}. Bar direction shows each channel's learned lean: up is reward-shaped, down is punishment-shaped.`}
      fontFamily="system-ui, -apple-system, 'Segoe UI', sans-serif"
    >
      {/* panel */}
      <rect x={0} y={0} width={SVG_W} height={SVG_H} rx={10} fill={INK} />

      {/* compartment washes + group headers */}
      <rect x={12} y={washY} width={266} height={washH} rx={8} fill={EM} opacity={0.07} />
      <rect x={282} y={washY} width={266} height={washH} rx={8} fill={ROSE} opacity={0.07} />
      <text
        x={145}
        y={21}
        textAnchor="middle"
        fontSize={10}
        fontWeight={600}
        letterSpacing={0.8}
        fill={EM_SOFT}
        opacity={0.9}
      >
        REWARD-SIDE CHANNELS
      </text>
      <text
        x={415}
        y={21}
        textAnchor="middle"
        fontSize={10}
        fontWeight={600}
        letterSpacing={0.8}
        fill={ROSE_SOFT}
        opacity={0.9}
      >
        PUNISHMENT-SIDE CHANNELS
      </text>

      {/* zero line */}
      <line x1={16} y1={zeroY} x2={544} y2={zeroY} stroke={GRID} strokeWidth={1} strokeDasharray="4 4" opacity={0.55} />

      {/* diverging lean bars */}
      {stats.leans.map((lean, i) => {
        const h = Math.max(1.5, (Math.abs(lean) / maxAbsLean) * maxBar);
        const up = lean >= 0;
        const color = up ? EM : ROSE;
        return (
          <rect
            key={`bar-${i}`}
            data-testid="fingerprint-bar"
            x={centers[i] - barW / 2}
            y={up ? zeroY - h : zeroY}
            width={barW}
            height={h}
            rx={3}
            fill={color}
            opacity={0.92}
            stroke={i === strongestIdx ? "#f4f4f5" : "none"}
            strokeWidth={i === strongestIdx ? 1.25 : 0}
          >
            <title>{`M${i + 1} · lean ${fmtLean(lean)} — ${up ? "reward" : "punishment"}-shaped memory (${stats.valences[i] > 0 ? "reward-side" : "punishment-side"} channel${i === strongestIdx ? " · strongest" : ""})`}</title>
          </rect>
        );
      })}

      {/* column labels */}
      {stats.leans.map((_, i) => (
        <text key={`label-${i}`} x={centers[i]} y={196} textAnchor="middle" fontSize={9.5} fill={TEXT_MUT}>
          M{i + 1}
        </text>
      ))}

      {/* net motor drive strip */}
      {stats.drives.map((drive, i) => {
        const opacity = 0.25 + 0.65 * (Math.abs(drive) / maxAbsDrive);
        const color = drive >= 0 ? EM : ROSE;
        return (
          <rect
            key={`drive-${i}`}
            data-testid="fingerprint-drive"
            x={centers[i] - driveW / 2}
            y={204}
            width={driveW}
            height={16}
            rx={4}
            fill={color}
            opacity={opacity}
          >
            <title>{`M${i + 1} · net motor drive ${fmtLean(drive)} (${drive >= 0 ? "pushes the motors" : "holds the motors back"})`}</title>
          </rect>
        );
      })}

      {/* legend */}
      <rect x={16} y={227} width={8} height={8} rx={2} fill={EM} />
      <text x={28} y={235} fontSize={9} fill={TEXT_MUT}>
        reward-shaped (approach)
      </text>
      <rect x={392} y={227} width={8} height={8} rx={2} fill={ROSE} />
      <text x={404} y={235} fontSize={9} fill={TEXT_MUT}>
        punishment-shaped (avoid)
      </text>
    </svg>
  );
}

// ---------------------------------------------------------------------------
// small presentational helpers
// ---------------------------------------------------------------------------

const SCROLLBAR =
  "[&::-webkit-scrollbar]:w-2 [&::-webkit-scrollbar-track]:bg-transparent [&::-webkit-scrollbar-thumb]:rounded-full [&::-webkit-scrollbar-thumb]:bg-border";

function InfoRow({
  icon: Icon,
  label,
  value,
  className,
}: {
  icon: typeof Trophy;
  label: string;
  value: ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "flex items-center justify-between gap-3 rounded-lg border border-border/60 bg-muted/30 px-3 py-2",
        className,
      )}
    >
      <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
        <Icon className="h-3.5 w-3.5 shrink-0" aria-hidden />
        {label}
      </span>
      <span className="truncate text-right text-sm font-medium">{value}</span>
    </div>
  );
}

function StatTile({
  icon: Icon,
  label,
  value,
  valueClass,
  sub,
  children,
}: {
  icon: typeof Network;
  label: string;
  value: ReactNode;
  valueClass?: string;
  sub?: ReactNode;
  children?: ReactNode;
}) {
  return (
    <div className="rounded-xl border border-border/60 bg-muted/20 p-3">
      <p className="flex items-center gap-1.5 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
        <Icon className="h-3.5 w-3.5 shrink-0 text-teal-500" aria-hidden />
        {label}
      </p>
      <p className={cn("mt-1 text-sm font-semibold", valueClass)}>{value}</p>
      {sub ? <p className="mt-0.5 text-[11px] leading-snug text-muted-foreground">{sub}</p> : null}
      {children}
    </div>
  );
}

// ---------------------------------------------------------------------------
// training pedigree (Task 13-c) — family-tree chip strip from snapshot.lineage
// ---------------------------------------------------------------------------

/** 12345 ms → "12s" · 192000 ms → "3.2 min" · 10800000 ms → "3.0 h" */
function fmtDuration(ms: number): string {
  const s = ms / 1000;
  if (s < 60) return `${Math.round(s)}s`;
  const min = s / 60;
  if (min < 60) return `${min.toFixed(1)} min`;
  return `${(min / 60).toFixed(1)} h`;
}

/** one milestone chip: `Founder · gen 1 · 3.5 m` (score only when nonzero) */
function PedigreeChip({
  milestone,
  task,
  highlight,
}: {
  milestone: { gen: number; score: number; label: string };
  task: string;
  highlight?: boolean;
}) {
  return (
    <span
      data-testid="pedigree-chip"
      className={cn(
        "inline-flex max-w-full items-center gap-1 whitespace-nowrap rounded-lg border px-2.5 py-1 text-[11px] font-medium tabular-nums",
        highlight
          ? "border-teal-500/30 bg-teal-500/10 text-teal-700 dark:text-teal-300"
          : "border-border/60 bg-muted/30",
      )}
    >
      <span className="truncate">{milestone.label}</span>
      <span aria-hidden className="text-muted-foreground">·</span>
      <span>gen {milestone.gen}</span>
      {milestone.score > 0 ? (
        <>
          <span aria-hidden className="text-muted-foreground">·</span>
          <span>{formatScore(task, milestone.score)}</span>
        </>
      ) : null}
    </span>
  );
}

/**
 * Rendered ONLY when the snapshot carries a `lineage` object — every brain
 * saved before round 13 renders nothing at all (backward-compatible silence).
 */
function PedigreeSection({ lineage, task }: { lineage: BrainLineage; task: string }) {
  const milestones = lineage.pedigree ?? [];
  if (milestones.length === 0 && !lineage.parentName) return null;

  // muted stat line: "25 generations · 3.2 min of training"
  const facts: string[] = [];
  if (typeof lineage.generations === "number" && lineage.generations > 0) {
    facts.push(
      `${lineage.generations} generation${lineage.generations === 1 ? "" : "s"}`,
    );
  }
  if (typeof lineage.trainedMs === "number" && lineage.trainedMs > 0) {
    facts.push(`${fmtDuration(lineage.trainedMs)} of training`);
  }

  return (
    <section aria-label="Training pedigree" data-testid="report-pedigree">
      <h4 className="flex items-center gap-1.5 text-sm font-semibold">
        <GitBranch className="h-4 w-4 text-teal-500 dark:text-teal-400" aria-hidden />
        Pedigree
      </h4>
      <div
        data-testid="pedigree-strip"
        className="mt-2 flex flex-wrap items-center gap-1.5 gap-y-2"
      >
        {lineage.parentName ? (
          <Fragment>
            <span
              data-testid="pedigree-parent"
              title={`This session continued from the saved brain "${lineage.parentName}"`}
              className="inline-flex max-w-full items-center gap-1 whitespace-nowrap rounded-lg border border-rose-500/40 bg-rose-500/10 px-2.5 py-1 text-[11px] font-medium text-rose-600 dark:text-rose-400"
            >
              <span className="truncate">Cloned from &ldquo;{lineage.parentName}&rdquo;</span>
            </span>
            <MoveRight
              className="h-3.5 w-3.5 shrink-0 text-emerald-500 dark:text-emerald-400"
              aria-hidden
            />
          </Fragment>
        ) : null}
        {milestones.map((m, i) => (
          <Fragment key={`${m.label}-${m.gen}-${i}`}>
            {i > 0 ? (
              <MoveRight
                className="h-3.5 w-3.5 shrink-0 text-emerald-500 dark:text-emerald-400"
                aria-hidden
              />
            ) : null}
            <PedigreeChip milestone={m} task={task} highlight={i === milestones.length - 1} />
          </Fragment>
        ))}
      </div>
      {facts.length > 0 ? (
        <p className="mt-2 text-xs text-muted-foreground tabular-nums">{facts.join(" · ")}</p>
      ) : null}
    </section>
  );
}

// ---------------------------------------------------------------------------
// main component
// ---------------------------------------------------------------------------

export function BrainReportCard({ row, open, onOpenChange }: BrainReportCardProps) {
  const [snapshot, setSnapshot] = useState<BrainSnapshot | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [retryNonce, setRetryNonce] = useState(0);
  /** transient inline feedback: "Copied ✓" / "Saved ✓" */
  const [exported, setExported] = useState<null | "text" | "png">(null);
  const resetTimer = useRef<number | null>(null);
  const fingerprintRef = useRef<HTMLDivElement | null>(null);

  // sticky row: keep the last non-null row so the exit animation has content
  const [shown, setShown] = useState<BrainRow | null>(row);
  useEffect(() => {
    if (row) setShown(row);
  }, [row]);

  const rowId = row?.id ?? null;

  // ---- fetch the snapshot on open (existing fetchBrain helper) -----------
  useEffect(() => {
    if (!open || !rowId) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    setSnapshot(null);
    setExported(null);
    (async () => {
      try {
        const { snapshot: snap } = await fetchBrain(rowId);
        if (!cancelled) setSnapshot(snap);
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : "Could not load this brain");
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [open, rowId, retryNonce]);

  const stats = useMemo(() => (snapshot ? deriveStats(snapshot) : null), [snapshot]);

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

  // ---- export 1: copy summary (clipboard with file-download fallback) ---
  const copySummary = useCallback(async () => {
    if (!shown || !snapshot || !stats) return;
    const text = buildSummaryText(shown, snapshot, stats);
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      // clipboard API unavailable (or denied) → fall back to a file download
      const a = document.createElement("a");
      a.href = URL.createObjectURL(new Blob([text], { type: "text/plain;charset=utf-8" }));
      a.download = `fly-reportcard-${sanitizeFileName(shown.name)}.txt`;
      a.click();
      URL.revokeObjectURL(a.href);
    }
    setExported("text");
    playSound("ding");
    queueReset();
  }, [shown, snapshot, stats, queueReset]);

  // ---- export 2: fingerprint PNG (SVG → 2× canvas raster → download) ----
  const exportPng = useCallback(() => {
    if (!shown || !stats) return;
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
            a.download = `fly-reportcard-${sanitizeFileName(shown.name)}.png`;
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
  }, [shown, stats, queueReset]);

  const meta = snapshot?.meta;
  const balance =
    stats && Math.abs(stats.balance) < 0.002
      ? { word: "balanced (naive)", cls: "text-muted-foreground" }
      : stats && stats.balance > 0
        ? { word: "leans reward", cls: "text-emerald-500 dark:text-emerald-400" }
        : { word: "leans punishment", cls: "text-rose-500 dark:text-rose-400" };
  const plasticShare = stats && stats.total > 0 ? stats.plastic / stats.total : 0;
  const nums = (v: number) => v.toLocaleString("en-US");

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        data-testid="report-card"
        className={cn(
          "max-h-[85vh] overflow-y-auto p-4 sm:max-w-lg sm:p-6",
          SCROLLBAR,
        )}
      >
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-left">
            <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border border-teal-500/30 bg-teal-500/10">
              <GraduationCap className="h-4 w-4 text-teal-500 dark:text-teal-400" aria-hidden />
            </span>
            Brain report card
          </DialogTitle>
          <DialogDescription>
            {shown ? (
              <>
                Identity, learned personality and wiring stats for &ldquo;{shown.name}&rdquo; — share it
                as text or an image.
              </>
            ) : (
              "Loading this brain's report card…"
            )}
          </DialogDescription>
        </DialogHeader>

        {loading ? (
          <div className="flex flex-col items-center gap-3 py-10 text-center" data-testid="report-loading">
            <Loader2 className="h-6 w-6 animate-spin text-teal-500" aria-hidden />
            <p className="text-sm text-muted-foreground">Fetching the connectome…</p>
          </div>
        ) : error ? (
          <div className="flex flex-col items-center gap-3 rounded-xl border border-rose-500/30 bg-rose-500/5 px-4 py-8 text-center">
            <p className="text-sm text-rose-500 dark:text-rose-400">Couldn&apos;t load this brain: {error}</p>
            <Button
              variant="outline"
              className="h-11"
              onClick={() => setRetryNonce((v) => v + 1)}
            >
              <RefreshCw className="h-4 w-4" /> Try again
            </Button>
          </div>
        ) : shown && snapshot && stats ? (
          <motion.div
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.3, ease: "easeOut" }}
            className="space-y-4"
          >
            {/* 1 — identity block */}
            <section aria-label="Brain identity" data-testid="report-identity">
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-base font-semibold leading-tight">{shown.name}</span>
                <TaskBadge task={shown.task} />
                <Badge variant="outline" className="border-teal-500/30 bg-teal-500/10 text-teal-600 dark:text-teal-300">
                  GEN {shown.generation}
                </Badge>
              </div>
              <div className="mt-3 grid grid-cols-1 gap-2 sm:grid-cols-2">
                <InfoRow icon={Trophy} label="Score" value={formatScore(shown.task, shown.score)} />
                <InfoRow
                  icon={Calendar}
                  label="Saved"
                  value={
                    <span title={new Date(shown.createdAt).toLocaleString()}>
                      {relativeDate(shown.createdAt)}
                    </span>
                  }
                />
                <InfoRow icon={Dna} label="Snapshot" value={formatBytes(shown.snapshotBytes)} />
                <InfoRow
                  icon={Activity}
                  label="Training"
                  value={`${nums(meta?.steps ?? 0)} steps · ${meta?.rewards ?? 0}✓ / ${meta?.punishments ?? 0}✕`}
                  className="sm:col-span-2"
                />
              </div>
              {shown.note ? (
                <p
                  className="mt-2 flex items-start gap-1.5 rounded-lg border border-border/60 bg-muted/30 px-3 py-2 text-xs text-muted-foreground"
                  data-testid="report-note"
                >
                  <StickyNote className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />
                  <span className="italic">{shown.note}</span>
                </p>
              ) : null}
            </section>

            {/* 2 — personality fingerprint */}
            <section aria-label="Personality fingerprint">
              <h4 className="flex items-center gap-1.5 text-sm font-semibold">
                <Sparkles className="h-4 w-4 text-teal-500 dark:text-teal-400" aria-hidden />
                Personality fingerprint
              </h4>
              <div
                ref={fingerprintRef}
                data-testid="fingerprint"
                className="mt-2 overflow-hidden rounded-xl border border-border/60"
              >
                <FingerprintChart stats={stats} />
              </div>
              <p className="mt-2 text-xs leading-relaxed text-muted-foreground">
                How this brain&rsquo;s {stats.leans.length} memory channels lean — learned from its
                training. <span className="text-emerald-500 dark:text-emerald-400">Green</span> bars
                lean reward (approach), <span className="text-rose-500 dark:text-rose-400">red</span>{" "}
                lean punishment (avoid); height = how strongly the channel was written. The small
                cells below each column show that channel&rsquo;s net push on the motors. Hover any
                bar for exact numbers.
              </p>
            </section>

            {/* 2.5 — training pedigree (Task 13-c): family-tree chip strip.
                Rendered ONLY when the snapshot carries lineage metadata —
                pre-round-13 brains render nothing (backward compatible). */}
            {snapshot.lineage ? (
              <PedigreeSection lineage={snapshot.lineage} task={shown.task} />
            ) : null}

            {/* 3 — stats row */}
            <section
              aria-label="Wiring statistics"
              data-testid="report-stats"
              className="grid grid-cols-1 gap-2 sm:grid-cols-2"
            >
              <StatTile
                icon={Network}
                label="Total synapses"
                value={nums(stats.total)}
                sub={`${nums(stats.neurons)} neurons · ${stats.leans.length} memory channels`}
              />
              <StatTile
                icon={Zap}
                label="Strongest channel"
                value={
                  <span className={stats.strongest && stats.strongest.lean >= 0 ? "text-emerald-500 dark:text-emerald-400" : "text-rose-500 dark:text-rose-400"}>
                    {stats.strongest
                      ? `${stats.strongest.label} · ${fmtLean(stats.strongest.lean)}`
                      : "none yet"}
                  </span>
                }
                sub={
                  stats.strongest
                    ? `${stats.strongest.valenceLabel} channel, ${stats.strongest.lean >= 0 ? "reward" : "punishment"}-shaped (mean Kenyon→MBON)`
                    : undefined
                }
              />
              <StatTile
                icon={Scale}
                label="Valence balance"
                value={<span className={balance?.cls}>{`${fmtLean(stats.balance)} · ${balance?.word}`}</span>}
                sub={`reward mass ${stats.rewardMass.toFixed(3)} vs punishment ${stats.punishMass.toFixed(3)}`}
              />
              <StatTile
                icon={Dna}
                label="Plastic vs innate"
                value={`${nums(stats.plastic)} / ${nums(stats.innate)}`}
                sub="learned vs hard-wired (innate rebuilds from seed)"
              >
                <div
                  className="mt-2 h-1.5 w-full overflow-hidden rounded-full bg-muted"
                  role="progressbar"
                  aria-label="Plastic share of all synapses"
                  aria-valuenow={Math.round(plasticShare * 100)}
                  aria-valuemin={0}
                  aria-valuemax={100}
                >
                  <div
                    data-testid="plastic-share-bar"
                    className="h-full rounded-full bg-teal-500/70"
                    style={{ width: `${Math.round(plasticShare * 100)}%` }}
                  />
                </div>
              </StatTile>
            </section>

            {/* 4 — export actions (inline feedback chips, no toasts) */}
            <div className="flex flex-col gap-2 sm:flex-row">
              <Button
                variant="outline"
                size="sm"
                data-testid="report-copy"
                className="h-11 flex-1 gap-1.5 px-4"
                onClick={() => void copySummary()}
              >
                <ClipboardCopy className="h-4 w-4" />
                {exported === "text" ? "Copied ✓" : "Copy summary"}
              </Button>
              <Button
                variant="outline"
                size="sm"
                data-testid="report-png"
                className="h-11 flex-1 gap-1.5 px-4"
                onClick={exportPng}
              >
                <Download className="h-4 w-4" />
                {exported === "png" ? "Saved ✓" : "Download PNG"}
              </Button>
            </div>
            <p className="text-[11px] leading-relaxed text-muted-foreground">
              Summary copies as a plain-text report card (falls back to a .txt download if the
              clipboard is blocked). The PNG is a 2× raster of the fingerprint above.
            </p>
          </motion.div>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}
