/**
 * BicycleTrainerCore — the simulation/training loop, framework-free.
 *
 * Owns a population of riders, each with a FlyBrain (DEFAULT_ARCH_BICYCLE,
 * motors = [steerLeft, steerRight, pedal]). Runs fixed-dt physics ticks
 * (1/60 s) driven by an rAF accumulator, applies reward/punishment dopamine,
 * ends episodes when every rider is done and evolves the population
 * (elitism top-2 + tournament crossover + mutation).
 */

import { FlyBrain } from "@/lib/flybrain/engine";
import { DEFAULT_ARCH_BICYCLE } from "@/lib/flybrain/types";
import type { BrainSnapshot } from "@/lib/flybrain/types";
import {
  buildRoad,
  riderTransform,
  type RoadData,
} from "./road";
import {
  DT,
  EPISODE_TIMEOUT_S,
  makeBikeState,
  stepBike,
  finishRider,
  steerFromMotors,
  roadCurvature,
  type BikeState,
} from "./physics";
import { buildRetina, RETINA_SIZE } from "./retina";
import { playSound } from "@/lib/sound";

export interface TrainerEvent {
  id: number;
  kind: "fall" | "offroad" | "milestone" | "gen" | "best" | "info" | "load";
  text: string;
}

export interface GenRecord {
  gen: number;
  best: number;
  avg: number;
}

export interface Rider {
  idx: number;
  brain: FlyBrain;
  st: BikeState;
  retina: Float32Array;
  motor: Float32Array;
  /** dopamine queued for the next brain step (progress sugar) */
  pendingReward: number;
  meterFloor: number;
  milestoneFloor: number;
  /** real time (s) when the rider finished — drives the tumble animation */
  doneRealT: number;
}

const PUNISH_FALL = -0.5;
const PUNISH_OFFROAD = -0.3;
const REWARD_PER_METER = 0.03;
const MILESTONE_BONUS = 0.2;
const MILESTONE_STEP = 100;
const MUTATE_RATE = 0.15;
const MAX_STEPS_PER_FRAME = 600;

function makeRider(brain: FlyBrain, idx: number): Rider {
  return {
    idx,
    brain,
    st: makeBikeState(Math.random),
    retina: new Float32Array(RETINA_SIZE),
    motor: new Float32Array(3),
    pendingReward: 0,
    meterFloor: 0,
    milestoneFloor: 0,
    doneRealT: 0,
  };
}

export class BicycleTrainerCore {
  readonly road: RoadData = buildRoad();
  riders: Rider[] = [];
  /** brains of the training population (kept while watch-best rides a clone) */
  trainingBrains: FlyBrain[] = [];
  generation = 1;
  simTime = 0;
  /** real (wall-clock) seconds since core creation — for animations */
  realTime = 0;
  running = true;
  turbo = 1;
  watchBest = false;
  popSize = 5;
  queuedPopSize = 5;
  mutationStrength = 0.3;
  bestEverDistance = 0;
  bestBrain: FlyBrain | null = null;
  history: GenRecord[] = [];
  events: TrainerEvent[] = [];
  leaderIdx = 0;
  /** decaying camera-shake amplitude (set when a rider bites the dust) */
  shake = 0;
  private eventSeq = 1;
  private accumulator = 0;

  constructor(popSize = 5) {
    this.popSize = popSize;
    this.queuedPopSize = popSize;
    this.spawnFreshPopulation();
    this.log("info", "Dusk road ready — Generation 1 rolls out.");
  }

  // ------------------------------------------------------------------ setup

  spawnFreshPopulation() {
    this.trainingBrains = Array.from(
      { length: this.popSize },
      () => new FlyBrain(DEFAULT_ARCH_BICYCLE)
    );
    this.generation = 1;
    this.bestEverDistance = 0;
    this.bestBrain = null;
    this.history = [];
    this.watchBest = false;
    this.resetEpisode(this.trainingBrains);
  }

  resetEpisode(brains: FlyBrain[]) {
    this.simTime = 0;
    this.accumulator = 0;
    const list = this.watchBest
      ? [this.championBrain().clone()]
      : brains;
    this.riders = list.map((b, i) => makeRider(b, i));
    this.leaderIdx = 0;
  }

  /** the brain to showcase in watch-best mode */
  championBrain(): FlyBrain {
    if (this.bestBrain) return this.bestBrain;
    let best = this.riders[0]?.brain ?? this.trainingBrains[0];
    let bestS = -1;
    for (const r of this.riders) {
      if (r.st.finalS > bestS) {
        bestS = r.st.finalS;
        best = r.brain;
      }
    }
    return best;
  }

  // ------------------------------------------------------------- main loop

  /** advance the simulation by `frameDt` real seconds (rAF-driven) */
  advance(frameDt: number) {
    this.realTime += frameDt;
    if (this.shake > 0.0001) this.shake *= Math.exp(-frameDt * 5);
    if (!this.running) return;
    this.accumulator += frameDt * this.turbo;
    if (this.accumulator > MAX_STEPS_PER_FRAME * DT) {
      this.accumulator = MAX_STEPS_PER_FRAME * DT; // never spiral
    }
    let steps = Math.floor(this.accumulator / DT);
    this.accumulator -= steps * DT;
    while (steps-- > 0) this.tick();
  }

  private tick() {
    this.simTime += DT;
    let anyAlive = false;

    for (const r of this.riders) {
      const st = r.st;
      if (!st.alive) continue;
      anyAlive = true;

      buildRetina(r.retina, st, this.road);
      const motor = r.brain.step(r.retina, r.pendingReward);
      r.motor.set(motor);
      r.pendingReward = 0;

      const delta = steerFromMotors(r.motor);
      const pedal = r.motor[2];
      const res = stepBike(st, delta, pedal, DT, roadCurvature(st.s));

      if (res.fell || res.offRoad) {
        const reason = res.fell ? "fall" : "offroad";
        const punish = finishRider(st, reason, this.simTime, {
          fall: PUNISH_FALL,
          offroad: PUNISH_OFFROAD,
        });
        r.doneRealT = this.realTime;
        r.brain.step(r.retina, punish); // the shock, at the moment of failure
        if (reason === "fall") this.shake = Math.min(0.9, this.shake + 0.5);
        if (this.turbo === 1) playSound("fall", 0.25);
        this.log(
          reason,
          `Rider ${r.idx + 1} ${
            reason === "fall" ? "fell" : "left the road"
          } at ${st.finalS.toFixed(0)} m (${punish})`
        );
        continue;
      }

      // progress = sugar
      const meters = Math.floor(st.s) - r.meterFloor;
      if (meters > 0) {
        r.meterFloor += meters;
        r.pendingReward += REWARD_PER_METER * meters;
      }
      const mile = Math.floor(st.s / MILESTONE_STEP);
      if (mile > r.milestoneFloor) {
        r.milestoneFloor = mile;
        r.pendingReward += MILESTONE_BONUS;
        if (this.turbo === 1) playSound("ding", 0.5);
        this.log(
          "milestone",
          `Rider ${r.idx + 1} reached ${mile * MILESTONE_STEP} m (+${MILESTONE_BONUS})`
        );
      }

      // track the all-time best (live brain reference stays valid: brains are
      // only mutated on freshly cloned children during evolution)
      if (st.s > this.bestEverDistance) {
        this.bestEverDistance = st.s;
        this.bestBrain = r.brain;
      }
    }

    // leader = furthest alive rider
    let leadS = -1;
    for (const r of this.riders) {
      if (r.st.alive && r.st.s > leadS) {
        leadS = r.st.s;
        this.leaderIdx = r.idx;
      }
    }
    if (!anyAlive || this.simTime >= EPISODE_TIMEOUT_S) {
      this.endEpisode();
    }
  }

  // -------------------------------------------------------------- episodes

  private endEpisode() {
    const survivors: string[] = [];
    for (const r of this.riders) {
      if (r.st.alive) {
        finishRider(r.st, "timeout", this.simTime, { fall: 0, offroad: 0 });
        r.doneRealT = this.realTime;
        survivors.push(`${r.idx + 1}`);
      }
    }
    if (survivors.length > 0) {
      this.log(
        "info",
        `Rider${survivors.length > 1 ? "s" : ""} ${survivors.join(", ")} survived the full 90 s run`
      );
    }

    if (this.watchBest) {
      // exhibition ride: just roll again with the champion
      this.resetEpisode(this.trainingBrains);
      return;
    }

    const fits = this.riders.map((r) => r.st.finalS);
    const best = Math.max(...fits);
    const avg = fits.reduce((a, b) => a + b, 0) / fits.length;
    this.history.push({ gen: this.generation, best, avg });
    playSound("gen");
    this.log(
      "gen",
      `Generation ${this.generation} done — best ${best.toFixed(0)} m · avg ${avg.toFixed(0)} m`
    );
    if (best >= this.bestEverDistance) {
      // ensure the champion snapshot matches the final distance
      this.bestEverDistance = best;
      const bi = fits.indexOf(best);
      this.bestBrain = this.riders[bi].brain;
      playSound("milestone");
      this.log("best", `New champion: ${best.toFixed(0)} m`);
    }
    this.autosave();

    this.evolve();
    this.generation += 1;
    if (this.queuedPopSize !== this.popSize) {
      this.popSize = this.queuedPopSize;
      this.log("info", `Population size → ${this.popSize}`);
    }
    this.resetEpisode(this.trainingBrains);
  }

  private evolve() {
    const sorted = [...this.riders].sort((a, b) => b.st.finalS - a.st.finalS);
    const next: FlyBrain[] = [sorted[0].brain.clone()];
    if (this.popSize > 1) next.push(sorted[1].brain.clone());
    const tournament = (): FlyBrain => {
      let best: Rider | null = null;
      for (let i = 0; i < 3; i++) {
        const cand = sorted[Math.floor(Math.random() * sorted.length)];
        if (!best || cand.st.finalS > best.st.finalS) best = cand;
      }
      return best!.brain;
    };
    while (next.length < this.popSize) {
      const child = FlyBrain.crossover(tournament(), tournament());
      child.mutate(MUTATE_RATE, this.mutationStrength);
      next.push(child);
    }
    this.trainingBrains = next;
  }

  // -------------------------------------------------------------- controls

  setRunning(run: boolean) {
    this.running = run;
  }

  setTurbo(t: number) {
    this.turbo = t;
  }

  setQueuedPopulation(n: number) {
    this.queuedPopSize = n;
    if (this.watchBest) this.popSize = n;
  }

  setMutationStrength(s: number) {
    this.mutationStrength = s;
  }

  setWatchBest(on: boolean) {
    if (on === this.watchBest) return;
    this.watchBest = on;
    if (on) {
      this.log("info", "Watch-best mode — riding the champion");
    } else {
      this.log("info", "Back to population training");
    }
    this.resetEpisode(this.trainingBrains);
  }

  reset() {
    this.spawnFreshPopulation();
    this.log("info", "Fresh start — new random brains, Generation 1");
  }

  // ------------------------------------------------------- load / persist

  adoptSnapshot(snap: BrainSnapshot) {
    const brain = FlyBrain.fromJSON(snap);
    this.trainingBrains = Array.from({ length: this.popSize }, () => brain.clone());
    this.generation = snap.generation;
    this.bestEverDistance = snap.score;
    this.bestBrain = brain;
    this.history = [];
    this.watchBest = false;
    this.resetEpisode(this.trainingBrains);
    this.log(
      "load",
      `Adopted "${snap.name}" (gen ${snap.generation}, ${snap.score.toFixed(0)} m) — population seeded with clones`
    );
  }

  private autosave() {
    try {
      if (!this.bestBrain) return;
      const payload = {
        generation: this.generation,
        bestDistance: this.bestEverDistance,
        history: this.history,
        snapshot: this.bestBrain.toJSON(
          "bicycle",
          "session",
          this.generation,
          this.bestEverDistance
        ),
      };
      localStorage.setItem(
        "eff-bicycle-session-v1",
        JSON.stringify(payload)
      );
    } catch {
      /* storage unavailable — fine */
    }
  }

  static loadSession(): {
    generation: number;
    bestDistance: number;
    history: GenRecord[];
    snapshot: BrainSnapshot;
  } | null {
    try {
      const raw = localStorage.getItem("eff-bicycle-session-v1");
      if (!raw) return null;
      const parsed = JSON.parse(raw);
      if (!parsed?.snapshot?.arch) return null;
      return parsed;
    } catch {
      return null;
    }
  }

  log(kind: TrainerEvent["kind"], text: string) {
    this.events.push({ id: this.eventSeq++, kind, text });
    if (this.events.length > 60) this.events.shift();
  }

  // ------------------------------------------------------------- readouts

  get leader(): Rider | null {
    return this.riders[this.leaderIdx] ?? this.riders[0] ?? null;
  }

  aliveCount(): number {
    return this.riders.reduce((n, r) => n + (r.st.alive ? 1 : 0), 0);
  }

  /** immutable snapshot for React HUD updates (polled a few times/sec) */
  hudSnapshot() {
    const lead = this.leader;
    return {
      gen: this.generation,
      alive: this.aliveCount(),
      total: this.riders.length,
      bestEver: this.bestEverDistance,
      simTime: this.simTime,
      leaderIdx: this.leaderIdx,
      leaderS: lead?.st.s ?? 0,
      leaderV: lead?.st.v ?? 0,
      leaderPhi: lead?.st.phi ?? 0,
      leaderDop: lead?.brain.getDopamine() ?? 0,
      watching: this.watchBest,
      running: this.running,
      turbo: this.turbo,
      popSize: this.queuedPopSize,
      mutationStrength: this.mutationStrength,
      events: this.events.slice(-8),
      history: this.history.slice(),
      hasBest: this.bestBrain !== null && this.bestEverDistance > 0,
    };
  }

  /** world transform of rider i (for the 3D rig) */
  riderWorld(i: number): { x: number; z: number; heading: number; lean: number; y: number } {
    const r = this.riders[i];
    if (!r) return { x: 0, z: 0, heading: 0, lean: 0, y: 0 };
    const t = riderTransform(this.road, r.st.s, r.st.u, r.st.psi);
    return { x: t.x, z: t.z, heading: t.heading, lean: r.st.phi, y: 0 };
  }
}

export type HudSnapshot = ReturnType<BicycleTrainerCore["hudSnapshot"]>;
