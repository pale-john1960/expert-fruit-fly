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
