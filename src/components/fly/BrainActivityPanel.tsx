"use client";

/**
 * BrainActivityPanel — compact 2D canvas showing live brain activity.
 *
 * One horizontal strip per region (retina → motor): every neuron is a small
 * cell whose brightness follows brain.rates, flashing white on spikes.
 * A dopamine meter at the bottom swings green (reward) / rose (punishment)
 * around a centered zero line.
 *
 * Reads brain state every animation frame directly from the FlyBrain —
 * no React re-renders in the hot path.
 */

import { useEffect, useRef } from "react";
import { FlyBrain } from "@/lib/flybrain/engine";
import type { BrainRegion } from "@/lib/flybrain/types";
import { cn } from "@/lib/utils";

export interface BrainActivityPanelProps {
  brain: FlyBrain | null;
  height?: number;
  className?: string;
}

const REGION_SHORT: Record<BrainRegion, string> = {
  retina: "Ret",
  lamina: "Lam",
  medulla: "Med",
  lobula: "Lob",
  kenyon: "KC",
  mbon: "MBON",
  motor: "Mot",
};

/** Anatomical palette — amber optic input, teal/emerald midbrain, magenta KC. */
const REGION_RGB: Record<BrainRegion, [number, number, number]> = {
  retina: [245, 158, 11],
  lamina: [251, 191, 36],
  medulla: [45, 212, 191],
  lobula: [52, 211, 153],
  kenyon: [232, 121, 249],
  mbon: [148, 163, 184], // replaced per-instance by valence below
  motor: [253, 224, 71],
};

const MBON_APPETITIVE: [number, number, number] = [52, 211, 153];
const MBON_AVERSIVE: [number, number, number] = [251, 113, 133];

const BG = "#0a0a0f";
const LABEL_W = 34;

export function BrainActivityPanel({
  brain,
  height = 140,
  className,
}: BrainActivityPanelProps) {
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    if (!brain) return;
    const wrap = wrapRef.current;
    const canvas = canvasRef.current;
    if (!wrap || !canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    let raf = 0;
    let cssW = 0;
    let cssH = 0;
    let dpr = 1;

    const resize = () => {
      const rect = wrap.getBoundingClientRect();
      dpr = Math.min(2, window.devicePixelRatio || 1);
      cssW = Math.max(60, Math.round(rect.width));
      cssH = Math.max(48, Math.round(rect.height));
      canvas.width = Math.round(cssW * dpr);
      canvas.height = Math.round(cssH * dpr);
    };
    resize();
    const ro = new ResizeObserver(resize);
    ro.observe(wrap);

    const draw = () => {
      raf = requestAnimationFrame(draw);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.fillStyle = BG;
      ctx.fillRect(0, 0, cssW, cssH);

      const availW = Math.max(10, cssW - LABEL_W - 6);
      const daH = 18;
      const stripsH = Math.max(28, cssH - daH - 8);
      const nR = brain.regions.length;
      const stripH = stripsH / nR;
      ctx.font = "9px ui-monospace, SFMono-Regular, Menlo, monospace";
      ctx.textBaseline = "middle";

      // ---- per-region activity strips ----
      for (let ri = 0; ri < nR; ri++) {
        const rg = brain.regions[ri];
        const y0 = 4 + ri * stripH;
        ctx.fillStyle = "rgba(161,161,170,0.9)";
        ctx.fillText(REGION_SHORT[rg.region], 2, y0 + stripH / 2);

        const cw = Math.min(availW / rg.count, 9); // auto-fit, capped so tiny regions stay cell-like
        const ch = Math.max(2, Math.floor(stripH) - 2);
        const cellW = Math.max(1, cw - 0.6);
        for (let i = 0; i < rg.count; i++) {
          const gi = rg.start + i;
          const rate = brain.rates[gi];
          const spiked = brain.spiked[gi];
          const energy = Math.min(1, rate + (spiked ? 0.7 : 0));
          const rgb =
            rg.region === "mbon"
              ? brain.mbonValence[i] > 0
                ? MBON_APPETITIVE
                : MBON_AVERSIVE
              : REGION_RGB[rg.region];
          const a = 0.1 + 0.9 * energy;
          ctx.fillStyle = `rgba(${rgb[0]},${rgb[1]},${rgb[2]},${a})`;
          ctx.fillRect(LABEL_W + i * cw, y0 + 1, cellW, ch);
          if (spiked) {
            ctx.fillStyle = "rgba(255,255,255,0.8)";
            ctx.fillRect(LABEL_W + i * cw, y0 + 1, cellW, ch);
          }
        }
      }

      // ---- dopamine meter (centered zero) ----
      const da = brain.getDopamine();
      const daY = cssH - daH + 3;
      const midX = LABEL_W + availW / 2;
      ctx.fillStyle = "rgba(255,255,255,0.14)";
      ctx.fillRect(LABEL_W, daY, availW, 5);
      ctx.fillStyle = "rgba(255,255,255,0.45)";
      ctx.fillRect(midX - 0.5, daY - 2, 1, 9);
      if (Math.abs(da) > 0.004) {
        const len = (availW / 2) * Math.min(1, Math.abs(da));
        ctx.fillStyle = da > 0 ? "#34d399" : "#fb7185";
        ctx.fillRect(da > 0 ? midX : midX - len, daY, len, 5);
      }
      ctx.fillStyle = "rgba(161,161,170,0.9)";
      ctx.fillText("DA", 2, daY + 2);
      const daTxt = da.toFixed(2);
      ctx.fillStyle =
        da > 0.004 ? "#34d399" : da < -0.004 ? "#fb7185" : "rgba(161,161,170,0.9)";
      ctx.fillText(daTxt, cssW - 6 - ctx.measureText(daTxt).width, daY + 2);
    };
    raf = requestAnimationFrame(draw);

    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
    };
  }, [brain]);

  return (
    <div
      ref={wrapRef}
      data-testid="brain-activity-panel"
      className={cn(
        "relative overflow-hidden rounded-lg border border-border/60 bg-[#0a0a0f]",
        className,
      )}
      style={{ height }}
    >
      <canvas ref={canvasRef} className="block h-full w-full" aria-hidden />
      {!brain && (
        <div className="absolute inset-0 flex items-center justify-center text-xs text-muted-foreground">
          no brain
        </div>
      )}
    </div>
  );
}
