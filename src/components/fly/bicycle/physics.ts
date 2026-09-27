/**
 * Simplified learnable bicycle dynamics (fixed dt = 1/60).
 *
 * State (per rider):
 *   s  — distance along the road centreline (m)
 *   u  — lateral offset from centreline (m, + = right of the road)
 *   ψ  — heading relative to the road tangent (rad, + = pointing right)
 *   v  — speed (m/s)
 *   φ  — lean / roll angle (rad, + = leaning right)
 *   ω  — roll rate (rad/s)
 *
 * Controls (from brain motor rates — the engine's smoothed rates live in
 * 0..~0.16, measured empirically, so gains map that range onto the intended
 * physical ranges: steer up to ±0.5 rad, cruise ~7–9 m/s):
 *   δ    = (rate[steerRight] − rate[steerLeft]) × 3.0, clamp ±0.5
 *   pedal — drive force factor = rate[2] × 32
 *
 * Sign conventions match a real bicycle: steering INTO the fall (φ>0, δ>0)
 * produces a righting torque — the classic counter-steering balance reflex.
 */

import { roadCurvature } from "./road";

export const DT = 1 / 60;
export const EPISODE_TIMEOUT_S = 90;

// geometry / physics constants
const WHEELBASE = 1.1; // b (m) — also the lever arm for steering-induced roll
const COM_HEIGHT = 1.05; // h (m) — centre of mass height above ground
const G = 9.81;
const G_OVER_H = G / COM_HEIGHT; // inverted-pendulum gravity term
const V2_OVER_BH = 1 / (WHEELBASE * COM_HEIGHT); // steer → roll coupling (× v²)
const ROLL_DAMPING = 1.2;
const DRIVE = 32; // pedal force factor (motor rates are 0..~0.16)
const STEER_GAIN = 3; // motor asymmetry (±0.16) → steer angle (±0.5)
const ROLL_DRAG = 0.35; // linear rolling resistance
const AERO_DRAG = 0.02; // quadratic drag
export const V_MAX = 14;

// episode-end conditions
export const FALL_PHI = 0.62; // |φ| beyond this → fallen
export const OFF_ROAD_U = 2.3; // |u| beyond this → off the road

export type DoneReason = null | "fall" | "offroad" | "timeout" | "finished";

export interface BikeState {
  s: number;
  u: number;
  psi: number;
  v: number;
  phi: number;
  omega: number;
  alive: boolean;
  doneReason: DoneReason;
  /** sim time (s) when the rider finished */
  doneAt: number;
  /** direction the rider fell (sign of φ at fall) for the tumble animation */
  fallSign: number;
  /** distance travelled when finished */
  finalS: number;
}

export function makeBikeState(rand: () => number): BikeState {
  // tiny random perturbation so every rider's episode is a little different
  return {
    s: 0,
    u: (rand() - 0.5) * 0.2,
    psi: (rand() - 0.5) * 0.1,
    v: 2.8 + rand() * 0.8, // a firm push-off so steering has real authority
    phi: (rand() - 0.5) * 0.1,
    omega: 0,
    alive: true,
    doneReason: null,
    doneAt: 0,
    fallSign: 0,
    finalS: 0,
  };
}

export interface StepResult {
  fell: boolean;
  offRoad: boolean;
}

/**
 * Advance one physics tick. `kappa` is the road curvature at the rider's s.
 * Returns terminal events (checked by the caller, which applies punishment).
 */
export function stepBike(
  st: BikeState,
  delta: number,
  pedal: number,
  dt: number,
  kappa: number
): StepResult {
  // --- longitudinal ---
  st.v += (pedal * DRIVE - ROLL_DRAG * st.v - AERO_DRAG * st.v * st.v) * dt;
  if (st.v < 0) st.v = 0;
  if (st.v > V_MAX) st.v = V_MAX;

  // --- roll dynamics (inverted pendulum + steer righting + damping) ---
  const omegaDot =
    G_OVER_H * Math.sin(st.phi) -
    V2_OVER_BH * st.v * st.v * delta -
    ROLL_DAMPING * st.omega;
  st.omega += omegaDot * dt;
  st.phi += st.omega * dt;

  // --- road-relative position ---
  // steering rotates the heading relative to the road; road curvature pulls
  // it back (κ>0 bends the road toward the rider's left, so ψ drifts −).
  st.psi += (st.v / WHEELBASE) * delta * dt - st.v * kappa * dt;
  st.u += st.v * Math.sin(st.psi) * dt;
  st.s += st.v * Math.cos(st.psi) * dt;

  const fell = Math.abs(st.phi) > FALL_PHI;
  const offRoad = Math.abs(st.u) > OFF_ROAD_U;
  return { fell, offRoad };
}

/** Mark a rider as done. Returns the punishment dopamine for the event. */
export function finishRider(
  st: BikeState,
  reason: Exclude<DoneReason, null>,
  simTime: number,
  punishes: { fall: number; offroad: number }
): number {
  st.alive = false;
  st.doneReason = reason;
  st.doneAt = simTime;
  st.finalS = st.s;
  st.fallSign = Math.sign(st.phi) || 1;
  return reason === "fall" ? punishes.fall : reason === "offroad" ? punishes.offroad : 0;
}

/** Steering angle from brain motor rates (motors: [steerLeft, steerRight, pedal]).
 *  `gain` scales the handlebar sensitivity — the bicycle "personality":
 *  > 1 = steadier geometry (stronger counter-steer authority), < 1 = twitchier. */
export function steerFromMotors(motor: Float32Array, gain = 1): number {
  const d = (motor[1] - motor[0]) * STEER_GAIN * gain;
  return d > 0.5 ? 0.5 : d < -0.5 ? -0.5 : d;
}

/** Road curvature at s (re-exported for the trainer loop convenience). */
export { roadCurvature };
