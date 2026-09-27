/**
 * Core types for the Fruit Fly Brain engine.
 *
 * The architecture is a simplified, browser-sized version of the real fruit
 * fly (Drosophila) visual → learning → motor pipeline, inspired by the
 * FlyWire / MaleCNS connectome releases and the way the viral "fly sims"
 * (Shiu et al. 2024, doomfly) embed connectomes into simulations:
 *
 *   retina   – photoreceptors (graded, non-spiking, like the real fly eye)
 *   lamina   – first optic neuropil (graded, adaptive = temporal contrast)
 *   medulla  – 8 fixed feature channels (edge / motion detectors), pooled
 *   lobula   – spiking LIF feature neurons
 *   kenyon   – mushroom body intrinsic cells (sparse coding, spiking LIF)
 *   mbon     – mushroom body output neurons (PLASTIC synapses, dopamine)
 *   motor    – motor neurons (PLASTIC synapses from MBONs)
 */

export type BrainRegion =
  | "retina"
  | "lamina"
  | "medulla"
  | "lobula"
  | "kenyon"
  | "mbon"
  | "motor";

export const BRAIN_REGIONS: BrainRegion[] = [
  "retina",
  "lamina",
  "medulla",
  "lobula",
  "kenyon",
  "mbon",
  "motor",
];

export interface BrainArchitecture {
  /** retina pixel columns */
  retinaCols: number;
  /** retina pixel rows */
  retinaRows: number;
  /** number of fixed feature channels in the medulla */
  medullaChannels: number;
  /** pools per channel (grid of pools over the retina) */
  medullaPools: number;
  /** spiking feature neurons in the lobula */
  lobulaCount: number;
  /** Kenyon cells (mushroom body) */
  kenyonCount: number;
  /** mushroom body output neurons */
  mbonCount: number;
  /** motor outputs (task dependent: 2 for dino, 3 for bicycle) */
  motorCount: number;
  /** seed that deterministically regenerates all fixed wiring */
  seed: number;
}

/** Everything needed to resurrect a trained brain exactly as it was. */
export interface BrainSnapshot {
  version: 1;
  task: string;
  name: string;
  arch: BrainArchitecture;
  generation: number;
  /** fitness / score at save time */
  score: number;
  createdAt: string;
  /** plastic weights – the "learned" part of the brain */
  weights: {
    kenyonToMbon: number[];
    mbonToMotor: number[];
    mbonBias: number[];
    motorBias: number[];
  };
  meta: {
    steps: number;
    rewards: number;
    punishments: number;
    note?: string;
  };
}

export const DEFAULT_ARCH_DINO: BrainArchitecture = {
  retinaCols: 24,
  retinaRows: 9,
  medullaChannels: 8,
  medullaPools: 24,
  lobulaCount: 48,
  kenyonCount: 240,
  mbonCount: 12,
  motorCount: 2,
  seed: 1337,
};

export const DEFAULT_ARCH_BICYCLE: BrainArchitecture = {
  retinaCols: 24,
  retinaRows: 9,
  medullaChannels: 8,
  medullaPools: 24,
  lobulaCount: 48,
  kenyonCount: 240,
  mbonCount: 12,
  motorCount: 3,
  seed: 4242,
};

export const DEFAULT_ARCH_LAB: BrainArchitecture = {
  retinaCols: 24,
  retinaRows: 9,
  medullaChannels: 8,
  medullaPools: 24,
  lobulaCount: 48,
  kenyonCount: 240,
  mbonCount: 12,
  motorCount: 4,
  seed: 777,
};

export interface RegionRange {
  region: BrainRegion;
  start: number;
  count: number;
}

export interface Edge {
  from: number;
  to: number;
  weight: number;
  plastic: boolean;
}

/** A single reward/punishment event, for the activity feed UIs. */
export interface DopamineEvent {
  t: number;
  value: number;
  label: string;
}
