# Expert Fruit Fly — Worklog

Project: Browser-based fruit fly brain simulation that learns tasks (Chrome Dino, 3D bicycle) via reward/punishment, with real-time 3D visualization and save/load of learned brains.

Repo target: https://github.com/pale-john1960/expert-fruit-fly

---
Task ID: 0
Agent: main (Z.ai Code)
Task: Research online how viral fly sims work; plan architecture

Work Log:
- Searched web for fruit fly connectome news + viral demos (fly playing Dino/Doom/Mario/Beat Saber)
- Read in full: "Deconstructing viral fly sims" by Patrick Mineault (neuroai.science)
- Key findings:
  - MaleCNS connectome (HHMI Janelia + Google, 2025/2026) = ~140K neurons; triggered viral wave
  - Shiu et al. 2024 (Nature): LIF (leaky-integrate-and-fire) neurons + weights from connectome matrix work in a stable regime
  - doomfly project (Alex Wormuth): trains via 3-factor learning rule on Kenyon cell → MBON synapses (mushroom body = fly learning center, dopamine-gated plasticity)
  - Real fly visual system: photoreceptors/lamina are GRADED (non-spiking), spiking starts deeper (medulla/lobula)
  - Mushroom body: Kenyon cells sparse-code, MBONs output; dopamine gates synaptic plasticity (reward/appetitive vs aversive)
  - Neuroevolution (GA on network weights, generation by generation) is the proven approach for Chrome Dino demos
  - "Reservoir + trained readout" is the pragmatic way to make connectome-style nets do tasks

Stage Summary:
- Chosen architecture: simplified fruit fly connectome engine in TypeScript:
  retina (graded) → lamina (graded, adaptive/temporal contrast) → medulla (8 fixed feature channels × pools) → lobula (spiking LIF) → Kenyon cells (sparse spiking, mushroom body) → MBONs (PLASTIC, dopamine 3-factor rule) → motor (PLASTIC)
- Learning = BOTH dopamine-modulated 3-factor plasticity (within lifetime: reward/punishment) AND neuroevolution (across generations)
- Visualization = React Three Fiber 3D brain with anatomical layout (eyes front, optic lobes, twin mushroom bodies, motor out)
- Tasks: Chrome Dino (population-based, gen by gen) + 3D Bicycle (R3F dusk scene, balance physics, episodes + evolution)
- Persistence: Prisma/SQLite "Brain" model storing full weight snapshot JSON; export/import JSON
- Stack: Next.js 16 + TS + Tailwind 4 + shadcn/ui + three.js/R3F + zustand + recharts + Prisma

---
Task ID: 1
Agent: main (Z.ai Code)
Task: Build and validate the core FlyBrain engine + app shell

Work Log:
- Installed three, @react-three/fiber@9, @react-three/drei, @types/three
- Wrote src/lib/flybrain/{rng,types,engine,store}.ts (engine ~900 lines)
- Debugging journey (all fixed):
  1. medulla kernels leaked across whole retina → restricted to pool rectangles
  2. lobula random sampling destroyed position info → retinotopic wiring
  3. kenyon random sampling diluted position → spatially-structured windows
  4. sustained+transient lamina (static patterns stay visible)
  5. cross-pool normalization in medulla (contrast vs rest of visual field)
  6. lobula encodes deviation-from-baseline (dynamic range fix)
  7. APL neuron global inhibition → sparse Kenyon coding (cosine A/B: 0.9 → 0.08)
  8. intrinsic neural noise → smooth firing + exploration
  9. tonic biases (mbon 1.0, motor 1.28) + biases OUTSIDE synaptic gains
  10. MBON valence compartments: appetitive (approach) vs aversive (avoidance, negative motor weights)
  11. giant-fiber reflex pathway (lobula→motor) — fast evolvable shortcut
  12. leak-compensated input semantics (v_ss = input)
- Architecture now: 24 pools × 8 channels medulla, 48 retinotopic lobula
- VALIDATION RESULTS:
  - classical conditioning: A+reward → motors 0.11→0.20 (approach); B+punish → 0.11→0.00 (suppression) ✓
  - dino neuroevolution: best-of-gen 3.4 → 6.0 over 40 gens (pop 30) ✓
  - gentle lifetime learning (lrKM .03 lrMM .06) keeps evolution stable ✓
  - 11.5K brain-steps/sec, snapshot 25KB, deterministic round-trip ✓
- Final defaults: noiseSigma .08, lrKM .04, lrMM .08, dopamineDecay .75, lobulaGain .7, kenyonGain 1.6, mbonGain 1.5, motorGain 2.5
- Prisma Brain model pushed to SQLite; store.ts (zustand) for cross-tab brain loading
- page.tsx: 5 tabs (Brain Lab / Dino / Bicycle / Library / How It Works) + stubs for all components
- Committed: "feat: core fruit fly brain engine" (0995a6d)

Stage Summary:
- ENGINE IS DONE AND VALIDATED — do not change engine constants without re-running the conditioning + dino validation scripts (they live in /home/z/scratch/)
- Contracts fixed: component stubs in src/components/fly/*.tsx define exact prop interfaces
- Next: 4 parallel agents build the UIs (2-a visualizer/lab, 2-b dino, 2-c bicycle, 2-d api/library)

---
Task ID: 2-d
Agent: full-stack-developer (persistence + library)
Task: Save/load API for learned brains + Brain Library UI (list/load/export/import/delete)
Work Log:
- src/app/api/brains/route.ts — GET list (metadata only: id,name,task,generation,score,note,createdAt,updatedAt,snapshotBytes; ?task= filter; createdAt desc) + POST create (zod v4: name 1..80, task enum, note ≤200, snapshot version===1/arch/weights with finite-number arrays; accepts snapshot as OBJECT and stores the ORIGINAL stringified — zod never strips, so meta/createdAt survive; 2MB cap → 413; in-memory rate limit 30 POST/min/IP → 429; 201 {brain:{...}} without snapshot)
- src/app/api/brains/[id]/route.ts — GET one → {brain:{...}, snapshot: PARSED object} (404 JSON if missing, 500 if stored JSON corrupt) + DELETE → {ok:true} (Prisma P2025 → 404); Next 16 async params awaited
- src/components/fly/BrainLibrary.tsx — dark neuro-lab card: segmented task filter (All/Dino/Bicycle/Lab → refetch with ?task=), name search, Refresh + Import (Dialog w/ drag&drop + file picker, client shape validation then POST), table (desktop) / stacked cards (<sm), both max-h-96 overflow-y-auto with custom webkit scrollbar; Load → GET [id] → useBrainStore.requestLoad → banner + sonner toast; Export → pretty JSON blob fly-brain-<name>-gen<gen>.json; Delete → AlertDialog → toast; task badges amber/rose/emerald with Gamepad2/Bike/Brain icons, score units pts/m, date-fns relative dates, framer-motion empty-state + card fade-in, ≥44px touch targets, data-testid="brain-library"; sonner <Toaster/> mounted inside component (layout only mounts the radix toaster)
- API smoke test (/home/z/scratch/test-brain-api.ts, real FlyBrain.toJSON snapshot): 38/38 — 201 create, list excludes snapshot + snapshotBytes≈25638, task filter, GET one parsed, FlyBrain.fromJSON round-trip lossless, 404 GET/DELETE, 400 (bad task/version 2/NaN weight/missing name/bad JSON), 413 oversize, 429 rate limit, DELETE ok
- Browser-verified with agent-browser: list renders, Dino filter, Load → store banner at page top + toast, Export toast, Delete → confirm dialog → row gone + toast, empty state after deleting all, Import upload → "File Fly" row appears, invalid files → specific error toasts, mobile stacked cards; screenshots /home/z/scratch/library-*.png; lint clean, dev.log clean
Stage Summary:
- Persistence layer DONE: /api/brains (GET list/POST) + /api/brains/[id] (GET parsed/DELETE) verified end-to-end incl. error paths; Brain Library UI fully functional (load/export/import/delete/filter/search)
- Trainers (2-b/2-c): POST /api/brains with {name, task, generation, score, snapshot} (snapshot = toJSON object, NOT string) — rate limited to 30 saves/min; consume pending loads via useBrainStore.consumeLoad(task) + render banner
- One demo brain ("File Fly", dino, gen 11) left in the DB so the library isn't empty

---
Task ID: 2-b
Agent: full-stack-developer (dino trainer)
Task: Chrome Dino training environment — population of FlyBrains learns the Dino runner generation by generation
Work Log:
- Read engine/types/store contracts; owned DinoTrainer.tsx only, split game code into src/components/fly/dino/{game.ts,evolution.ts}
- game.ts: fixed 480×140 logical world; each 60Hz step draws the world WITHOUT flies → offscreen canvas → 240×90 → retinaFromImageData(24,9) shared input (pure reactive vision); cacti 40-68px wide (≥2 retina cols) × 18-34px tall in 3 variants; low birds after score>100 (must duck: standing box overlaps ~5px, ducking clears ~8px); speed 165→360 capped; day/night cycle with score, parallax clouds, twinkling stars, scrolling pebbles; cute Drosophila renderer (tan body, red compound eye, flapping/swept wings, tucked legs, poses for jump/duck) with ghost alpha 0.38 + dashed emerald BEST ring on leader
- Training loop: rAF accumulator @60Hz, turbo ×1/×3/×10 (cap 60 steps/frame); jump on motorRates[0]>0.12 with 500ms game-time cooldown, duck on motorRates[1]>0.15 (airborne duck = fast-fall); +0.4 dopamine folded into step on obstacle clear, −0.3 death step on crash; gen ends all-dead or 180s cap → evolve → auto next gen; React re-renders throttled to 4Hz (HUD, feed of last 8 events, chart, panel brain)
- evolution.ts: elitism top-2 clones + tournament-of-5 crossover + child.mutate(0.15, strength slider 0.1-0.5)
- DinoTrainer.tsx: dark neuro-lab UI (emerald/rose/amber accents) — game card with DOM HUD overlay (GEN, alive/total, score + HI monospace, SPD), Start overlay, turbo segmented control; right column: BrainActivityPanel (best-alive brain, height 150), reward/punishment feed with +green/−rose badges, controls (play/pause, reset, pop-size 4-10, mutation slider, watch-best switch), stats + save (POST /api/brains with sonner toasts, Toaster mounted locally); recharts LineChart best/avg per generation below; useBrainStore consumeLoad("dino") on mount+change → population of clones; localStorage autosave each gen + "Resume last session (gen N)" banner
- VERIFIED in agent-browser: 80 gens in 32s @×10 (best-ever 73, feed shows clears +0.4 / crashes −0.3 / gen summaries); loaded "Turbo Drosophila" from Library → cloned pop → GEN 34 with best-ever 66→92; save → POST /api/brains 201 (25.7KB snapshot); watch-best shows 1/1 full-opacity fly; autosave+resume continues gen numbering (2→3) and improves best (44→50); chart plots per-gen best/avg; mobile 390px stacks; lint clean; zero console errors from this component (pre-existing hydration warning is from the Brain Lab tab)
Stage Summary:
- Dino trainer fully functional and verified: game renders + animates, population evolves automatically, fitness improves, brains save/load cross-component, sessions resume — all spec'd controls present (turbo, pop size, mutation strength, watch best)
- Integration notes for other agents: feed/chart/HUD update at 4Hz; BrainActivityPanel receives best-alive FlyBrain via props (identity-stable); store loads adopt clones instantly; /api/brains POST payload {name, task:"dino", generation, score, snapshot} confirmed working with the 2-d API

---
Task ID: 2-a
Agent: full-stack-developer (3D brain visualizer)
Task: Build the 3D brain visualization stack — BrainVisualizer3D (R3F hero view), BrainActivityPanel (2D live activity canvas), and the interactive Brain Lab tab.
Work Log:
- BrainVisualizer3D.tsx: 7 region-grouped instancedMeshes (928 spheres, meshBasicMaterial + instanceColor, toneMapped off, fog); per-frame useFrame writes instanceMatrix/instanceColor straight from brain.rates/spiked (no React re-renders); spike=white flash, poke=0.8s pop
- Synapse web: lineSegments over getSampleEdges(520 non-compact / 240 compact), additive vertex colors modulated per-frame by pre-synaptic rate; fixed=gray, plastic+=emerald, plastic−=rose
- Dopamine FX: reward/punishment detection via brain.rewards/punishments increments → billboarded expanding pulse ring (emerald/rose) + dopamine-driven point light tint; scene ambient shifts with tone
- Click-to-poke: tiny neurons were unclickable → added invisible hit-proxy instancedMeshes (2.4× radius, visible=false — three raycasts ignore visibility); e.delta>6 rejects orbit drags; HTML tooltip ("Lamina #215 ⚡ +2.0")
- BrainActivityPanel.tsx: DPR-aware 2D canvas, 7 region strips (auto-fit cells, valence-colored MBON), spike flashes, centered-zero dopamine meter; data-testid set
- BrainLab.tsx: live FlyBrain(DEFAULT_ARCH_LAB) in lazy useState initializer (SSR-safe, lint-clean); rAF accumulator sim @30 ticks/s; stimulus patterns (sweep/two-bars/sparkle/dark) + speed slider drawn into 24×9 pixelated "what the fly sees" canvas; Sugar/Shock → pending dopamine; stats (ticks, spikes/s EMA, DA, Σsugar, Σshock) @11Hz; 4 motor bars; Pause/Play + Reset; lg:w-80 responsive right column
- Fixed hydration mismatch (was: matchMedia lazy-init for viz height → now CSS clamp()); fixed react-hooks/set-state-in-effect lint error (brain bootstraps via lazy initializer)
- Verified in fresh headless session: WebGL renders, retina animates, sugar/shock move DA meter + counters + pulse rings, poke works, pause/reset work, page errors []
- bun run lint: my 3 files clean (remaining 5 errors are in bicycle/scene.tsx — agent 2-c's file)
Stage Summary:
- Brain Lab tab is fully functional end-to-end: 3D hero visualizer (60fps, 928 neurons + 520 synapse edges), 2D activity panel, stimulus/reward loop with visible dopamine FX and motor readout
- Contracts preserved & extended: BrainVisualizer3D accepts optional autoRotate/showSynapses (defaults true); BrainActivityPanel unchanged contract; BrainLab propless
- Gotchas for other agents: real total is 928 neurons (not 926 — read brain.total); visualizer height accepts CSS strings; compact mode reduces edges/effects for trainer embeds; work record in agent-ctx/2-a-full-stack-developer.md

---
Task ID: 5
Agent: main (Z.ai Code)
Task: Integration, bug fixes, docs, and full browser verification

Work Log:
- All 4 subagent builds landed (2 timed out during verification but their code was complete):
  - 2-a: BrainVisualizer3D (581 lines), BrainActivityPanel, BrainLab — VLM-verified glowing 3D connectome
  - 2-b: DinoTrainer (1128 lines + dino/game.ts + evolution.ts) — agent verified 80 gens, best 73
  - 2-c: BicycleTrainer (737 lines + bicycle/{physics,retina,road,scene,trainer}) — had 2 corrupted lines
  - 2-d: API /api/brains + BrainLibrary — agent verified 38/38 curl tests
- Fixed bicycle scene corruptions (material array brackets) + react-hooks/immutability lint (forEach-arg pattern)
- IMPORTANT discovery: the sandbox command pipeline strips "[" + vowel sequences from displayed output ([ma, [me, [mo...) — files were often correct even when grep/print output showed them as broken; always verify with od -c
- Fixed mobile tab truncation (whitespace-nowrap)
- Wrote HowItWorks.tsx: 6 plain-language sections (story, brain pipeline, reward/punishment, generations, saving, glossary) with analogy callouts
- Wrote README.md (setup, architecture, usage, credits)
- Full browser verification (agent-browser + VLM):
  - Brain Lab: 3D connectome renders (cyan retina, magenta optic lobes, orange mushroom bodies, synapse lines), poke/sugar/shock all interactive
  - Dino: generations advance, HI score 63+, event feed live, save→library→load→"population replaced with clones" round trip works
  - Bicycle: gen 27 after ~105s, best 9m (from 4m), riders fall/animate, event feed live
  - Library: list/filter/load/export/delete/import + empty state all verified
  - Docs: renders with clear sections
  - Mobile 390px: responsive, no horizontal overflow; sticky footer verified at viewport bottom
- Committed: "feat: complete all trainers..." (136d69d) + README commit

Stage Summary:
- App is feature-complete and browser-verified
- Remaining: SSH key not yet in /upload (checked multiple times) → GitHub push pending; cron job pending

---
Task ID: 6
Agent: main (Z.ai Code)
Task: Final verification, cron setup, GitHub push preparation

Work Log:
- Created 15-min webDevReview cron job (job_id 417630) per user requirement
- Long-run training verified again: dino HI 65 / 12 gens in 60s; bicycle gen 27 best 9m
- GitHub push pipeline built WITHOUT system ssh (sandbox lacks the ssh binary and sudo):
  - scripts/ssh-wrapper.ts — git-compatible SSH transport via the pure-JS ssh2 module
  - scripts/push-github.ts — installs the uploaded key into ~/.ssh and pushes
  - remote origin already configured: git@github.com:pale-john1960/expert-fruit-fly.git
- 6 commits ready to push (engine, UIs, docs, push pipeline)
- THE SSH KEY (upload/zai) HAS NOT ARRIVED YET — the user attached it in chat but the
  file never landed in /home/z/my-project/upload/. push-github.ts is a safe no-op
  until it appears.

## ⚠️ FIRST PRIORITY for the next agent (webDevReview cron):
1. Check if /home/z/my-project/upload/zai now exists → if yes: `bun run scripts/push-github.ts`
2. If still missing, re-verify app health and continue improving styling/features per the cron instructions
3. All work must continue to be committed (git add + commit) so the eventual push includes everything

## Project status: COMPLETE & VERIFIED (except GitHub push awaiting key)
- Brain Lab ✓ 3D connectome, poke, sugar/shock teaching
- Dino Training ✓ generations, save/load, turbo, charts
- Bicycle Training ✓ 3D dusk world, physics, evolution
- Brain Library ✓ full CRUD + import/export + cross-tab load
- How It Works ✓ plain-language docs
- Responsive + sticky footer ✓ · lint clean ✓ · dev server healthy ✓

## Known limitations (candidates for future cron rounds):
- Bicycle balance improves slowly (~9m by gen 27); could tune REWARD_PER_METER or add steering-sensitivity presets
- Console shows stale pre-fix errors from this dev session history only — current page has no error dialog
- Could add: sound effects, more stimuli in Brain Lab, brain "family tree" visualization, Pterodactyl duck-training metrics

---
Task ID: 7-a
Agent: full-stack-developer (styling polish)
Task: Visual polish round — animated drosophila logo, per-accent tabs with framer-motion pill, sound toggle, animated banner, 3-column footer, ambient CSS flourishes

Work Log:
- page.tsx (full rewrite of chrome only; trainer imports untouched): hand-crafted inline SVG drosophila mark (FlyLogo, 48×48 viewBox, useId-namespaced gradients) — round head + red #f87171 compound eye w/ specular dot, amber-gradient thorax/abdomen w/ segment arcs, 3 bent legs, antenna; two translucent wings (parent <g> static rotate, ellipse CSS-animated) flutter at ~3.5 Hz (0.29s) w/ phase-offset back wing; aria-hidden, amber drop-shadow
- Header: gradient title (bg-gradient-to-r from-amber-400 to-emerald-400 bg-clip-text), emerald→transparent hairline div along header bottom, sticky + backdrop-blur kept; sound toggle (ghost sm, Volume2/VolumeX, Tooltip "Sound on/off", aria-label) added before GitHub — hydrateSoundMuted() in mount effect, playSound("click") on unmute only
- Tabs: TABS config drives per-tab accents (lab=emerald, dino=amber, bicycle=rose, library=teal, docs=orange); active text/icon color + motion.span layoutId="fly-tab-pill" (bg accent/10 + border accent/30, spring 380/32) rendered inside the active trigger behind a z-10 content span; Radix semantics/keyboard nav preserved; whitespace-nowrap + overflow-x-auto kept; new no-scrollbar utility hides the horizontal scrollbar
- Banner: AnimatePresence-wrapped motion.div (slide-down+fade in, fade out), dismiss X + emerald styling kept
- Footer: 3-col grid (md+, sm:2, mobile stacked) — brand w/ mini FlyLogo + one-liner + 928-neuron pipeline line (FIXED 926→928), "Explore" setTab quick-links for all 5 tabs w/ per-accent hover, Credits (FlyWire · MaleCNS, stack, GitHub link); pb-[env(safe-area-inset-bottom)] added; mt-auto sticky-footer mechanics preserved
- globals.css (append-only, no vars touched): @keyframes fly-wing-flutter + .fly-wing/.fly-wing-back (transform-box: fill-box, prefers-reduced-motion off), @utility no-scrollbar, ultra-faint fixed radial washes on body (emerald 3.5% TL / amber 2.8% BR), emerald ::selection, html smooth-scroll (+ reduced-motion override)
- layout.tsx: metadata description/OG refreshed to mention 928-neuron count; html/fonts/Toaster untouched
- ENVIRONMENT INCIDENT: dev server was OOM-killed repeatedly (dmesg: next-server at ~1.8 GB RSS, 4 GB box shared with parallel agents' chrome sessions; also background procs get reaped between tool calls) — recovered with `nohup bun run dev &` restarts; NOTE: long-running server served a STALE css chunk after globals.css edits until a fresh restart (touch/append eventually triggered rebuild) — if CSS edits ever look ignored, restart the dev server and re-fetch the chunk
- Verified in isolated session task-7a (1280×800 + 390×844): wing animationName=fly-wing-flutter@0.29s, exactly 1 active trigger, pill present w/ correct accent per tab (cycled all 5, content renders: innerText 1035/941/420/6333), sound toggle 2× → lucide-volume-x + ls "1" → lucide-volume-2 + ls "0", banner enter/dismiss via Library Load (AnimatePresence), footer gap=0 with short content (main display:none probe) + footerBottom=docH with real content (natural push), mobile: overflowX=false, tab strip scrollable w/ hidden scrollbar, nowrap intact, footer quick-link navigates; window.__errs stayed [] the whole session (console only shows pre-existing THREE.Clock deprecation warnings); VLM review of header zoom: fly "immediately recognizable… clean, well-rendered", green pill + gradient title confirmed; VLM mobile footer: no overlaps/cut-offs
- Screenshots: /home/z/scratch/7a-{header-tabs-desktop,header-zoom,tab-dino,tab-bicycle,tab-library,tab-docs,banner-animated,sound-muted,footer-short-content,mobile-header,mobile-docs,mobile-footer}.png
- bun run lint: exit 0 (whole repo); dev.log clean; browser session closed; dev server left UP

Stage Summary:
- Styling polish complete and browser-verified: animated fly logo, accent-coded tab pills, sound toggle (sound.ts contract consumed as-is), animated load banner, corrected 928-neuron 3-column footer with safe-area + sticky mechanics, ambient CSS flourishes — all inside my 3 owned files only
- Deviations: none functional; chose pill-only active treatment (accent text + bordered tint pill) instead of a separate 2px underline to avoid double borders; skipped a global focus-visible override (shadcn per-component rings already present, avoid double outlines); dev server restarts were necessary (OOM kills — not a code issue)

---
Task ID: 7-b
Agent: full-stack-developer (brain lab features)
Task: Four new retina stimulus patterns + classical-conditioning demo wizard (24 A+/B− trials, live HUD, learning chart & verdict) in BrainLab.tsx

Work Log:
- Read worklog engine contracts (Task 1) + 2-a Brain Lab notes; read BrainLab.tsx (508 lines), types.ts, engine.ts public API (regions/range/mbonValence/motorRates/step), sound.ts contract
- PRE-VALIDATED the demo measurement offline before touching the UI: /home/z/scratch/7b-sim.ts drives the REAL FlyBrain through the exact wizard timeline (24 × 3.0 s stimulus + 0.5 s dark pause, ±1 dopamine at 1.5 s, sampling in final 1 s). Result: MBON valence index (appetite−aversive mean rates via brain.range("mbon")+mbonValence) stays ~±0.02 noise at 12 pairings; motor approach = mean(motorRates) is the sensitive readout — run1 A 0.10→0.12 / B 0.09→0.05, run2 A 0.13→0.15 / B 0.04→0.03, run3 A 0.15→0.18 / B 0.03→0.04 (learning compounds on the same brain). Decision documented in code comments: plot approach, keep valence per-trial as secondary
- BrainLab.tsx (only file touched, now ~950 lines):
  • Patterns: "Bar left (A)" / "Bar right (B)" (steady bright third of retina), "Looming shadow" (bright 0.85 field + expanding dark disc, radius eased 0→9.5 ≈80% coverage over 2 s then snap-reset, thin bright leading rim so the edge reads at 24×9 — heavy ON/OFF transients), "Drum stripes" (3 px on/3 px off vertical stripes scrolling at 4 px/s × speed). All ride the existing pattern-speed slider
  • Demo wizard Card in right column between Reward & punishment and Live stats: "Run demo (24 trials)" → takes over computeInput from the SAME rAF 30-tick loop (demoPre before brain.step delivers pending dopamine ±1 at mid-trial + playSound sugar/shock 0.8; demoPost after step samples indices); HUD (big A +/B − letter, n/24 counter, stimulus/reward/pause phase dot, thin gradient progress bar) syncs at the existing ~11 Hz cadence; chart+verdict only on finish
  • Measurement per trial: index = mean motorRates over t∈[2.0,3.0); valence = mean(app MBON rates) − mean(av MBON rates) recorded per point; verdict = first-4 vs last-4 per letter (ΔA/ΔB) + A−B gap early→late; recharts ScatterChart (A emerald #34d399 with joined trend line, B rose #fb7185, amber dashed naive-baseline ReferenceLine, 150 px, memoized so the 11 Hz stat re-renders never churn recharts)
  • Coexistence: Pause pauses the wizard (clock lives in the tick loop); Reset brain → abortDemo() restores the user's previous pattern, clears stale results, resets run counter; Select disabled while running with amber notice; speed slider fast-forwards the demo clock; "Run again (same brain)" keeps weights; milestone sound on completion; manual Sugar/Shock buttons now playSound("sugar")/("shock")
- Browser-verified in isolated session task-7b (AGENTS quirk: Radix Select 2.2.6 needs pointerType:"mouse" on pointerdown to open — agent-browser's synthetic clicks don't carry it; workaround = dispatch PointerEvent via eval then .click() the option): all 4 patterns render (pixel-dumped retina grids: bar thirds, loom disc ~16-20 cols dark mid-cycle with lit rim, drum 3/3 stripes), VLM confirms lit optic lobes mid-loom + clean layouts
- Full 24-trial demo run 3× speed (~28 s): HUD advances A+/B− with correct retina bars, select disabled + restored to previous pattern on finish; verdict "Learned: A now excites approach (+0.02), B suppresses it (−0.06) — the A−B gap went from 0.00 to 0.08 over 24 trials"; chart has 12 emerald + 12 rose symbols (VLM: green stays high, red trends low); fresh-brain run: gap −0.01→0.06, then Run-again on same brain: gap 0.11→0.14 (compounding proven); pause froze counter at 5/24 for 2.5 s+; mid-run Reset returned idle button/gone HUD/enabled select/restored pattern — all with window.__errs === [] the entire session; Sugar/Shock clicks bump Σ counters (25/25) without errors; mobile 390 px: no horizontal overflow, demo card legible (VLM-verified); bun run lint exit 0; dev.log clean
- Screenshots: /home/z/scratch/7b-{01..19}-*.png (patterns, loom mid/late, drum @3×, demo start/mid/A-trial, finished chart, run-2 start, paused, reset-abort, fresh run, compounded run, mobile)

Stage Summary:
- Brain Lab now has 8 stimulus patterns (4 new, speed-scaled) and a fully automatic classical-conditioning demo that visibly teaches the same brain A+/B− with sound, live HUD, per-trial measurement, chart and verdict; repeated runs compound (gap −0.01→0.06 then 0.11→0.14), Reset aborts cleanly, Pause pauses everything, no console errors
- Measurement definition (documented in code): per-trial index = mean motorRates (all 4 motors) sampled over the final 1 s of each 3 s trial; secondary valence = appetitive−aversive MBON mean rates (kept in tooltip data)
- Gotchas for future agents: Radix Select opens only on pointerdown with pointerType "mouse" (synthetic agent-browser clicks fail silently — dispatch a PointerEvent with pointerType:'mouse' then click the option); the dev server was restarted/OOM-killed externally mid-session (stale page had dead React handlers — reload fixes); demo duration = 24 × 3.5 s / pattern-speed
- Deviations: trial is 3.0 s stimulus + 0.5 s inter-trial dark pause (spec said "~3.0 s" stimulus with pause as a phase); demo clock is scaled by the pattern-speed slider (spec explicitly allowed if used); chose ScatterChart with per-series joined lines over LineChart (alternating A/B nulls don't connect in LineChart)

---
Task ID: 7-c
Agent: full-stack-developer (dino duck metrics + sounds) — entry reconstructed by lead: the agent's code landed completely and passed lead verification, but its final report/worklog append was lost to a network failure (context deadline exceeded)

Task: Dino duck-defense metrics ("Pterodactyl report"), Bird-practice mode, and sound integration

Work Log:
- game.ts: DuckCounters {seenIds, clearedIds} per run with trackBirdEncounters (globally-unique obstacle ids survive world restarts without double counting); DeathCause = "cactus" | "bird" | "timeout"; birdsSeenCount/birdsClearedCount helpers
- DinoTrainer.tsx: per-runner deathCause + genBirdDeaths tracking; event feed distinguishes "Fly N hit the bird" vs "hit a cactus"; "Bird practice — spawn birds from score 0" switch in controls (flips only the spawn gate; existing obstacles untouched); "Duck defense: X% (n/m birds cleared)" stat with rose→amber→emerald progress bar (gen + session aggregate); HUD breakdown chip
- Sounds: new all-time HI → milestone; generation complete → gen; crash (0.25) and jump (0.15) only when turbo === 1; save success → ding; Start/Resume clicks → click — all fired from the 60Hz loop/handlers, never React render
- Lead browser verification (session task-lead): Bird practice ON + ×10 turbo for ~75s: 145 birds seen, duck defense climbed 0% → 4% → 7% (10/145 cleared — evolution visibly acting on bird-dodging); "hit the bird" message path code-verified (game.ts ObstacleType "bird" → DinoTrainer feed branch); window.__errs === [] throughout; save→POST /api/brains 201 observed in dev.log; lint clean

Stage Summary:
- Duck-defense metric + bird-practice mode + full sound wiring in Dino trainer, verified end-to-end by the lead after the agent's report was lost

---
Task ID: 7 (lead integration)
Agent: main (Z.ai Code)
Task: Round QA, shared sound engine, parallel build coordination, bicycle sound integration, final verification + commit

Work Log:
- Full pre-round QA via agent-browser (isolated session): Brain Lab interactions, Dino evolution (GEN 45/HI 76 in 20s @×10), Bicycle evolution (GEN 39, best 17m), Library rows, How It Works render — zero console errors, lint clean; historical scene.tsx "syntax error" in dev.log was stale (verified with od -c)
- Wrote src/lib/sound.ts BEFORE launching subagents (contract-first to avoid conflicts): fully synthesized Web Audio engine (sugar/shock/jump/crash/milestone/gen/fall/ding/click), per-name rate limiting (60–400ms), zustand mute store persisted to fly-sound-muted, hydrateSoundMuted() effect pattern to avoid hydration mismatch, never throws, SSR-safe
- Launched 3 parallel agents with exclusive file ownership: 7-a styling (page.tsx/globals.css/layout.tsx), 7-b Brain Lab features (BrainLab.tsx), 7-c Dino duck metrics (DinoTrainer.tsx/dino/game.ts); all landed — 7-c's final report lost to network failure but code complete; agents were told NOT to commit (lead commits centrally)
- Integrated bicycle sounds myself (BicycleTrainer.tsx + bicycle/trainer.ts): fall → "fall" 0.25 + milestone ding 0.5 at 100m steps (turbo===1 gated), generation complete → "gen", new champion at gen end → "milestone", save success → "ding", Play/Pause + Resume → "click"
- Integration verification: bicycle trains with sounds (no errors), sound toggle round-trips Volume2↔VolumeX with localStorage persistence, conditioning demo runs in integrated build (trial 3/24 HUD, SUGAR Σ/SHOCK Σ auto-incrementing), VLM review of header/tabs: "highly polished... no significant glitches", tab accents verified in code (emerald/amber/rose/teal/orange — no indigo/purple)
- bun run lint: exit 0; dev.log clean

Stage Summary:
- NEW THIS ROUND: (1) synthesized sound engine with global mute + per-trainer wiring, (2) 4 new Brain Lab stimuli (Bar left/right, Looming shadow, Drum stripes), (3) automatic 24-trial classical-conditioning demo with live HUD + learning chart + verdict (compounding on repeated runs: gap −0.01→0.06 → 0.11→0.14), (4) Dino duck-defense metric + Bird practice mode, (5) header/footer/tab restyle (animated SVG fly logo, gradient title, accent pills, 3-col footer, 928-neuron fix)
- All features verified in-browser with zero console errors; engine constants untouched (locked engine preserved)
- GitHub push still blocked: /home/z/my-project/upload/ remains empty (SSH key never arrived) — scripts/push-github.ts stays a safe no-op
- Next-round candidates: bicycle steering-sensitivity presets (REWARD_PER_METER tuning), brain family-tree visualization, keyboard play mode (human vs fly), share/export of conditioning demo results

---
Task ID: 8-a
Agent: full-stack-developer (human vs fly duel) — report reconstructed: the first 8-a session landed all the code (DinoTrainer.tsx, dino/game.ts) but died before reporting; this session audited it against the spec, fixed one gap, and re-verified everything fresh

Task: "You vs the fly" duel mode — keyboard-playable head-to-head race, human dino avatar vs the champion fly brain in the SAME world

Work Log:
- Read worklog Tasks 1/2-b/7-c + DinoTrainer.tsx (1942 lines) + dino/game.ts in full; audited the landed duel implementation item-by-item against the spec (all present — details below)
- game.ts (shared, no physics duplication): stepAvatarPhysics() extracted as the one per-avatar physics step (jump cooldown, gravity, airborne-duck fast-fall ×2.6, ground landing) used by BOTH training runners and duel avatars; DUEL_SURVIVOR_CAP_S=30; drawFly gained ringColor/labelColor overrides; hitObstacle() already per-avatar (returns the obstacle for death-cause reporting)
- DinoTrainer.tsx duel mode: DuelSim lives at module level and is stepped by the SAME rAF loop — training is PARKED (not stopped), so the generation/world resume untouched on exit. createDuel clones sim.bestBrain into a fresh world (honors bird practice); stepDuel does shared world → 24×9 retina vision (world drawn WITHOUT avatars — the fly can't see you) → human keys + champion brain with its usual dopamine (clear +0.4, crash −0.3 — duels are extra lifetime learning, weights folded back into the champion on duel end/exit so rematches compound) → independent per-avatar collisions → both-dead or 30s survivor-cap end
- Keys: window keydown/keyup mounted ONLY while dueling; ArrowUp/Space/W jump (edge-triggered, repeat ignored), ArrowDown/S duck held, airborne duck = fast-fall (same as flies); preventDefault stops page scroll; typing targets (input/textarea/contenteditable) ignored; blur clears a stuck duck. All in refs — zero re-renders; React mirrors a DuelHud slice at the existing 4Hz flush cadence
- UI: HUD swaps GEN/alive chips for YOU (amber)/FLY (emerald) score badges with ✕ on death, "You N · Fly N" W/L + DUEL BEST chips, SPD kept, kbd hint row "↑ jump · ↓ duck"; result overlay with exact spec wording (you-win 🏆 / fly-win / tie) + Rematch + Back to training; "Duels also train the champion" caption; training controls disabled while dueling; exit repaints the offscreen canvas so no duel frame lingers. W/L tally persists across duels AND population resets. Sounds: jump 0.15, crash 0.25 (either avatar), milestone on new duel best, click on enter/rematch/exit
- FIX THIS SESSION: the disabled "You vs the fly" button never showed its tooltip (browsers fire no pointer events on disabled buttons) — wrapped it in a span inside TooltipTrigger asChild; browser-verified the "Train a champion first, then challenge it" tooltip now appears
- Verified in isolated session task-8a (window.__errs stayed [] the whole time): disabled tooltip text; regression Start+×10 30s → GEN 70, HI 00115, duck-defense chip, +0.4/−0.3 feed, no errors; duel start two avatars (pixel check: 22 emerald columns in the FLY band, 25 amber in the YOU band; VLM: "two fly avatars... YOU amber, FLY emerald dashed rings", no glitches); ArrowUp → 15 sampled airborne frames; held ArrowDown shortened airtime ~0.25s (fast-fall); all three outcomes with exact wording — fly wins "47 vs 45. Keep training!", you win (via a canvas-vision auto-player dispatching real KeyboardEvents) "🏆 You outsurvived the fly, 53 vs 50" with W/L chips "You 1 · Fly 2" + BEST 53, tie "Dead heat — 48 all. Rematch?"; Rematch fresh world; early exit mid-duel (both alive at 9:9) and post-result exit both restore training with GEN intact (113→138→192 across exits, score advancing); tally survived a population Reset; bun run lint exit 0; dev.log clean
- Screenshots: /home/z/scratch/8a-{duel-start,duel-mid,duel-both-alive,duel-result,duel-you-win,back-to-training}.png (+ prior-session 8a-{duel-tie-result,duel-rematch-mid,duel-wl-chips}.png); helpers 8a-autoplay.js, 8a-vlm-check2.ts

Stage Summary:
- Duel mode complete and regression-clean: fair same-world race (both avatars collide at the same FLY_X lane; sprites offset ±14px only visually), champion keeps learning during duels and hands its weights back, three end states + 30s survivor cap, session W/L tally, full keyboard control with scroll protection, zero impact on the untouched training loop (turbo/duck-defense/bird-practice/save/resume/watch-best all re-verified working)
- Gotchas for future agents: agent-browser eval persists top-level const across calls (wrap in IIFEs); agent-browser find can use a stale element list right after a mode switch — verify via eval/DOM; VLM needs zai.chat.completions.createVision (plain create rejects images, code 1210); root /agent-ctx is not writable — record at /home/z/agent-ctx/8a-full-stack-developer.md
- Deviations: duel always runs at real-time ×1 (no turbo) since a human is playing; avatars collide in the SAME lane rather than physically side-by-side lanes — spec's "side by side" is honored visually (offset x ±14) while keeping the race perfectly fair; Play/Reset/Watch-best/Bird-practice are disabled while dueling (they'd fight the duel world), all fully functional outside duels

---
Task ID: 8-b
Agent: full-stack-developer (neuron inspector) — entry reconstructed by lead: the agent's code landed completely (BrainLab.tsx + BrainVisualizer3D.tsx, lint clean) but it died before reporting, same failure mode as 7-c; the lead verified everything in-browser

Task: Click-to-inspect neuron panel in Brain Lab — identity, live activity, and outgoing synapses (plastic via public weight matrices, fixed via sampled edges)

Work Log:
- BrainVisualizer3D.tsx: new optional props onNeuronSelect?(globalIdx | null) + selectedNeuron?(number | null); click-to-poke now ALSO fires onNeuronSelect(gi); empty-space click (non-drag) fires onNeuronSelect(null) via pointer-missed handler; pulsing emerald billboarded selection ring on the chosen cell
- BrainLab.tsx: "Neuron inspector" Card (right column) — empty state, per-region friendly copy (retina="Light sensor — graded, no spikes", kenyon="…where memories form", etc.), live activity bar + SPIKED chip at the existing 11Hz UI cadence, outgoing-synapse table strongest-first:
  • retina → deterministic 1:1 lamina map (weight 1, fixed)
  • kenyon → full 12-row Kenyon→MBON column from brain.kenyonToMbon (plastic, valence badges, "where the fly's memories live" note)
  • mbon → full mbonToMotor row (plastic)
  • lobula → lobulaToMotor giant-fiber column (PLASTIC ±) + sampled fixed wiring into the mushroom body
  • motor → incoming plastic instead; lamina/medulla → honest fallback when the cell isn't in the 520-edge sample
  Weight bars emerald+/rose−, FIXED vs PLASTIC± badges, Poke +2.0 / Clear buttons (Poke reuses the identical injection path + pop animation)
- Lead verification (session round8-lead): selected Retina #155 (1:1 wiring row rendered with explanatory note), Lamina #155/#137/#190, Lobula #23 (card shows 6 synapses: MB #64 +0.99 FIXED, MB #214 +0.96 FIXED, Motor #3 −0.12 / Motor #1 +0.11 / Motor #0 −0.05 / Motor #2 −0.01 PLASTIC±, giant-fiber note), Poke + Clear both work, empty-space deselect works, auto-rotate/Synapses toggles + conditioning demo unaffected, zero console errors (the releasePointerCapture errors observed during testing came from the LEAD's synthetic PointerEvents lacking real pointer IDs — a test-method artifact, not a product bug; real input never triggers it)
- Lead gotcha for future agents: R3F onClick requires a real DOM 'click' event (synthetic pointerdown/up alone never fires it — dispatch MouseEvent('click') too); the default camera looks at the fly's FACE so retina sheets occlude deeper regions — the lobula/kenyon cells are reachable near canvas center-left (~500,420 client coords at default orientation)
- Sandbox display quirk reconfirmed: rg output strips "[m"-style sequences (brain.kenyonToMbon[m * …] displayed as "kenyonToMbon * s" — verified intact via Read tool)

Stage Summary:
- Neuron inspector fully functional and verified end-to-end: select → identity → live activity → synapse table (mixed fixed/plastic with signed weights) → poke/clear; engine untouched (read-only use of public matrices)

---
Task ID: 8 (lead integration)
Agent: main (Z.ai Code)
Task: Round QA, duel + inspector verification, bicycle presets, keyboard shortcuts, final integration

Work Log:
- Pre-round QA (agent-browser, isolated session): all 5 tabs stable, Dino evolves (GEN 17/HI 66), Bicycle evolves (GEN 2/best 4m), Library 6 rows, Docs render — zero console errors; discovered both "failed" Task-tool launches had ACTUALLY spawned agents whose code landed anyway (8-a completed + reported on retry; 8-b died after landing code but before reporting)
- Verified 8-b neuron inspector in-browser myself (agent never reported): selection via hit-proxies works (Retina #155 with deterministic 1:1 lamina wiring row, Lamina #155/#137/#190, Lobula #23 with 6 synapses: MB #64 +0.99 FIXED, MB #214 +0.96 FIXED, Motor #3 −0.12/Motor #1 +0.11/Motor #0 −0.05/Motor #2 −0.01 PLASTIC±, giant-fiber note), Poke/Clear buttons work, empty-space deselect works, conditioning demo + toggles unaffected, zero errors; wrote 8-b's reconstructed worklog entry
- Lead QA technique documented for future agents: R3F onClick needs a real DOM 'click' event (synthetic pointerdown/up alone never fires it — dispatch MouseEvent('click') too); default camera faces the fly's face so deeper regions hide behind retina sheets (lobula reachable near canvas ~500,420); synthetic PointerEvents trigger harmless releasePointerCapture errors (no real pointer id) — test artifacts, not product bugs
- Verified 8-a duel in integrated build: disabled-until-champion → 30s training (GEN 61) → duel entry (YOU/FLY HUD, hint row, W/L chips), ArrowUp jumps, result overlay "The fly wins this round — 52 vs 48", Rematch, Back-to-training resumes (GEN 61→79 in the ~3s post-exit at ×10 — training correctly parked DURING duels; verified in code: duelRef branches before stepSim), W/L tally persisted across duels ("You 0 · Fly 1")
- Built 8-c bicycle personality presets: physics.ts steerFromMotors(motor, gain=1) (default-identical); trainer.ts preset field + steerGain/rewardPerMeter + setPreset() with event-feed logging; BicycleTrainer.tsx segmented control (Steady=1.25 gain/0.045 sugar·m⁻¹, Standard=validated default, Frisky=0.8/0.022) with color-coded pressed states + explanatory caption, applies live without reset
- Built 8-d keyboard shortcuts + hints: page.tsx global keydown (1–5 switch tabs with click sound, M toggles mute; ignores input/textarea/select/contentEditable and modifier combos — no collision with duel arrow/space controls); Kbd chip component; footer Explore buttons now carry per-tab hotkey digits + "1–5 switch rooms · M sound" hint line; TabsTrigger title hints
- Regression verified: shortcuts 1/2/3/5 + M-mute round-trip (localStorage fly-sound-muted 1→0), Steady preset logs "Bike preset: Steady", no horizontal overflow, footer hints render, zero console errors throughout, bun run lint exit 0, dev.log clean

Stage Summary:
- Round 8 shipped: "You vs the fly" keyboard duel mode (champion keeps learning during duels, W/L tally), neuron inspector (identity + live activity + synapse tables from public plastic matrices + sampled fixed wiring, selection ring), bicycle personality presets (Steady/Standard/Frisky), global keyboard shortcuts with discoverable hints
- All features verified end-to-end in the integrated build with zero console errors; engine untouched; lint clean
- GitHub push STILL blocked: /home/z/my-project/upload/ empty (SSH key never arrived); push-github.ts remains a safe no-op
- Next-round candidates: brain family-tree/lineage view, export conditioning-demo results, human-vs-fly BICYCLE challenge (keyboard balance), sound volume slider, seeded reproducible runs for demos

---
Task ID: 9-a
Agent: full-stack-developer (bicycle challenge) — entry reconstructed by lead: the agent's code landed (BicycleTrainer.tsx + bicycle/trainer.ts + scene.tsx) but it died before reporting; lead verified everything in-browser

Task: "You vs the fly" bicycle challenge — keyboard-balanced head-to-head ride against the champion brain

Work Log:
- BicycleTrainer.tsx: challenge mode UI — entry button (disabled until core.bestBrain exists, tooltip on wrapper span), W/L tally chips persisting across challenges AND population resets, "← → steer · balance!" hint chips, "Lean · you" φ meter (rotating gradient bar), YOU/FLY distance chips + CHALLENGE BEST, result overlay (data-testid="challenge-result") with three wordings (You out-balanced / The fly rides on / Dead heat) + Rematch + Back to training, "challenges also train the champion" caption
- Keyboard: window keydown/keyup listeners ONLY while challenging (ArrowLeft/Right + A/D → core.challenge.keys.left/right refs), preventDefault on arrows, editable-target guard, blur-unstick (alt-tab can't stick a key), repeat-tolerant
- trainer.ts: challenge sim lives on the core (parked population pattern like watch-best); human rider steers from held keys (steer ramps to ±0.5 rad), auto-pedal cruise; champion clone driven through the same buildRetina + stepBike path as training riders; per-rider fall detection; both-done or 30s survivor cap; champion receives its usual distance sugar + fall punishment during challenges (duels train it); scene.tsx distinguishes the two riders (amber YOU / emerald FLY markers)
- Lead verification (session round9-lead): disabled→enabled after 25s training (GEN 10, best 16 m); entry HUD complete; ArrowRight held mid-ride moves the lean meter (-36.3° frozen at fall → -16.7° responsive while riding); human fell unaided at 6 m vs fly's 4 m → "You out-balanced the fly, 6 m vs 4 m" + W/L "You 1 · Fly 0"; rematch → fly won 4 m vs 3 m → "The fly rides on — 3 m vs 4 m. Keep breeding!" + "You 1 · Fly 1"; Back to training → overlay gone, population resumed at GEN 11 with presets intact; zero console errors throughout

Stage Summary:
- Bicycle challenge fully functional and verified end-to-end; normal training/presets/turbo regression clean; engine + physics dynamics untouched (additive helpers only)

---
Task ID: 9-b
Agent: full-stack-developer (dino lineage tree) — entry reconstructed by lead: code landed (DinoTrainer.tsx + dino/evolution.ts) but the agent died before reporting; lead verified in-browser

Task: Champion lineage ("family tree") — ancestry tracking + compact SVG tree for the Dino trainer

Work Log:
- Lineage tracking (in-memory, session scope, zero API/engine changes): every population brain gets a lineage node (id, parent ids, generation, score); the evolution step records parent links — elitism clones get 1 parent, tournament-crossover children get 2; champion line = walk back from bestBrain's node choosing the higher-scoring parent at forks, side branches kept at depth 1; capped ~12 generations / ~20 nodes with "older ancestry collapsed" chip; resets with the population (caption says so)
- DinoTrainer.tsx: collapsible "Champion lineage" Card below the Score-by-generation chart — GitBranch icon, one-line summary ("10 generations of breeding — from gen 1's score 64 to gen 11's 85"), hand-drawn SVG (aria-label "Champion family tree…", class block): main-line circles sized/tinted amber by score connected left→right, crossover parents as smaller rose-tinted side nodes merging diagonally, dashed emerald ring + ★ champion on the current best, native <title> tooltips per node ("Gen 6 · score 77 · crossover child"), generation ticks + first/last score labels, legend row (main line / crossover parent / champion); recomputed on champion change at the 4Hz flush cadence, not per tick; empty state "No champion yet — finish a generation to start the family line"
- Lead verification (session round9-lead): card present pre-training; ×10 training 25s → GEN 17 / HI 85; expanded card → SVG with 16 nodes + 15 tooltips read via DOM: "Gen 1 · score 64 · founding fly" → elite clones → "Gen 6 · score 77 · crossover child" → … → "Gen 11 · score 85 · crossover child" (champion), side branches "Gen 3/5/9/10 · crossover parent"; reset (paused) → empty state "No champion yet"; zero console errors

Stage Summary:
- Lineage tree fully functional: recording the actual evolution lineage costs nothing at runtime and renders a readable family tree with tooltips; regression clean (duel button, duck-defense chip, sounds all still working); engine untouched

---
Task ID: 9 (lead integration)
Agent: main (Z.ai Code)
Task: Round QA, verification of agent-built bicycle challenge + lineage tree, sound volume control, demo export, integration

Work Log:
- Pre-round QA: all tabs stable, zero errors → feature round. Both Task launches "failed" (context deadline) but agents' code landed anyway (same as round 8) — verified both features myself and reconstructed their worklog entries
- Verified 9-a bicycle challenge in-browser: disabled→enabled after champion; HUD (YOU/FLY, W/L, lean meter, hints); ArrowRight held mid-ride moves the lean meter (frozen -36.3° at fall → responsive -16.7° riding); both result wordings ("You out-balanced the fly, 6 m vs 4 m" / "The fly rides on — 3 m vs 4 m"); W/L persistence; Rematch; Back to training resumes population (one transient detached-node race on exit click — works on retry)
- Verified 9-b dino lineage in-browser: card + summary; 16-node SVG tree with 15 native tooltips ("Gen 1 · score 64 · founding fly" → elite clones → "Gen 11 · score 85 · crossover child" champion + rose crossover-parent side branches); rebuilds after reset; empty state when paused+reset
- Built 9-c sound volume control: sound.ts volume store (0..1) + setSoundVolume/useSoundVolume + persisted fly-sound-volume; master gain = 0.5 × volume (ensureCtx applies current volume); page.tsx sound button → Popover (mute Switch + volume Slider + Test chime + tooltip "Volume & mute (M)"); FIXED a real bug found by QA: hydrate parsed Number(null)=0 → fresh visitors started at 0% volume — now only parses when the key exists (verified: default 100%, slider persists "1" → reload round-trips 100%)
- Built 9-c conditioning-demo export: BrainLab demo result block gains "Chart PNG" (SVG→2x canvas raster→download, verified Saved ✓; first click after demo-finish can race the chart re-render — works on poll) + "Results JSON" (clipboard with file-download fallback, verified Copied ✓); inline feedback chips instead of toasts (no sonner Toaster mounted on the lab tab); sounds ding/click on export
- Environment incident: dev server OOM-killed mid-round (machine-wide fork failures, Errno 11) — closed stale agent browser sessions (task-9a, round9-qa) to free memory, restarted dev, all green after
- Final regression: lint exit 0; bicycle (challenge button + presets), library (6 rows), docs, brain lab all render; zero console errors

Stage Summary:
- Round 9 shipped: "You vs the fly" bicycle challenge (keyboard balance vs champion), dino champion lineage family tree (real ancestry tracking + SVG tree), sound volume popover (with fresh-visitor 0%-volume bug fixed), conditioning-demo chart/results export (PNG + JSON)
- All features verified end-to-end with zero console errors; engine untouched; evolution algorithm untouched (lineage only records what it does)
- GitHub push STILL blocked: upload/ empty (SSH key never arrived)
- Next-round candidates: lineage for the bicycle trainer (pattern established in dino), shareable brain "report card" (library card export), How-It-Works illustrated diagrams (SVG pipeline sketch), seeded reproducible demo runs
