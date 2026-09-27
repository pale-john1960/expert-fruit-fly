/**
 * Road model for the bicycle trainer — shared by physics, retina and rendering.
 *
 * The centerline is defined by its curvature as a function of arc length s:
 *   κ(s) = 0.012·sin(s·0.045) + 0.008·sin(s·0.013 + 2.1) + 0.006·sin(s·0.11 + 4)
 * and integrated numerically (heading θ, position) at 1 m resolution.
 *
 * World frame (three.js, y-up):
 *   tangent      t̂(s) = ( sin θ, cos θ )   (x, z)
 *   left-normal  n̂(s) = ( cos θ, −sin θ )  — "left" as seen when traveling forward
 *   The rider's RIGHT side is −n̂ = (−cos θ, sin θ).
 *   A rider at lateral offset u (positive = right of centerline) sits at
 *   P(s) + u·(−cos θ, sin θ), and a heading offset ψ (positive = pointing
 *   right of the road tangent) corresponds to world heading angle θ − ψ.
 */

export const ROAD_POINTS = 2401; // 0..2400 m at 1 m spacing
export const ROAD_LENGTH_M = ROAD_POINTS - 1;
export const ROAD_HALF_WIDTH = 2.5; // metres, road is 5 m wide
export const POST_SPACING_M = 15; // roadside glow posts
export const POST_OFFSET_M = 2.65; // posts just outside the road edge

export interface RoadData {
  /** flat [x0, z0, x1, z1, ...] centerline positions, index = s in metres */
  px: Float32Array;
  pz: Float32Array;
  /** heading θ(s) per metre */
  heading: Float32Array;
  /** analytic curvature κ(s) */
  curvature: (s: number) => number;
  /** interpolated centerline position + heading at arc length s */
  sample: (s: number) => { x: number; z: number; theta: number };
}

export function roadCurvature(s: number): number {
  return (
    0.012 * Math.sin(s * 0.045) +
    0.008 * Math.sin(s * 0.013 + 2.1) +
    0.006 * Math.sin(s * 0.11 + 4)
  );
}

export function buildRoad(): RoadData {
  const px = new Float32Array(ROAD_POINTS);
  const pz = new Float32Array(ROAD_POINTS);
  const heading = new Float32Array(ROAD_POINTS);
  const ds = 1;
  let theta = 0;
  let x = 0;
  let z = 0;
  for (let i = 0; i < ROAD_POINTS; i++) {
    px[i] = x;
    pz[i] = z;
    heading[i] = theta;
    const s = i * ds;
    // θ integrates −κ so that κ > 0 reads as a RIGHT-hand bend in the
    // three.js world (tangent (sinθ, cosθ), chase cam behind the bike) —
    // this keeps the physics sign conventions of the spec exact:
    // ψ' = (v/b)·δ − v·κ, with ψ > 0 = pointing right, u > 0 = offset right.
    theta -= roadCurvature(s + ds * 0.5) * ds;
    x += Math.sin(theta) * ds;
    z += Math.cos(theta) * ds;
  }

  const sample = (s: number) => {
    const sc = Math.min(Math.max(s, 0), ROAD_LENGTH_M - 0.001);
    const i = Math.floor(sc);
    const f = sc - i;
    const j = Math.min(i + 1, ROAD_POINTS - 1);
    return {
      x: px[i] + (px[j] - px[i]) * f,
      z: pz[i] + (pz[j] - pz[i]) * f,
      theta: heading[i] + (heading[j] - heading[i]) * f,
    };
  };

  return { px, pz, heading, curvature: roadCurvature, sample };
}

/**
 * World transform of a rider given (s, u, ψ).
 * Returns position + heading angle α such that an object with rotation.y = α
 * and forward = local +Z faces the rider's travel direction.
 */
export function riderTransform(
  road: RoadData,
  s: number,
  u: number,
  psi: number
): { x: number; z: number; heading: number } {
  const { x, z, theta } = road.sample(s);
  return {
    x: x - u * Math.cos(theta),
    z: z + u * Math.sin(theta),
    heading: theta - psi,
  };
}
