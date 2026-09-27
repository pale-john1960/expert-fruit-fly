# Task 12-a — full-stack-developer (progress vs newborn)

Feature: **"Learning progress — vs newborn"** — one-click comparison of any saved
brain against a freshly-instantiated UNTRAINED fly, showing exactly what
training wrote into the connectome.

## Files touched (exclusive ownership)
- `src/components/fly/BrainDiffDialog.tsx` — extended with `mode: "pair" | "progress"`
- `src/components/fly/BrainLibrary.tsx` — per-row "Progress vs newborn" dropdown action + second dialog instance

Read-only imports (NOT modified): `src/lib/flybrain/engine.ts` (FlyBrain),
`src/components/fly/BrainReportCard.tsx` (`deriveStats`, `FingerprintStats`).

## Key implementation facts (for future agents)
1. **FlyBrain constructor is `(arch, params?)`** — the seed is a field of
   `BrainArchitecture`. "new FlyBrain(7)" from the brief is really
   `new FlyBrain({ ...trainedArch, seed: 7 })`. The newborn SHARES the trained
   brain's arch (motor layout → identical synapse budget) with seed 7, so every
   newborn is byte-identical + reproducible for a given task. UI says
   "untrained, seeded" / "fixed seed 7".
2. **Newborn stats go through the SAME math**: serialize with
   `toJSON(task, "Newborn fly", 0, 0)` then `deriveStats(snapshot)` — never
   re-derived, so report card / diff / progress all agree byte-for-byte.
3. **Sticky-row loop hazard**: the pseudo-row is memoized on `progressRow`, and
   the render-phase adjust-state comparison watches the SOURCE prop
   (`progressRow` / `rows`), never the pair array that is rebuilt each render.
4. **PNG carries the drift headline**: a 30px band is rendered INSIDE the SVG
   (`TOTAL DRIFT — WHAT TRAINING WROTE` + `Σ|Δ| = x.xxx · <phrase> — heaviest
   in M#`); the whole pair-mode body sits in a `<g translate(0,30)>` so pair
   mode renders byte-identically (viewBox 0 0 560 212, no band, no transform).
5. Drift math: Σ|Δ| over the 12 compartment leans; "rewritten" = |Δ| > 0.01
   (a newborn's compartment leans sit within ±0.01 of zero); gen-0 brains
   phrase training as brain-steps, gen>0 as generations.
6. Copy text header: `Learning progress of “<name>” vs untrained newborn
   (fixed seed 7)`; fallback filename `fly-progress-<name>-vs-newborn.txt/.png`.
7. Test ids: `progress-diff` (dialog), `progress-drift` (banner),
   `progress-fingerprint`, `progress-copy` / `progress-png` (pair mode keeps
   `genome-diff` / `diff-*`).

## Verification (session task-12a, window.__errs [] throughout)
- Row More-menu → "Progress vs newborn" (desktop table AND mobile card):
  dialog opens, 12 A/B/Δ cells, Δ all non-zero, drift banner + SVG band +
  heaviest-learning annotation + re-framed tiles + verdict.
- Copy → "Copied ✓" (immediate re-check); PNG → "Saved ✓"; raster proven
  directly (104,637-byte PNG blob). Clipboard write is permission-denied in
  headless → .txt fallback fires (by design) — file content verified exact.
- Escape closes; pair-mode regression clean (2 picks → Compare genomes:
  strips, biggest-gap, 4 tiles, verdict, Copy ✓, Escape ✓, unchanged SVG).
- Mobile 390×844: no horizontal overflow (dialog open). Light mode rendered +
  screenshotted, dark restored. bun run lint exit 0; dev.log clean.
- Screenshots: /home/z/scratch/12a-{desktop-progress,desktop-progress-lower,
  mobile-progress,mobile-progress-lower,mobile-progress-turbo,light-progress}.png

## Incidents
- Dev server OOM-died twice under parallel-agent load; recovered via the
  Task-10 orphan-spawn trick both times (`bash -c 'cd /home/z/my-project &&
  nohup bun run dev >/dev/null 2>&1 < /dev/null & disown'`), verified 200.
- agent-browser gotchas hit: multi-statement evals need IIFE wrapping when the
  same identifier was declared before; at 390px the desktop table's actions are
  display:none (0×0 rect) — target the mobile card trigger via
  `div[class*="sm:hidden"] button[...]`.
