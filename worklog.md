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
