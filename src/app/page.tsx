"use client";

import { useState } from "react";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { BrainLab } from "@/components/fly/BrainLab";
import { DinoTrainer } from "@/components/fly/DinoTrainer";
import { BicycleTrainer } from "@/components/fly/BicycleTrainer";
import { BrainLibrary } from "@/components/fly/BrainLibrary";
import { HowItWorks } from "@/components/fly/HowItWorks";
import { useBrainStore } from "@/lib/flybrain/store";
import { Bug, Gamepad2, Bike, Library, BookOpen, X, Github } from "lucide-react";
import { Button } from "@/components/ui/button";

export default function Home() {
  const [tab, setTab] = useState("lab");
  const banner = useBrainStore((s) => s.banner);
  const clearBanner = useBrainStore((s) => s.clearBanner);

  return (
    <div className="flex min-h-screen flex-col bg-background text-foreground">
      {/* Header */}
      <header className="sticky top-0 z-40 border-b border-border/60 bg-background/80 backdrop-blur-md">
        <div className="mx-auto flex max-w-7xl items-center gap-3 px-4 py-3">
          <div className="flex items-center gap-2.5">
            <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-primary text-primary-foreground">
              <Bug className="h-5 w-5" />
            </div>
            <div className="leading-tight">
              <h1 className="text-base font-semibold tracking-tight sm:text-lg">
                Expert Fruit Fly
              </h1>
              <p className="hidden text-xs text-muted-foreground sm:block">
                A connectome-inspired brain that learns by reward &amp; punishment
              </p>
            </div>
          </div>
          <div className="ml-auto flex items-center gap-2">
            <Button
              variant="ghost"
              size="sm"
              className="text-muted-foreground"
              onClick={() => window.open("https://github.com/pale-john1960/expert-fruit-fly", "_blank")}
            >
              <Github className="mr-1.5 h-4 w-4" />
              <span className="hidden sm:inline">GitHub</span>
            </Button>
          </div>
        </div>
        {/* Tabs */}
        <div className="mx-auto max-w-7xl px-4">
          <Tabs value={tab} onValueChange={setTab} className="w-full">
            <TabsList className="h-auto w-full justify-start gap-1 overflow-x-auto rounded-none bg-transparent p-0 pb-px">
              <TabsTrigger
                value="lab"
                className="gap-1.5 whitespace-nowrap rounded-t-lg border-b-2 border-transparent data-[state=active]:border-primary data-[state=active]:bg-transparent px-3 py-2"
              >
                <Bug className="h-4 w-4" /> Brain Lab
              </TabsTrigger>
              <TabsTrigger
                value="dino"
                className="gap-1.5 whitespace-nowrap rounded-t-lg border-b-2 border-transparent data-[state=active]:border-primary data-[state=active]:bg-transparent px-3 py-2"
              >
                <Gamepad2 className="h-4 w-4" /> Dino Training
              </TabsTrigger>
              <TabsTrigger
                value="bicycle"
                className="gap-1.5 whitespace-nowrap rounded-t-lg border-b-2 border-transparent data-[state=active]:border-primary data-[state=active]:bg-transparent px-3 py-2"
              >
                <Bike className="h-4 w-4" /> Bicycle Training
              </TabsTrigger>
              <TabsTrigger
                value="library"
                className="gap-1.5 whitespace-nowrap rounded-t-lg border-b-2 border-transparent data-[state=active]:border-primary data-[state=active]:bg-transparent px-3 py-2"
              >
                <Library className="h-4 w-4" /> Brain Library
              </TabsTrigger>
              <TabsTrigger
                value="docs"
                className="gap-1.5 whitespace-nowrap rounded-t-lg border-b-2 border-transparent data-[state=active]:border-primary data-[state=active]:bg-transparent px-3 py-2"
              >
                <BookOpen className="h-4 w-4" /> How It Works
              </TabsTrigger>
            </TabsList>
          </Tabs>
        </div>
      </header>

      {/* Banner */}
      {banner && (
        <div className="mx-auto mt-3 flex w-full max-w-7xl items-start gap-2 rounded-lg border border-emerald-600/40 bg-emerald-500/10 px-4 py-2.5 text-sm text-emerald-700 dark:text-emerald-300">
          <span className="flex-1">{banner}</span>
          <button onClick={clearBanner} className="opacity-60 hover:opacity-100" aria-label="Dismiss">
            <X className="h-4 w-4" />
          </button>
        </div>
      )}

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
      <footer className="mt-auto border-t border-border/60 bg-muted/30">
        <div className="mx-auto flex max-w-7xl flex-wrap items-center gap-x-4 gap-y-1 px-4 py-4 text-xs text-muted-foreground">
          <span className="font-medium text-foreground">Expert Fruit Fly</span>
          <span>·</span>
          <span>926-neuron connectome-inspired brain: retina → optic lobe → mushroom body → motor</span>
          <span>·</span>
          <span>learns by dopamine-gated plasticity + neuroevolution</span>
          <span className="ml-auto">inspired by FlyWire / MaleCNS connectome research</span>
        </div>
      </footer>
    </div>
  );
}
