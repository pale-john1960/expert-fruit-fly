# Task 2-a — 3D Brain Visualizer + Brain Lab (full-stack-developer)

## Scope
Owned and fully implemented 3 files (stub overwrites only):
- `src/components/fly/BrainVisualizer3D.tsx`
- `src/components/fly/BrainActivityPanel.tsx`
- `src/components/fly/BrainLab.tsx`

No other files touched. Engine (`src/lib/flybrain/engine.ts`) untouched.

## Contract notes for downstream agents
- `BrainVisualizer3D` props: `{ brain: FlyBrain | null; className?; height?: number|string; compact? }` PLUS two
  backward-compatible optional extras: `autoRotate?: boolean` (default true), `showSynapses?: boolean` (default true).
  Passing only the 4 contract props works exactly as before. Use `compact` inside trainers (240 edges, edge color
  updates every 3rd frame, no stars/legend, dpr cap 1.5).
- `BrainActivityPanel` props: `{ brain: FlyBrain | null; height?: number; className? }`, `data-testid="brain-activity-panel"`.
- `BrainLab` takes no props (`export type BrainLabProps = Record<string, never>` preserved).
- NOTE: actual neuron total is **928** (216+216+192+48+240+12+4), not 926. My UIs read `brain.total` dynamically.

## Implementation summary
### BrainVisualizer3D (R3F)
- One `instancedMesh` per region (7 meshes, 928 spheres), meshBasicMaterial + instanceColor, `toneMapped={false}`,
  fog for depth. Radii: retina .025 … motor .06. MBON per-instance color from `brain.mbonValence` (+emerald/−rose).
- Per-frame `useFrame`: writes `instanceMatrix` (scale = 0.8 + energy*0.85) + `instanceColor` directly from
  `brain.rates`/`brain.spiked` — zero React re-renders. Spike = white flash add; poke = 0.8s pop (2.6× scale).
- Synapses: `lineSegments` over `brain.getSampleEdges(520|240)` with additive-blended vertexColors; per-frame color
  from pre-synaptic rate; fixed=gray, plastic+ =emerald, plastic− =rose.
- Dopamine FX: pulse trigger now watches `brain.rewards`/`brain.punishments` increments (robust vs. decaying tone),
  expanding billboarded ring (emerald/rose, 1.15s) + point light whose color/intensity follow `getDopamine()`.
- Click-to-poke: works via **invisible hit-proxy instancedMeshes** (radius max(0.055, r*2.4), `visible={false}`;
  three.js raycasts ignore visibility) — plain tiny-sphere raycast was too precise to click. `e.delta > 6` guard
  rejects orbit drags. Tooltip HTML overlay shows region + # + ⚡.
- Legend (non-compact): bottom-left chips w/ counts; top-right interaction hint. Scene remounts via `key` on brain
  swap; imperative edge geometry disposed in effect cleanup.

### BrainActivityPanel (2D canvas)
- DPR-aware rAF loop, ResizeObserver; per-region strips (auto-fit cell width, cap 9px), rate→alpha, spike→white
  flash; MBON strip colored by valence; dopamine meter centered-zero (emerald right / rose left) + numeric readout.

### BrainLab
- Owns live `FlyBrain(DEFAULT_ARCH_LAB)` created in a lazy `useState` initializer (pure/DOM-free ⇒ SSR-safe;
  avoids `setState`-in-effect lint error — do NOT "fix" this back to an effect).
- Sim loop: rAF accumulator at 30 ticks/sec (catch-up guard 6), stimulus patterns: sweep bar (+random dots) /
  two bars / random sparkle (decaying field) / dark; drawn into 24×9 pixelated retina canvas.
- Sugar/Shock set `pendingDaRef = ±1` consumed on next tick; dopamine meter + stats (ticks, spikes/s via EMA,
  dopamine, sugar Σ, shock Σ) synced at ~11Hz; 4 motor bars (M1 Jump…M4 Right) with CSS-transition widths.
- Controls: Pause/Play, Reset brain, pattern Select, speed Slider, Auto-rotate + Synapses Switches.
- Responsive: `lg:flex-row` with `lg:w-80` right column; visualizer height `clamp(360px, 52vh, 500px)` (a CSS
  string — do not replace with a matchMedia lazy-initializer, that caused a hydration mismatch).

## Verification (agent-browser, fresh session)
- WebGL canvas present (910×358 buffer), 3D brain + synapses render (VLM-confirmed).
- Retina canvas animates (sweep bar → sparkle switch verified visually).
- Sugar/Shock: dopamine meter swings +0.18/−0.18, counters increment, emerald/rose pulse ring confirmed in screenshots.
- Click-to-poke: hover cursor + click → tooltip "Lamina #215 ⚡ +2.0".
- Pause freezes ticks; Reset restarts at 0; stats live.
- Fresh-session page errors: `[]`. Only console message: THREE.Clock deprecation warning (R3F internal w/ three 0.186 —
  harmless, library-level).
- `bun run lint`: my 3 files clean (5 remaining errors are in `src/components/fly/bicycle/scene.tsx` — agent 2-c's file).
