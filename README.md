# 🪰 Expert Fruit Fly

**A fruit fly brain that learns — in your browser.**

A connectome-inspired, 926-neuron fruit fly brain simulation inspired by the real fruit fly connectome releases ([FlyWire](https://flywire.ai) / MaleCNS) and the viral "fly plays Doom / Dino / Beat Saber" demos. Watch the brain think in real-time 3D, teach it with sugar and shocks, train populations of flies to play the Chrome Dino game and balance a bicycle — generation by generation — and save the trained brains so they remember everything.

---

## What's inside

| Tab | What it does |
|---|---|
| 🧠 **Brain Lab** | Live 3D visualization of the full connectome — every neuron glows as it fires, synapses flash, dopamine surges pulse green (reward) or red (punishment). Poke neurons with your mouse, feed stimuli to the retina, and teach associations with Sugar / Shock buttons. |
| 🎮 **Dino Training** | A population of flies plays the Chrome offline Dino runner. Clearing obstacles = sugar. Crashing = shock. When all flies die, the best brains breed → next generation. Includes turbo training, score history charts, and brain saving. |
| 🚲 **Bicycle Training** | Flies learn to ride bicycles in a 3D dusk world. Distance = sugar, falling = shock. Simplified bicycle balance physics (lean dynamics, counter-steering), ghost riders, chase camera, generational training. |
| 📚 **Brain Library** | Saved connectomes live here. Load one and the fly **remembers everything it learned** — weights, generation, scars. Export/import as JSON files, all persisted in SQLite. |
| 📖 **How It Works** | Plain-language documentation — the brain architecture, why reward/punishment works, how saving works, and a mini glossary. |

---

## The brain (short version)

```
 Retina (216)      the eye — 24×9 pixels of brightness
    ↓
 Lamina (216)      keeps what CHANGES, ignores what stays still
    ↓
 Medulla (192)     feature detectors — bright/dark spots, edges, motion
    ↓
 Lobula (48)       spiking neurons, each watching one patch of view
    ↓
 Kenyon cells (240)  the MUSHROOM BODY — sparse code for "what's happening"
    ↓                (kept sparse by the APL neuron, like in real flies)
 MBONs (12)        memory outputs — appetitive (approach) & aversive (avoid)
    ↓
 Motor (2–4)       jump / duck / steer-left / steer-right / pedal
```

- **Spiking neurons**: leaky integrate-and-fire (LIF), the same model used in real connectome simulations (Shiu et al. 2024)
- **Learning**: dopamine-gated 3-factor plasticity — `Δw = η × dopamine × eligibility`. Sugar strengthens recently-active synapses; shock weakens them. This is genuinely how biologists believe the mushroom body learns.
- **Evolution**: whole brains mutate + breed across generations (elitism + tournament crossover + gaussian mutation)
- **Fast reflexes**: a "giant fiber" lobula→motor shortcut (real flies have exactly this for escape jumps)

See the **How It Works** tab in the app for the friendly long version.

## Getting started

```bash
bun install          # or npm install
bun run db:push      # create the SQLite database
bun run dev          # http://localhost:3000
```

**First run suggestion:**
1. Open **Brain Lab** — click neurons, press Sugar as the bar sweeps the same spot ~10 times, watch the motor bars shift.
2. Open **Dino Training** — press Start, set Turbo ×10, watch generations climb for a few minutes.
3. Press **💾 Save best brain**, then open **Brain Library** — Load it later and training continues from that generation.

## Tech stack

- **Next.js 16** (App Router) + TypeScript
- **three.js / React Three Fiber** — 3D brain + dusk bicycle world
- **Tailwind CSS 4 + shadcn/ui** — dark neuro-lab interface
- **Prisma + SQLite** — brain persistence (`Brain` model)
- **Zustand** — cross-tab brain loading
- **Recharts** — training curves
- Zero backend ML: the whole brain simulates client-side at ~10K+ ticks/sec

## Project layout

```
src/lib/flybrain/
  engine.ts     FlyBrain class — the entire simulation (LIF, plasticity, evolution)
  types.ts      architecture presets + BrainSnapshot (save format)
  rng.ts        seeded deterministic RNG
  store.ts      cross-component brain loading
src/components/fly/
  BrainVisualizer3D.tsx   3D connectome renderer (R3F)
  BrainActivityPanel.tsx  compact 2D activity strips
  BrainLab.tsx            interactive lab tab
  DinoTrainer.tsx + dino/ dino game + evolution loop
  BicycleTrainer.tsx + bicycle/ 3D world + physics + retina synthesis
  BrainLibrary.tsx        save/load/import/export UI
  HowItWorks.tsx          in-app documentation
src/app/api/brains/       REST API (GET/POST/DELETE)
prisma/schema.prisma      Brain model
```

## How saving works

A trained brain = ~3,000 plastic synapse weights + one seed number that deterministically regenerates all fixed innate wiring. That's a ~25 KB JSON file (smaller than a photo of an actual fly). Snapshots round-trip losslessly — load a saved brain and it resumes exactly where it left off.

## Credits & inspiration

- The **FlyWire** and **MaleCNS** teams for the real connectomes
- **Shiu et al. 2024** (Nature) — LIF connectome simulations
- The viral fly-sim authors (doomfly, FLM, and friends)
- Patrick Mineault's ["Deconstructing viral fly sims"](https://www.neuroai.science/p/are-flies-playing-beat-saber) for the excellent technical breakdown

## Disclaimer

This is a playful, browser-sized homage — 926 neurons instead of 140,000, and simplified dynamics. It is not a "real" fly brain, and no virtual flies were harmed beyond routine electroshock. 🪰⚡
