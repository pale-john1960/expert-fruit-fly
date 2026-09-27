"use client";

/**
 * The 3D dusk world — React Three Fiber scene for the bicycle trainer.
 *
 * Warm plum/rose/amber palette (no blue dominance): gradient sky shader
 * with a low sun disc + faint stars, rolling low-poly hills, stylized
 * trees and rocks along a 2.4 km road ribbon with glowing marker posts,
 * drifting fireflies, a procedural low-poly bicycle with a fly rider,
 * ghosts of the rest of the population, and a smooth chase camera.
 */

import { useMemo, useRef } from "react";
import { useFrame, useThree } from "@react-three/fiber";
import * as THREE from "three";
import { mulberry32 } from "@/lib/flybrain/rng";
import {
  ROAD_POINTS,
  ROAD_HALF_WIDTH,
  POST_SPACING_M,
  POST_OFFSET_M,
  type RoadData,
} from "./road";
import type { BicycleTrainerCore } from "./trainer";
import type { RiderTag } from "./trainer";
import { retinaColor, RETINA_COLS, RETINA_ROWS } from "./retina";

// ---------------------------------------------------------------- palette
const C = {
  zenith: "#150a1e",
  midSky: "#6b2545",
  horizon: "#c25a3c",
  sun: "#ffd9a8",
  fog: "#2b1220",
  ground: "#221319",
  asphalt: "#241a20",
  dash: "#f5a96b",
  edge: "#8a4f43",
  post: "#ffc27a",
  hills: ["#4a2440", "#3f3a22", "#54284a", "#46402a", "#3a2233"],
  farHills: "#351b30",
  trunk: "#4a2c22",
  canopies: ["#33421f", "#472c42", "#3d3527"],
  rock: "#4e3a44",
  firefly: "#ffcf7a",
  frame: "#d9a066",
  tire: "#1c1418",
  flyBody: "#2b2026",
  eye: "#ff3b30",
  rim: "#ff7ab8",
};

// ------------------------------------------------------------------- sky
const SKY_VERT = /* glsl */ `
  varying vec3 vDir;
  void main() {
    vDir = position;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;
const SKY_FRAG = /* glsl */ `
  varying vec3 vDir;
  uniform vec3 zenithColor;
  uniform vec3 midColor;
  uniform vec3 horizonColor;
  uniform vec3 sunColor;
  uniform vec3 sunDir;
  void main() {
    vec3 d = normalize(vDir);
    float h = clamp(d.y, -0.08, 1.0);
    vec3 col = mix(horizonColor, midColor, smoothstep(-0.02, 0.16, h));
    col = mix(col, zenithColor, smoothstep(0.10, 0.52, h));
    vec3 s = normalize(sunDir);
    float sunDot = max(dot(d, s), 0.0);
    float disc = pow(sunDot, 900.0);
    float glow = pow(sunDot, 10.0);
    float haze = pow(sunDot, 2.5);
    col += sunColor * (disc * 1.35 + glow * 0.45 + haze * 0.12);
    // faint early stars in the upper sky
    vec3 cell = floor(d * 230.0);
    float starHash = fract(sin(dot(cell, vec3(12.9898, 78.233, 37.719))) * 43758.5453);
    float star = smoothstep(0.9975, 1.0, starHash) * smoothstep(0.28, 0.65, d.y);
    col += vec3(1.0, 0.92, 0.82) * star * 0.55;
    gl_FragColor = vec4(col, 1.0);
  }
`;

const SUN_DIR = new THREE.Vector3(0.32, 0.1, 0.94).normalize();

function DuskSky() {
  const mat = useMemo(
    () =>
      new THREE.ShaderMaterial({
        vertexShader: SKY_VERT,
        fragmentShader: SKY_FRAG,
        side: THREE.BackSide,
        depthWrite: false,
        uniforms: {
          zenithColor: { value: new THREE.Color(C.zenith) },
          midColor: { value: new THREE.Color(C.midSky) },
          horizonColor: { value: new THREE.Color(C.horizon) },
          sunColor: { value: new THREE.Color(C.sun) },
          sunDir: { value: SUN_DIR },
        },
      }),
    []
  );
  return (
    <mesh material={mat} renderOrder={-10} frustumCulled={false}>
      <sphereGeometry args={[950, 32, 20]} />
    </mesh>
  );
}

// ----------------------------------------------------------------- clouds
function DuskClouds({ road }: { road: RoadData }) {
  const clouds = useMemo(() => {
    const rand = mulberry32(77123);
    return Array.from({ length: 9 }, (_, i) => {
      const s = 80 + rand() * 2100;
      const { x, z, theta } = road.sample(s);
      const lat = (rand() - 0.5) * 340;
      return {
        key: i,
        pos: [
          x - Math.sin(theta) * lat,
          55 + rand() * 70,
          z + Math.cos(theta) * lat,
        ] as [number, number, number],
        w: 90 + rand() * 160,
        d: 26 + rand() * 40,
        color: rand() < 0.5 ? "#c76a4f" : "#8f3d5c",
        opacity: 0.05 + rand() * 0.08,
        rot: rand() * Math.PI,
      };
    });
  }, [road]);
  return (
    <group>
      {clouds.map((c) => (
        <mesh key={c.key} position={c.pos} rotation={[-Math.PI / 2, 0, c.rot]}>
          <planeGeometry args={[c.w, c.d]} />
          <meshBasicMaterial
            color={c.color}
            transparent
            opacity={c.opacity}
            depthWrite={false}
            side={THREE.DoubleSide}
          />
        </mesh>
      ))}
    </group>
  );
}

// ------------------------------------------------------------------ hills
function Hills({ road }: { road: RoadData }) {
  // built imperatively (instanced meshes + matrices) and mounted via
  // <primitive> — plain three.js code, deterministic placement
  const group = useMemo(() => {
    const rand = mulberry32(20260207);
    const m = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const col = new THREE.Color();

    const nearMesh = new THREE.InstancedMesh(
      new THREE.SphereGeometry(1, 9, 6),
      new THREE.MeshStandardMaterial({ flatShading: true, roughness: 1, metalness: 0 }),
      220
    );
    let n = 0;
    // rolling hills every ~26 m on either side of the road
    for (let s = 14; s < 2380; s += 24 + rand() * 16) {
      for (const side of [-1, 1]) {
        if (rand() < 0.35 || n >= 220) continue;
        const { x, z, theta } = road.sample(s);
        const lat = side * (13 + rand() * 65);
        const r = 5 + rand() * 20;
        const h = r * (0.28 + rand() * 0.3);
        m.compose(
          new THREE.Vector3(x - Math.sin(theta) * lat, h * 0.18, z + Math.cos(theta) * lat),
          q,
          new THREE.Vector3(r, h, r * (0.8 + rand() * 0.5))
        );
        nearMesh.setMatrixAt(n, m);
        nearMesh.setColorAt(n, col.set(C.hills[Math.floor(rand() * C.hills.length)]));
        n++;
      }
    }
    nearMesh.count = n;
    nearMesh.instanceMatrix.needsUpdate = true;
    if (nearMesh.instanceColor) nearMesh.instanceColor.needsUpdate = true;

    // distant ridge silhouettes
    const farMesh = new THREE.InstancedMesh(
      new THREE.SphereGeometry(1, 8, 5),
      new THREE.MeshStandardMaterial({ flatShading: true, roughness: 1, metalness: 0 }),
      14
    );
    for (let i = 0; i < 14; i++) {
      const s = 100 + rand() * 2200;
      const { x, z, theta } = road.sample(s);
      const lat = (rand() < 0.5 ? -1 : 1) * (170 + rand() * 260);
      const r = 90 + rand() * 140;
      const h = r * (0.1 + rand() * 0.1);
      m.compose(
        new THREE.Vector3(x - Math.sin(theta) * lat, h * 0.15, z + Math.cos(theta) * lat),
        q,
        new THREE.Vector3(r, h, r)
      );
      farMesh.setMatrixAt(i, m);
      farMesh.setColorAt(i, col.set(C.farHills));
    }
    farMesh.instanceMatrix.needsUpdate = true;
    if (farMesh.instanceColor) farMesh.instanceColor.needsUpdate = true;

    const g = new THREE.Group();
    g.add(nearMesh, farMesh);
    return g;
  }, [road]);

  return <primitive object={group} />;
}

// ------------------------------------------------------------------ trees
function Trees({ road }: { road: RoadData }) {
  const group = useMemo(() => {
    const rand = mulberry32(424242);
    const m = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const col = new THREE.Color();
    const UP = new THREE.Vector3(0, 1, 0);
    const COUNT = 170;
    const trunkMesh = new THREE.InstancedMesh(
      new THREE.CylinderGeometry(0.13, 0.18, 1.4, 5),
      new THREE.MeshStandardMaterial({ color: C.trunk, flatShading: true, roughness: 1 }),
      COUNT
    );
    const canopyMesh = new THREE.InstancedMesh(
      new THREE.ConeGeometry(1.15, 3, 6),
      new THREE.MeshStandardMaterial({ flatShading: true, roughness: 1, metalness: 0 }),
      COUNT
    );
    for (let i = 0; i < COUNT; i++) {
      const s = 8 + rand() * 2380;
      const { x, z, theta } = road.sample(s);
      const lat = (rand() < 0.5 ? -1 : 1) * (6.5 + rand() * 24);
      const scale = 0.7 + rand() * 0.9;
      const rot = rand() * Math.PI * 2;
      const px = x - Math.sin(theta) * lat;
      const pz = z + Math.cos(theta) * lat;
      q.setFromAxisAngle(UP, rot);
      m.compose(
        new THREE.Vector3(px, 0.7 * scale, pz),
        q,
        new THREE.Vector3(scale * 0.9, scale, scale * 0.9)
      );
      trunkMesh.setMatrixAt(i, m);
      m.compose(
        new THREE.Vector3(px, (1.4 + 1.5) * scale, pz),
        q,
        new THREE.Vector3(scale, scale, scale)
      );
      canopyMesh.setMatrixAt(i, m);
      canopyMesh.setColorAt(i, col.set(C.canopies[Math.floor(rand() * C.canopies.length)]));
    }
    trunkMesh.instanceMatrix.needsUpdate = true;
    canopyMesh.instanceMatrix.needsUpdate = true;
    if (canopyMesh.instanceColor) canopyMesh.instanceColor.needsUpdate = true;
    const g = new THREE.Group();
    g.add(trunkMesh, canopyMesh);
    return g;
  }, [road]);
  return <primitive object={group} />;
}

// ------------------------------------------------------------------ rocks
function Rocks({ road }: { road: RoadData }) {
  const mesh = useMemo(() => {
    const rand = mulberry32(5150);
    const m = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const COUNT = 60;
    const rockMesh = new THREE.InstancedMesh(
      new THREE.DodecahedronGeometry(1, 0),
      new THREE.MeshStandardMaterial({ color: C.rock, flatShading: true, roughness: 1 }),
      COUNT
    );
    for (let i = 0; i < COUNT; i++) {
      const s = 5 + rand() * 2390;
      const { x, z, theta } = road.sample(s);
      const lat = (rand() < 0.5 ? -1 : 1) * (3.6 + rand() * 5);
      const sc = 0.22 + rand() * 0.5;
      q.setFromEuler(new THREE.Euler(rand() * 1.2, rand() * Math.PI, rand() * 0.9));
      m.compose(
        new THREE.Vector3(x - Math.sin(theta) * lat, sc * 0.5, z + Math.cos(theta) * lat),
        q,
        new THREE.Vector3(sc, sc * 0.8, sc * 1.2)
      );
      rockMesh.setMatrixAt(i, m);
    }
    rockMesh.instanceMatrix.needsUpdate = true;
    return rockMesh;
  }, [road]);
  return <primitive object={mesh} />;
}

// ------------------------------------------------------------------- road
function RoadRibbon({ road }: { road: RoadData }) {
  const asphalt = useMemo(() => {
    const g = new THREE.BufferGeometry();
    const n = ROAD_POINTS;
    const pos = new Float32Array(n * 2 * 3);
    const nor = new Float32Array(n * 2 * 3);
    const idx: number[] = [];
    for (let i = 0; i < n; i++) {
      const theta = road.heading[i];
      const nx = Math.cos(theta);
      const nz = -Math.sin(theta);
      const x = road.px[i];
      const z = road.pz[i];
      pos.set([x + nx * ROAD_HALF_WIDTH, 0.03, z + nz * ROAD_HALF_WIDTH], i * 6);
      pos.set([x - nx * ROAD_HALF_WIDTH, 0.03, z - nz * ROAD_HALF_WIDTH], i * 6 + 3);
      nor.set([0, 1, 0], i * 6);
      nor.set([0, 1, 0], i * 6 + 3);
      if (i < n - 1) {
        const a = i * 2;
        idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
      }
    }
    g.setAttribute("position", new THREE.BufferAttribute(pos, 3));
    g.setAttribute("normal", new THREE.BufferAttribute(nor, 3));
    g.setIndex(idx);
    return g;
  }, [road]);

  const dashes = useMemo(() => {
    // warm dashed centre line: 1.5 m dash, 2.5 m gap
    const pos: number[] = [];
    const idx: number[] = [];
    let v = 0;
    for (let s = 2; s < 2395; s += 4) {
      const i0 = Math.floor(s);
      const i1 = Math.min(Math.floor(s + 1.5), ROAD_POINTS - 1);
      if (i1 <= i0) continue;
      for (const i of [i0, i1]) {
        const theta = road.heading[i];
        const nx = Math.cos(theta);
        const nz = -Math.sin(theta);
        pos.push(
          road.px[i] + nx * 0.09, 0.045, road.pz[i] + nz * 0.09,
          road.px[i] - nx * 0.09, 0.045, road.pz[i] - nz * 0.09
        );
      }
      idx.push(v, v + 1, v + 2, v + 1, v + 3, v + 2);
      v += 4;
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
    g.setIndex(idx);
    g.computeVertexNormals();
    return g;
  }, [road]);

  const edges = useMemo(() => {
    // dim warm edge lines at ±2.32 m
    const pos: number[] = [];
    const idx: number[] = [];
    let v = 0;
    for (const side of [1, -1]) {
      for (let i = 0; i < ROAD_POINTS - 1; i++) {
        const theta = road.heading[i];
        const nx = Math.cos(theta);
        const nz = -Math.sin(theta);
        const cx = road.px[i] + nx * 2.32 * side;
        const cz = road.pz[i] + nz * 2.32 * side;
        const theta2 = road.heading[i + 1];
        const nx2 = Math.cos(theta2);
        const nz2 = -Math.sin(theta2);
        const cx2 = road.px[i + 1] + nx2 * 2.32 * side;
        const cz2 = road.pz[i + 1] + nz2 * 2.32 * side;
        pos.push(
          cx + nx * 0.07, 0.04, cz + nz * 0.07,
          cx - nx * 0.07, 0.04, cz - nz * 0.07,
          cx2 + nx2 * 0.07, 0.04, cz2 + nz2 * 0.07,
          cx2 - nx2 * 0.07, 0.04, cz2 - nz2 * 0.07
        );
        idx.push(v, v + 1, v + 2, v + 1, v + 3, v + 2);
        v += 4;
      }
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
    g.setIndex(idx);
    g.computeVertexNormals();
    return g;
  }, [road]);

  return (
    <group>
      <mesh geometry={asphalt}>
        <meshStandardMaterial color={C.asphalt} roughness={0.94} metalness={0} />
      </mesh>
      <mesh geometry={dashes}>
        <meshBasicMaterial color={C.dash} toneMapped={false} />
      </mesh>
      <mesh geometry={edges}>
        <meshBasicMaterial color={C.edge} toneMapped={false} transparent opacity={0.75} />
      </mesh>
    </group>
  );
}

function GlowPosts({ road }: { road: RoadData }) {
  const group = useMemo(() => {
    const m = new THREE.Matrix4();
    const posts: { x: number; z: number }[] = [];
    for (let s = POST_SPACING_M; s < 2395; s += POST_SPACING_M) {
      const i = Math.floor(s);
      const theta = road.heading[i];
      const nx = Math.cos(theta);
      const nz = -Math.sin(theta);
      for (const side of [1, -1]) {
        posts.push({
          x: road.px[i] + nx * POST_OFFSET_M * side,
          z: road.pz[i] + nz * POST_OFFSET_M * side,
        });
      }
    }
    const orbMesh = new THREE.InstancedMesh(
      new THREE.SphereGeometry(0.11, 10, 8),
      new THREE.MeshBasicMaterial({ color: C.post, toneMapped: false }),
      posts.length
    );
    const stickMesh = new THREE.InstancedMesh(
      new THREE.CylinderGeometry(0.025, 0.03, 0.62, 5),
      new THREE.MeshStandardMaterial({ color: "#3a2530", roughness: 1 }),
      posts.length
    );
    posts.forEach((p, i) => {
      m.makeTranslation(p.x, 0.62, p.z);
      orbMesh.setMatrixAt(i, m);
      m.makeTranslation(p.x, 0.31, p.z);
      stickMesh.setMatrixAt(i, m);
    });
    orbMesh.instanceMatrix.needsUpdate = true;
    stickMesh.instanceMatrix.needsUpdate = true;
    const g = new THREE.Group();
    g.add(orbMesh, stickMesh);
    return g;
  }, [road]);
  return <primitive object={group} />;
}

// -------------------------------------------------------------- fireflies
function Fireflies({ road }: { road: RoadData }) {
  const ref = useRef<THREE.Points>(null);
  const COUNT = 900;
  const { geometry, seeds } = useMemo(() => {
    const rand = mulberry32(99117);
    const positions = new Float32Array(COUNT * 3);
    const colors = new Float32Array(COUNT * 3);
    const seeds = new Float32Array(COUNT * 2);
    const base = new THREE.Color(C.firefly);
    for (let i = 0; i < COUNT; i++) {
      const s = rand() * 2390;
      const { x, z, theta } = road.sample(s);
      const lat = (rand() < 0.5 ? -1 : 1) * (3.5 + rand() * 24);
      positions[i * 3] = x - Math.sin(theta) * lat;
      positions[i * 3 + 1] = 0.4 + rand() * 5;
      positions[i * 3 + 2] = z + Math.cos(theta) * lat;
      const warmth = 0.75 + rand() * 0.25;
      colors[i * 3] = base.r * warmth;
      colors[i * 3 + 1] = base.g * warmth * (0.85 + rand() * 0.15);
      colors[i * 3 + 2] = base.b * warmth * 0.7;
      seeds[i * 2] = rand() * Math.PI * 2; // phase
      seeds[i * 2 + 1] = 0.3 + rand() * 0.8; // speed
    }
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
    geometry.setAttribute("color", new THREE.BufferAttribute(colors, 3));
    return { geometry, seeds };
  }, [road]);

  const basePos = useMemo(
    () => Float32Array.from(geometry.attributes.position.array as Float32Array),
    [geometry]
  );

  useFrame(({ clock }) => {
    const t = clock.elapsedTime;
    const attr = ref.current?.geometry.attributes.position as
      | THREE.BufferAttribute
      | undefined;
    if (!attr) return;
    const arr = attr.array as Float32Array;
    for (let i = 0; i < COUNT; i++) {
      const ph = seeds[i * 2];
      const sp = seeds[i * 2 + 1];
      arr[i * 3] = basePos[i * 3] + Math.sin(t * sp * 0.5 + ph) * 0.9;
      arr[i * 3 + 1] = basePos[i * 3 + 1] + Math.sin(t * sp + ph * 2) * 0.55;
      arr[i * 3 + 2] = basePos[i * 3 + 2] + Math.cos(t * sp * 0.4 + ph) * 0.9;
    }
    attr.needsUpdate = true;
  });

  return (
    <points ref={ref} geometry={geometry} frustumCulled={false}>
      <pointsMaterial
        size={0.3}
        vertexColors
        transparent
        opacity={0.9}
        blending={THREE.AdditiveBlending}
        depthWrite={false}
        sizeAttenuation
        toneMapped={false}
      />
    </points>
  );
}

// ------------------------------------------------------------ bicycle rig
interface RigMaterials {
  frame: THREE.MeshStandardMaterial;
  tire: THREE.MeshStandardMaterial;
  dark: THREE.MeshStandardMaterial;
  body: THREE.MeshStandardMaterial;
  eye: THREE.MeshStandardMaterial;
  wing: THREE.MeshBasicMaterial;
}

// "You vs the fly" challenge markers (amber = YOU, emerald = FLY)
const TAG_COLORS = {
  you: { rim: "#fbbf24", lamp: "#ffc24a" },
  fly: { rim: "#34d399", lamp: "#3ce6a0" },
} as const;

const riderLabelTex: Partial<Record<RiderTag, THREE.CanvasTexture>> = {};
/** Lazily-built glowing "YOU" / "FLY" label textures (browser canvas). */
function riderLabelTexture(tag: RiderTag): THREE.CanvasTexture | null {
  const cached = riderLabelTex[tag];
  if (cached) return cached;
  if (typeof document === "undefined") return null;
  const cv = document.createElement("canvas");
  cv.width = 256;
  cv.height = 96;
  const ctx = cv.getContext("2d");
  if (!ctx) return null;
  const isYou = tag === "you";
  ctx.font = "700 54px ui-monospace, SFMono-Regular, Menlo, monospace";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.shadowColor = isYou ? "rgba(251,191,36,0.85)" : "rgba(52,211,153,0.85)";
  ctx.shadowBlur = 22;
  ctx.fillStyle = isYou ? "#fde68a" : "#a7f3d0";
  // double pass → a stronger glow around the lettering
  ctx.fillText(isYou ? "YOU" : "FLY", 128, 52);
  ctx.fillText(isYou ? "YOU" : "FLY", 128, 52);
  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.SRGBColorSpace;
  riderLabelTex[tag] = tex;
  return tex;
}

function makeRigMaterials(): RigMaterials {
  // one material set per rig — ghost translucency and death fades are
  // driven imperatively in useFrame by animating opacity
  return {
    frame: new THREE.MeshStandardMaterial({
      color: C.frame,
      metalness: 0.55,
      roughness: 0.4,
    }),
    tire: new THREE.MeshStandardMaterial({ color: C.tire, roughness: 0.9 }),
    dark: new THREE.MeshStandardMaterial({ color: "#3a2a30", roughness: 0.8 }),
    body: new THREE.MeshStandardMaterial({
      color: C.flyBody,
      roughness: 0.55,
      metalness: 0.1,
    }),
    eye: new THREE.MeshStandardMaterial({
      color: C.eye,
      emissive: "#d92618",
      emissiveIntensity: 1.4,
      roughness: 0.25,
    }),
    wing: new THREE.MeshBasicMaterial({
      color: "#ffd9c8",
      transparent: true,
      opacity: 0.32,
      depthWrite: false,
      side: THREE.DoubleSide,
    }),
  };
}

const BIKE_R = 0.34; // wheel radius

function BikeRig({
  core,
  riderIndex,
}: {
  core: BicycleTrainerCore;
  riderIndex: number;
}) {
  const root = useRef<THREE.Group>(null);
  const lean = useRef<THREE.Group>(null);
  const wheelF = useRef<THREE.Group>(null);
  const wheelR = useRef<THREE.Group>(null);
  const crank = useRef<THREE.Group>(null);
  const legL = useRef<THREE.Mesh>(null);
  const legR = useRef<THREE.Mesh>(null);
  const rim = useRef<THREE.Mesh>(null);
  const lamp = useRef<THREE.PointLight>(null);
  const label = useRef<THREE.Sprite>(null);
  const wingL = useRef<THREE.Mesh>(null);
  const wingR = useRef<THREE.Mesh>(null);

  // every rig owns its own material set so ghosts / fades are per-rider
  // (mutated imperatively each frame, outside React's data flow)
  const mats = useMemo(() => makeRigMaterials(), []);

  // bookkeeping for fall animation + episode resets
  const wasAlive = useRef(true);
  const crankAngle = useRef(0);
  const wheelAngle = useRef(0);

  useFrame((_, dt) => {
    const r = core.riders[riderIndex];
    const g = root.current;
    const lg = lean.current;
    if (!g || !lg) return;
    if (!r) {
      // population smaller than the rig pool — park it out of sight
      g.visible = false;
      return;
    }
    g.visible = true;

    // --- transform from physics state ---
    const w = core.riderWorld(riderIndex);
    g.position.set(w.x, 0, w.z);
    g.rotation.y = w.heading;

    // --- ghost vs solid vs leader materials ---
    const isLeader = riderIndex === core.leaderIdx;
    // challenge riders (tagged YOU / FLY) are always fully visible
    const ghost = !isLeader && core.riders.length > 1 && !r.tag;
    const bodyMats = [mats.frame, mats.tire, mats.dark, mats.body];
    if (r.st.alive) {
      const target = ghost ? 0.28 : 1;
      bodyMats.forEach((m) => {
        m.transparent = ghost;
        m.opacity += (target - m.opacity) * Math.min(1, dt * 6);
        m.depthWrite = !ghost;
      });
      [mats.eye].forEach((m) => {
        m.transparent = ghost;
        m.opacity += ((ghost ? 0.45 : 1) - m.opacity) * Math.min(1, dt * 6);
      });
      [mats.wing].forEach((m) => {
        m.opacity += ((ghost ? 0.12 : 0.32) - m.opacity) * Math.min(1, dt * 6);
      });
      lg.rotation.z = w.lean;
    } else {
      // tumble: tip over 0.5 s, then fade out over ~1.2 s
      const tFall = core.realTime - r.doneRealT;
      const tip = Math.min(1, tFall / 0.5);
      const ease = tip * tip * (3 - 2 * tip);
      lg.rotation.z = r.st.fallSign * (Math.PI / 2) * ease;
      const fade = Math.max(0, 1 - Math.max(0, tFall - 0.45) / 1.2);
      [...bodyMats, mats.eye].forEach((m) => {
        m.transparent = true;
        m.opacity = fade * (ghost ? 0.28 : 1);
        m.depthWrite = fade > 0.5;
      });
      [mats.wing].forEach((m) => { m.opacity = fade * 0.3; });
    }
    if (r.st.alive && !wasAlive.current) {
      // episode reset — restore upright pose and solid materials
      lg.rotation.z = 0;
      [mats.frame, mats.tire, mats.dark, mats.body, mats.eye].forEach((m) => {
        m.opacity = 1;
        m.transparent = false;
        m.depthWrite = true;
      });
      [mats.wing].forEach((m) => { m.opacity = 0.32; });
    }
    wasAlive.current = r.st.alive;

    // --- wheels & pedalling legs ---
    const v = r.st.alive ? r.st.v : 0;
    wheelAngle.current += (v / BIKE_R) * dt;
    crankAngle.current += v * 1.15 * dt;
    if (wheelF.current) wheelF.current.rotation.z = wheelAngle.current;
    if (wheelR.current) wheelR.current.rotation.z = wheelAngle.current;
    if (crank.current) crank.current.rotation.x = crankAngle.current;
    const ph = crankAngle.current;
    if (legL.current) legL.current.rotation.x = -0.35 + Math.sin(ph) * 0.55;
    if (legR.current) legR.current.rotation.x = -0.35 + Math.sin(ph + Math.PI) * 0.55;
    // wing flutter
    const flut = Math.sin(core.realTime * 38 + riderIndex * 3) * 0.45;
    if (wingL.current) wingL.current.rotation.y = 0.7 + flut;
    if (wingR.current) wingR.current.rotation.y = -0.7 - flut;

    // --- leader highlight / challenge marker: pulsing rim + warm lamp ---
    const tag = r.tag as RiderTag | undefined;
    if (rim.current) {
      rim.current.visible = isLeader || !!tag;
      const s = 1 + Math.sin(core.realTime * 3.2) * 0.06;
      rim.current.scale.set(s, s, 1);
      const rimMat = rim.current.material as THREE.MeshBasicMaterial;
      if (tag === "you") rimMat.color.set(TAG_COLORS.you.rim);
      else if (tag === "fly") rimMat.color.set(TAG_COLORS.fly.rim);
      else rimMat.color.set(C.rim);
    }
    if (lamp.current) {
      lamp.current.intensity = isLeader || tag ? 2.4 : 0;
      lamp.current.color.set(
        tag === "you"
          ? TAG_COLORS.you.lamp
          : tag === "fly"
            ? TAG_COLORS.fly.lamp
            : "#ffa070"
      );
    }
    // floating YOU / FLY label over challenge riders
    if (label.current) {
      const tex = tag ? riderLabelTexture(tag) : null;
      label.current.visible = !!tex;
      if (tex) {
        const lm = label.current.material as THREE.SpriteMaterial;
        if (lm.map !== tex) {
          lm.map = tex;
          lm.needsUpdate = true;
        }
        label.current.position.y = 2.0 + Math.sin(core.realTime * 2.1) * 0.04;
      }
    }
  });

  const tube = (
    from: [number, number, number],
    to: [number, number, number],
    r = 0.035,
    mat: THREE.Material
  ) => {
    const dx = to[0] - from[0];
    const dy = to[1] - from[1];
    const dz = to[2] - from[2];
    const len = Math.sqrt(dx * dx + dy * dy + dz * dz);
    const mid: [number, number, number] = [
      (from[0] + to[0]) / 2,
      (from[1] + to[1]) / 2,
      (from[2] + to[2]) / 2,
    ];
    const quat = new THREE.Quaternion().setFromUnitVectors(
      new THREE.Vector3(0, 1, 0),
      new THREE.Vector3(dx, dy, dz).normalize()
    );
    const e = new THREE.Euler().setFromQuaternion(quat);
    return (
      <mesh position={mid} rotation={[e.x, e.y, e.z]} material={mat}>
        <cylinderGeometry args={[r, r, len, 6]} />
      </mesh>
    );
  };

  const rearHub: [number, number, number] = [0, BIKE_R, -0.55];
  const frontHub: [number, number, number] = [0, BIKE_R, 0.55];
  const bb: [number, number, number] = [0, 0.3, 0.02];
  const seatTop: [number, number, number] = [0, 0.98, -0.22];
  const headTop: [number, number, number] = [0, 0.95, 0.42];

  return (
    <group ref={root}>
      <group ref={lean}>
        {/* wheels */}
        <group position={rearHub} rotation={[0, Math.PI / 2, 0]}>
          <group ref={wheelR}>
            <mesh material={mats.tire}>
              <torusGeometry args={[BIKE_R, 0.045, 8, 20]} />
            </mesh>
            {[0, 1, 2].map((k) => (
              <mesh key={k} rotation={[0, 0, (k * Math.PI) / 3]} material={mats.dark}>
                <boxGeometry args={[0.016, BIKE_R * 2 - 0.06, 0.016]} />
              </mesh>
            ))}
          </group>
        </group>
        <group position={frontHub} rotation={[0, Math.PI / 2, 0]}>
          <group ref={wheelF}>
            <mesh material={mats.tire}>
              <torusGeometry args={[BIKE_R, 0.045, 8, 20]} />
            </mesh>
            {[0, 1, 2].map((k) => (
              <mesh key={k} rotation={[0, 0, (k * Math.PI) / 3]} material={mats.dark}>
                <boxGeometry args={[0.016, BIKE_R * 2 - 0.06, 0.016]} />
              </mesh>
            ))}
          </group>
        </group>

        {/* frame */}
        {tube(rearHub, seatTop, 0.035, mats.frame)}
        {tube(seatTop, headTop, 0.032, mats.frame)}
        {tube(rearHub, bb, 0.028, mats.dark)}
        {tube(bb, seatTop, 0.032, mats.frame)}
        {tube(bb, headTop, 0.03, mats.frame)}
        {tube(headTop, frontHub, 0.026, mats.frame)}
        {/* handlebar */}
        <mesh position={[0, 1.02, 0.44]} rotation={[0, 0, Math.PI / 2]} material={mats.dark}>
          <cylinderGeometry args={[0.022, 0.022, 0.52, 6]} />
        </mesh>
        {/* seat */}
        <mesh position={[0, 1.0, -0.24]} material={mats.dark}>
          <boxGeometry args={[0.09, 0.05, 0.24]} />
        </mesh>

        {/* cranks + pedals */}
        <group ref={crank} position={[0, 0.3, 0.02]}>
          <mesh position={[0.1, 0, 0]} material={mats.dark}>
            <boxGeometry args={[0.16, 0.022, 0.03]} />
          </mesh>
          <mesh position={[-0.1, 0, 0]} material={mats.dark}>
            <boxGeometry args={[0.16, 0.022, 0.03]} />
          </mesh>
        </group>

        {/* the FLY rider */}
        <group position={[0, 1.06, -0.18]}>
          <mesh position={[0, 0.14, 0]} material={mats.body}>
            <sphereGeometry args={[0.16, 12, 10]} />
          </mesh>
          {/* big red compound eyes */}
          <mesh position={[0.1, 0.26, 0.05]} material={mats.eye}>
            <sphereGeometry args={[0.078, 10, 8]} />
          </mesh>
          <mesh position={[-0.1, 0.26, 0.05]} material={mats.eye}>
            <sphereGeometry args={[0.078, 10, 8]} />
          </mesh>
          {/* wings */}
          <mesh ref={wingL} position={[0.06, 0.22, -0.1]} rotation={[0.5, 0.7, 0.2]} material={mats.wing}>
            <planeGeometry args={[0.34, 0.13]} />
          </mesh>
          <mesh ref={wingR} position={[-0.06, 0.22, -0.1]} rotation={[0.5, -0.7, -0.2]} material={mats.wing}>
            <planeGeometry args={[0.34, 0.13]} />
          </mesh>
          {/* antennae */}
          <mesh position={[0.03, 0.36, 0.12]} rotation={[0.5, 0, 0.4]} material={mats.dark}>
            <cylinderGeometry args={[0.006, 0.006, 0.16, 4]} />
          </mesh>
          <mesh position={[-0.03, 0.36, 0.12]} rotation={[0.5, 0, -0.4]} material={mats.dark}>
            <cylinderGeometry args={[0.006, 0.006, 0.16, 4]} />
          </mesh>
          {/* arms to handlebar */}
          <mesh position={[0.1, -0.04, 0.28]} rotation={[1.1, 0, 0.25]} material={mats.body}>
            <cylinderGeometry args={[0.02, 0.02, 0.34, 5]} />
          </mesh>
          <mesh position={[-0.1, -0.04, 0.28]} rotation={[1.1, 0, -0.25]} material={mats.body}>
            <cylinderGeometry args={[0.02, 0.02, 0.34, 5]} />
          </mesh>
          {/* pedalling legs */}
          <mesh ref={legL} position={[0.07, -0.1, 0.06]} material={mats.body}>
            <cylinderGeometry args={[0.018, 0.022, 0.4, 5]} />
          </mesh>
          <mesh ref={legR} position={[-0.07, -0.1, 0.06]} material={mats.body}>
            <cylinderGeometry args={[0.018, 0.022, 0.4, 5]} />
          </mesh>
        </group>
      </group>

      {/* leader glow rim under the bike */}
      <mesh ref={rim} position={[0, 0.06, 0]} rotation={[-Math.PI / 2, 0, 0]} visible={false}>
        <ringGeometry args={[0.62, 0.72, 28]} />
        <meshBasicMaterial color={C.rim} transparent opacity={0.85} toneMapped={false} side={THREE.DoubleSide} />
      </mesh>
      <pointLight ref={lamp} color="#ffa070" intensity={2.4} distance={11} decay={2} position={[0, 1.6, 0]} />
      {/* floating YOU / FLY challenge label (visibility set per frame) */}
      <sprite ref={label} position={[0, 2.0, 0]} visible={false} scale={[1.15, 0.43, 1]}>
        <spriteMaterial transparent depthTest={false} toneMapped={false} />
      </sprite>
    </group>
  );
}

// ----------------------------------------------------------- chase camera
function ChaseCamera({ core }: { core: BicycleTrainerCore }) {
  const { camera } = useThree();
  const camPos = useRef(new THREE.Vector3(0, 2.8, -8));
  const camTgt = useRef(new THREE.Vector3(0, 1, 3));
  const desired = useRef(new THREE.Vector3());
  const tgt = useRef(new THREE.Vector3());

  useFrame((_, dt) => {
    let wx: number;
    let wz: number;
    let heading: number;
    let lean: number;
    let back = 7.2;
    let ahead = 3.4;
    const ch = core.challenge;
    if (ch) {
      // challenge: frame BOTH riders — target the midpoint of the pair and
      // orient along the further rider's heading; bank with the human's lean
      const a = core.riderWorld(0);
      const b = core.riderWorld(1);
      wx = (a.x + b.x) / 2;
      wz = (a.z + b.z) / 2;
      const leadW = ch.human.st.s >= ch.fly.st.s ? a : b;
      heading = leadW.heading;
      lean = ch.human.st.alive ? ch.human.st.phi : ch.fly.st.phi;
      back = 8.6;
      ahead = 4.0;
    } else {
      const w = core.riderWorld(core.leaderIdx);
      wx = w.x;
      wz = w.z;
      heading = w.heading;
      lean = w.lean;
    }
    const lead = core.leader;
    if (!lead) return;
    const fwdX = Math.sin(heading);
    const fwdZ = Math.cos(heading);

    desired.current.set(wx - fwdX * back, 2.6, wz - fwdZ * back);
    tgt.current.set(wx + fwdX * ahead, 1.05, wz + fwdZ * ahead);

    const k = 1 - Math.exp(-dt * 2.6);
    camPos.current.lerp(desired.current, k);
    camTgt.current.lerp(tgt.current, 1 - Math.exp(-dt * 4));

    // fall shake
    let sx = 0;
    let sy = 0;
    if (core.shake > 0.005) {
      sx = (Math.random() - 0.5) * core.shake;
      sy = (Math.random() - 0.5) * core.shake * 0.7;
    }
    camera.position.set(camPos.current.x + sx, camPos.current.y + sy, camPos.current.z);
    camera.up.set(0, 1, 0);
    camera.lookAt(camTgt.current);
    // gentle banking with the rider's lean (the human's, during a challenge)
    camera.rotateZ(-lean * 0.16);
  });
  return null;
}

// ------------------------------------------------------------- sim runner
function SimRunner({
  core,
  retinaCanvas,
}: {
  core: BicycleTrainerCore;
  retinaCanvas: React.RefObject<HTMLCanvasElement | null>;
}) {
  // pixel buffer for the retina mini-canvas — lazily created, mutated per frame
  const bufRef = useRef<{
    img: ImageData;
    px: Uint8ClampedArray;
  } | null>(null);

  useFrame((_, dt) => {
    core.advance(Math.min(dt, 0.1));

    const cv = retinaCanvas.current;
    // in challenge mode the mini-canvas shows what the CHAMPION FLY sees
    // (its actual brain input), otherwise the current leader's view
    const src = core.challenge ? core.challenge.fly : core.leader;
    if (cv && src && typeof ImageData !== "undefined") {
      const ctx = cv.getContext("2d");
      if (ctx) {
        if (!bufRef.current) {
          bufRef.current = {
            img: new ImageData(RETINA_COLS, RETINA_ROWS),
            px: new Uint8ClampedArray(RETINA_COLS * RETINA_ROWS * 4),
          };
        }
        const { img, px } = bufRef.current;
        const r = src.retina;
        for (let i = 0; i < RETINA_COLS * RETINA_ROWS; i++) {
          const [cr, cg, cb] = retinaColor(r[i]);
          px[i * 4] = cr;
          px[i * 4 + 1] = cg;
          px[i * 4 + 2] = cb;
          px[i * 4 + 3] = 255;
        }
        img.data.set(px);
        ctx.putImageData(img, 0, 0);
      }
    }
  });
  return null;
}

// ------------------------------------------------------------------ scene
export interface DuskSceneProps {
  core: BicycleTrainerCore;
  retinaCanvas: React.RefObject<HTMLCanvasElement | null>;
  maxRiders: number;
}

export function DuskScene({ core, retinaCanvas, maxRiders }: DuskSceneProps) {
  const road = core.road;
  const sunPos = useMemo(
    () => new THREE.Vector3().copy(SUN_DIR).multiplyScalar(220),
    []
  );
  return (
    <>
      <color attach="background" args={[C.zenith]} />
      <fog attach="fog" args={[C.fog, 50, 330]} />
      <ambientLight intensity={0.62} color="#9a5f72" />
      <directionalLight
        position={sunPos}
        color="#ffa45e"
        intensity={1.9}
      />
      <hemisphereLight args={["#6b2545", "#221319", 0.5]} />

      <DuskSky />
      <DuskClouds road={road} />

      {/* ground */}
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, -0.02, 0]}>
        <planeGeometry args={[4000, 4000]} />
        <meshStandardMaterial color={C.ground} roughness={1} metalness={0} />
      </mesh>

      <Hills road={road} />
      <Trees road={road} />
      <Rocks road={road} />
      <RoadRibbon road={road} />
      <GlowPosts road={road} />
      <Fireflies road={road} />

      {Array.from({ length: maxRiders }, (_, i) => (
        <BikeRig key={i} core={core} riderIndex={i} />
      ))}

      <ChaseCamera core={core} />
      <SimRunner core={core} retinaCanvas={retinaCanvas} />
    </>
  );
}
