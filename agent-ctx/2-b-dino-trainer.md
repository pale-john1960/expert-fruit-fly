# Task 2-b — Dino Trainer (Chrome Dino training environment)

Agent: full-stack-developer (dino trainer)
Status: DONE — verified end-to-end in agent-browser

## Files owned / created
- `src/components/fly/DinoTrainer.tsx` — exported entry (React component: sim loop, HUD, feed, controls, stats/save, chart, load & autosave integration)
- `src/components/fly/dino/game.ts` — pure TS game world: physics, obstacles, scenery, all canvas drawing (world + cute fly character)
- `src/components/fly/dino/evolution.ts` — elitism (top-2 clones) + tournament-of-5 crossover + `mutate(0.15, strength)`

No other files touched. Engine (`engine.ts`), `types.ts`, `store.ts`, `page.tsx`, other components untouched.

## Architecture (how it works)
- Fixed 60Hz sim via rAF accumulator; turbo ×1/×3/×10 = extra steps per frame (capped 60 steps/frame, no spiral).
- Logical world is 480×140 (CSS-independent). Each sim step: draw world WITHOUT flies → offscreen game canvas → downscale to 240×90 (willReadFrequently ctx) → `getImageData` → `retinaFromImageData(..., 24, 9, false)` → shared Float32Array(216) input for ALL flies (they never see themselves).
- Each alive fly: `brain.step(input, dopamineDelta)`. Jump if `motorRates[0] > 0.12 && onGround && cooldown 500ms game-time`; duck while `motorRates[1] > 0.15` (duck while airborne = fast-fall ×2.6 gravity).
- Rewards: obstacle fully past fly → +0.4 folded into that step (all alive flies). Crash → extra `brain.step(input, −0.3)` then fly dies; deathScore = current world score.
- Gen ends when all dead or 180s game-time cap → history push, autosave, evolve, next gen automatically.
- Obstacles: cacti 40–68px wide (≥2 retina columns) × 18–34px tall, 3 variants; birds (52×12, low) after score > 100 at 22% — must duck (standing box collides by ~5px, ducking clears by ~8px).
- Speed ramps 165 → 360 px/s (capped for learnability). Score = dist/16. Day/night sky cycles with score (period 500 pts), stars twinkle at night, 2 parallax cloud layers, scrolling pebbles.
- Rendering: game canvas upscaled to DPR-aware visible canvas; flies drawn crisp on top — ghosts at 0.38 alpha, current best-alive fly at alpha 1 with dashed emerald ring + "BEST" label.
- React state pushed at 4 Hz only (HUD stats, feed of last 8 events reversed, chart history, panel brain identity). BrainActivityPanel gets best-alive fly's brain (reads live state in its own rAF).
- Population size 4–10 slider (applies next gen), mutation strength 0.1–0.5, watch-best switch (replays a CLONE of best-ever brain solo, population parked, auto-restarts on death with 0.75s pause), reset button, play/pause + Start overlay.
- Save: `POST /api/brains {name, task:"dino", generation, score, snapshot: bestBrain.toJSON(...)}` with sonner toasts (Toaster mounted inside DinoTrainer since layout.tsx only mounts the radix toaster).
- Load: `useBrainStore` pending → `consumeLoad("dino")` on mount AND on store change → population replaced with clones of `FlyBrain.fromJSON(snapshot)`, gen from snapshot.generation, bestEver from snapshot.score, toast.
- Autosave: every gen end → `localStorage["fly-dino-autosave"]` {gen, bestScore, history, snapshot}; on mount with no pending store load → "Resume last session (gen N)" amber banner; resume restores population + history + gen numbering.

## Verification evidence (agent-browser, viewport 1440×900 and 390×844)
- Turbo ×10 fresh population: **80 generations in ~32s**; feed: "Generation 79 ended — best 71, avg 56.3", "+0.4 Obstacle cleared", "−0.3 Fly #N crashed". Best-ever 73.
- Pixel-sampled canvas: sky rgb(27,24,19), ground ok, fly body exactly #d9b380 at FLY_X — rendering pipeline correct.
- Loaded "Turbo Drosophila" (gen 4, score 66) from Brain Library → toast `Loaded "Turbo Drosophila" (gen 4, score 66) — population replaced with its clones`, trained 25s ×10 → GEN 34, best-ever improved 66 → **92** (loaded-brain lineage keeps evolving).
- Save best brain → POST /api/brains 201; GET shows the brain (25,673-byte snapshot); success toast verified verbatim.
- Watch best: HUD "1/1 alive", "WATCHING BEST", single full-opacity fly.
- Autosave/resume: banner "Previous session found — generation 2, best score 44"; resume toast; numbering continued 2 → 3; best improved 44 → 50.
- Chart: 2 recharts lines with real path data, per-gen x ticks (best emerald, avg amber dashed).
- Mobile 390×844: canvas 356×104 (correct 480/140 ratio), cards stack.
- `bun run lint` clean; zero console/page errors with Dino tab mounted alone (the hydration warning seen on reload comes from the Brain Lab tab, not this component).
- Screenshots: `agent-ctx/screenshots/dino-1…dino-11*.png`.

## Deviations / notes
- Turbo segmented control lives under the game canvas (per left-column spec); not duplicated inside the controls card.
- Sonner `<Toaster>` mounted inside DinoTrainer (layout.tsx is owned by others and only mounts the radix toaster).
- In watch mode the replay uses a clone, so replay-time dopamine plasticity never corrupts the champion brain; watch runs don't count as generations.
- Population-size changes apply at the next generation (labelled "(next gen)" in UI).
- Fitness = Chrome-style score (distance/16 + clears), shared world; per-fly deathScore recorded at death time.
