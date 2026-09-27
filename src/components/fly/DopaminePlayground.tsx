"use client";

/**
 * DopaminePlayground — an interactive, self-contained toy that lets the reader
 * RUN the fly's 3-factor learning rule (Δw = lr × dopamine × valence ×
 * eligibility) with their own clicks. Embedded in the "How It Works" tab,
 * Section 2, right after DopamineLoopDiagram.
 *
 * Toy circuit (pure local React state, deterministic, deliberately NOT wired
 * to the real engine in src/lib/flybrain — this is a 6-cell teaching model):
 *   - 6 toy Kenyon cells K1–K6. Odor A activates K1–K3, odor B activates K4–K6
 *     (sparse code: each odor lights a different third of the cells).
 *   - 2 MBON compartments: M+ (appetitive, "approach", emerald) and M−
 *     (aversive, "avoid", rose) — valence +1 / −1, mirroring the engine's
 *     mbonValence compartments.
 *   - 12 plastic weights w[K][M], initialized to 0.10.
 *   - Eligibility trace e[K]: set to 1 for the active cells when an odor is
 *     presented, decaying ×0.5 on each subsequent presentation.
 *   - Dopamine: +1 sugar, −1 shock, 0 nothing.
 *   - Learning: Δw = 0.08 × dopamine × valence × eligibility, clamped to
 *     [−1, +1] (the same shape as the engine's Kenyon→MBON rule).
 *   - Behavior: score = mean(active-K w→M+) − mean(active-K w→M−); the sign
 *     is the verdict (approach / avoid / indifferent).
 *
 * Visual language matches HowItWorksDiagrams.tsx (region hues retina/amber,
 * teal, kenyon #e879f9, MBON emerald/rose split), with a scoped `dpg-` style
 * prefix, dark-first but light-mode-safe, and prefers-reduced-motion kills
 * every CSS transition/animation.
 *
 * Cross-tab deep link (Task 12-c): the "Run the real experiment" CTA at the
 * end of the card hands the visitor off to the REAL 928-neuron Brain Lab —
 * see runRealExperiment below for how the tab switch happens.
 */

import {
  useCallback,
  useEffect,
  useReducer,
  useRef,
  useState,
} from "react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  ArrowRight,
  Candy,
  FlaskConical,
  Loader2,
  Minus,
  MousePointerClick,
  Play,
  RotateCcw,
  Zap,
} from "lucide-react";
import { playSound } from "@/lib/sound";
import { useBrainStore } from "@/lib/flybrain/store";

/* ------------------------------------------------------------------ types */

type Odor = "A" | "B";
type Outcome = "sugar" | "shock" | "none";
type Verdict = "approach" | "avoid" | "indifferent";

interface FeedItem {
  n: number;
  text: string;
  tone: "emerald" | "rose" | "neutral";
}

interface LastTrial {
  odor: Odor;
  outcome: Outcome;
  /** dopamine delivered: +1 / −1 / 0 */
  da: number;
  /** representative eligible Kenyon cell (first active cell) */
  cell: number;
  /** eligibility of that cell at update time */
  e: number;
  /** Δw applied to K→M+ and K→M− for that cell (unclamped) */
  dwP: number;
  dwM: number;
  clamped: boolean;
  /** fading trace from the previous trial, if any crossed over */
  traceNote: string | null;
}

interface SimState {
  /** w[k][0] = K(k+1)→M+, w[k][1] = K(k+1)→M− */
  w: number[][];
  elig: number[];
  presented: Odor | null;
  trial: number;
  feed: FeedItem[];
  last: LastTrial | null;
}

type Action =
  | { type: "present"; odor: Odor }
  | { type: "outcome"; kind: Outcome }
  | { type: "reset" };

/* ------------------------------------------------------------- constants */

const LR = 0.08; // learning rate
const E_DECAY = 0.5; // eligibility decay per presentation
const INIT_W = 0.1; // neutral starting weight
const DEADBAND = 0.1; // |score| ≤ this → "indifferent"
const VALENCE = [1, -1]; // M+ = +1 (approach), M− = −1 (avoid)
const ODOR_KC: Record<Odor, readonly number[]> = {
  A: [0, 1, 2],
  B: [3, 4, 5],
};
const KC_NAME = (k: number) => `K${k + 1}`;

/* Region hues — byte-identical to HowItWorksDiagrams' REGION_HEX. */
const KENYON_FILL = "#e879f9";
const EMERALD = "#34d399";
const ROSE = "#fb7185";
const ODOR_A_HEX = "#f59e0b";
const ODOR_B_HEX = "#2dd4bf";

const DEMO_PACING = 600; // ms between demo actions

/* --------------------------------------------------------------- helpers */

const clampW = (v: number) => Math.min(1, Math.max(-1, v));
const clamp01 = (v: number) => Math.min(1, Math.max(0, v));
const sleep = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

/** "+0.34" / "-0.14" — signed fixed-decimal, tabular-friendly. */
function fmtSigned(v: number, digits = 2): string {
  return (v >= 0 ? "+" : "-") + Math.abs(v).toFixed(digits);
}

function freshState(): SimState {
  return {
    w: Array.from({ length: 6 }, () => [INIT_W, INIT_W]),
    elig: new Array(6).fill(0),
    presented: null,
    trial: 0,
    feed: [],
    last: null,
  };
}

/** mean w→M+ minus mean w→M− over the odor's active Kenyon cells. */
function odorScore(w: number[][], odor: Odor): number {
  const ks = ODOR_KC[odor];
  let mp = 0;
  let mm = 0;
  for (const k of ks) {
    mp += w[k][0];
    mm += w[k][1];
  }
  return mp / ks.length - mm / ks.length;
}

function verdictOf(score: number): Verdict {
  if (score > DEADBAND) return "approach";
  if (score < -DEADBAND) return "avoid";
  return "indifferent";
}

const VERDICT_WORD: Record<Verdict, string> = {
  approach: "APPROACHES",
  avoid: "AVOIDS",
  indifferent: "indifferent",
};

/* --------------------------------------------------------------- reducer */

function reducer(s: SimState, a: Action): SimState {
  switch (a.type) {
    case "present": {
      // every new cue decays all traces ×0.5, then the freshly active cells
      // get a full eligibility of 1
      const elig = s.elig.map((v) => v * E_DECAY);
      for (const k of ODOR_KC[a.odor]) elig[k] = 1;
      return { ...s, elig, presented: a.odor };
    }

    case "outcome": {
      if (!s.presented) return s;
      const odor = s.presented;
      const da = a.kind === "sugar" ? 1 : a.kind === "shock" ? -1 : 0;

      const w = s.w.map((row) => row.slice());
      let clamped = false;
      for (let k = 0; k < 6; k++) {
        for (let m = 0; m < 2; m++) {
          const raw = w[k][m] + LR * da * VALENCE[m] * s.elig[k];
          const next = clampW(raw);
          if (next !== raw) clamped = true;
          w[k][m] = next;
        }
      }

      const cell = ODOR_KC[odor][0];
      const e = s.elig[cell];
      const dwP = LR * da * VALENCE[0] * e;
      const dwM = LR * da * VALENCE[1] * e;

      // fading trace: cells from the OTHER odor still eligible?
      let traceNote: string | null = null;
      const other: Odor = odor === "A" ? "B" : "A";
      let traceMax = 0;
      for (const k of ODOR_KC[other]) traceMax = Math.max(traceMax, s.elig[k]);
      if (traceMax > 0.02) {
        traceNote = `fading trace: odor ${other} cells still ×${traceMax.toFixed(2)} eligible`;
      }

      const n = s.trial + 1;
      let text: string;
      let tone: FeedItem["tone"];
      if (da === 0) {
        text = `odor ${odor} + no reward → dopamine 0 — the gate stays shut, Δw 0.00`;
        tone = "neutral";
      } else {
        const mPlusWord = da > 0 ? "strengthened" : "weakened";
        const mMinusWord = da > 0 ? "weakened" : "strengthened";
        const range = `K${ODOR_KC[odor][0] + 1}–K${ODOR_KC[odor][2] + 1}`;
        text = `odor ${odor} + ${a.kind} → M+ wiring ${mPlusWord} (Δw ${fmtSigned(dwP)} on ${range}), M− wiring ${mMinusWord} (Δw ${fmtSigned(dwM)})`;
        tone = da > 0 ? "emerald" : "rose";
      }
      if (traceNote) text += ` · ${traceNote}`;
      if (clamped) text += ` · hit the ±1.00 clamp`;

      return {
        ...s,
        w,
        elig: s.elig,
        presented: null,
        trial: n,
        feed: [{ n, text, tone }, ...s.feed].slice(0, 30),
        last: {
          odor,
          outcome: a.kind,
          da,
          cell,
          e,
          dwP,
          dwM,
          clamped,
          traceNote,
        },
      };
    }

    case "reset":
      return freshState();
  }
}

/* --------------------------------------------------------- scoped styles */

const DPG_STYLE = `
.dpg .dpg-t { fill: var(--foreground); }
.dpg .dpg-tm { fill: var(--muted-foreground); }
.dpg .dpg-card { fill: var(--card); }
.dpg .dpg-kc { stroke: #c026d3; }
.dark .dpg .dpg-kc { stroke: #e879f9; }
.dpg .dpg-mp { stroke: #059669; }
.dark .dpg .dpg-mp { stroke: #34d399; }
.dpg .dpg-mpf { fill: #34d399; }
.dpg .dpg-mpt { fill: #047857; }
.dark .dpg .dpg-mpt { fill: #6ee7b7; }
.dpg .dpg-mm { stroke: #be123c; }
.dark .dpg .dpg-mm { stroke: #fb7185; }
.dpg .dpg-mmf { fill: #fb7185; }
.dpg .dpg-mmt { fill: #be123c; }
.dark .dpg .dpg-mmt { fill: #fda4af; }
.dpg .dpg-cuea { stroke: #d97706; fill: #f59e0b; }
.dark .dpg .dpg-cuea { stroke: #f59e0b; }
.dpg .dpg-cueb { stroke: #0d9488; fill: #2dd4bf; }
.dark .dpg .dpg-cueb { stroke: #2dd4bf; }
.dpg .dpg-syn { transition: stroke-width .25s ease, stroke-opacity .25s ease; }
.dpg .dpg-fill { transition: fill-opacity .25s ease; }
.dpg .dpg-bar { transition: height .2s ease; }
.dpg .dpg-needle { transition: left .25s ease; }
@keyframes dpg-pulse { 0%, 100% { opacity: 1; } 50% { opacity: .3; } }
.dpg .dpg-pulse { animation: dpg-pulse 1.8s ease-in-out infinite; }
@keyframes dpg-rise { from { opacity: 0; transform: translateY(14px); } to { opacity: 1; transform: none; } }
.dpg .dpg-enter { animation: dpg-rise .5s ease-out both; }
.dpg .dpg-scroll::-webkit-scrollbar { width: 6px; height: 6px; }
.dpg .dpg-scroll::-webkit-scrollbar-track { background: transparent; }
.dpg .dpg-scroll::-webkit-scrollbar-thumb { background: color-mix(in oklab, currentColor 25%, transparent); border-radius: 3px; }
.dpg .dpg-scroll { scrollbar-width: thin; }
@media (prefers-reduced-motion: reduce) {
  .dpg .dpg-enter,
  .dpg .dpg-pulse,
  .dpg .dpg-syn,
  .dpg .dpg-fill,
  .dpg .dpg-bar,
  .dpg .dpg-needle { animation: none !important; transition: none !important; }
}
`;

/* -------------------------------------------------------- SVG bits */

/** Tiny arrowhead pointing +x (same shape language as the hiw diagrams). */
function Head({
  x,
  y,
  a = 0,
  s = 1,
  fill,
  opacity,
}: {
  x: number;
  y: number;
  a?: number;
  s?: number;
  fill: string;
  opacity: number;
}) {
  return (
    <path
      d="M -6.5 -5 L 6.5 0 L -6.5 5 Z"
      transform={`translate(${x} ${y}) rotate(${a}) scale(${s})`}
      fill={fill}
      opacity={opacity}
      aria-hidden="true"
    />
  );
}

/** Stroke width / opacity for a synapse line, from |w|. */
function synStyle(wv: number): React.CSSProperties {
  const a = clamp01(Math.abs(wv));
  return { strokeWidth: 0.9 + 3.1 * a, strokeOpacity: 0.28 + 0.62 * a };
}

interface CircuitProps {
  w: number[][];
  elig: number[];
  presented: Odor | null;
  lastDa: number;
  meanP: number;
  meanM: number;
}

/**
 * Desktop circuit — 6 Kenyon cells across the top, M+/M− compartments at the
 * bottom, 12 plastic synapse lines whose thickness & brightness track |w|.
 */
function CircuitDesktop({ w, elig, presented, lastDa, meanP, meanM }: CircuitProps) {
  const kx = [60, 172, 284, 396, 508, 620];
  const mPlusT = [120, 144, 168, 192, 216, 240];
  const mMinusT = [440, 464, 488, 512, 536, 560];
  const fillP = 0.12 + 0.5 * clamp01(meanP);
  const fillM = 0.12 + 0.5 * clamp01(meanM);

  return (
    <div className="mx-auto hidden max-w-[720px] md:block">
      <svg
        viewBox="0 0 680 242"
        role="img"
        aria-label="Toy mushroom-body circuit: six Kenyon cells K1 to K6, each wiring into two MBON compartments, M plus approach and M minus avoid. Line thickness shows synapse strength; glowing rings mark eligible cells."
        className="h-auto w-full"
      >
        <title>Toy circuit — 6 Kenyon cells wiring into M+ / M− compartments</title>
        <g strokeLinecap="round" strokeLinejoin="round">
          {/* odor cue chips */}
          <rect x={45} y={6} width={254} height={20} rx={10} className="dpg-card" />
          <rect
            x={45} y={6} width={254} height={20} rx={10}
            className="dpg-cuea" fillOpacity={presented === "A" ? 0.22 : 0.1}
            strokeOpacity={presented === "A" ? 0.95 : 0.45} strokeWidth={1.4}
          />
          <text x={172} y={20} textAnchor="middle" fontSize={10} fontWeight={700} letterSpacing={1.2} className="dpg-t">
            ODOR A · K1–K3
          </text>
          <rect x={381} y={6} width={254} height={20} rx={10} className="dpg-card" />
          <rect
            x={381} y={6} width={254} height={20} rx={10}
            className="dpg-cueb" fillOpacity={presented === "B" ? 0.22 : 0.1}
            strokeOpacity={presented === "B" ? 0.95 : 0.45} strokeWidth={1.4}
          />
          <text x={508} y={20} textAnchor="middle" fontSize={10} fontWeight={700} letterSpacing={1.2} className="dpg-t">
            ODOR B · K4–K6
          </text>

          {/* 12 plastic synapses (drawn first, under the nodes) */}
          {kx.map((x, i) =>
            [0, 1].map((m) => {
              const tx = m === 0 ? mPlusT[i] : mMinusT[i];
              const wv = w[i][m];
              const st = synStyle(wv);
              const cls = m === 0 ? "dpg-mp" : "dpg-mm";
              const fill = m === 0 ? "#059669" : "#be123c";
              return (
                <g key={`syn-${i}-${m}`} aria-hidden="true">
                  <path
                    d={`M ${x} 72 C ${x} 110, ${tx} 130, ${tx} 176`}
                    fill="none"
                    className={`dpg-syn ${cls}`}
                    style={st}
                  />
                  <Head x={tx} y={177} a={90} s={0.62} fill={fill} opacity={st.strokeOpacity} />
                </g>
              );
            }),
          )}

          {/* Kenyon nodes */}
          {kx.map((x, i) => {
            const active = presented !== null && ODOR_KC[presented].includes(i);
            const e = elig[i];
            return (
              <g key={`kc-${i}`}>
                {active && (
                  <circle cx={x} cy={56} r={21} fill="none" stroke={KENYON_FILL} strokeWidth={2} strokeOpacity={0.85} className="dpg-pulse" aria-hidden="true" />
                )}
                {e > 0.03 && (
                  <circle
                    cx={x} cy={56} r={17} fill="none" stroke={KENYON_FILL}
                    strokeWidth={1.8} strokeOpacity={0.25 + 0.55 * e} aria-hidden="true"
                  />
                )}
                <circle
                  cx={x} cy={56} r={14}
                  fill={active ? KENYON_FILL : undefined}
                  fillOpacity={active ? 0.95 : undefined}
                  className={active ? undefined : "dpg-card"}
                  stroke={KENYON_FILL}
                  strokeOpacity={active ? 1 : 0.55}
                  strokeWidth={1.6}
                />
                <text x={x} y={59.5} textAnchor="middle" fontSize={10} fontWeight={700} fill={active ? "#ffffff" : undefined} className={active ? undefined : "dpg-t"}>
                  {KC_NAME(i)}
                </text>
                {e > 0.03 && (
                  <text x={x} y={88} textAnchor="middle" fontSize={7.5} className="dpg-tm" style={{ fontFamily: "var(--font-mono, monospace)" }}>
                    e {e.toFixed(2)}
                  </text>
                )}
              </g>
            );
          })}

          {/* M+ compartment */}
          {lastDa > 0 && (
            <rect x={102} y={177} width={156} height={54} rx={17} fill="none" className="dpg-mp dpg-pulse" strokeWidth={2} strokeOpacity={0.8} aria-hidden="true" />
          )}
          <rect x={105} y={180} width={150} height={48} rx={14} className="dpg-mpf dpg-fill" fillOpacity={fillP} />
          <rect x={105} y={180} width={150} height={48} rx={14} fill="none" className="dpg-mp" strokeWidth={1.6} />
          <text x={180} y={200} textAnchor="middle" fontSize={11.5} fontWeight={700} letterSpacing={0.8} className="dpg-mpt">
            M+ · APPROACH
          </text>
          <text x={180} y={218} textAnchor="middle" fontSize={10.5} className="dpg-t" style={{ fontFamily: "var(--font-mono, monospace)" }}>
            mean {fmtSigned(meanP)}
          </text>

          {/* M− compartment */}
          {lastDa < 0 && (
            <rect x={422} y={177} width={156} height={54} rx={17} fill="none" className="dpg-mm dpg-pulse" strokeWidth={2} strokeOpacity={0.8} aria-hidden="true" />
          )}
          <rect x={425} y={180} width={150} height={48} rx={14} className="dpg-mmf dpg-fill" fillOpacity={fillM} />
          <rect x={425} y={180} width={150} height={48} rx={14} fill="none" className="dpg-mm" strokeWidth={1.6} />
          <text x={500} y={200} textAnchor="middle" fontSize={11.5} fontWeight={700} letterSpacing={0.8} className="dpg-mmt">
            M− · AVOID
          </text>
          <text x={500} y={218} textAnchor="middle" fontSize={10.5} className="dpg-t" style={{ fontFamily: "var(--font-mono, monospace)" }}>
            mean {fmtSigned(meanM)}
          </text>

          {/* dopamine badge from the last trial */}
          <rect x={303} y={186} width={74} height={36} rx={9} className="dpg-card" />
          {lastDa !== 0 && (
            <rect
              x={303} y={186} width={74} height={36} rx={9}
              fill={lastDa > 0 ? EMERALD : ROSE} fillOpacity={0.16}
              stroke={lastDa > 0 ? EMERALD : ROSE} strokeWidth={1.4}
            />
          )}
          <text x={340} y={200} textAnchor="middle" fontSize={7.5} letterSpacing={1} className="dpg-tm">
            DOPAMINE
          </text>
          <text
            x={340} y={214} textAnchor="middle" fontSize={11} fontWeight={700}
            className={lastDa > 0 ? "dpg-mpt" : lastDa < 0 ? "dpg-mmt" : "dpg-tm"}
            style={{ fontFamily: "var(--font-mono, monospace)" }}
          >
            {lastDa > 0 ? "+1" : lastDa < 0 ? "-1" : "0"}
          </text>
        </g>
      </svg>
    </div>
  );
}

/** Mobile circuit — same toy, stacked proportions for narrow viewports. */
function CircuitMobile({ w, elig, presented, lastDa, meanP, meanM }: CircuitProps) {
  const kx = [42, 97, 152, 208, 263, 318];
  const mPlusT = [46, 65, 84, 103, 122, 141];
  const mMinusT = [202, 221, 240, 259, 278, 297];
  const fillP = 0.12 + 0.5 * clamp01(meanP);
  const fillM = 0.12 + 0.5 * clamp01(meanM);

  return (
    <div className="mx-auto w-full max-w-[420px] md:hidden">
      <svg
        viewBox="0 0 360 252"
        role="img"
        aria-label="Toy mushroom-body circuit, stacked: six Kenyon cells wiring into M plus approach and M minus avoid compartments. Line thickness shows synapse strength."
        className="h-auto w-full"
      >
        <title>Toy circuit — stacked layout</title>
        <g strokeLinecap="round" strokeLinejoin="round">
          {/* odor chips */}
          <rect x={30} y={4} width={134} height={17} rx={8} className="dpg-card" />
          <rect
            x={30} y={4} width={134} height={17} rx={8}
            className="dpg-cuea" fillOpacity={presented === "A" ? 0.22 : 0.1}
            strokeOpacity={presented === "A" ? 0.95 : 0.45} strokeWidth={1.2}
          />
          <text x={97} y={16} textAnchor="middle" fontSize={8} fontWeight={700} letterSpacing={0.8} className="dpg-t">
            ODOR A · K1–K3
          </text>
          <rect x={196} y={4} width={134} height={17} rx={8} className="dpg-card" />
          <rect
            x={196} y={4} width={134} height={17} rx={8}
            className="dpg-cueb" fillOpacity={presented === "B" ? 0.22 : 0.1}
            strokeOpacity={presented === "B" ? 0.95 : 0.45} strokeWidth={1.2}
          />
          <text x={263} y={16} textAnchor="middle" fontSize={8} fontWeight={700} letterSpacing={0.8} className="dpg-t">
            ODOR B · K4–K6
          </text>

          {/* 12 plastic synapses */}
          {kx.map((x, i) =>
            [0, 1].map((m) => {
              const tx = m === 0 ? mPlusT[i] : mMinusT[i];
              const wv = w[i][m];
              const st = synStyle(wv);
              const cls = m === 0 ? "dpg-mp" : "dpg-mm";
              const fill = m === 0 ? "#059669" : "#be123c";
              return (
                <g key={`synm-${i}-${m}`} aria-hidden="true">
                  <path
                    d={`M ${x} 66 C ${x} 105, ${tx} 120, ${tx} 192`}
                    fill="none"
                    className={`dpg-syn ${cls}`}
                    style={st}
                  />
                  <Head x={tx} y={193} a={90} s={0.5} fill={fill} opacity={st.strokeOpacity} />
                </g>
              );
            }),
          )}

          {/* Kenyon nodes */}
          {kx.map((x, i) => {
            const active = presented !== null && ODOR_KC[presented].includes(i);
            const e = elig[i];
            return (
              <g key={`kcm-${i}`}>
                {active && (
                  <circle cx={x} cy={52} r={18} fill="none" stroke={KENYON_FILL} strokeWidth={1.8} strokeOpacity={0.85} className="dpg-pulse" aria-hidden="true" />
                )}
                {e > 0.03 && (
                  <circle
                    cx={x} cy={52} r={14.5} fill="none" stroke={KENYON_FILL}
                    strokeWidth={1.5} strokeOpacity={0.25 + 0.55 * e} aria-hidden="true"
                  />
                )}
                <circle
                  cx={x} cy={52} r={11.5}
                  fill={active ? KENYON_FILL : undefined}
                  fillOpacity={active ? 0.95 : undefined}
                  className={active ? undefined : "dpg-card"}
                  stroke={KENYON_FILL}
                  strokeOpacity={active ? 1 : 0.55}
                  strokeWidth={1.4}
                />
                <text x={x} y={55.5} textAnchor="middle" fontSize={9} fontWeight={700} fill={active ? "#ffffff" : undefined} className={active ? undefined : "dpg-t"}>
                  {i + 1}
                </text>
                {e > 0.03 && (
                  <text x={x} y={80} textAnchor="middle" fontSize={7} className="dpg-tm" style={{ fontFamily: "var(--font-mono, monospace)" }}>
                    e {e.toFixed(2)}
                  </text>
                )}
              </g>
            );
          })}

          {/* M+ compartment */}
          {lastDa > 0 && (
            <rect x={29} y={193} width={146} height={52} rx={15} fill="none" className="dpg-mp dpg-pulse" strokeWidth={1.8} strokeOpacity={0.8} aria-hidden="true" />
          )}
          <rect x={32} y={196} width={140} height={46} rx={12} className="dpg-mpf dpg-fill" fillOpacity={fillP} />
          <rect x={32} y={196} width={140} height={46} rx={12} fill="none" className="dpg-mp" strokeWidth={1.4} />
          <text x={102} y={214} textAnchor="middle" fontSize={9.5} fontWeight={700} letterSpacing={0.5} className="dpg-mpt">
            M+ · APPROACH
          </text>
          <text x={102} y={230} textAnchor="middle" fontSize={9} className="dpg-t" style={{ fontFamily: "var(--font-mono, monospace)" }}>
            mean {fmtSigned(meanP)}
          </text>

          {/* M− compartment */}
          {lastDa < 0 && (
            <rect x={185} y={193} width={146} height={52} rx={15} fill="none" className="dpg-mm dpg-pulse" strokeWidth={1.8} strokeOpacity={0.8} aria-hidden="true" />
          )}
          <rect x={188} y={196} width={140} height={46} rx={12} className="dpg-mmf dpg-fill" fillOpacity={fillM} />
          <rect x={188} y={196} width={140} height={46} rx={12} fill="none" className="dpg-mm" strokeWidth={1.4} />
          <text x={258} y={214} textAnchor="middle" fontSize={9.5} fontWeight={700} letterSpacing={0.5} className="dpg-mmt">
            M− · AVOID
          </text>
          <text x={258} y={230} textAnchor="middle" fontSize={9} className="dpg-t" style={{ fontFamily: "var(--font-mono, monospace)" }}>
            mean {fmtSigned(meanM)}
          </text>
        </g>
      </svg>
    </div>
  );
}

/* --------------------------------------------------------------- weight bar */

function WeightBar({ wv }: { wv: number }) {
  const pos = wv >= 0;
  const h = clamp01(Math.abs(wv)) * 50; // percent of the 48px track
  return (
    <div className="flex flex-col items-center gap-1">
      <div
        className="relative h-12 w-full overflow-hidden rounded-[3px] border border-border/70 bg-muted/25"
        role="img"
        aria-label={`weight ${fmtSigned(wv)}`}
      >
        <div className="absolute inset-x-0 top-1/2 border-t border-border/80" aria-hidden="true" />
        <div
          className={`dpg-bar absolute left-1/2 w-[72%] -translate-x-1/2 rounded-[2px] ${
            pos ? "bottom-1/2 rounded-t-[3px] bg-emerald-500/80" : "top-1/2 rounded-b-[3px] bg-rose-500/80"
          }`}
          style={{ height: `${Math.max(h, 1.5)}%` }}
          aria-hidden="true"
        />
      </div>
      <span
        className={`font-mono text-[9px] leading-none tabular-nums ${
          pos ? "text-emerald-600 dark:text-emerald-300" : "text-rose-600 dark:text-rose-300"
        }`}
      >
        {fmtSigned(wv)}
      </span>
    </div>
  );
}

/* ------------------------------------------------------------- main component */

export function DopaminePlayground() {
  const [sim, dispatch] = useReducer(reducer, undefined, freshState);
  const [focus, setFocus] = useState<Odor>("A");
  const [demo, setDemo] = useState(false);
  const demoRef = useRef(false);
  const cancelRef = useRef(false);

  // cancel the auto-demo if the tab unmounts (Radix unmounts inactive tabs)
  useEffect(() => {
    return () => {
      cancelRef.current = true;
    };
  }, []);

  const doPresent = useCallback((odor: Odor) => {
    if (demoRef.current) return;
    playSound("click");
    dispatch({ type: "present", odor });
    setFocus(odor);
  }, []);

  const doOutcome = useCallback((kind: Outcome) => {
    if (demoRef.current) return;
    if (kind === "sugar") playSound("sugar");
    else if (kind === "shock") playSound("shock");
    dispatch({ type: "outcome", kind });
  }, []);

  const doReset = useCallback(() => {
    if (demoRef.current) return;
    playSound("click");
    dispatch({ type: "reset" });
    setFocus("A");
  }, []);

  /* ------------------------------------------------- cross-tab deep link */
  /**
   * "Run the real experiment" — jump straight from this toy to the real
   * 928-neuron Brain Lab with the 24-trial conditioning wizard armed.
   *
   * HOW the tab switch works (page.tsx is lead-owned and not editable this
   * round, and its tab state is a LOCAL useState): we dispatch a synthetic
   * keydown for the digit "1" on window. page.tsx's existing window-level
   * hotkey listener (its PUBLIC 1–5 tab contract, same path a keyboard user
   * takes) switches to the Brain Lab and plays its own click sound. Radix
   * Tabs unmounts the inactive content, so BrainLab mounts fresh right after
   * the switch and consumes the `labIntent` we stored here first.
   */
  const runRealExperiment = useCallback(() => {
    // 1) arm the deep-link intent BEFORE the tab flip so BrainLab's mount
    //    effect can consume it (order matters — dispatch is synchronous)
    useBrainStore.getState().requestLabIntent("conditioning");
    // 2) switch tabs via the app's public "1" hotkey (see comment above)
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "1", bubbles: true }));
    // 3) our own click feedback (merged with the hotkey's by the sound
    //    engine's per-name rate limiting)
    playSound("click");
  }, []);

  /** One-click classic conditioning: A+sugar ×3, then B+shock ×3. */
  const runDemo = useCallback(async () => {
    if (demoRef.current) return;
    demoRef.current = true;
    cancelRef.current = false;
    setDemo(true);
    dispatch({ type: "reset" });
    setFocus("A");
    await sleep(500);
    const seq: Array<{ odor: Odor; outcome: Outcome }> = [
      { odor: "A", outcome: "sugar" },
      { odor: "A", outcome: "sugar" },
      { odor: "A", outcome: "sugar" },
      { odor: "B", outcome: "shock" },
      { odor: "B", outcome: "shock" },
      { odor: "B", outcome: "shock" },
    ];
    for (const step of seq) {
      if (cancelRef.current) break;
      dispatch({ type: "present", odor: step.odor });
      setFocus(step.odor);
      playSound("click");
      await sleep(DEMO_PACING);
      if (cancelRef.current) break;
      if (step.outcome === "sugar") playSound("sugar");
      else if (step.outcome === "shock") playSound("shock");
      dispatch({ type: "outcome", kind: step.outcome });
      await sleep(DEMO_PACING + 50);
    }
    demoRef.current = false;
    setDemo(false);
  }, []);

  /* ------------------------------------------------ derived values */

  const scoreA = odorScore(sim.w, "A");
  const scoreB = odorScore(sim.w, "B");
  const focusScore = focus === "A" ? scoreA : scoreB;
  const focusVerdict = verdictOf(focusScore);
  const meterPct = ((Math.min(1, Math.max(-1, focusScore)) + 1) / 2) * 100;
  const meanP = sim.w.reduce((s, row) => s + row[0], 0) / 6;
  const meanM = sim.w.reduce((s, row) => s + row[1], 0) / 6;
  const lastDa = sim.last ? sim.last.da : 0;
  const canOutcome = sim.presented !== null && !demo;

  const status = demo
    ? "Running the classic conditioning demo — odor A + sugar ×3, then odor B + shock ×3…"
    : sim.presented
      ? `Odor ${sim.presented} is on the antenna — K${ODOR_KC[sim.presented][0] + 1}–K${ODOR_KC[sim.presented][2] + 1} are eligible (e = 1.00). Now deliver the outcome.`
      : sim.trial > 0
        ? `Trial ${sim.trial} complete. Present the next odor to continue.`
        : "Present an odor to start trial 1 — then deliver sugar, shock, or nothing.";

  const last = sim.last;
  const daClass =
    last && last.da > 0
      ? "text-emerald-600 dark:text-emerald-300"
      : last && last.da < 0
        ? "text-rose-600 dark:text-rose-300"
        : "text-muted-foreground";

  /* ------------------------------------------------------------- render */

  return (
    <div className="dpg dpg-enter space-y-3">
      <style>{DPG_STYLE}</style>

      <h4 className="flex items-center gap-2 text-sm font-semibold text-foreground">
        <MousePointerClick className="h-4 w-4 shrink-0 text-primary" />
        Try it — run the learning rule yourself
      </h4>

      <div
        className="space-y-4 rounded-xl border border-border/70 bg-card/70 p-4 sm:p-5"
        data-testid="dopamine-playground"
      >
        {/* header row */}
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex items-center gap-2.5">
            <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-primary/15 text-primary">
              <FlaskConical className="h-4.5 w-4.5" aria-hidden="true" />
            </div>
            <div>
              <div className="text-sm font-semibold leading-tight text-foreground">
                Dopamine Playground
              </div>
              <div className="text-xs text-muted-foreground">
                a 6-cell toy running the exact rule above
              </div>
            </div>
            <Badge variant="secondary" className="font-mono text-[10px] tabular-nums">
              trial {sim.trial}
            </Badge>
          </div>
          <div className="flex flex-wrap gap-2">
            <Button
              type="button"
              size="sm"
              variant="outline"
              className="h-10 gap-1.5"
              onClick={runDemo}
              disabled={demo}
              aria-label="Run the classic conditioning demo: odor A with sugar three times, then odor B with shock three times"
            >
              {demo ? (
                <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
              ) : (
                <Play className="h-4 w-4" aria-hidden="true" />
              )}
              {demo ? "Running…" : "Classic conditioning demo"}
            </Button>
            <Button
              type="button"
              size="sm"
              variant="ghost"
              className="h-10 gap-1.5"
              onClick={doReset}
              disabled={demo}
              aria-label="Reset all wiring back to the neutral starting weight of +0.10"
            >
              <RotateCcw className="h-4 w-4" aria-hidden="true" />
              Reset wiring
            </Button>
          </div>
        </div>

        <p className="text-xs leading-relaxed text-muted-foreground">
          Present a cue (an odor), then deliver an outcome. Sugar releases{" "}
          <span className="font-medium text-emerald-600 dark:text-emerald-300">
            dopamine +1
          </span>
          , shock{" "}
          <span className="font-medium text-rose-600 dark:text-rose-300">
            dopamine −1
          </span>
          , and only recently-active wiring gets changed — that is the whole
          trick.
        </p>

        {/* controls */}
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="rounded-lg border border-border bg-muted/30 p-3">
            <div className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
              1 · Present a cue
            </div>
            <div className="flex flex-wrap gap-2">
              <Button
                type="button"
                variant="outline"
                className="h-11 flex-1 gap-2 border-amber-500/40 bg-amber-500/5 hover:bg-amber-500/10"
                onClick={() => doPresent("A")}
                disabled={demo}
                aria-label="Present odor A — activates Kenyon cells K1 to K3"
              >
                <span className="h-2.5 w-2.5 shrink-0 rounded-full" style={{ backgroundColor: ODOR_A_HEX }} aria-hidden="true" />
                Present odor A
              </Button>
              <Button
                type="button"
                variant="outline"
                className="h-11 flex-1 gap-2 border-teal-500/40 bg-teal-500/5 hover:bg-teal-500/10"
                onClick={() => doPresent("B")}
                disabled={demo}
                aria-label="Present odor B — activates Kenyon cells K4 to K6"
              >
                <span className="h-2.5 w-2.5 shrink-0 rounded-full" style={{ backgroundColor: ODOR_B_HEX }} aria-hidden="true" />
                Present odor B
              </Button>
            </div>
          </div>
          <div className="rounded-lg border border-border bg-muted/30 p-3">
            <div className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
              2 · Deliver the outcome
            </div>
            <div className="flex flex-wrap gap-2">
              <Button
                type="button"
                variant="outline"
                className="h-11 min-w-[92px] flex-1 gap-1.5 border-emerald-500/50 bg-emerald-500/10 text-emerald-700 hover:bg-emerald-500/15 dark:text-emerald-300"
                onClick={() => doOutcome("sugar")}
                disabled={!canOutcome}
                aria-label="Deliver sugar — reward, dopamine plus one"
              >
                <Candy className="h-4 w-4 shrink-0" aria-hidden="true" />
                Sugar ✓
              </Button>
              <Button
                type="button"
                variant="outline"
                className="h-11 min-w-[92px] flex-1 gap-1.5 border-rose-500/50 bg-rose-500/10 text-rose-700 hover:bg-rose-500/15 dark:text-rose-300"
                onClick={() => doOutcome("shock")}
                disabled={!canOutcome}
                aria-label="Deliver shock — punishment, dopamine minus one"
              >
                <Zap className="h-4 w-4 shrink-0" aria-hidden="true" />
                Shock ✗
              </Button>
              <Button
                type="button"
                variant="outline"
                className="h-11 min-w-[110px] flex-1 gap-1.5"
                onClick={() => doOutcome("none")}
                disabled={!canOutcome}
                aria-label="No reward — dopamine zero, no plasticity"
              >
                <Minus className="h-4 w-4 shrink-0" aria-hidden="true" />
                No reward
              </Button>
            </div>
          </div>
        </div>

        <p role="status" aria-live="polite" className="min-h-5 text-xs text-muted-foreground">
          {status}
        </p>

        {/* circuit */}
        <div>
          <CircuitDesktop
            w={sim.w}
            elig={sim.elig}
            presented={sim.presented}
            lastDa={lastDa}
            meanP={meanP}
            meanM={meanM}
          />
          <CircuitMobile
            w={sim.w}
            elig={sim.elig}
            presented={sim.presented}
            lastDa={lastDa}
            meanP={meanP}
            meanM={meanM}
          />
          <p className="mt-1.5 text-center text-[11px] leading-relaxed text-muted-foreground">
            Sparse code — each odor lights a different third of the Kenyon
            cells (odor A → K1–K3, odor B → K4–K6). Line thickness = |w|; the
            glowing ring marks eligibility e.
          </p>
        </div>

        {/* live formula */}
        <div className="rounded-lg border border-border bg-muted/40 p-3">
          <div className="mb-1.5 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
            The rule, with live numbers
          </div>
          {last ? (
            <div className="space-y-1.5">
              <div className="overflow-x-auto font-mono text-xs leading-relaxed tabular-nums text-foreground sm:text-[13px]">
                <div>
                  Δw(K{last.cell + 1}→M+) = 0.08 ×{" "}
                  <span className={daClass}>
                    ({last.da > 0 ? "+1" : last.da < 0 ? "-1" : "0"})
                  </span>{" "}
                  × <span className="text-emerald-600 dark:text-emerald-300">(+1)</span> ×{" "}
                  {last.e.toFixed(2)} ={" "}
                  <span className={last.dwP >= 0 ? "text-emerald-600 dark:text-emerald-300" : "text-rose-600 dark:text-rose-300"}>
                    {fmtSigned(last.dwP)}
                  </span>
                </div>
                <div>
                  Δw(K{last.cell + 1}→M−) = 0.08 ×{" "}
                  <span className={daClass}>
                    ({last.da > 0 ? "+1" : last.da < 0 ? "-1" : "0"})
                  </span>{" "}
                  × <span className="text-rose-600 dark:text-rose-300">(−1)</span> ×{" "}
                  {last.e.toFixed(2)} ={" "}
                  <span className={last.dwM >= 0 ? "text-emerald-600 dark:text-emerald-300" : "text-rose-600 dark:text-rose-300"}>
                    {fmtSigned(last.dwM)}
                  </span>
                </div>
              </div>
              <p className="font-sans text-[11px] leading-relaxed text-muted-foreground">
                {last.da === 0 ? (
                  <>
                    No dopamine → Δw = 0. The gate stayed shut: plasticity needs
                    the neuromodulator, so nothing moved.
                  </>
                ) : (
                  <>
                    {last.outcome === "sugar" ? "Sugar" : "Shock"} after odor{" "}
                    {last.odor}: the eligible cells&apos; approach and avoid
                    wiring moved by the same magnitude with opposite signs —
                    valence is +1 in the M+ compartment, −1 in M−, like the
                    real mushroom body.
                  </>
                )}
                {last.traceNote ? <> A fading trace also nudged last trial&apos;s cells at reduced eligibility.</> : null}
                {last.clamped ? <> Some weights hit the ±1.00 clamp.</> : null}
              </p>
            </div>
          ) : (
            <div className="space-y-1.5">
              <div className="overflow-x-auto font-mono text-xs leading-relaxed tabular-nums text-muted-foreground sm:text-[13px]">
                Δw(K→M) = 0.08 × (dopamine) × (valence) × (eligibility)
              </div>
              <p className="font-sans text-[11px] leading-relaxed text-muted-foreground">
                Run a trial and the exact numbers you produced appear here.
                Valence: +1 in the M+ (approach) compartment, −1 in M− (avoid).
              </p>
            </div>
          )}
        </div>

        {/* behavior meter */}
        <div className="rounded-lg border border-border bg-muted/30 p-3">
          <div className="mb-2.5 flex flex-wrap items-center justify-between gap-2">
            <div className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
              Behavior readout{" "}
              <span className="normal-case tracking-normal">
                — odor {focus} · score{" "}
                <span
                  className={`font-mono tabular-nums ${
                    focusVerdict === "approach"
                      ? "text-emerald-600 dark:text-emerald-300"
                      : focusVerdict === "avoid"
                        ? "text-rose-600 dark:text-rose-300"
                        : ""
                  }`}
                >
                  {fmtSigned(focusScore)}
                </span>
              </span>
            </div>
            <div className="flex gap-2">
              {(["A", "B"] as const).map((o) => {
                const v = verdictOf(o === "A" ? scoreA : scoreB);
                return (
                  <button
                    key={o}
                    type="button"
                    aria-pressed={focus === o}
                    aria-label={`Odor ${o} verdict: ${VERDICT_WORD[v].toLowerCase()}. Click to show odor ${o} on the meter.`}
                    onClick={() => setFocus(o)}
                    className={`rounded-full border px-2.5 py-1 text-[11px] font-semibold transition-colors ${
                      v === "approach"
                        ? "border-emerald-500/50 bg-emerald-500/15 text-emerald-700 dark:text-emerald-300"
                        : v === "avoid"
                          ? "border-rose-500/50 bg-rose-500/15 text-rose-700 dark:text-rose-300"
                          : "border-border bg-muted/40 text-muted-foreground"
                    } ${focus === o ? "ring-1 ring-primary/60" : ""} focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring`}
                  >
                    odor {o} · {VERDICT_WORD[v]}
                  </button>
                );
              })}
            </div>
          </div>

          <div className="relative pt-6">
            <span
              className={`absolute top-0 -translate-x-1/2 font-mono text-[10px] font-semibold tabular-nums ${
                focusVerdict === "approach"
                  ? "text-emerald-600 dark:text-emerald-300"
                  : focusVerdict === "avoid"
                    ? "text-rose-600 dark:text-rose-300"
                    : "text-muted-foreground"
              }`}
              style={{ left: `clamp(6%, ${meterPct}%, 94%)` }}
              aria-hidden="true"
            >
              {fmtSigned(focusScore)}
            </span>
            <div className="relative h-3 rounded-full border border-border/70 bg-muted/50">
              <div className="absolute inset-y-0 left-0 w-1/2 rounded-l-full bg-rose-500/15" aria-hidden="true" />
              <div className="absolute inset-y-0 right-0 w-1/2 rounded-r-full bg-emerald-500/15" aria-hidden="true" />
              <div className="absolute -inset-y-1 left-1/2 w-px bg-border" aria-hidden="true" />
              <div
                className="dpg-needle absolute top-1/2 h-6 w-1.5 -translate-x-1/2 -translate-y-1/2 rounded-full bg-foreground/90"
                style={{ left: `${meterPct}%` }}
                aria-hidden="true"
              />
            </div>
            <div className="mt-1.5 flex justify-between text-[10px] text-muted-foreground">
              <span>strong avoid</span>
              <span>indifferent</span>
              <span>strong approach</span>
            </div>
          </div>
          <p className="mt-2 text-[11px] leading-relaxed text-muted-foreground">
            The fly approaches or avoids based on the sign of (mean K→M+ weight
            − mean K→M− weight) over that odor&apos;s cells; |score| ≤ 0.10
            counts as indifferent. Click a verdict chip to inspect the other
            odor.
          </p>
        </div>

        {/* synapse grid + feed */}
        <div className="grid gap-4 md:grid-cols-2">
          <div className="rounded-lg border border-border bg-muted/30 p-3">
            <div className="mb-2.5 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
              The 12 plastic synapses
            </div>
            <div className="grid" style={{ gridTemplateColumns: "52px repeat(6, minmax(0, 1fr))" }}>
              <div />
              {Array.from({ length: 6 }, (_, i) => (
                <div
                  key={`kh-${i}`}
                  className={`pb-1 text-center font-mono text-[10px] font-semibold tabular-nums ${
                    sim.presented && ODOR_KC[sim.presented].includes(i)
                      ? "text-foreground"
                      : "text-muted-foreground"
                  }`}
                >
                  {KC_NAME(i)}
                </div>
              ))}
              {([0, 1] as const).map((m) => (
                <div key={`row-${m}`} className="contents">
                  <div className="flex flex-col justify-center pr-1 text-right">
                    <span
                      className={`text-[10px] font-semibold leading-tight ${
                        m === 0
                          ? "text-emerald-600 dark:text-emerald-300"
                          : "text-rose-600 dark:text-rose-300"
                      }`}
                    >
                      → M{m === 0 ? "+" : "−"}
                    </span>
                    <span className="text-[8px] leading-tight text-muted-foreground">
                      {m === 0 ? "approach" : "avoid"}
                    </span>
                  </div>
                  {Array.from({ length: 6 }, (_, i) => (
                    <div
                      key={`cell-${m}-${i}`}
                      className="px-[3px] py-1"
                      style={
                        sim.presented && ODOR_KC[sim.presented].includes(i)
                          ? { backgroundColor: "rgba(232, 121, 249, 0.07)" }
                          : undefined
                      }
                    >
                      <WeightBar wv={sim.w[i][m]} />
                    </div>
                  ))}
                </div>
              ))}
            </div>
            <p className="mt-2 text-[11px] leading-relaxed text-muted-foreground">
              Each bar is one Kenyon→MBON weight. Emerald above zero, rose
              below; height = |w|. Sugar pushes the M+ row up and the M− row
              down — shock does the opposite.
            </p>
          </div>

          <div className="flex flex-col rounded-lg border border-border bg-muted/30 p-3">
            <div className="mb-2 flex items-center justify-between">
              <div className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                Event feed
              </div>
              <span className="font-mono text-[10px] tabular-nums text-muted-foreground">
                {sim.trial} {sim.trial === 1 ? "trial" : "trials"}
              </span>
            </div>
            <div
              role="log"
              className="dpg-scroll max-h-44 flex-1 space-y-1.5 overflow-y-auto pr-1"
            >
              {sim.feed.length === 0 ? (
                <p className="text-[11px] text-muted-foreground">
                  No trials yet — present an odor, then pick an outcome.
                </p>
              ) : (
                sim.feed.map((f) => (
                  <div key={f.n} className="flex items-start gap-1.5 text-[11px] leading-relaxed text-muted-foreground">
                    <span
                      className={`mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full ${
                        f.tone === "emerald"
                          ? "bg-emerald-500"
                          : f.tone === "rose"
                            ? "bg-rose-500"
                            : "bg-muted-foreground/40"
                      }`}
                      aria-hidden="true"
                    />
                    <span className="shrink-0 font-mono tabular-nums text-muted-foreground/80">
                      T{f.n}
                    </span>
                    <span>{f.text}</span>
                  </div>
                ))
              )}
            </div>
          </div>
        </div>

        {/* cross-tab deep link: hand off from this 6-cell toy to the real
            928-neuron Brain Lab (see runRealExperiment above) */}
        <div className="flex flex-col gap-2 border-t border-border/70 pt-4 sm:flex-row sm:items-center sm:gap-3">
          <Button
            type="button"
            variant="outline"
            className="h-11 w-full gap-2 border-emerald-500/50 bg-emerald-500/10 text-emerald-700 hover:border-emerald-500/70 hover:bg-emerald-500/20 hover:text-emerald-800 focus-visible:border-emerald-500/60 focus-visible:ring-emerald-500/50 dark:border-emerald-500/50 dark:bg-emerald-500/10 dark:text-emerald-300 dark:hover:border-emerald-500/70 dark:hover:bg-emerald-500/20 dark:hover:text-emerald-200 sm:w-auto"
            onClick={runRealExperiment}
            aria-label="Run the real conditioning experiment in the Brain Lab — 928 neurons, 24 trials"
            data-testid="cta-run-real-experiment"
          >
            <FlaskConical className="h-4 w-4" aria-hidden="true" />
            Run the real experiment
            <ArrowRight className="h-4 w-4" aria-hidden="true" />
          </Button>
          <p className="text-[11px] leading-relaxed text-muted-foreground sm:py-1">
            Same rule, real connectome —{" "}
            <span className="font-medium text-foreground/80">928 neurons, 24 trials</span>.
          </p>
        </div>
      </div>
    </div>
  );
}
