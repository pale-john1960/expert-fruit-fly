/**
 * Session Export — shareable markdown reports + CSV history for the two
 * trainers (Dino + Bicycle).
 *
 * Pure, React-free helpers so they stay unit-testable and safe to call from
 * any click handler (they never touch the training loops — callers snapshot
 * their CURRENT React state / sim values at click time and pass them in).
 *
 *  - `toSessionMarkdown(opts)` → a formatted report: title, generated
 *    timestamp, task, summary stats, optional duel / duck-defense / lineage /
 *    challenge sections, a compact unicode table of the last N generations
 *    (full table when ≤ 30) and a fixed footer.
 *  - `toHistoryCsv(history)` → `generation,best,avg` header + one row per
 *    generation.
 *  - `downloadTextFile(filename, text, mime)` → Blob download (SSR-guarded).
 *  - `sessionExportFilename(task, ext, date?)` →
 *    `expert-fruit-fly-{task}-YYYYMMDD-HHmm.{ext}`.
 *  - `escapeMarkdownCell(text)` → sanitizes user text (brain names, notes) so
 *    pipes / newlines can't break the tables.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** One per-generation history record (both trainers use this shape). */
export interface HistoryPoint {
  gen: number;
  best: number;
  avg: number;
}

/** One `label → value` row of the summary stats table. */
export interface ExportStat {
  label: string;
  value: string;
}

/** Dino: "You vs the fly" duel record for the session. */
export interface DuelRecord {
  wins: number;
  losses: number;
  /** best HUMAN score achieved in a duel this session */
  bestHuman: number;
}

/** Dino: duck-defense totals — the "Pterodactyl report". */
export interface DuckDefenseRecord {
  birdsSeen: number;
  birdsCleared: number;
}

/** Champion lineage summary (both trainers track the same view shape). */
export interface LineageSummary {
  /** generation the family line starts from (the founder) */
  rootGen: number;
  rootScore: number;
  championGen: number;
  championScore: number;
  /** champion.gen − root.gen — the span of breeding behind the champion */
  breedGens: number;
}

/** Bicycle: "You vs the fly" challenge record for the session. */
export interface ChallengeRecord {
  wins: number;
  losses: number;
  /** your best challenge distance this session */
  bestHuman: number;
}

/** Options for {@link toSessionMarkdown} — designed to serve BOTH trainers:
 *  everything task-specific is optional so each caller passes only what it
 *  has (duel stats / duck defense for dino, lineage / challenge for bicycle). */
export interface SessionExportOptions {
  /** which trainer produced this session */
  task: "dino" | "bicycle";
  /** report title override (defaults to "Expert Fruit Fly — {Dino|Bicycle} session report") */
  title?: string;
  /** generation timestamp (defaults to `new Date()`; pass explicitly in tests) */
  generatedAt?: Date;
  /** per-generation history — the table + CSV body */
  history: HistoryPoint[];
  /** score unit shown in the table header and stats ("pt" / "m") */
  unit?: string;
  /** ordered summary stats rendered as a `Stat | Value` table */
  stats: ExportStat[];
  /** dino: human-vs-fly duel record (omit/null → section skipped) */
  duel?: DuelRecord | null;
  /** dino: duck-defense stats (omit/null or 0 birds seen → section skipped) */
  duckDefense?: DuckDefenseRecord | null;
  /** champion lineage summary (omit/null → section skipped) */
  lineage?: LineageSummary | null;
  /** bicycle: human-vs-fly challenge record (omit/null → section skipped) */
  challenge?: ChallengeRecord | null;
  /** free-form note (e.g. the brain name it was trained under); sanitized */
  note?: string | null;
  /** max generations kept in the table (default 30; shorter history = full table) */
  maxTableRows?: number;
}

// ---------------------------------------------------------------------------
// Sanitizers / formatting (pure, dependency-free)
// ---------------------------------------------------------------------------

/** Make user-provided text safe inside a markdown table cell: escape pipes,
 *  collapse line breaks to spaces, trim. Empty/whitespace-only → "—". */
export function escapeMarkdownCell(text: string | null | undefined): string {
  if (text === null || text === undefined) return "—";
  const cleaned = String(text)
    .replace(/\r?\n/g, " ") // newlines would break the row
    .replace(/\|/g, "\\|") // pipes would split the cell
    .replace(/\s+/g, " ")
    .trim();
  return cleaned.length > 0 ? cleaned : "—";
}

/** Quote a CSV cell if it contains a separator, quote or newline. */
function csvCell(value: string | number): string {
  const s = String(value);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** Trim a number to at most 2 decimals without trailing zeros ("12", "4.25"). */
function fmtNum(value: number): string {
  if (!Number.isFinite(value)) return "0";
  return String(Number(value.toFixed(2)));
}

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

/** "2026-01-12 14:32" — local time, human-readable, no external deps. */
function fmtTimestamp(d: Date): string {
  return (
    `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}` +
    ` ${pad2(d.getHours())}:${pad2(d.getMinutes())}`
  );
}

// ---------------------------------------------------------------------------
// Markdown report
// ---------------------------------------------------------------------------

/** Build the shareable markdown session report (pure). */
export function toSessionMarkdown(opts: SessionExportOptions): string {
  const {
    task,
    history,
    stats,
    unit = "pt",
    maxTableRows = 30,
  } = opts;

  const generatedAt = opts.generatedAt ?? new Date();
  const title =
    opts.title ??
    `Expert Fruit Fly — ${task === "dino" ? "Dino" : "Bicycle"} session report`;

  const lines: string[] = [];
  const push = (...ls: string[]) => lines.push(...ls);

  // --- header -------------------------------------------------------------
  push(`# ${escapeMarkdownCell(title)}`, "");
  push(
    `*Generated ${fmtTimestamp(generatedAt)} · task: ${task === "dino" ? "Chrome Dino runner" : "bicycle balancing"}.*`,
    ""
  );

  if (opts.note) {
    push(`> ${escapeMarkdownCell(opts.note)}`, "");
  }

  // --- summary stats table --------------------------------------------------
  push("## Summary", "");
  push("| Stat | Value |", "| --- | --- |");
  for (const s of stats) {
    push(`| ${escapeMarkdownCell(s.label)} | ${escapeMarkdownCell(s.value)} |`);
  }
  push("");

  // --- duel record (dino) ----------------------------------------------------
  if (opts.duel && opts.duel.wins + opts.duel.losses > 0) {
    const d = opts.duel;
    push("## Duel record — You vs the fly", "");
    push(`- Session tally: **You ${d.wins} · Fly ${d.losses}**`);
    push(`- Best human score in a duel: **${fmtNum(d.bestHuman)} ${unit}**`);
    push(
      "- The champion keeps its sugar/shock learning during duels — rematches compound.",
      ""
    );
  }

  // --- duck defense (dino) ---------------------------------------------------
  if (opts.duckDefense && opts.duckDefense.birdsSeen > 0) {
    const { birdsSeen, birdsCleared } = opts.duckDefense;
    const pct = Math.round((100 * birdsCleared) / Math.max(1, birdsSeen));
    push("## Duck defense — the Pterodactyl report", "");
    push(
      `- Pterodactyls seen: **${birdsSeen}** · ducks cleared: **${birdsCleared}** (**${pct}%**)`
    );
    push("");
  }

  // --- challenge record (bicycle) ---------------------------------------------
  if (opts.challenge && opts.challenge.wins + opts.challenge.losses > 0) {
    const c = opts.challenge;
    push("## Challenge record — You vs the fly", "");
    push(`- Session tally: **You ${c.wins} · Fly ${c.losses}**`);
    push(`- Your best challenge distance: **${fmtNum(c.bestHuman)} ${unit}**`);
    push(
      "- Challenges also train the champion — its trained weights fold back in.",
      ""
    );
  }

  // --- champion lineage --------------------------------------------------------
  if (opts.lineage) {
    const l = opts.lineage;
    push("## Champion lineage", "");
    if (l.breedGens > 0) {
      push(
        `- Founder: gen **${l.rootGen}** (${fmtNum(l.rootScore)} ${unit}) → champion: gen **${l.championGen}** (${fmtNum(l.championScore)} ${unit})`
      );
      push(`- **${l.breedGens} generations of breeding** behind the champion.`);
    } else {
      push(
        `- The champion is an **original fly** — gen ${l.championGen}, ${fmtNum(l.championScore)} ${unit}.`
      );
      push("- Bred descendants will grow its family line.");
    }
    push("");
  }

  // --- history table -------------------------------------------------------------
  push("## Generations", "");
  if (history.length === 0) {
    push("_No generations finished yet._", "");
  } else {
    const shown =
      history.length > maxTableRows ? history.slice(-maxTableRows) : history;
    if (history.length > maxTableRows) {
      push(
        `_Showing the last ${shown.length} of ${history.length} generations._`,
        ""
      );
    }
    push(`| gen | best (${unit}) | avg (${unit}) |`, "| ---: | ---: | ---: |");
    for (const h of shown) {
      push(`| ${h.gen} | ${fmtNum(h.best)} | ${fmtNum(h.avg)} |`);
    }
    push("");
  }

  // --- footer (fixed wording) -------------------------------------------------------
  push("---", "", "_Generated by Expert Fruit Fly — trains entirely in your browser._", "");

  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// CSV export
// ---------------------------------------------------------------------------

/** `generation,best,avg` header + one row per generation (pure). */
export function toHistoryCsv(history: HistoryPoint[]): string {
  const rows = ["generation,best,avg"];
  for (const h of history) {
    rows.push(
      [h.gen, fmtNum(h.best), fmtNum(h.avg)].map(csvCell).join(",")
    );
  }
  return rows.join("\n") + "\n";
}

// ---------------------------------------------------------------------------
// Download plumbing (browser-only, SSR-guarded)
// ---------------------------------------------------------------------------

/** `expert-fruit-fly-{task}-YYYYMMDD-HHmm.{ext}` (local time; pass a Date in tests). */
export function sessionExportFilename(
  task: "dino" | "bicycle",
  ext: "md" | "csv",
  date?: Date
): string {
  const d = date ?? new Date();
  const stamp =
    `${d.getFullYear()}${pad2(d.getMonth() + 1)}${pad2(d.getDate())}` +
    `-${pad2(d.getHours())}${pad2(d.getMinutes())}`;
  return `expert-fruit-fly-${task}-${stamp}.${ext}`;
}

/** Trigger a Blob download. Returns true when a download was actually fired
 *  (false on the server or when the DOM APIs are unavailable — never throws). */
export function downloadTextFile(
  filename: string,
  text: string,
  mime = "text/plain"
): boolean {
  if (typeof document === "undefined" || typeof URL === "undefined") {
    return false; // SSR — caller can skip
  }
  try {
    const blob = new Blob([text], { type: `${mime};charset=utf-8` });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    a.rel = "noopener";
    a.style.display = "none";
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    return true;
  } catch {
    return false; // blocked download, full storage, detached DOM — give up quietly
  }
}
