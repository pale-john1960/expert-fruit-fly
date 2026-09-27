"use client";

/**
 * BrainVisualizer3D — real-time 3D visualization of the fruit fly brain.
 *
 * Contract:
 * - props.brain: FlyBrain instance (or null while initializing)
 * - reads brain state every animation frame WITHOUT React re-renders:
 *   brain.rates (0..1), brain.spiked (0/1), brain.positions, brain.regions,
 *   brain.getDopamine(), brain.getSampleEdges(maxEdges)
 * - neurons: one instancedMesh per region, glowing spheres colored by an
 *   anatomical palette; brightness + scale follow activity, spikes flash
 * - synapses: lineSegments (additive blending) whose vertex colors pulse with
 *   pre-synaptic firing — gray fixed wiring, emerald/rose plastic synapses
 * - dopamine surge: scene-wide glow (emerald = sugar, rose = shock) plus an
 *   expanding pulse ring
 * - click a neuron to poke it (brain.poke) — the cell pops with a white flash
 * - slow auto-rotate orbit controls; dark void background with subtle fog
 */

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import * as THREE from "three";
import { Canvas, useFrame, type ThreeEvent } from "@react-three/fiber";
import { OrbitControls, Stars } from "@react-three/drei";
import { FlyBrain } from "@/lib/flybrain/engine";
import type { BrainRegion } from "@/lib/flybrain/types";
import { cn } from "@/lib/utils";

export interface BrainVisualizer3DProps {
  brain: FlyBrain | null;
  className?: string;
  height?: number | string;
  compact?: boolean;
  /** slow camera auto-rotation (default true) */
  autoRotate?: boolean;
  /** draw the synapse edge web (default true) */
  showSynapses?: boolean;
  /** fired when a neuron is clicked (its global index) — or null when empty
   *  space is clicked (deselect). No-op unless provided (trainer embeds keep
   *  their current behavior exactly). */
  onNeuronSelect?: (globalIdx: number | null) => void;
  /** the inspected neuron — renders a pulsing emerald selection ring at its
   *  position (default null = hidden) */
  selectedNeuron?: number | null;
  /** increment this counter to poke `selectedNeuron` through the exact same
   *  path as a canvas click (current injection + pop animation) */
  pokeNonce?: number;
}

interface PokeTip {
  x: number;
  y: number;
  region: string;
  neuron: number;
}

interface RegionInfo {
  region: BrainRegion;
  start: number;
  count: number;
  ordinal: number;
  label: string;
  color: string;
  radius: number;
  seg: number;
  /** per-instance base colors (count × 3) */
  base: Float32Array;
}

const BG = "#0a0a0f";
const EMERALD = "#34d399";
const ROSE = "#fb7185";

/** Anatomical palette — bioluminescent, no blues/indigo.
 *  (Exported for the Brain Lab neuron inspector, so its region badges match
 *  the 3D legend exactly.) */
export const REGION_META: Record<
  BrainRegion,
  { label: string; color: string; radius: number; seg: number }
> = {
  retina: { label: "Retina", color: "#f59e0b", radius: 0.025, seg: 8 },
  lamina: { label: "Lamina", color: "#fbbf24", radius: 0.024, seg: 8 },
  medulla: { label: "Medulla", color: "#2dd4bf", radius: 0.026, seg: 8 },
  lobula: { label: "Lobula", color: "#34d399", radius: 0.03, seg: 8 },
  kenyon: { label: "Mushroom body", color: "#e879f9", radius: 0.028, seg: 8 },
  mbon: { label: "MBON", color: EMERALD, radius: 0.05, seg: 12 },
  motor: { label: "Motor", color: "#fde047", radius: 0.06, seg: 12 },
};

/** Synapse tints: fixed wiring is cool gray; plastic synapses glow by sign. */
const EDGE_TINT = {
  fixed: [0.3, 0.33, 0.38],
  plasticPos: [0.14, 0.85, 0.55],
  plasticNeg: [0.95, 0.35, 0.45],
};

let sceneIdCounter = 0;

// ---------------------------------------------------------------------------
// Scene contents (inside <Canvas>)
// ---------------------------------------------------------------------------

interface BrainSceneProps {
  brain: FlyBrain;
  compact: boolean;
  autoRotate: boolean;
  showSynapses: boolean;
  onPoke: (tip: PokeTip) => void;
  onNeuronSelect?: (globalIdx: number | null) => void;
  selectedNeuron: number | null;
  pokeNonce: number;
}

function BrainScene({
  brain,
  compact,
  autoRotate,
  showSynapses,
  onPoke,
  onNeuronSelect,
  selectedNeuron,
  pokeNonce,
}: BrainSceneProps) {
  // ---- per-brain static data (region palettes incl. MBON valence) ----
  const prep = useMemo(() => {
    const regionList: RegionInfo[] = brain.regions.map((rg, ordinal) => {
      const meta = REGION_META[rg.region];
      const base = new Float32Array(rg.count * 3);
      const c = new THREE.Color();
      if (rg.region === "mbon") {
        for (let m = 0; m < rg.count; m++) {
          c.set(brain.mbonValence[m] > 0 ? EMERALD : ROSE);
          base[m * 3] = c.r;
          base[m * 3 + 1] = c.g;
          base[m * 3 + 2] = c.b;
        }
      } else {
        c.set(meta.color);
        for (let m = 0; m < rg.count; m++) {
          base[m * 3] = c.r;
          base[m * 3 + 1] = c.g;
          base[m * 3 + 2] = c.b;
        }
      }
      return {
        region: rg.region,
        start: rg.start,
        count: rg.count,
        ordinal,
        label: meta.label,
        color: meta.color,
        radius: meta.radius,
        seg: meta.seg,
        base,
      };
    });
    return { regionList };
  }, [brain]);

  // ---- synapse edge geometry (positions from brain.positions) ----
  const edge = useMemo(() => {
    const edges = brain.getSampleEdges(compact ? 240 : 520);
    const geo = new THREE.BufferGeometry();
    const pos = new Float32Array(edges.length * 6);
    const col = new Float32Array(edges.length * 6);
    const p = brain.positions;
    for (let e = 0; e < edges.length; e++) {
      const { from, to } = edges[e];
      const o = e * 6;
      pos[o] = p[from * 3];
      pos[o + 1] = p[from * 3 + 1];
      pos[o + 2] = p[from * 3 + 2];
      pos[o + 3] = p[to * 3];
      pos[o + 4] = p[to * 3 + 1];
      pos[o + 5] = p[to * 3 + 2];
    }
    geo.setAttribute("position", new THREE.BufferAttribute(pos, 3));
    geo.setAttribute("color", new THREE.BufferAttribute(col, 3));
    return { edges, geo };
  }, [brain, compact]);

  useEffect(() => () => { edge.geo.dispose(); }, [edge]);

  // ---- refs & scratch objects (no per-frame allocation) ----
  const meshRefs = useRef<(THREE.InstancedMesh | null)[]>([]);
  const proxyRefs = useRef<(THREE.InstancedMesh | null)[]>([]);
  const lineRef = useRef<THREE.LineSegments>(null);
  const ringRef = useRef<THREE.Mesh>(null);
  const selRingRef = useRef<THREE.Mesh>(null);
  const daLightRef = useRef<THREE.PointLight>(null);
  const clockRef = useRef(0);
  const prevStats = useRef({ rewards: 0, punishments: 0 });
  const frameNo = useRef(0);
  const pulse = useRef({ active: false, t0: 0, sign: 1 });
  const pokeFx = useRef<{ gi: number; t0: number } | null>(null);
  const dummy = useMemo(() => new THREE.Object3D(), []);
  const tmpColor = useMemo(() => new THREE.Color(), []);
  const whiteColor = useMemo(() => new THREE.Color("#ffffff"), []);

  // ---- initialize instance colors + matrices ----
  useEffect(() => {
    meshRefs.current.forEach((mesh, ri) => {
      if (!mesh) return;
      const rg = prep.regionList[ri];
      const c = new THREE.Color();
      const p = brain.positions;
      for (let i = 0; i < rg.count; i++) {
        const gi = rg.start + i;
        const gi3 = gi * 3;
        c.setRGB(rg.base[i * 3], rg.base[i * 3 + 1], rg.base[i * 3 + 2]);
        mesh.setColorAt(i, c);
        dummy.position.set(p[gi3], p[gi3 + 1], p[gi3 + 2]);
        dummy.scale.setScalar(1);
        dummy.updateMatrix();
        mesh.setMatrixAt(i, dummy.matrix);
      }
      mesh.instanceMatrix.needsUpdate = true;
      if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    });
    // invisible hit proxies: same positions, larger radius → forgiving clicks
    proxyRefs.current.forEach((mesh, ri) => {
      if (!mesh) return;
      const rg = prep.regionList[ri];
      const p = brain.positions;
      for (let i = 0; i < rg.count; i++) {
        const gi3 = (rg.start + i) * 3;
        dummy.position.set(p[gi3], p[gi3 + 1], p[gi3 + 2]);
        dummy.scale.setScalar(1);
        dummy.updateMatrix();
        mesh.setMatrixAt(i, dummy.matrix);
      }
      mesh.instanceMatrix.needsUpdate = true;
    });
  }, [prep, brain, dummy]);

  // ---- click-to-poke ----
  const handleMeshClick = useCallback(
    (rg: RegionInfo, e: ThreeEvent<MouseEvent>) => {
      e.stopPropagation();
      if (e.instanceId == null || e.delta > 6) return; // ignore orbit drags
      const gi = rg.start + e.instanceId;
      brain.poke(gi, 2.0);
      pokeFx.current = { gi, t0: clockRef.current };
      const ne = e.nativeEvent as MouseEvent;
      onPoke({
        x: ne.offsetX,
        y: ne.offsetY,
        region: rg.label,
        neuron: e.instanceId,
      });
      // same click also feeds the neuron inspector (if one is listening)
      onNeuronSelect?.(gi);
    },
    [brain, onPoke, onNeuronSelect],
  );

  // ---- external poke (inspector "Poke" button) — identical path to a click:
  //      current injection + white-flash pop animation on the selected cell ----
  const lastPokeNonce = useRef(pokeNonce);
  useEffect(() => {
    if (pokeNonce === lastPokeNonce.current) return;
    lastPokeNonce.current = pokeNonce;
    if (pokeNonce <= 0 || selectedNeuron == null) return;
    brain.poke(selectedNeuron, 2.0);
    pokeFx.current = { gi: selectedNeuron, t0: clockRef.current };
  }, [pokeNonce, selectedNeuron, brain]);

  // ---- per-frame update: neurons, edges, dopamine FX ----
  useFrame((state) => {
    const t = state.clock.elapsedTime;
    clockRef.current = t;
    frameNo.current++;

    const rates = brain.rates;
    const spiked = brain.spiked;
    const pos = brain.positions;
    const da = brain.getDopamine();

    // dopamine pulse trigger: a fresh reward/punishment injection
    // (brain.rewards / brain.punishments count each dopamine event)
    if (brain.rewards > prevStats.current.rewards) {
      pulse.current = { active: true, t0: t, sign: 1 };
    } else if (brain.punishments > prevStats.current.punishments) {
      pulse.current = { active: true, t0: t, sign: -1 };
    }
    prevStats.current = { rewards: brain.rewards, punishments: brain.punishments };

    const poke = pokeFx.current;

    // neurons: scale + color by activity, flash on spikes, pop on poke
    for (let ri = 0; ri < prep.regionList.length; ri++) {
      const mesh = meshRefs.current[ri];
      if (!mesh) continue;
      const instColor = mesh.instanceColor;
      if (!instColor) continue;
      const rg = prep.regionList[ri];
      const colArr = instColor.array as Float32Array;
      for (let i = 0; i < rg.count; i++) {
        const gi = rg.start + i;
        const rate = rates[gi];
        const sp = spiked[gi];
        let energy = rate + (sp ? 0.7 : 0);
        let pokeBoost = 0;
        if (poke && poke.gi === gi) {
          const age = t - poke.t0;
          if (age < 0.8) {
            const k = 1 - age / 0.8;
            energy += k * 1.3;
            pokeBoost = k * 2.6;
          } else {
            pokeFx.current = null;
          }
        }
        if (energy > 1.4) energy = 1.4;
        const gi3 = gi * 3;
        dummy.position.set(pos[gi3], pos[gi3 + 1], pos[gi3 + 2]);
        dummy.scale.setScalar(0.8 + energy * 0.85 + pokeBoost);
        dummy.updateMatrix();
        mesh.setMatrixAt(i, dummy.matrix);
        const b = 0.2 + 0.8 * Math.min(1, energy);
        const w = sp ? 0.55 : 0;
        const i3 = i * 3;
        colArr[i3] = rg.base[i3] * b + w;
        colArr[i3 + 1] = rg.base[i3 + 1] * b + w;
        colArr[i3 + 2] = rg.base[i3 + 2] * b + w;
      }
      mesh.instanceMatrix.needsUpdate = true;
      instColor.needsUpdate = true;
    }

    // synapse edges: vertex colors modulated by pre-synaptic rate
    if (showSynapses && lineRef.current && (compact ? frameNo.current % 3 === 0 : true)) {
      const line = lineRef.current;
      const attr = line.geometry.getAttribute("color") as THREE.BufferAttribute;
      const arr = attr.array as Float32Array;
      const edges = edge.edges;
      for (let e = 0; e < edges.length; e++) {
        const ed = edges[e];
        const preRate = rates[ed.from];
        const sp = spiked[ed.from];
        const g = 0.08 + 0.9 * Math.min(1, preRate * 1.05 + (sp ? 0.85 : 0));
        let tr: number;
        let tg: number;
        let tb: number;
        if (ed.plastic) {
          if (ed.weight >= 0) {
            tr = EDGE_TINT.plasticPos[0];
            tg = EDGE_TINT.plasticPos[1];
            tb = EDGE_TINT.plasticPos[2];
          } else {
            tr = EDGE_TINT.plasticNeg[0];
            tg = EDGE_TINT.plasticNeg[1];
            tb = EDGE_TINT.plasticNeg[2];
          }
        } else {
          tr = EDGE_TINT.fixed[0];
          tg = EDGE_TINT.fixed[1];
          tb = EDGE_TINT.fixed[2];
        }
        const o = e * 6;
        arr[o] = tr * g;
        arr[o + 1] = tg * g;
        arr[o + 2] = tb * g;
        arr[o + 3] = tr * g;
        arr[o + 4] = tg * g;
        arr[o + 5] = tb * g;
      }
      attr.needsUpdate = true;
    }

    // dopamine pulse ring (billboarded, expanding, fading)
    const ring = ringRef.current;
    if (ring) {
      const p = pulse.current;
      const mat = ring.material as THREE.MeshBasicMaterial;
      if (p.active) {
        const age = t - p.t0;
        if (age > 1.15) {
          p.active = false;
          ring.visible = false;
          mat.opacity = 0;
        } else {
          const k = age / 1.15;
          ring.visible = true;
          ring.scale.setScalar(0.55 + k * 5.2);
          ring.quaternion.copy(state.camera.quaternion);
          mat.opacity = Math.pow(1 - k, 1.6) * 0.5;
          tmpColor.set(p.sign > 0 ? EMERALD : ROSE);
          mat.color.copy(tmpColor);
        }
      } else if (ring.visible) {
        ring.visible = false;
      }
    }

    // selection marker: pulsing billboarded emerald ring on the inspected
    // neuron (depth-tested off → stays visible even when the cell is hidden
    // behind the brain, like a lab marker)
    const selRing = selRingRef.current;
    if (selRing) {
      if (selectedNeuron != null && selectedNeuron >= 0 && selectedNeuron < brain.total) {
        const gi3 = selectedNeuron * 3;
        const pulse = 0.5 + 0.5 * Math.sin(t * 4.0);
        selRing.visible = true;
        selRing.position.set(pos[gi3], pos[gi3 + 1], pos[gi3 + 2]);
        selRing.scale.setScalar(0.15 + 0.035 * pulse);
        selRing.quaternion.copy(state.camera.quaternion);
        (selRing.material as THREE.MeshBasicMaterial).opacity = 0.55 + 0.4 * pulse;
      } else {
        selRing.visible = false;
      }
    }

    // dopamine ambient glow — the brain "feels" reward / punishment
    const light = daLightRef.current;
    if (light) {
      const a = Math.min(1, Math.abs(da));
      light.intensity = 5 + a * 30;
      if (da >= 0) tmpColor.set(EMERALD).lerp(whiteColor, 0.35);
      else tmpColor.set(ROSE).lerp(whiteColor, 0.35);
      light.color.copy(tmpColor);
    }
  });

  return (
    <>
      <color attach="background" args={[BG]} />
      <fog attach="fog" args={[BG, 7.5, 16]} />
      <ambientLight intensity={0.65} />
      <pointLight
        ref={daLightRef}
        position={[0, 0.3, 0.6]}
        intensity={6}
        distance={10}
        decay={1.5}
      />

      {prep.regionList.map((rg) => (
        <instancedMesh
          key={rg.region}
          ref={(m) => {
            meshRefs.current[rg.ordinal] = m ?? null;
          }}
          args={[undefined!, undefined!, rg.count]}
          frustumCulled={false}
        >
          <sphereGeometry args={[rg.radius, rg.seg, Math.max(6, rg.seg - 2)]} />
          <meshBasicMaterial toneMapped={false} />
        </instancedMesh>
      ))}

      {/* invisible hit proxies (larger radius) → easy click-to-poke */}
      {prep.regionList.map((rg) => (
        <instancedMesh
          key={`hit-${rg.region}`}
          ref={(m) => {
            proxyRefs.current[rg.ordinal] = m ?? null;
          }}
          args={[undefined!, undefined!, rg.count]}
          frustumCulled={false}
          visible={false}
          onClick={(e) => handleMeshClick(rg, e)}
          onPointerOver={(e) => {
            e.stopPropagation();
            document.body.style.cursor = "pointer";
          }}
          onPointerOut={() => {
            document.body.style.cursor = "auto";
          }}
        >
          <sphereGeometry args={[Math.max(0.055, rg.radius * 2.4), 6, 4]} />
          <meshBasicMaterial />
        </instancedMesh>
      ))}

      {showSynapses && (
        <lineSegments ref={lineRef} geometry={edge.geo} frustumCulled={false}>
          <lineBasicMaterial
            vertexColors
            transparent
            opacity={compact ? 0.3 : 0.4}
            blending={THREE.AdditiveBlending}
            depthWrite={false}
            toneMapped={false}
          />
        </lineSegments>
      )}

      <mesh ref={ringRef} visible={false} frustumCulled={false} renderOrder={5}>
        <ringGeometry args={[0.94, 1, 64]} />
        <meshBasicMaterial
          transparent
          opacity={0}
          side={THREE.DoubleSide}
          blending={THREE.AdditiveBlending}
          depthWrite={false}
          toneMapped={false}
        />
      </mesh>

      {/* pulsing selection ring on the inspected neuron (emerald) */}
      <mesh ref={selRingRef} visible={false} frustumCulled={false} renderOrder={10}>
        <ringGeometry args={[0.78, 1, 48]} />
        <meshBasicMaterial
          color={EMERALD}
          transparent
          opacity={0.8}
          side={THREE.DoubleSide}
          blending={THREE.AdditiveBlending}
          depthWrite={false}
          depthTest={false}
          toneMapped={false}
        />
      </mesh>

      {!compact && (
        <Stars radius={45} depth={18} count={900} factor={2.4} saturation={0} fade speed={0.4} />
      )}

      <OrbitControls
        autoRotate={autoRotate}
        autoRotateSpeed={0.55}
        enableDamping
        dampingFactor={0.08}
        enablePan
        enableZoom
        minDistance={2.4}
        maxDistance={13}
        target={[0, 0, 0.45]}
      />
    </>
  );
}

// ---------------------------------------------------------------------------
// Legend
// ---------------------------------------------------------------------------

function Legend({ brain }: { brain: FlyBrain }) {
  return (
    <div className="absolute bottom-2 left-2 z-10 flex max-w-[calc(100%-1rem)] flex-wrap items-center gap-x-3 gap-y-1 rounded-lg border border-white/10 bg-black/55 px-2.5 py-1.5 text-[10px] leading-none text-zinc-300 backdrop-blur-sm">
      {brain.regions.map((rg) => {
        const meta = REGION_META[rg.region];
        return (
          <span key={rg.region} className="inline-flex items-center gap-1.5 whitespace-nowrap">
            {rg.region === "mbon" ? (
              <span className="flex h-2 w-2 overflow-hidden rounded-full">
                <span className="h-full w-1/2" style={{ background: EMERALD }} />
                <span className="h-full w-1/2" style={{ background: ROSE }} />
              </span>
            ) : (
              <span className="h-2 w-2 rounded-full" style={{ background: meta.color }} />
            )}
            <span>{meta.label}</span>
            <span className="text-zinc-500">{rg.count}</span>
          </span>
        );
      })}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Wrapper (HTML overlay + Canvas)
// ---------------------------------------------------------------------------

export function BrainVisualizer3D({
  brain,
  className,
  height = 420,
  compact = false,
  autoRotate = true,
  showSynapses = true,
  onNeuronSelect,
  selectedNeuron = null,
  pokeNonce = 0,
}: BrainVisualizer3DProps) {
  const [tooltip, setTooltip] = useState<PokeTip | null>(null);
  const tipTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // pointer-down position, to tell a genuine click on empty space apart from
  // an orbit drag (same 6 px threshold as the neuron click handler)
  const pointerDownPos = useRef<{ x: number; y: number } | null>(null);
  // remount the whole scene when the brain instance is swapped
  const sceneKey = useMemo(() => `brain-scene-${++sceneIdCounter}`, [brain]);

  const handlePoke = useCallback((tip: PokeTip) => {
    setTooltip(tip);
    if (tipTimer.current) clearTimeout(tipTimer.current);
    tipTimer.current = setTimeout(() => setTooltip(null), 1800);
  }, []);

  useEffect(
    () => () => {
      if (tipTimer.current) clearTimeout(tipTimer.current);
      document.body.style.cursor = "auto";
    },
    [],
  );

  const handlePointerDown = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    pointerDownPos.current = { x: e.clientX, y: e.clientY };
  }, []);

  // clicking empty space (not a drag) deselects the inspected neuron
  const handlePointerMissed = useCallback(
    (e: MouseEvent) => {
      if (!onNeuronSelect) return;
      const pd = pointerDownPos.current;
      if (pd) {
        const dx = e.clientX - pd.x;
        const dy = e.clientY - pd.y;
        if (Math.hypot(dx, dy) > 6) return; // that was an orbit drag
      }
      onNeuronSelect(null);
    },
    [onNeuronSelect],
  );

  return (
    <div
      data-testid="brain-visualizer"
      className={cn(
        "relative isolate overflow-hidden rounded-xl border border-border/60 bg-[#0a0a0f]",
        className,
      )}
      style={{ height }}
      onPointerDown={handlePointerDown}
    >
      {brain ? (
        <Canvas
          frameloop="always"
          dpr={[1, compact ? 1.5 : 2]}
          gl={{ antialias: true, powerPreference: "high-performance" }}
          camera={{ position: [0, 1.15, 7.4], fov: 48 }}
          onPointerMissed={handlePointerMissed}
        >
          <BrainScene
            key={sceneKey}
            brain={brain}
            compact={compact}
            autoRotate={autoRotate}
            showSynapses={showSynapses}
            onPoke={handlePoke}
            onNeuronSelect={onNeuronSelect}
            selectedNeuron={selectedNeuron}
            pokeNonce={pokeNonce}
          />
        </Canvas>
      ) : (
        <div className="flex h-full items-center justify-center p-4 text-center text-sm text-muted-foreground">
          waiting for a brain…
        </div>
      )}

      {!compact && brain && (
        <>
          <div className="pointer-events-none absolute right-2 top-2 z-10 rounded-md border border-white/10 bg-black/40 px-2 py-1 text-[10px] text-zinc-400 backdrop-blur-sm">
            click a neuron to poke + inspect · click empty space to deselect ·
            drag to orbit
          </div>
          <Legend brain={brain} />
        </>
      )}

      {tooltip && (
        <div
          className="pointer-events-none absolute z-20 -translate-x-1/2 -translate-y-[130%] whitespace-nowrap rounded-md border border-white/15 bg-black/85 px-2 py-1 text-[11px] font-medium text-zinc-100 shadow-lg"
          style={{ left: tooltip.x, top: tooltip.y }}
        >
          <span className="font-semibold">{tooltip.region}</span>
          <span className="ml-1.5 text-zinc-400">#{tooltip.neuron}</span>
          <span className="ml-1.5 text-amber-300">⚡ +2.0</span>
        </div>
      )}
    </div>
  );
}
