/**
 * BicycleTrainerCore — the simulation/training loop, framework-free.
 *
 * Owns a population of riders, each with a FlyBrain (DEFAULT_ARCH_BICYCLE,
 * motors = [steerLeft, steerRight, pedal]). Runs fixed-dt physics ticks
 * (1/60 s) driven by an rAF accumulator, applies reward/punishment dopamine,
 * ends episodes when every rider is done and evolves the population
 * (elitism top-2 + tournament crossover + mutation).
 *
 * Also owns the "You vs the fly" challenge: the training population is
 * PARKED (not stopped) while a HUMAN rider (keyboard steer, automatic cruise
 * pedal) races the champion brain clone on the same road. The champion keeps
 * receiving its usual dopamine (distance sugar + fall shock) during
 * challenges, and its trained weights are folded back into the trainer's
 * best brain when the challenge ends, so rematches compound.
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
  type StepResult,
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
  /** "You vs the fly" challenge marker (undefined for training riders) */
  tag?: RiderTag;
}

export type RiderTag = "you" | "fly";

export interface ChallengeResult {
  winner: "you" | "fly" | "tie";
  youS: number;
  flyS: number;
}

export interface ChallengeState {
  /** HUMAN rider — keyboard-steered, dummy brain (never stepped) */
  human: Rider;
  /** champion clone — driven exactly like a training rider (keeps learning) */
  fly: Rider;
  /** held-key state, written by window listeners (refs, never React state) */
  keys: { left: boolean; right: boolean };
  /** ramped human steer delta (rad, ±HUMAN_STEER_MAX) */
  humanSteer: number;
  /** challenge-local fixed-dt accumulator (real time only — a human rides) */
  acc: number;
  simT: number;
  /** sim time of the first rider's finish — starts the 30 s survivor cap */
  firstDeathT: number | null;
  ended: boolean;
  result: ChallengeResult | null;
  /** the parked training population (restored on endChallenge) */
  parkedRiders: Rider[];
  parkedLeaderIdx: number;
}

const PUNISH_FALL = -0.5;
const PUNISH_OFFROAD = -0.3;
const REWARD_PER_METER = 0.03;
const MILESTONE_BONUS = 0.2;
const MILESTONE_STEP = 100;
const MUTATE_RATE = 0.15;
const MAX_STEPS_PER_FRAME = 600;

// --- "You vs the fly" challenge -------------------------------------------
const CHALLENGE_SURVIVOR_CAP_S = 30; // survivor's grace after the first fall
const CHALLENGE_TOTAL_CAP_S = 90; // hard cap (same as a training episode)
const CHALLENGE_LANE_M = 0.6; // side-by-side lane offset (1.2 m apart)
const HUMAN_CRUISE_PEDAL = 0.11; // fixed pedal rate → ~7 m/s cruise
const HUMAN_STEER_MAX = 0.5; // rad — same clamp as steerFromMotors
const HUMAN_STEER_RAMP_S = 0.15; // hold-to-full-lock ramp time (s)
const CHALLENGE_TIE_M = 0.5; // distances within this → dead heat

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

/** A challenge rider: same standing start for both (only the lane differs). */
function makeChallengeRider(
  brain: FlyBrain,
  idx: number,
  tag: RiderTag,
  laneU: number,
  phi0: number,
  v0: number
): Rider {
  const r = makeRider(brain, idx);
  r.tag = tag;
  r.st.u = laneU;
  r.st.psi = 0;
  r.st.phi = phi0;
  r.st.omega = 0;
  r.st.v = v0;
  return r;
}

function createChallenge(core: BicycleTrainerCore): ChallengeState {
  // champion clone — it keeps learning during challenges (lifetime dopamine)
  const champion = (core.bestBrain ?? core.championBrain()).clone();
  // one shared random draw → both riders get identical push-off conditions
  const phi0 = (Math.random() - 0.5) * 0.08;
  const v0 = 3.0 + Math.random() * 0.6;
  return {
    human: makeChallengeRider(
      new FlyBrain(DEFAULT_ARCH_BICYCLE), // dummy — the human has no brain
      0,
      "you",
      CHALLENGE_LANE_M,
      phi0,
      v0
    ),
    fly: makeChallengeRider(champion, 1, "fly", -CHALLENGE_LANE_M, phi0, v0),
    keys: { left: false, right: false },
    humanSteer: 0,
    acc: 0,
    simT: 0,
    firstDeathT: null,
    ended: false,
    result: null,
    parkedRiders: [],
    parkedLeaderIdx: 0,
  };
}

/**
 * Human keyboard steering — additive helper; stepBike's validated dynamics
 * are untouched. While a key is held the target delta ramps to
 * ±HUMAN_STEER_MAX over ~0.15 s and holds; releasing returns it to 0 at the
 * same rate (analog-feeling steer, not instant full lock).
 */
export function humanSteer(
  current: number,
  keys: { left: boolean; right: boolean },
  dt: number
): number {
  const target =
    ((keys.right ? 1 : 0) - (keys.left ? 1 : 0)) * HUMAN_STEER_MAX;
  const rate = (HUMAN_STEER_MAX / HUMAN_STEER_RAMP_S) * dt;
  const d = target - current;
  if (d > rate) return current + rate;
  if (d < -rate) return current - rate;
  return target;
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
  /** bicycle "personality" — scales handlebar sensitivity (see steerFromMotors) */
  preset: "steady" | "standard" | "frisky" = "standard";
  steerGain = 1;
  /** sugar per meter ridden — the Steady preset is richer, Frisky leaner */
  rewardPerMeter = REWARD_PER_METER;
  bestEverDistance = 0;
  bestBrain: FlyBrain | null = null;
  /** "You vs the fly" challenge — null while normal training runs */
  challenge: ChallengeState | null = null;
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
    const ch = this.challenge;
    if (ch) {
      // challenge mode: population training is PARKED; the race runs at
      // real-time fixed dt from the same rAF accumulator pattern (no turbo —
      // a human is riding)
      if (ch.ended) return;
      ch.acc += frameDt;
      if (ch.acc > MAX_STEPS_PER_FRAME * DT) {
        ch.acc = MAX_STEPS_PER_FRAME * DT; // never spiral
      }
      let steps = Math.floor(ch.acc / DT);
      ch.acc -= steps * DT;
      while (steps-- > 0) this.stepChallenge();
      return;
    }
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

      const delta = steerFromMotors(r.motor, this.steerGain);
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
        r.pendingReward += this.rewardPerMeter * meters;
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

  // ----------------------------------------------------- "You vs the fly"

  /** Enter (or re-enter — Rematch) the challenge. The training population
   *  is parked and restored on endChallenge(); the champion clone keeps
   *  learning from its duel dopamine. */
  startChallenge() {
    const prev = this.challenge;
    const parked = prev ? prev.parkedRiders : this.riders;
    const parkedLeaderIdx = prev ? prev.parkedLeaderIdx : this.leaderIdx;
    const ch = createChallenge(this);
    ch.parkedRiders = parked;
    ch.parkedLeaderIdx = parkedLeaderIdx;
    this.challenge = ch;
    this.riders = [ch.human, ch.fly];
    this.leaderIdx = 0;
    this.log(
      "info",
      prev
        ? "Rematch — the champion keeps what it learned"
        : "Challenge — you vs the champion. ← / → to balance!"
    );
  }

  /** Leave the challenge: fold the champion's lifetime learning back into
   *  the trainer's best brain (even on early exit) and restore the parked
   *  training population — same generation, same world positions. */
  endChallenge() {
    const ch = this.challenge;
    if (!ch) return;
    this.bestBrain = ch.fly.brain.clone(); // challenges train the champion
    this.riders = ch.parkedRiders;
    this.leaderIdx = ch.parkedLeaderIdx;
    this.challenge = null;
    this.log("info", "Back to population training");
  }

  private stepChallenge() {
    const ch = this.challenge!;
    ch.simT += DT;
    const human = ch.human;
    const fly = ch.fly;

    // --- HUMAN: analog steer from held keys, automatic cruise pedal ---
    if (human.st.alive) {
      ch.humanSteer = humanSteer(ch.humanSteer, ch.keys, DT);
      const res = stepBike(
        human.st,
        ch.humanSteer,
        HUMAN_CRUISE_PEDAL,
        DT,
        roadCurvature(human.st.s)
      );
      if (res.fell || res.offRoad) {
        this.finishChallengeRider(human, res, ch, "You");
      }
    }

    // --- FLY: the champion brain, driven exactly like a training rider ---
    if (fly.st.alive) {
      buildRetina(fly.retina, fly.st, this.road);
      const motor = fly.brain.step(fly.retina, fly.pendingReward);
      fly.motor.set(motor);
      fly.pendingReward = 0;
      const delta = steerFromMotors(fly.motor, this.steerGain);
      const res = stepBike(
        fly.st,
        delta,
        fly.motor[2],
        DT,
        roadCurvature(fly.st.s)
      );
      if (res.fell || res.offRoad) {
        this.finishChallengeRider(fly, res, ch, "The champion");
      } else {
        // progress = sugar (challenges train the champion)
        const meters = Math.floor(fly.st.s) - fly.meterFloor;
        if (meters > 0) {
          fly.meterFloor += meters;
          fly.pendingReward += this.rewardPerMeter * meters;
        }
      }
    }

    // leader = further alive rider (drives the chase camera)
    let leadS = -1;
    for (const r of this.riders) {
      if (r.st.alive && r.st.s > leadS) {
        leadS = r.st.s;
        this.leaderIdx = r.idx;
      }
    }

    // end conditions: both done, the survivor's 30 s cap after the first
    // finish, or the hard 90 s cap (same as a training episode)
    const bothDone = !human.st.alive && !fly.st.alive;
    const survivorCap =
      ch.firstDeathT !== null &&
      ch.simT - ch.firstDeathT >= CHALLENGE_SURVIVOR_CAP_S;
    const totalCap = ch.simT >= CHALLENGE_TOTAL_CAP_S;
    if (bothDone || survivorCap || totalCap) {
      for (const r of [human, fly]) {
        if (r.st.alive) {
          finishRider(r.st, "timeout", ch.simT, { fall: 0, offroad: 0 });
          r.doneRealT = this.realTime;
        }
      }
      this.finishChallenge();
    }
  }

  private finishChallengeRider(
    r: Rider,
    res: StepResult,
    ch: ChallengeState,
    who: string
  ) {
    const reason: "fall" | "offroad" = res.fell ? "fall" : "offroad";
    const punish = finishRider(r.st, reason, ch.simT, {
      fall: PUNISH_FALL,
      offroad: PUNISH_OFFROAD,
    });
    r.doneRealT = this.realTime;
    if (r.tag === "fly") {
      r.brain.step(r.retina, punish); // the shock, at the moment of failure
    }
    if (reason === "fall") this.shake = Math.min(0.9, this.shake + 0.5);
    playSound("fall", 0.3);
    if (ch.firstDeathT === null) ch.firstDeathT = ch.simT;
    this.log(
      reason,
      `${who} ${reason === "fall" ? "fell" : "left the road"} at ${r.st.finalS.toFixed(0)} m`
    );
  }

  private finishChallenge() {
    const ch = this.challenge!;
    if (ch.result) return;
    const youS = ch.human.st.finalS;
    const flyS = ch.fly.st.finalS;
    const winner: ChallengeResult["winner"] =
      Math.abs(youS - flyS) < CHALLENGE_TIE_M
        ? "tie"
        : youS > flyS
          ? "you"
          : "fly";
    ch.result = { winner, youS, flyS };
    ch.ended = true;
    this.log(
      "info",
      `Challenge over — you ${youS.toFixed(0)} m vs the fly ${flyS.toFixed(0)} m`
    );
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

  /** Apply a bicycle personality preset — steering authority × sugar richness. */
  setPreset(p: "steady" | "standard" | "frisky") {
    if (p === this.preset) return;
    this.preset = p;
    if (p === "steady") {
      this.steerGain = 1.25;
      this.rewardPerMeter = 0.045;
      this.log("info", "Bike preset: Steady — forgiving geometry, richer sugar");
    } else if (p === "frisky") {
      this.steerGain = 0.8;
      this.rewardPerMeter = 0.022;
      this.log("info", "Bike preset: Frisky — twitchy handling, leaner sugar");
    } else {
      this.steerGain = 1;
      this.rewardPerMeter = REWARD_PER_METER;
      this.log("info", "Bike preset: Standard — the validated default");
    }
  }

  setWatchBest(on: boolean) {
    if (this.challenge) return; // riders are the challenge pair right now
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
    if (this.challenge) return; // exit the challenge first
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
