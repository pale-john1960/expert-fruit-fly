"use client";

/**
 * HowItWorks — friendly, plain-language documentation for the whole project.
 * Sections: the story, the brain, learning by reward/punishment, generations,
 * saving & loading, and a mini glossary.
 */

import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import {
  DopamineLoopDiagram,
  EvolutionLoopDiagram,
  PipelineDiagram,
  REGION_HEX,
} from "./HowItWorksDiagrams";
import {
  Bug,
  Eye,
  Zap,
  Candy,
  Dna,
  Save,
  ArrowRight,
  Lightbulb,
  BookOpen,
  Brain,
  Sparkles,
  Database,
  Repeat,
} from "lucide-react";

function Section({
  icon,
  title,
  subtitle,
  children,
}: {
  icon: React.ReactNode;
  title: string;
  subtitle?: string;
  children: React.ReactNode;
}) {
  return (
    <Card className="border-border/70 bg-card/60">
      <CardHeader className="pb-3">
        <div className="flex items-center gap-3">
          <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-primary/15 text-primary">
            {icon}
          </div>
          <div>
            <CardTitle className="text-lg">{title}</CardTitle>
            {subtitle && (
              <p className="mt-0.5 text-sm text-muted-foreground">{subtitle}</p>
            )}
          </div>
        </div>
      </CardHeader>
      <CardContent className="space-y-4 text-sm leading-relaxed text-muted-foreground">
        {children}
      </CardContent>
    </Card>
  );
}

function Analogy({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex gap-3 rounded-lg border border-amber-500/30 bg-amber-500/10 p-4 text-amber-900 dark:text-amber-200">
      <Lightbulb className="mt-0.5 h-5 w-5 shrink-0" />
      <div className="text-sm leading-relaxed">{children}</div>
    </div>
  );
}

const PIPELINE = [
  { key: "retina", name: "Retina", count: "216", desc: "The eye — 24×9 pixels of the world, brightness only" },
  { key: "lamina", name: "Lamina", count: "216", desc: "First wiring — keeps what changes, ignores what stays still" },
  { key: "medulla", name: "Medulla", count: "192", desc: "Feature detectors — bright spots, dark spots, edges, motion" },
  { key: "lobula", name: "Lobula", count: "48", desc: "Spiking neurons — each watches one patch of the view" },
  { key: "kenyon", name: "Kenyon cells", count: "240", desc: "The mushroom body — sparse code for “what is happening”" },
  { key: "mbon", name: "MBONs", count: "12", desc: "Memory outputs — appetitive (green) & aversive (rose) compartments" },
  { key: "motor", name: "Motor", count: "2–4", desc: "Muscle commands — jump, duck, steer, pedal" },
];

export function HowItWorks() {
  return (
    <div className="space-y-6">
      {/* Hero */}
      <div className="rounded-xl border border-border/70 bg-gradient-to-br from-primary/10 via-card to-card p-6">
        <div className="flex items-start gap-4">
          <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-xl bg-primary text-primary-foreground">
            <Bug className="h-7 w-7" />
          </div>
          <div className="space-y-2">
            <h2 className="text-xl font-semibold tracking-tight sm:text-2xl">
              How this fruit fly brain works
            </h2>
            <p className="max-w-3xl text-sm leading-relaxed text-muted-foreground sm:text-base">
              In 2024–2026, scientists finished mapping every neuron in a fruit
              fly&apos;s brain (~140,000 neurons, millions of synapses) and released
              the map for free — it&apos;s called a{" "}
              <span className="text-foreground">connectome</span>. People then
              wired it into games and robots. This app is a{" "}
              <span className="text-foreground">browser-sized version of that idea</span>:
              a 928-neuron fly brain, inspired by the real one, that you can watch
              think, teach with sugar and shocks, and train to play games.
            </p>
          </div>
        </div>
      </div>

      {/* 1. The brain */}
      <Section
        icon={<Brain className="h-5 w-5" />}
        title="1 · The brain"
        subtitle="Light goes in the front, muscle commands come out the back"
      >
        <p>
          The brain is a pipeline of seven regions, modelled on real fruit fly
          anatomy. Each region is a layer of neurons; each neuron is a tiny
          simulator that charges up as input arrives and{" "}
          <span className="text-foreground">fires a spike</span> when it reaches
          a threshold — the classic{" "}
          <span className="text-foreground">leaky integrate-and-fire</span> model
          used in real connectome simulations.
        </p>
        <PipelineDiagram />
        <p className="text-xs text-muted-foreground">
          Region by region — colors match the 3-D brain viewer:
        </p>
        <div className="grid gap-2 sm:grid-cols-2">
          {PIPELINE.map((r) => (
            <div
              key={r.name}
              className="flex items-start gap-2.5 rounded-lg border border-border bg-muted/40 p-2.5"
            >
              <span
                aria-hidden="true"
                className="mt-1.5 h-2.5 w-2.5 shrink-0 rounded-full"
                style={{ backgroundColor: REGION_HEX[r.key] }}
              />
              <p className="text-xs leading-relaxed">
                <span className="font-medium text-foreground">{r.name}</span>{" "}
                <Badge variant="secondary" className="h-5 px-1.5 text-[10px]">
                  {r.count}
                </Badge>{" "}
                — {r.desc}
              </p>
            </div>
          ))}
        </div>
        <p>
          The first three regions are the fly&apos;s{" "}
          <span className="text-foreground">innate visual hardware</span> — fixed
          wiring it is born with (like your retina: you can&apos;t learn to see
          edges differently). The learning lives at the back half, especially the{" "}
          <span className="text-foreground">mushroom body</span> — the part a
          real fly uses to remember &quot;sweet smell = food&quot; and{" "}
          &quot;shock = danger&quot;.
        </p>
        <Analogy>
          Think of it as a factory line: the eye reports pixels, the optic lobe
          turns them into &quot;something bright is approaching from the
          right&quot;, the mushroom body asks &quot;was that good or bad last
          time?&quot;, and the motor neurons fire the jump.
        </Analogy>
      </Section>

      {/* 2. Reward & punishment */}
      <Section
        icon={<Candy className="h-5 w-5" />}
        title="2 · Why reward & punishment work"
        subtitle="Dopamine decides which connections survive"
      >
        <p>
          Every trainable connection keeps a tiny{" "}
          <span className="text-foreground">eligibility trace</span> — a
          fading memory of &quot;these two neurons just fired together&quot;.
          When something good happens (sugar — the game shows it as a green
          dopamine pulse), the brain strengthens exactly those recently-active
          connections. When something bad happens (shock — red pulse), it
          weakens them.
        </p>
        <div className="rounded-lg border border-border bg-muted/40 p-4 font-mono text-xs leading-relaxed sm:text-sm">
          Δw = learningRate × <span className="text-emerald-500">dopamine</span> ×
          eligibility
          <div className="mt-2 font-sans text-xs text-muted-foreground">
            (&quot;change this wire&quot; = &quot;how good was it&quot; ×
            &quot;how recently was this wire used&quot;)
          </div>
        </div>
        <DopamineLoopDiagram />
        <p>
          This is the same trick the viral fly sims used — a{" "}
          <span className="text-foreground">3-factor learning rule</span>, and
          it&apos;s genuinely how biologists believe real flies learn. The
          mushroom body even has separate compartments: green{" "}
          <span className="text-foreground">appetitive MBONs</span> that learn
          &quot;approach this&quot; from rewards, and rose{" "}
          <span className="text-foreground">aversive MBONs</span> that learn
          &quot;avoid this&quot; from punishments.
        </p>
        <Analogy>
          You touch a hot stove once (shock!) → the connections that caused
          &quot;hand forward&quot; get weakened → next time you&apos;re near the
          stove, those neurons are quieter. Eat a nice cookie after opening a
          specific drawer (sugar!) → &quot;open THAT drawer&quot; connections
          strengthen. Nobody tells the brain <em>which</em> wires to change —
          the timing does it automatically.
        </Analogy>
        <p>
          Try it in the <span className="text-foreground">Brain Lab</span> tab:
          pair Sugar with the bar sweeping past a spot ~10 times, then watch the
          motor bars change.
        </p>
      </Section>

      {/* 3. Generations */}
      <Section
        icon={<Dna className="h-5 w-5" />}
        title="3 · Learning across generations"
        subtitle="Rewards teach one fly; evolution teaches the species"
      >
        <p>
          Within-lifetime learning is slow — a single fly only experiences so
          much. So each trainer also runs a miniature{" "}
          <span className="text-foreground">evolution</span>:
        </p>
        <EvolutionLoopDiagram />
        <div className="grid gap-2 sm:grid-cols-2">
          {[
            ["Repeat", "A population of flies (5–8) plays the same world simultaneously as translucent ghosts"],
            ["Judge", "Score = obstacles cleared (dino) or distance ridden (bicycle)"],
            ["Select", "Top-2 survivors are cloned exactly — including what they learned"],
            ["Breed", "The rest are bred: mix two survivors' wires, add small random mutations"],
          ].map(([step, desc]) => (
            <div key={step} className="flex gap-3 rounded-lg border border-border bg-muted/40 p-3">
              <Repeat className="mt-0.5 h-4 w-4 shrink-0 text-primary" />
              <div>
                <div className="text-xs font-semibold uppercase tracking-wide text-foreground">
                  {step}
                </div>
                <div className="mt-0.5 text-xs leading-relaxed">{desc}</div>
              </div>
            </div>
          ))}
        </div>
        <p>
          Mutations + childhood memories (the learned weights) are inherited
          together, so improvements compound. The dino chart you see while
          training is exactly this: best &amp; average score per generation,
          climbing.
        </p>
        <Analogy>
          It&apos;s like a family of chefs: each one tastes and adjusts their own
          recipe during their shift (rewards), and only the best recipes get
          copied into the next generation — with tiny experimental tweaks.
        </Analogy>
      </Section>

      {/* 4. Saving */}
      <Section
        icon={<Save className="h-5 w-5" />}
        title="4 · How saving & loading works"
        subtitle="A brain file is just a photo of its wires"
      >
        <p>
          A trained brain is fully described by ~3,000 numbers: the plastic
          synapse strengths (the &quot;learned&quot; part) plus a seed that
          regenerates all the fixed innate wiring identically. Saving = writing
          those numbers to the database (~25 KB — smaller than a photo of an
          actual fly).
        </p>
        <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
          {[
            { icon: <Database className="h-4 w-4" />, t: "Saved to SQLite via the Brain Library" },
            { icon: <ArrowRight className="h-4 w-4" />, t: "" },
            { icon: <Save className="h-4 w-4" />, t: "Export as .json file anywhere" },
            { icon: <ArrowRight className="h-4 w-4" />, t: "" },
            { icon: <Sparkles className="h-4 w-4" />, t: "Load → the fly resumes exactly where it left off" },
          ]
            .filter((s) => s.t)
            .map((s, i) => (
              <div key={i} className="flex flex-1 items-center gap-2 rounded-lg border border-border bg-muted/40 p-3 text-xs">
                <span className="text-primary">{s.icon}</span>
                <span>{s.t}</span>
              </div>
            ))}
        </div>
        <p>
          When you press <span className="text-foreground">Load</span> in the
          Library, the snapshot is handed to the right trainer, the population
          is replaced with clones of that brain, and training continues from
          that generation. Nothing is re-trained from scratch — the fly
          <em> remembers</em>.
        </p>
        <p className="text-xs text-muted-foreground">
          Also automatic: every trainer saves a local autosave each generation
          (browser storage), so a refresh never loses your progress.
        </p>
      </Section>

      {/* 5. Glossary */}
      <Section
        icon={<BookOpen className="h-5 w-5" />}
        title="5 · Mini glossary"
        subtitle="The six words that make you sound like a neuroscientist"
      >
        <div className="grid gap-2 sm:grid-cols-2">
          {[
            ["Connectome", "The complete wiring map of a brain — which neuron connects to which. Real fly maps have ~140k neurons; ours has 926."],
            ["LIF neuron", "Leaky Integrate-and-Fire: charge up → hit threshold → spike → reset. The standard simple neuron model."],
            ["Kenyon cell", "The mushroom body's neurons. They fire sparsely so each combination of cues gets its own almost-unique code."],
            ["MBON", "Mushroom Body Output Neuron — reads the Kenyon code and pushes approach (green) or avoidance (rose)."],
            ["Dopamine", "The 'was that good or bad?' signal. Green pulse = strengthen recent wiring; red = weaken it."],
            ["Neuroevolution", "Breeding whole brains: keep the best, mix their weights, mutate slightly, repeat."],
          ].map(([term, def]) => (
            <div key={term} className="rounded-lg border border-border bg-muted/40 p-3">
              <div className="text-xs font-semibold text-foreground">{term}</div>
              <div className="mt-0.5 text-xs leading-relaxed">{def}</div>
            </div>
          ))}
        </div>
      </Section>

      {/* Further reading */}
      <Section
        icon={<Eye className="h-5 w-5" />}
        title="Further reading — where this all comes from"
        subtitle="The real science and the viral demos that inspired this app"
      >
        <ul className="space-y-2">
          {[
            ["FlyWire & MaleCNS connectomes", "The complete fruit fly brain maps (Princeton/Janelia/Google) that started the 2025–2026 fly-sim wave."],
            ["Shiu et al. 2024 (Nature)", "Showed that a leaky-integrate-and-fire simulation built straight from the connectome can produce real behaviour."],
            ["Deconstructing viral fly sims (neuroai.science)", "Patrick Mineault's breakdown of how the fly-plays-Doom / Mario / Beat-Saber demos actually work."],
            ["Mushroom body research (Aso et al. and others)", "The dopamine-gated Kenyon→MBON learning rule and appetitive/aversive compartments used here."],
          ].map(([name, desc]) => (
            <li key={name} className="flex gap-2">
              <Zap className="mt-0.5 h-4 w-4 shrink-0 text-primary" />
              <div>
                <span className="font-medium text-foreground">{name}</span>
                <span> — {desc}</span>
              </div>
            </li>
          ))}
        </ul>
      </Section>
    </div>
  );
}
