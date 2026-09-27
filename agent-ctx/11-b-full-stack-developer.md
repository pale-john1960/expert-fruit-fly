# Task 11-b — Dopamine Playground (full-stack-developer)

Task: Interactive clickable mini-simulation of the 3-factor learning rule, embedded in the How It Works tab (Section 2, after DopamineLoopDiagram).

## Owned files
- NEW `src/components/fly/DopaminePlayground.tsx` (~1100 lines, self-contained "use client", NO engine import)
- `src/components/fly/HowItWorks.tsx` — additive integration only (import + teaser paragraph + `<DopaminePlayground />`)

## Design summary
- Toy circuit in a `useReducer` (deterministic, no RNG): 6 Kenyon cells (odor A → K1–K3, odor B → K4–K6), 2 MBON compartments M+ (emerald, valence +1) / M− (rose, valence −1), 12 weights init 0.10, eligibility e set to 1 on presentation and decayed ×0.5 per subsequent presentation.
- **Rule**: `Δw = 0.08 × dopamine × valence × eligibility`, clamped [−1, +1]. The valence factor mirrors the real engine's `d × mbonValence` K→M rule (read-only reference) — without it, sugar would move both compartments equally and the approach score would never change. Sugar strengthens M+ and weakens M−; shock vice versa; no-reward → dopamine 0 → Δw 0 (gate shut).
- Behavior: `score = mean(w→M+) − mean(w→M−)` over the odor's cells; verdict |score| ≤ 0.10 → indifferent (flips after a single pairing — flies really do one-trial learning; needle keeps moving over later trials).
- Interaction: "Present odor A/B" → activates cells + resets eligibility (click sound); "Sugar ✓ / Shock ✗ / No reward" completes the trial (sugar/shock sounds), weights update, trial counter +1, feed line appended in the spec format ("odor A + sugar → M+ wiring strengthened (Δw +0.08 on K1–K3), M− wiring weakened (Δw -0.08)"), fading cross-odor traces noted in the feed.
- Visualization: hand-authored SVG circuits (desktop 680×242 max-w-720 md:block + mobile 360×252 stacked md:hidden) with region hues matching HowItWorksDiagrams (kenyon #e879f9, M+ #34d399, M− #fb7185, odor chips amber/teal); synapse line thickness+opacity track |w|; MBON fill intensity tracks mean incoming weight; pulse halo on presented odor; eligibility rings + "e 1.00" mono labels; dopamine badge (±1/0). 12 diverging weight bars in HTML (emerald above 0, rose below, CSS height transition 200ms) with font-mono tabular values; behavior meter (rose→emerald halves, needle with left transition, clamped score label) + two clickable verdict chips; live-substituted formula lines for K→M+ and K→M−; event feed (role=log, newest first, max 30, max-h-44 scroll with scoped slim scrollbar).
- Extras: trial badge, Reset wiring (no confirm), "Classic conditioning" auto-demo (resets, then A+sugar ×3 + B+shock ×3 at ~600ms pacing; all 7 buttons disabled while running; cancel flag set on unmount so tab switches kill it — Radix unmounts inactive tabs); sounds via `playSound("sugar"/"shock"/"click")` from `@/lib/sound`.
- Scoped CSS prefix `dpg-` (dark + light stroke variants like hiw-), entrance keyframe, `@media (prefers-reduced-motion: reduce)` kills every animation AND transition (verified: transition-property none, 0 running animations). Auto-demo keeps its 600ms trial pacing under reduced motion (content sequencing, not decoration).
- a11y: SVG role="img" + aria-label + <title> ×2, all 9 buttons carry aria-labels, status line role=status aria-live=polite, feed role=log, chips aria-pressed, focus-visible rings, ≥44px control buttons (h-11).

## Verification (session task-11b, error hooks installed)
- Manual conditioning: A+sugar ×3 → chip "odor A · APPROACHES", score +0.48, needle 58%→75%, weights +0.34/−0.14 exact, means +0.22/−0.02; B+shock ×3 → "odor B · AVOIDS" (B cells exactly −0.14/+0.34; A cells drifted to +0.27/−0.07 via the ×0.5/×0.25/×0.125 fading traces — by design, feed notes "fading trace: odor A cells still ×0.13 eligible").
- Formula shows live numbers ("Δw(K4→M+) = 0.08 × (-1) × (+1) × 1.00 = -0.08"); no-reward path shows "(0)" and "the gate stays shut, Δw 0.00"; reset restores trial 0 / +0.10 / indifferent / empty feed.
- Auto-demo runs (mid-run: 7 buttons disabled + "Running…" status), ends APPROACHES/AVOIDS with 6 feed lines. Tab-switch mid-demo cancels (no ghost dispatches/sounds; fresh state on remount — local state, Radix remount semantics).
- Mobile 390×844: scrollWidth == clientWidth == 390 (no horizontal overflow), mobile circuit visible / desktop hidden, VLM "No issues". Light mode (dark class removed): K labels lab(2.75) near-black, bars/chips/glows vivid (VLM), e-texts ≈5.2:1 (AA). Dark restored.
- All 5 docs section titles + glossary + further reading + original paragraphs intact (additive integration confirmed in DOM).
- `window.__errs` stayed `[]` the whole session; `bun run lint` exit 0; dev.log clean (GET / 200, no errors).
- Screenshots: /home/z/scratch/11b-{desktop-initial,desktop-conditioned,desktop-conditioned-lower,desktop-autodemo,mobile,mobile-lower,light,light-lower}.png

## Gotchas for future agents
- The dev server DIED mid-session (OOM under parallel-agent load: page → chrome-error://, then ERR_CONNECTION_REFUSED, `next dev` gone; bash fork retries too). Restored with the Task-10 orphan-spawn trick `bash -c 'nohup bun run dev >/dev/null 2>&1 < /dev/null & disown; exit 0'` — 200 OK, re-parented. dev.log is truncated on each respawn (tee).
- agent-browser `eval` querySelector on `svg[title]` matches the ATTRIBUTE not the <title> child — use `svg.querySelector('title')`.
- Adding class "light" while "dark" remains does nothing (.dark rules still match); remove 'dark' for a true light-mode probe.
- VLM light-mode review over-flags small muted labels; verify with getComputedStyle().fill (Lab L≈48.5 ≈ 5.2:1 on white passes AA).
