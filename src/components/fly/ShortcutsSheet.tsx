"use client";

/**
 * ShortcutsSheet — a styled dialog listing every keyboard shortcut in the
 * app ("?" key or the header keyboard button opens it).
 *
 * Groups mirror the tab accents: emerald (global/lab), amber (dino duel),
 * rose (bicycle challenge). Kbd chips are exported for reuse (page footer).
 */

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Bike, Gamepad2, Sparkles } from "lucide-react";
import { cn } from "@/lib/utils";

/** Tiny keyboard-key chip (shared with the page footer hints). */
export function Kbd({ children }: { children: React.ReactNode }) {
  return (
    <kbd className="rounded border border-border bg-muted px-1.5 py-0.5 font-mono text-[10px] font-medium text-foreground/80 shadow-[inset_0_-1px_0_rgba(0,0,0,0.06)]">
      {children}
    </kbd>
  );
}

interface ShortcutRow {
  keys: string[];
  label: string;
  hint?: string;
}

interface ShortcutGroup {
  icon: React.ReactNode;
  title: string;
  accent: string;
  rows: ShortcutRow[];
}

const GROUPS: ShortcutGroup[] = [
  {
    icon: <Sparkles className="h-4 w-4" />,
    title: "Everywhere",
    accent: "text-emerald-400",
    rows: [
      { keys: ["1"], label: "Brain Lab" },
      { keys: ["2"], label: "Dino Training" },
      { keys: ["3"], label: "Bicycle Training" },
      { keys: ["4"], label: "Brain Library" },
      { keys: ["5"], label: "How It Works" },
      {
        keys: ["M"],
        label: "Mute / unmute sound",
        hint: "Volume lives in the header speaker popover",
      },
      {
        keys: ["?"],
        label: "Toggle this shortcut panel",
        hint: "Shift + / on most keyboards",
      },
    ],
  },
  {
    icon: <Gamepad2 className="h-4 w-4" />,
    title: "You vs the fly — Dino duel",
    accent: "text-amber-400",
    rows: [
      {
        keys: ["↑", "Space", "W"],
        label: "Jump",
        hint: "Edge-triggered — key repeat is ignored",
      },
      {
        keys: ["↓", "S"],
        label: "Duck (hold)",
        hint: "Ducking mid-air fast-falls, just like the flies",
      },
    ],
  },
  {
    icon: <Bike className="h-4 w-4" />,
    title: "You vs the fly — Bicycle challenge",
    accent: "text-rose-400",
    rows: [
      {
        keys: ["←", "→"],
        label: "Steer / lean",
        hint: "Hold to lean further — release to recover",
      },
      { keys: ["A", "D"], label: "Steer (left-hand alt)" },
    ],
  },
];

export interface ShortcutsSheetProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function ShortcutsSheet({ open, onOpenChange }: ShortcutsSheetProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md gap-0 p-0">
        <DialogHeader className="border-b border-border/60 px-5 py-4">
          <DialogTitle className="flex items-center gap-2 text-base">
            <Sparkles className="h-4 w-4 text-emerald-400" />
            Keyboard shortcuts
          </DialogTitle>
          <DialogDescription className="text-xs">
            The whole lab is playable without touching the mouse.
          </DialogDescription>
        </DialogHeader>

        <div className="max-h-[60vh] overflow-y-auto px-5 py-4">
          {GROUPS.map((g) => (
            <section key={g.title} className="mb-5 last:mb-1">
              <h3
                className={cn(
                  "mb-2 flex items-center gap-2 text-xs font-semibold uppercase tracking-wide",
                  g.accent,
                )}
              >
                {g.icon}
                {g.title}
              </h3>
              <ul className="space-y-1.5">
                {g.rows.map((r) => (
                  <li
                    key={r.label}
                    className="flex items-center justify-between gap-3 rounded-lg border border-border/60 bg-muted/40 px-3 py-2"
                  >
                    <div className="min-w-0">
                      <div className="text-sm text-foreground">{r.label}</div>
                      {r.hint && (
                        <div className="truncate text-xs text-muted-foreground">
                          {r.hint}
                        </div>
                      )}
                    </div>
                    <div className="flex shrink-0 items-center gap-1">
                      {r.keys.map((k) => (
                        <Kbd key={k}>{k}</Kbd>
                      ))}
                    </div>
                  </li>
                ))}
              </ul>
            </section>
          ))}
        </div>

        <p className="border-t border-border/60 px-5 py-3 text-[11px] leading-relaxed text-muted-foreground">
          Shortcuts pause while you type in an input, and they never fire with
          Ctrl/⌘/Alt held. Arrow keys only act inside duels and challenges.
        </p>
      </DialogContent>
    </Dialog>
  );
}
