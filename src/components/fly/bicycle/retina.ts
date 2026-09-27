/**
 * The fly's retina — a 24×9 "camera" looking down the road.
 *
 * Each row r looks at a distance d = 28 − 3·r metres ahead (bottom row is
 * near, top row is far). For every row we project where the road centreline
 * (and its edges + marker posts) falls on the retina:
 *
 *   x = −u − ψ·d + ½·κ(s+d)·d²    (metres; + = to the fly's RIGHT)
 *   col = 12 + round(x·1.1 − φ·2.5) (lean shifts the whole view)
 *
 * This single construction encodes lateral offset, heading error, upcoming
 * road curvature AND the current lean — everything a steering reflex needs.
 * (κ > 0 is a right-hand bend: the road ahead swings right across the rows.)
 */

import { roadCurvature } from "./road";
import { POST_SPACING_M, POST_OFFSET_M } from "./road";
import type { BikeState } from "./physics";
import type { RoadData } from "./road";

export const RETINA_COLS = 24;
export const RETINA_ROWS = 9;
export const RETINA_SIZE = RETINA_COLS * RETINA_ROWS;

const BG = 0.05; // dusk grass
const ROAD = 0.9; // bright road stripe
const EDGE = 0.5; // road edge lines
const POST = 1.0; // glowing marker posts

/** viewing distance for retina row r (0 = far, 8 = near) */
export function rowDistance(r: number): number {
  return 28 - 3 * r;
}

/** Build one rider's retina (216 floats, row-major, row 0 = top). */
export function buildRetina(
  out: Float32Array,
  st: BikeState,
  _road: RoadData
): void {
  out.fill(BG);
  const { u, psi, phi, s } = st;

  for (let r = 0; r < RETINA_ROWS; r++) {
    const d = rowDistance(r);
    const sd = s + d;
    // lateral offset of the road centre at distance d (+ = fly's right)
    const xc = -u - psi * d + 0.5 * roadCurvature(sd) * d * d;
    const colC = 12 + Math.round(xc * 1.1 - phi * 2.5);

    // road stripe + edge lines
    for (let col = 0; col < RETINA_COLS; col++) {
      const dist = Math.abs(col - colC);
      if (dist <= 1.2) {
        out[r * RETINA_COLS + col] = ROAD;
      } else if (Math.abs(dist - 2.2) <= 0.6) {
        out[r * RETINA_COLS + col] = EDGE;
      }
    }
  }

  // roadside glow posts every 15 m — motion parallax beacons
  const firstPost = Math.ceil((s + 3.5) / POST_SPACING_M) * POST_SPACING_M;
  for (let sp = firstPost; sp <= s + 28; sp += POST_SPACING_M) {
    const d = sp - s;
    let row = Math.round((28 - d) / 3);
    if (row < 0) row = 0;
    if (row > RETINA_ROWS - 1) row = RETINA_ROWS - 1;
    const xc = -u - psi * d + 0.5 * roadCurvature(s + d) * d * d;
    for (const side of [POST_OFFSET_M, -POST_OFFSET_M]) {
      const col = 12 + Math.round((xc + side) * 1.1 - phi * 2.5);
      if (col >= 0 && col < RETINA_COLS) {
        out[row * RETINA_COLS + col] = POST;
      }
    }
  }
}

/** Map retina values (0..1) to dusk colours for the mini canvas. */
export function retinaColor(v: number): [number, number, number] {
  // background: dark plum grass → road: warm asphalt glow → posts: hot amber
  if (v <= BG + 0.01) return [26, 13, 26];
  if (v >= POST - 0.01) return [255, 200, 120];
  if (v >= ROAD - 0.01) return [222, 158, 116];
  return [128, 82, 84];
}
