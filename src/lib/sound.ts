"use client";

/**
 * Shared sound engine — every effect is synthesized with the Web Audio API
 * (zero audio assets, works offline).
 *
 * Contract for other components:
 *   playSound(name, volume?)   fire-and-forget; safe to call from rAF loops,
 *                              SSR-safe, no-ops when muted; rate-limited per
 *                              sound name so turbo training can't spam.
 *   useSoundMuted()            zustand hook for UI toggles.
 *   toggleSoundMuted()         flips mute + persists to localStorage.
 *   hydrateSoundMuted()        call once on mount (syncs persisted value into
 *                              the store without causing hydration mismatch).
 */

import { create } from "zustand";

export type SoundName =
  | "sugar" // pleasant two-note chime (reward)
  | "shock" // harsh buzz (punishment)
  | "jump" // quick rising boing
  | "crash" // noise burst + low thud
  | "milestone" // little arpeggio (new record)
  | "gen" // soft double blip (generation complete)
  | "fall" // descending sweep (rider falls)
  | "ding" // single bell
  | "click"; // tiny neutral UI click

const STORAGE_KEY = "fly-sound-muted";
const VOLUME_KEY = "fly-sound-volume";

/* ------------------------------------------------------------------ */
/* mute + volume state                                                 */
/* ------------------------------------------------------------------ */

interface SoundStore {
  muted: boolean;
  /** 0..1 master volume scale (default 1 = the original loudness) */
  volume: number;
  setMuted: (m: boolean) => void;
  setVolume: (v: number) => void;
}

export const useSoundStore = create<SoundStore>((set) => ({
  muted: false,
  volume: 1,
  setMuted: (m) => set({ muted: m }),
  setVolume: (v) => set({ volume: v }),
}));

/** Read the persisted preferences into the store — call once from a mount
 *  effect (never during render, to keep SSR/client output identical). */
export function hydrateSoundMuted(): void {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (raw === "1") useSoundStore.getState().setMuted(true);
    // NB: getItem returns null when unset — Number(null) === 0, so parse only
    // when the key actually exists (otherwise a fresh visitor starts muted).
    const rawVol = window.localStorage.getItem(VOLUME_KEY);
    if (rawVol !== null) {
      const vol = Number(rawVol);
      if (Number.isFinite(vol) && vol >= 0 && vol <= 1) {
        useSoundStore.getState().setVolume(vol);
        applyMasterVolume(vol);
      }
    }
  } catch {
    /* localStorage unavailable — ignore */
  }
}

export function toggleSoundMuted(): void {
  const next = !useSoundStore.getState().muted;
  useSoundStore.getState().setMuted(next);
  try {
    window.localStorage.setItem(STORAGE_KEY, next ? "1" : "0");
  } catch {
    /* ignore */
  }
}

export function useSoundMuted(): boolean {
  return useSoundStore((s) => s.muted);
}

export function useSoundVolume(): number {
  return useSoundStore((s) => s.volume);
}

/** Scale the synth's master gain (base loudness 0.5 × volume). Safe before
 *  the AudioContext exists — applyMasterVolume re-runs on every ensureCtx. */
function applyMasterVolume(v: number): void {
  try {
    if (master) master.gain.value = 0.5 * Math.max(0, Math.min(1, v));
  } catch {
    /* ignore */
  }
}

/** Persist + apply a 0..1 master volume. */
export function setSoundVolume(v: number): void {
  const clamped = Math.max(0, Math.min(1, v));
  useSoundStore.getState().setVolume(clamped);
  applyMasterVolume(clamped);
  try {
    window.localStorage.setItem(VOLUME_KEY, String(clamped));
  } catch {
    /* ignore */
  }
}

/* ------------------------------------------------------------------ */
/* synth engine                                                        */
/* ------------------------------------------------------------------ */

let ctx: AudioContext | null = null;
let master: GainNode | null = null;
let noiseBuf: AudioBuffer | null = null;

/** Per-sound minimum interval (ms) — rate limiting for turbo loops. */
const MIN_INTERVAL: Record<SoundName, number> = {
  sugar: 150,
  shock: 150,
  jump: 180,
  crash: 300,
  milestone: 400,
  gen: 250,
  fall: 250,
  ding: 250,
  click: 60,
};

const lastPlayed: Partial<Record<SoundName, number>> = {};

function ensureCtx(): AudioContext | null {
  if (typeof window === "undefined") return null;
  try {
    if (!ctx) {
      const AC: typeof AudioContext | undefined =
        window.AudioContext ??
        (window as unknown as { webkitAudioContext?: typeof AudioContext })
          .webkitAudioContext;
      if (!AC) return null;
      ctx = new AC();
      master = ctx.createGain();
      master.gain.value = 0.5 * useSoundStore.getState().volume;
      master.connect(ctx.destination);
    }
    if (ctx.state === "suspended") void ctx.resume();
    return ctx;
  } catch {
    return null;
  }
}

function getNoise(c: AudioContext): AudioBuffer {
  if (!noiseBuf) {
    noiseBuf = c.createBuffer(1, Math.floor(c.sampleRate * 0.25), c.sampleRate);
    const data = noiseBuf.getChannelData(0);
    for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
  }
  return noiseBuf;
}

interface ToneOpts {
  freq: number;
  endFreq?: number; // sweep target
  dur: number;
  delay?: number; // seconds after now
  gain: number;
  type?: OscillatorType;
}

function tone(c: AudioContext, o: ToneOpts): void {
  if (!master) return;
  const t0 = c.currentTime + (o.delay ?? 0);
  const osc = c.createOscillator();
  const g = c.createGain();
  osc.type = o.type ?? "sine";
  osc.frequency.setValueAtTime(o.freq, t0);
  if (o.endFreq !== undefined) {
    osc.frequency.exponentialRampToValueAtTime(
      Math.max(1, o.endFreq),
      t0 + o.dur,
    );
  }
  g.gain.setValueAtTime(0, t0);
  g.gain.linearRampToValueAtTime(o.gain, t0 + 0.012);
  g.gain.exponentialRampToValueAtTime(0.0001, t0 + o.dur);
  osc.connect(g).connect(master);
  osc.start(t0);
  osc.stop(t0 + o.dur + 0.02);
}

function noise(c: AudioContext, dur: number, gain: number, lowpass: number): void {
  if (!master) return;
  const t0 = c.currentTime;
  const src = c.createBufferSource();
  src.buffer = getNoise(c);
  const filt = c.createBiquadFilter();
  filt.type = "lowpass";
  filt.frequency.value = lowpass;
  const g = c.createGain();
  g.gain.setValueAtTime(gain, t0);
  g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
  src.connect(filt).connect(g).connect(master);
  src.start(t0);
  src.stop(t0 + dur + 0.02);
}

/** Play a named effect. Volume 0..1 scales the effect's built-in loudness. */
export function playSound(name: SoundName, volume = 1): void {
  try {
    if (useSoundStore.getState().muted) return;
    const now = performance.now();
    const min = MIN_INTERVAL[name];
    const last = lastPlayed[name] ?? -Infinity;
    if (now - last < min) return;
    lastPlayed[name] = now;

    const c = ensureCtx();
    if (!c) return;
    const v = Math.max(0, Math.min(1, volume));

    switch (name) {
      case "sugar": // E5 -> A5, soft and sweet
        tone(c, { freq: 659.25, dur: 0.16, gain: 0.22 * v });
        tone(c, { freq: 880, dur: 0.28, gain: 0.22 * v, delay: 0.11 });
        break;
      case "shock": // harsh 110 Hz sawtooth buzz
        tone(c, {
          freq: 110,
          endFreq: 70,
          dur: 0.22,
          gain: 0.3 * v,
          type: "sawtooth",
        });
        noise(c, 0.12, 0.12 * v, 900);
        break;
      case "jump": // rising boing
        tone(c, { freq: 280, endFreq: 640, dur: 0.12, gain: 0.18 * v });
        break;
      case "crash": // noise thud
        noise(c, 0.25, 0.3 * v, 1400);
        tone(c, { freq: 95, endFreq: 55, dur: 0.3, gain: 0.28 * v, type: "triangle" });
        break;
      case "milestone": // C5 E5 G5 arpeggio
        tone(c, { freq: 523.25, dur: 0.14, gain: 0.16 * v });
        tone(c, { freq: 659.25, dur: 0.14, gain: 0.16 * v, delay: 0.09 });
        tone(c, { freq: 783.99, dur: 0.24, gain: 0.18 * v, delay: 0.18 });
        break;
      case "gen": // soft double blip
        tone(c, { freq: 880, dur: 0.07, gain: 0.1 * v });
        tone(c, { freq: 660, dur: 0.1, gain: 0.1 * v, delay: 0.08 });
        break;
      case "fall": // descending sweep
        tone(c, { freq: 500, endFreq: 170, dur: 0.3, gain: 0.2 * v, type: "triangle" });
        break;
      case "ding": // single bell w/ harmonic
        tone(c, { freq: 1318.5, dur: 0.4, gain: 0.14 * v });
        tone(c, { freq: 1975, dur: 0.22, gain: 0.05 * v, delay: 0.01 });
        break;
      case "click": // tiny neutral tick
        tone(c, { freq: 1400, endFreq: 900, dur: 0.03, gain: 0.06 * v });
        break;
    }
  } catch {
    /* never let audio break a training loop */
  }
}
