"use client";

import { useEffect, useId, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { BrainLab } from "@/components/fly/BrainLab";
import { DinoTrainer } from "@/components/fly/DinoTrainer";
import { BicycleTrainer } from "@/components/fly/BicycleTrainer";
import { BrainLibrary } from "@/components/fly/BrainLibrary";
import { HowItWorks } from "@/components/fly/HowItWorks";
import {
  ShortcutsSheet,
  Kbd,
} from "@/components/fly/ShortcutsSheet";
import { useBrainStore } from "@/lib/flybrain/store";
import {
  playSound,
  useSoundMuted,
  toggleSoundMuted,
  hydrateSoundMuted,
  useSoundVolume,
  setSoundVolume,
} from "@/lib/sound";
import {
  Bike,
  BookOpen,
  Bug,
  Gamepad2,
  Github,
  Keyboard,
  Library,
  Volume2,
  VolumeX,
  X,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Slider } from "@/components/ui/slider";
import { Switch } from "@/components/ui/switch";
import { cn } from "@/lib/utils";

/* ------------------------------------------------------------------ */
/* Hand-crafted animated drosophila mark (wings flutter via globals.css */
/* `.fly-wing` keyframes; aria-hidden — adjacent title carries meaning) */
/* ------------------------------------------------------------------ */

function FlyLogo({ className }: { className?: string }) {
  const uid = useId().replace(/:/g, "");
  return (
    <svg
      viewBox="0 0 48 48"
      aria-hidden="true"
      focusable="false"
      className={cn(
        "shrink-0 drop-shadow-[0_2px_8px_rgba(245,158,11,0.3)]",
        className,
      )}
    >
      <defs>
        <linearGradient id={`${uid}-thorax`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="#fbbf24" />
          <stop offset="100%" stopColor="#b45309" />
        </linearGradient>
        <linearGradient id={`${uid}-abdomen`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="#d97706" />
          <stop offset="100%" stopColor="#7c2d12" />
        </linearGradient>
      </defs>

      {/* translucent shimmering wings, folded back over the abdomen */}
      <g transform="rotate(-34 26 19)">
        <ellipse
          className="fly-wing fly-wing-back"
          cx="34"
          cy="12"
          rx="10"
          ry="3.8"
          fill="rgba(224,255,239,0.07)"
          stroke="rgba(167,243,208,0.22)"
          strokeWidth="0.8"
        />
      </g>
      <g transform="rotate(-19 26 19)">
        <ellipse
          className="fly-wing fly-wing-front"
          cx="32"
          cy="15"
          rx="11.5"
          ry="4.4"
          fill="rgba(224,255,239,0.13)"
          stroke="rgba(167,243,208,0.38)"
          strokeWidth="0.9"
        />
      </g>

      {/* tiny legs */}
      <g
        stroke="#b45309"
        strokeWidth="1.3"
        strokeLinecap="round"
        strokeLinejoin="round"
        fill="none"
      >
        <path d="M21 27.5 19.5 32.5 22.5 34.5" />
        <path d="M24.5 28 23.5 33.5 26.5 35" />
        <path d="M28 27 28.5 32.5 31.5 33.5" />
      </g>

      {/* segmented abdomen */}
      <ellipse
        cx="36"
        cy="23.5"
        rx="9.2"
        ry="5.4"
        fill={`url(#${uid}-abdomen)`}
        stroke="rgba(124,45,18,0.7)"
        strokeWidth="0.7"
      />
      <g stroke="rgba(124,45,18,0.55)" strokeWidth="0.9" fill="none">
        <path d="M31.8 20 Q32.8 23.5 31.8 27" />
        <path d="M36.2 19.4 Q37.3 23.5 36.2 27.6" />
        <path d="M40.4 20.4 Q41.3 23.5 40.4 26.8" />
      </g>

      {/* tan thorax */}
      <ellipse
        cx="24"
        cy="22"
        rx="7.2"
        ry="6.2"
        fill={`url(#${uid}-thorax)`}
        stroke="rgba(146,64,14,0.7)"
        strokeWidth="0.7"
      />

      {/* round head with red compound eye + antenna */}
      <circle
        cx="13.5"
        cy="20"
        r="6"
        fill={`url(#${uid}-thorax)`}
        stroke="rgba(146,64,14,0.7)"
        strokeWidth="0.7"
      />
      <circle cx="12.6" cy="19.2" r="4.3" fill="#f87171" />
      <circle
        cx="12.6"
        cy="19.2"
        r="4.3"
        fill="none"
        stroke="rgba(159,18,57,0.6)"
        strokeWidth="0.6"
      />
      <circle cx="11.1" cy="17.5" r="1.1" fill="rgba(254,202,202,0.8)" />
      <path
        d="M9.6 16.6 Q6.9 13.2 7.9 10.4"
        stroke="#b45309"
        strokeWidth="1.1"
        fill="none"
        strokeLinecap="round"
      />
      <circle cx="7.9" cy="10.4" r="0.9" fill="#b45309" />
    </svg>
  );
}

/* ------------------------------------------------------------------ */
/* Tab definitions — one accent per room of the lab                    */
/* ------------------------------------------------------------------ */

interface TabDef {
  value: string;
  label: string;
  Icon: LucideIcon;
  /** active-state text/icon color (light + dark variants) */
  activeText: string;
  /** shared-layout pill: bg accent/10 + border accent/30 */
  pill: string;
  /** hover accent for the inactive state */
  hover: string;
}

const TABS: TabDef[] = [
  {
    value: "lab",
    label: "Brain Lab",
    Icon: Bug,
    activeText:
      "data-[state=active]:text-emerald-400 dark:data-[state=active]:text-emerald-400",
    pill: "border-emerald-500/30 bg-emerald-500/10",
    hover: "hover:text-emerald-300",
  },
  {
    value: "dino",
    label: "Dino Training",
    Icon: Gamepad2,
    activeText:
      "data-[state=active]:text-amber-400 dark:data-[state=active]:text-amber-400",
    pill: "border-amber-500/30 bg-amber-500/10",
    hover: "hover:text-amber-300",
  },
  {
    value: "bicycle",
    label: "Bicycle Training",
    Icon: Bike,
    activeText:
      "data-[state=active]:text-rose-400 dark:data-[state=active]:text-rose-400",
    pill: "border-rose-500/30 bg-rose-500/10",
    hover: "hover:text-rose-300",
  },
  {
    value: "library",
    label: "Brain Library",
    Icon: Library,
    activeText:
      "data-[state=active]:text-teal-400 dark:data-[state=active]:text-teal-400",
    pill: "border-teal-500/30 bg-teal-500/10",
    hover: "hover:text-teal-300",
  },
  {
    value: "docs",
    label: "How It Works",
    Icon: BookOpen,
    activeText:
      "data-[state=active]:text-orange-400 dark:data-[state=active]:text-orange-400",
    pill: "border-orange-500/30 bg-orange-500/10",
    hover: "hover:text-orange-300",
  },
];

const PILL_SPRING = {
  type: "spring",
  stiffness: 380,
  damping: 32,
} as const;

/* ------------------------------------------------------------------ */
/* Page                                                                */
/* ------------------------------------------------------------------ */

export default function Home() {
  const [tab, setTab] = useState("lab");
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  const banner = useBrainStore((s) => s.banner);
  const clearBanner = useBrainStore((s) => s.clearBanner);
  const muted = useSoundMuted();
  const volume = useSoundVolume();

  useEffect(() => {
    hydrateSoundMuted();
  }, []);

  // ---- keyboard shortcuts: 1–5 switch rooms, M toggles sound ------------
  // (digits never collide with the Dino duel's arrow/space controls; typing
  // in inputs and modifier combos are ignored)
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (
        t &&
        (t.tagName === "INPUT" ||
          t.tagName === "TEXTAREA" ||
          t.tagName === "SELECT" ||
          t.isContentEditable)
      )
        return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key >= "1" && e.key <= "5") {
        const next = TABS[Number(e.key) - 1];
        if (next) {
          setTab(next.value);
          playSound("click");
        }
      } else if (e.key === "m" || e.key === "M") {
        toggleSoundMuted();
      } else if (e.key === "?") {
        e.preventDefault(); // Firefox uses "/" for quick-find
        setShortcutsOpen((v) => !v);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  return (
    <div className="flex min-h-screen flex-col bg-background text-foreground">
      {/* Header */}
      <header className="sticky top-0 z-40 border-b border-border/60 bg-background/80 backdrop-blur-md">
        {/* faint emerald hairline along the header's bottom edge */}
        <div className="pointer-events-none absolute inset-x-0 bottom-0 h-px bg-gradient-to-r from-emerald-500/60 via-emerald-500/10 to-transparent" />
        <div className="mx-auto flex max-w-7xl items-center gap-3 px-4 py-3">
          <div className="flex items-center gap-2.5">
            <FlyLogo className="h-10 w-10" />
            <div className="leading-tight">
              <h1 className="bg-gradient-to-r from-amber-400 to-emerald-400 bg-clip-text text-base font-semibold tracking-tight text-transparent sm:text-lg">
                Expert Fruit Fly
              </h1>
              <p className="hidden text-xs text-muted-foreground sm:block">
                A connectome-inspired brain that learns by reward &amp;
                punishment
              </p>
            </div>
          </div>
          <div className="ml-auto flex items-center gap-1.5">
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="ghost"
                  size="sm"
                  aria-label="Keyboard shortcuts"
                  aria-keyshortcuts="?"
                  onClick={() => {
                    setShortcutsOpen(true);
                    playSound("click");
                  }}
                  className="h-9 w-9 px-0 text-muted-foreground hover:text-foreground"
                >
                  <Keyboard className="h-4 w-4" />
                </Button>
              </TooltipTrigger>
              <TooltipContent>Shortcuts (?)</TooltipContent>
            </Tooltip>
            <Popover>
              <Tooltip>
                <TooltipTrigger asChild>
                  <PopoverTrigger asChild>
                    <Button
                      variant="ghost"
                      size="sm"
                      aria-label="Sound settings"
                      className="h-9 w-9 px-0 text-muted-foreground hover:text-foreground"
                    >
                      {muted ? (
                        <VolumeX className="h-4 w-4" />
                      ) : (
                        <Volume2 className="h-4 w-4" />
                      )}
                    </Button>
                  </PopoverTrigger>
                </TooltipTrigger>
                <TooltipContent>Volume &amp; mute (M)</TooltipContent>
              </Tooltip>
              <PopoverContent align="end" className="w-64 p-4">
                <div className="flex flex-col gap-4">
                  <div className="flex items-center justify-between">
                    <span className="text-sm font-medium">Sound</span>
                    <div className="flex items-center gap-2">
                      <Switch
                        id="sound-enabled"
                        checked={!muted}
                        onCheckedChange={(on) => {
                          if (on === muted) toggleSoundMuted();
                        }}
                        aria-label={muted ? "Unmute" : "Mute"}
                      />
                      <Label
                        htmlFor="sound-enabled"
                        className="cursor-pointer text-xs text-muted-foreground"
                      >
                        {muted ? "muted" : "on"}
                      </Label>
                    </div>
                  </div>
                  <div className="flex flex-col gap-2">
                    <div className="flex items-center justify-between">
                      <Label
                        htmlFor="volume-slider"
                        className="text-xs text-muted-foreground"
                      >
                        Volume
                      </Label>
                      <span className="text-xs font-medium tabular-nums text-foreground">
                        {Math.round(volume * 100)}%
                      </span>
                    </div>
                    <Slider
                      id="volume-slider"
                      min={0}
                      max={1}
                      step={0.05}
                      value={[volume]}
                      onValueChange={(v) => setSoundVolume(v[0])}
                      aria-label="Master volume"
                    />
                  </div>
                  <Button
                    variant="outline"
                    size="sm"
                    className="h-8 w-full text-xs"
                    onClick={() => playSound("sugar")}
                  >
                    Test chime
                  </Button>
                </div>
              </PopoverContent>
            </Popover>
            <Button
              variant="ghost"
              size="sm"
              className="text-muted-foreground"
              onClick={() =>
                window.open(
                  "https://github.com/pale-john1960/expert-fruit-fly",
                  "_blank",
                )
              }
            >
              <Github className="mr-1.5 h-4 w-4" />
              <span className="hidden sm:inline">GitHub</span>
            </Button>
          </div>
        </div>
        {/* Tabs */}
        <div className="mx-auto max-w-7xl px-4">
          <Tabs value={tab} onValueChange={setTab} className="w-full">
            <TabsList className="no-scrollbar h-auto w-full justify-start gap-1 overflow-x-auto rounded-none bg-transparent p-0 pb-1.5">
              {TABS.map(({ value, label, Icon, activeText, pill, hover }) => (
                <TabsTrigger
                  key={value}
                  value={value}
                  className={cn(
                    "relative flex-none gap-0 whitespace-nowrap rounded-lg px-3.5 py-2.5 text-sm font-medium text-muted-foreground transition-colors",
                    hover,
                    activeText,
                  )}
                >
                  {tab === value && (
                    <motion.span
                      layoutId="fly-tab-pill"
                      aria-hidden="true"
                      className={cn(
                        "pointer-events-none absolute inset-0 rounded-lg border",
                        pill,
                      )}
                      transition={PILL_SPRING}
                    />
                  )}
                  <span className="relative z-10 inline-flex items-center gap-1.5">
                    <Icon className="h-4 w-4" />
                    {label}
                  </span>
                </TabsTrigger>
              ))}
            </TabsList>
          </Tabs>
        </div>
      </header>

      {/* Banner */}
      <AnimatePresence>
        {banner && (
          <motion.div
            key="load-banner"
            initial={{ opacity: 0, y: -14 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -10 }}
            transition={{ duration: 0.28, ease: "easeOut" }}
            className="mx-auto mt-3 flex w-full max-w-7xl items-start gap-2 rounded-lg border border-emerald-600/40 bg-emerald-500/10 px-4 py-2.5 text-sm text-emerald-700 dark:text-emerald-300"
          >
            <span className="flex-1">{banner}</span>
            <button
              onClick={clearBanner}
              className="mt-px shrink-0 rounded-sm opacity-60 transition-opacity hover:opacity-100"
              aria-label="Dismiss"
            >
              <X className="h-4 w-4" />
            </button>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Main */}
      <main className="mx-auto w-full max-w-7xl flex-1 px-4 py-6">
        <Tabs value={tab} onValueChange={setTab}>
          <TabsContent value="lab" className="mt-0">
            <BrainLab />
          </TabsContent>
          <TabsContent value="dino" className="mt-0">
            <DinoTrainer />
          </TabsContent>
          <TabsContent value="bicycle" className="mt-0">
            <BicycleTrainer />
          </TabsContent>
          <TabsContent value="library" className="mt-0">
            <BrainLibrary />
          </TabsContent>
          <TabsContent value="docs" className="mt-0">
            <HowItWorks />
          </TabsContent>
        </Tabs>
      </main>

      {/* Footer */}
      <footer className="mt-auto border-t border-border/60 bg-muted/30 pb-[env(safe-area-inset-bottom)]">
        <div className="mx-auto grid max-w-7xl gap-8 px-4 py-8 text-xs text-muted-foreground sm:grid-cols-2 md:grid-cols-3">
          {/* Brand */}
          <div className="flex flex-col items-start gap-3">
            <div className="flex items-center gap-2.5">
              <FlyLogo className="h-7 w-7" />
              <span className="text-sm font-semibold text-foreground">
                Expert Fruit Fly
              </span>
            </div>
            <p className="max-w-xs leading-relaxed">
              A connectome-inspired brain that learns by reward &amp;
              punishment.
            </p>
            <p className="max-w-xs leading-relaxed">
              928-neuron pipeline: retina → optic lobe → mushroom body → motor,
              trained with dopamine-gated plasticity + neuroevolution.
            </p>
          </div>

          {/* Explore */}
          <nav className="flex flex-col gap-3" aria-label="Footer">
            <h2 className="text-[11px] font-semibold uppercase tracking-widest text-foreground/80">
              Explore
            </h2>
            <div className="flex flex-wrap gap-1.5">
              {TABS.map(({ value, label, Icon, hover }, i) => (
                <button
                  key={value}
                  type="button"
                  onClick={() => setTab(value)}
                  title={`Press ${i + 1}`}
                  className={cn(
                    "inline-flex h-8 items-center gap-1.5 rounded-md px-2.5 text-xs font-medium text-muted-foreground transition-colors hover:bg-accent hover:text-foreground",
                    "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40",
                    hover,
                  )}
                >
                  <Icon className="h-3.5 w-3.5" />
                  {label}
                  <span className="rounded border border-border/60 px-1 font-mono text-[10px] text-muted-foreground/70">
                    {i + 1}
                  </span>
                </button>
              ))}
            </div>
            <p className="flex items-center gap-1.5 leading-relaxed">
              <Kbd>1</Kbd>–<Kbd>5</Kbd> switch rooms · <Kbd>M</Kbd> sound ·{" "}
              <Kbd>?</Kbd> shortcuts
            </p>
          </nav>

          {/* Credits */}
          <div className="flex flex-col gap-3">
            <h2 className="text-[11px] font-semibold uppercase tracking-widest text-foreground/80">
              Credits
            </h2>
            <p className="leading-relaxed">
              Connectome science: FlyWire · MaleCNS (Janelia + Google)
            </p>
            <p className="leading-relaxed">
              Built with Next.js 16 · three.js · Web Audio
            </p>
            <a
              href="https://github.com/pale-john1960/expert-fruit-fly"
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1.5 rounded-md text-xs font-medium text-muted-foreground transition-colors hover:text-foreground"
            >
              <Github className="h-3.5 w-3.5" />
              pale-john1960/expert-fruit-fly
            </a>
          </div>
        </div>
      </footer>
      {/* Shortcuts help sheet ("?" or the header keyboard button) */}
      <ShortcutsSheet
        open={shortcutsOpen}
        onOpenChange={setShortcutsOpen}
      />
    </div>
  );
}
