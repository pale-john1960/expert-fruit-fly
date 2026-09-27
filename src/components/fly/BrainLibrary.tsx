"use client";

/**
 * BrainLibrary — save / load / export / import learned fly brains.
 *
 * - lists saved brains from GET /api/brains (name, task, generation, score, size, date)
 * - "Load"  → GET /api/brains/[id] → useBrainStore.requestLoad(task, snapshot, name)
 * - "Export" → downloads the snapshot as pretty JSON
 * - "Import" → file picker / drag-drop → POST /api/brains
 * - "Delete" → AlertDialog confirm → DELETE /api/brains/[id]
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { formatDistanceToNow } from "date-fns";
import { motion } from "framer-motion";
import { toast } from "sonner";
import {
  Bike,
  Brain,
  Download,
  FlaskConical,
  Gamepad2,
  LayoutGrid,
  Loader2,
  MoreHorizontal,
  Play,
  RefreshCw,
  Search,
  Trash2,
  Upload,
  FileJson,
} from "lucide-react";

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Toaster } from "@/components/ui/sonner";
import { useBrainStore } from "@/lib/flybrain/store";
import type { BrainSnapshot } from "@/lib/flybrain/types";
import { cn } from "@/lib/utils";

export type BrainLibraryProps = Record<string, never>;

// ---------------------------------------------------------------------------
// types + small helpers
// ---------------------------------------------------------------------------

interface BrainRow {
  id: string;
  name: string;
  task: string;
  generation: number;
  score: number;
  note: string | null;
  createdAt: string;
  updatedAt: string;
  snapshotBytes: number;
}

type TaskFilter = "all" | "dino" | "bicycle" | "lab";

const TASK_META: Record<
  string,
  { label: string; icon: typeof Gamepad2; badge: string; iconColor: string }
> = {
  dino: {
    label: "Dino",
    icon: Gamepad2,
    badge: "border-amber-500/30 bg-amber-500/10 text-amber-300",
    iconColor: "text-amber-400",
  },
  bicycle: {
    label: "Bicycle",
    icon: Bike,
    badge: "border-rose-500/30 bg-rose-500/10 text-rose-300",
    iconColor: "text-rose-400",
  },
  lab: {
    label: "Lab",
    icon: Brain,
    badge: "border-emerald-500/30 bg-emerald-500/10 text-emerald-300",
    iconColor: "text-emerald-400",
  },
};

const FILTERS: { value: TaskFilter; label: string; icon: typeof Gamepad2 }[] = [
  { value: "all", label: "All", icon: LayoutGrid },
  { value: "dino", label: "Dino", icon: Gamepad2 },
  { value: "bicycle", label: "Bicycle", icon: Bike },
  { value: "lab", label: "Lab", icon: FlaskConical },
];

function taskMeta(task: string) {
  return (
    TASK_META[task] ?? {
      label: task ? task.charAt(0).toUpperCase() + task.slice(1) : "Unknown",
      icon: FlaskConical,
      badge: "border-border bg-muted text-muted-foreground",
      iconColor: "text-muted-foreground",
    }
  );
}

function formatScore(task: string, score: number): string {
  const num =
    Math.abs(score) >= 1000 ? `${(score / 1000).toFixed(1)}k` : `${Math.round(score * 10) / 10}`;
  if (task === "dino") return `${num} pts`;
  if (task === "bicycle") return `${num} m`;
  return num;
}

function formatBytes(n: number): string {
  if (n >= 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`;
  if (n >= 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${n} B`;
}

function relativeDate(iso: string): string {
  try {
    return formatDistanceToNow(new Date(iso), { addSuffix: true });
  } catch {
    return "unknown";
  }
}

function sanitizeFileName(name: string): string {
  const clean = name
    .toLowerCase()
    .replace(/[^a-z0-9-_]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return clean || "brain";
}

async function fetchBrain(id: string): Promise<{ brain: BrainRow; snapshot: BrainSnapshot }> {
  const res = await fetch(`/api/brains/${id}`, { cache: "no-store" });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(data?.error ?? `Could not fetch brain (${res.status})`);
  }
  if (!data?.snapshot || typeof data.snapshot !== "object" || !data.snapshot.weights) {
    throw new Error("Stored snapshot is malformed");
  }
  return data;
}

const SCROLLBAR =
  "[&::-webkit-scrollbar]:w-2 [&::-webkit-scrollbar-track]:bg-transparent [&::-webkit-scrollbar-thumb]:rounded-full [&::-webkit-scrollbar-thumb]:bg-border";

// ---------------------------------------------------------------------------
// task badge
// ---------------------------------------------------------------------------

function TaskBadge({ task }: { task: string }) {
  const meta = taskMeta(task);
  const Icon = meta.icon;
  return (
    <Badge variant="outline" className={cn("gap-1", meta.badge)}>
      <Icon className="h-3 w-3" aria-hidden />
      {meta.label}
    </Badge>
  );
}

// ---------------------------------------------------------------------------
// main component
// ---------------------------------------------------------------------------

export function BrainLibrary(_props: BrainLibraryProps = {}) {
  const [brains, setBrains] = useState<BrainRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [taskFilter, setTaskFilter] = useState<TaskFilter>("all");
  const [query, setQuery] = useState("");
  const [busyId, setBusyId] = useState<string | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<BrainRow | null>(null);
  const [deleteBusy, setDeleteBusy] = useState(false);
  const [importOpen, setImportOpen] = useState(false);
  const [importing, setImporting] = useState(false);
  const [dragOver, setDragOver] = useState(false);

  const fileInputRef = useRef<HTMLInputElement>(null);

  const loadList = useCallback(async (task: TaskFilter) => {
    setLoading(true);
    setError(null);
    try {
      const qs = task !== "all" ? `?task=${encodeURIComponent(task)}` : "";
      const res = await fetch(`/api/brains${qs}`, { cache: "no-store" });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data?.error ?? `Server responded ${res.status}`);
      setBrains(Array.isArray(data.brains) ? (data.brains as BrainRow[]) : []);
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Failed to load the library";
      setError(msg);
      if (brains.length > 0) toast.error(`Couldn't refresh the library: ${msg}`);
    } finally {
      setLoading(false);
    }
  }, [brains.length]);

  useEffect(() => {
    void loadList("all");
  }, []);

  const handleFilterChange = (task: TaskFilter) => {
    setTaskFilter(task);
    void loadList(task);
  };

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    return brains.filter((b) => {
      if (q) {
        const haystack = `${b.name} ${b.task} ${b.note ?? ""}`.toLowerCase();
        if (!haystack.includes(q)) return false;
      }
      return true;
    });
  }, [brains, query]);

  const totalBytes = useMemo(() => brains.reduce((acc, b) => acc + (b.snapshotBytes ?? 0), 0), [brains]);

  // ----- actions ----------------------------------------------------------

  const handleLoad = async (row: BrainRow) => {
    setBusyId(row.id);
    try {
      const { snapshot } = await fetchBrain(row.id);
      useBrainStore.getState().requestLoad(row.task, snapshot, row.name);
      const meta = taskMeta(row.task);
      toast.success(`Loaded "${row.name}" — open the ${meta.label} tab to continue training`);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Load failed");
    } finally {
      setBusyId(null);
    }
  };

  const handleExport = async (row: BrainRow) => {
    setBusyId(row.id);
    try {
      const { snapshot } = await fetchBrain(row.id);
      const blob = new Blob([JSON.stringify(snapshot, null, 2)], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `fly-brain-${sanitizeFileName(row.name)}-gen${row.generation}.json`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
      toast.success(`Exported "${row.name}" (gen ${row.generation}) as JSON`);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Export failed");
    } finally {
      setBusyId(null);
    }
  };

  const handleDelete = async () => {
    if (!deleteTarget) return;
    setDeleteBusy(true);
    const row = deleteTarget;
    try {
      const res = await fetch(`/api/brains/${row.id}`, { method: "DELETE" });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data?.error ?? `Delete failed (${res.status})`);
      setBrains((bs) => bs.filter((b) => b.id !== row.id));
      toast.success(`Deleted "${row.name}" — that connectome is gone`);
      setDeleteTarget(null);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Delete failed");
    } finally {
      setDeleteBusy(false);
    }
  };

  const handleImportFile = async (file: File) => {
    setImporting(true);
    try {
      const text = await file.text();
      let parsed: unknown;
      try {
        parsed = JSON.parse(text);
      } catch {
        throw new Error("That file isn't valid JSON");
      }
      const snap = parsed as Partial<BrainSnapshot> | null;
      if (!snap || typeof snap !== "object" || Array.isArray(snap)) {
        throw new Error("Not a fly-brain file — expected a JSON object");
      }
      if (snap.version !== 1) throw new Error(`Unsupported brain version: ${String(snap.version)}`);
      if (typeof snap.task !== "string" || !snap.task.trim()) throw new Error("Snapshot is missing its task");
      if (!snap.arch || typeof snap.arch !== "object") throw new Error("Snapshot is missing its architecture");
      if (!snap.weights || typeof snap.weights !== "object") throw new Error("Snapshot is missing its weights");
      for (const key of ["kenyonToMbon", "mbonToMotor", "mbonBias", "motorBias"] as const) {
        if (!Array.isArray(snap.weights[key])) throw new Error(`Snapshot weights.${key} is missing`);
      }

      const fallbackName = file.name
        .replace(/\.json$/i, "")
        .replace(/[_-]+/g, " ")
        .trim();
      const name =
        typeof snap.name === "string" && snap.name.trim() ? snap.name.trim() : fallbackName || "Imported brain";

      const res = await fetch("/api/brains", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name,
          task: snap.task,
          generation: typeof snap.generation === "number" ? snap.generation : 0,
          score: typeof snap.score === "number" ? snap.score : 0,
          note: typeof snap.meta?.note === "string" ? snap.meta.note : undefined,
          snapshot: snap,
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data?.error ?? `Import failed (${res.status})`);

      toast.success(`Imported "${data.brain?.name ?? name}" (gen ${data.brain?.generation ?? 0}) into the library`);
      setImportOpen(false);
      await loadList(taskFilter);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Import failed");
    } finally {
      setImporting(false);
      if (fileInputRef.current) fileInputRef.current.value = "";
    }
  };

  // ----- render helpers ---------------------------------------------------

  const showEmptyState = !loading && !error && visible.length === 0;
  const showFilteredEmpty = showEmptyState && (brains.length > 0 || query.trim() !== "");

  const rowActions = (row: BrainRow, full = false) => (
    <div className={cn("flex items-center gap-2", full && "w-full")}>
      <Button
        size="sm"
        className={cn("h-11 gap-1.5 bg-emerald-600 px-4 text-white hover:bg-emerald-500", full && "flex-1")}
        disabled={busyId === row.id}
        onClick={() => void handleLoad(row)}
        aria-label={`Load ${row.name} into the trainer`}
      >
        {busyId === row.id ? <Loader2 className="h-4 w-4 animate-spin" /> : <Play className="h-4 w-4" />}
        Load
      </Button>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            variant="outline"
            size="icon"
            className="h-11 w-11 shrink-0"
            disabled={busyId === row.id}
            aria-label={`More actions for ${row.name}`}
          >
            <MoreHorizontal className="h-4 w-4" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-44">
          <DropdownMenuItem
            className="min-h-11 cursor-pointer"
            onSelect={() => void handleExport(row)}
          >
            <Download className="h-4 w-4" /> Export JSON
          </DropdownMenuItem>
          <DropdownMenuItem
            className="min-h-11 cursor-pointer text-rose-400 focus:text-rose-300"
            onSelect={() => setDeleteTarget(row)}
          >
            <Trash2 className="h-4 w-4" /> Delete
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );

  // ----- render -----------------------------------------------------------

  return (
    <div data-testid="brain-library" className="w-full">
      {/* sonner toaster — layout only mounts the radix one, so mount it here */}
      <Toaster position="bottom-right" />

      <Card className="gap-4 border-border/60 bg-card/70 py-5 backdrop-blur-sm sm:py-6">
        <CardHeader className="border-b border-border/60 px-4 pb-4 sm:px-6">
          <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
            <div className="flex items-start gap-3">
              <div className="mt-0.5 flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border border-emerald-500/30 bg-emerald-500/10">
                <Brain className="h-5 w-5 text-emerald-400" aria-hidden />
              </div>
              <div>
                <CardTitle className="text-lg">Brain Library</CardTitle>
                <CardDescription className="mt-1 max-w-xl text-sm">
                  Saved connectomes. Load one and the fly remembers everything it learned —
                  weights, generation, scars.
                </CardDescription>
              </div>
            </div>
            <div className="flex shrink-0 items-center gap-2">
              <Button
                variant="outline"
                size="icon"
                className="h-11 w-11"
                onClick={() => void loadList(taskFilter)}
                disabled={loading}
                aria-label="Refresh the brain library"
                title="Refresh"
              >
                <RefreshCw className={cn("h-4 w-4", loading && "animate-spin")} />
              </Button>
              <Button
                size="sm"
                className="h-11 gap-1.5 bg-emerald-600 px-4 text-white hover:bg-emerald-500"
                onClick={() => setImportOpen(true)}
              >
                <Upload className="h-4 w-4" />
                Import
              </Button>
            </div>
          </div>
        </CardHeader>

        <CardContent className="px-4 sm:px-6">
          {/* filters + search */}
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <div
              role="tablist"
              aria-label="Filter brains by task"
              className="inline-flex max-w-full items-center gap-1 overflow-x-auto rounded-xl border border-border/60 bg-muted/40 p-1"
            >
              {FILTERS.map((f) => {
                const active = taskFilter === f.value;
                const Icon = f.icon;
                return (
                  <button
                    key={f.value}
                    role="tab"
                    type="button"
                    aria-selected={active}
                    onClick={() => handleFilterChange(f.value)}
                    className={cn(
                      "flex h-11 shrink-0 items-center gap-1.5 rounded-lg px-3 text-sm font-medium transition-colors",
                      active
                        ? "border border-border/60 bg-card text-foreground shadow-sm"
                        : "text-muted-foreground hover:bg-card/60 hover:text-foreground"
                    )}
                  >
                    <Icon
                      className={cn(
                        "h-4 w-4",
                        f.value === "dino" && "text-amber-400",
                        f.value === "bicycle" && "text-rose-400",
                        f.value === "lab" && "text-emerald-400",
                        f.value === "all" && (active ? "text-foreground" : "text-muted-foreground")
                      )}
                      aria-hidden
                    />
                    {f.label}
                  </button>
                );
              })}
            </div>
            <div className="relative w-full sm:w-64">
              <Search
                className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground"
                aria-hidden
              />
              <Input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Search by name…"
                className="h-11 pl-9"
                aria-label="Search saved brains by name"
              />
            </div>
          </div>

          {/* content */}
          <div className="mt-4">
            {error && brains.length === 0 ? (
              <div className="flex flex-col items-center gap-3 rounded-xl border border-rose-500/30 bg-rose-500/5 px-6 py-10 text-center">
                <FlaskConical className="h-8 w-8 text-rose-400" aria-hidden />
                <p className="text-sm text-rose-300">Couldn&apos;t reach the brain library: {error}</p>
                <Button
                  variant="outline"
                  className="h-11"
                  onClick={() => void loadList(taskFilter)}
                >
                  <RefreshCw className="h-4 w-4" /> Try again
                </Button>
              </div>
            ) : loading && brains.length === 0 ? (
              <div className="space-y-2">
                {[0, 1, 2].map((i) => (
                  <div
                    key={i}
                    className="h-16 animate-pulse rounded-xl border border-border/40 bg-muted/30"
                    aria-hidden
                  />
                ))}
              </div>
            ) : showEmptyState ? (
              <motion.div
                initial={{ opacity: 0, y: 8 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ duration: 0.35 }}
                className="flex flex-col items-center gap-3 rounded-xl border border-dashed border-border/70 bg-muted/20 px-6 py-12 text-center"
              >
                <motion.div
                  animate={{ y: [0, -6, 0] }}
                  transition={{ duration: 3.5, repeat: Infinity, ease: "easeInOut" }}
                  className="flex h-16 w-16 items-center justify-center rounded-2xl border border-emerald-500/25 bg-emerald-500/10"
                >
                  <Brain className="h-8 w-8 text-emerald-400/80" aria-hidden />
                </motion.div>
                {showFilteredEmpty ? (
                  <>
                    <p className="font-medium">No brains match your filter</p>
                    <p className="max-w-sm text-sm text-muted-foreground">
                      Try a different task filter or clear the search box.
                    </p>
                    <Button
                      variant="outline"
                      className="h-11"
                      onClick={() => {
                        setQuery("");
                        handleFilterChange("all");
                      }}
                    >
                      Clear filters
                    </Button>
                  </>
                ) : (
                  <>
                    <p className="font-medium">No saved brains yet</p>
                    <p className="max-w-sm text-sm text-muted-foreground">
                      Train a fly in the Dino or Bicycle tab and hit{" "}
                      <span className="font-medium text-foreground">Save</span> — its connectome
                      lands here, ready to re-load, export or share.
                    </p>
                  </>
                )}
              </motion.div>
            ) : (
              <>
                {/* desktop table */}
                <div
                  className={cn(
                    "hidden max-h-96 overflow-y-auto rounded-xl border border-border/60 sm:block",
                    SCROLLBAR
                  )}
                >
                  <Table>
                    <TableHeader>
                      <TableRow className="hover:bg-transparent">
                        <TableHead className="pl-4 text-muted-foreground">Brain</TableHead>
                        <TableHead className="text-muted-foreground">Task</TableHead>
                        <TableHead className="text-muted-foreground">Gen</TableHead>
                        <TableHead className="text-muted-foreground">Score</TableHead>
                        <TableHead className="text-muted-foreground">Size</TableHead>
                        <TableHead className="text-muted-foreground">Saved</TableHead>
                        <TableHead className="pr-4 text-right text-muted-foreground">
                          Actions
                        </TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {visible.map((row) => (
                        <TableRow key={row.id} className="group">
                          <TableCell className="max-w-[220px] py-3 pl-4">
                            <div className="truncate font-medium">{row.name}</div>
                            {row.note ? (
                              <div className="truncate text-xs text-muted-foreground" title={row.note}>
                                {row.note}
                              </div>
                            ) : null}
                          </TableCell>
                          <TableCell>
                            <TaskBadge task={row.task} />
                          </TableCell>
                          <TableCell className="font-mono text-xs text-muted-foreground">
                            G{row.generation}
                          </TableCell>
                          <TableCell className="whitespace-nowrap">
                            {formatScore(row.task, row.score)}
                          </TableCell>
                          <TableCell className="whitespace-nowrap text-muted-foreground">
                            {formatBytes(row.snapshotBytes)}
                          </TableCell>
                          <TableCell
                            className="whitespace-nowrap text-muted-foreground"
                            title={new Date(row.createdAt).toLocaleString()}
                          >
                            {relativeDate(row.createdAt)}
                          </TableCell>
                          <TableCell className="py-2.5 pr-4">
                            <div className="flex justify-end">{rowActions(row)}</div>
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>

                {/* mobile stacked cards */}
                <div
                  className={cn(
                    "flex max-h-96 flex-col gap-3 overflow-y-auto sm:hidden",
                    SCROLLBAR
                  )}
                >
                  {visible.map((row, i) => (
                    <motion.div
                      key={row.id}
                      initial={{ opacity: 0, y: 6 }}
                      animate={{ opacity: 1, y: 0 }}
                      transition={{ duration: 0.25, delay: Math.min(i * 0.04, 0.2) }}
                      className="rounded-xl border border-border/60 bg-background/40 p-4"
                    >
                      <div className="flex items-start justify-between gap-2">
                        <div className="min-w-0">
                          <div className="truncate font-medium">{row.name}</div>
                          {row.note ? (
                            <div className="truncate text-xs text-muted-foreground">{row.note}</div>
                          ) : null}
                        </div>
                        <TaskBadge task={row.task} />
                      </div>
                      <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
                        <span className="font-mono">G{row.generation}</span>
                        <span>{formatScore(row.task, row.score)}</span>
                        <span>{formatBytes(row.snapshotBytes)}</span>
                        <span title={new Date(row.createdAt).toLocaleString()}>
                          {relativeDate(row.createdAt)}
                        </span>
                      </div>
                      <div className="mt-3">{rowActions(row, true)}</div>
                    </motion.div>
                  ))}
                </div>
              </>
            )}
          </div>

          {/* footer stats */}
          {!error && brains.length > 0 && (
            <p className="mt-3 text-xs text-muted-foreground" aria-live="polite">
              {brains.length} saved {brains.length === 1 ? "brain" : "brains"} ·{" "}
              {formatBytes(totalBytes)} of connectome data
            </p>
          )}
        </CardContent>
      </Card>

      {/* import dialog */}
      <Dialog open={importOpen} onOpenChange={(open) => !importing && setImportOpen(open)}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Upload className="h-4 w-4 text-emerald-400" aria-hidden />
              Import a brain
            </DialogTitle>
            <DialogDescription>
              Pick a <code className="rounded bg-muted px-1 py-0.5 text-xs">fly-brain-*.json</code>{" "}
              file — it will be validated and stored in the library.
            </DialogDescription>
          </DialogHeader>
          <div
            onDragOver={(e) => {
              e.preventDefault();
              setDragOver(true);
            }}
            onDragLeave={() => setDragOver(false)}
            onDrop={(e) => {
              e.preventDefault();
              setDragOver(false);
              const file = e.dataTransfer.files?.[0];
              if (file) void handleImportFile(file);
            }}
            className={cn(
              "flex flex-col items-center gap-3 rounded-xl border border-dashed p-8 text-center transition-colors",
              dragOver
                ? "border-emerald-500/60 bg-emerald-500/10"
                : "border-border bg-muted/20"
            )}
          >
            <FileJson className="h-8 w-8 text-muted-foreground" aria-hidden />
            <p className="text-sm text-muted-foreground">
              Drag &amp; drop a <code className="rounded bg-muted px-1 py-0.5">.json</code> brain file
              here
            </p>
            <Button
              variant="outline"
              className="h-11"
              onClick={() => fileInputRef.current?.click()}
              disabled={importing}
            >
              {importing ? (
                <>
                  <Loader2 className="h-4 w-4 animate-spin" /> Importing…
                </>
              ) : (
                <>
                  <Upload className="h-4 w-4" /> Choose file
                </>
              )}
            </Button>
            <input
              ref={fileInputRef}
              type="file"
              accept=".json,application/json"
              className="hidden"
              onChange={(e) => {
                const file = e.target.files?.[0];
                if (file) void handleImportFile(file);
              }}
              aria-label="Brain JSON file"
            />
          </div>
        </DialogContent>
      </Dialog>

      {/* delete confirmation */}
      <AlertDialog
        open={!!deleteTarget}
        onOpenChange={(open) => {
          if (!open && !deleteBusy) setDeleteTarget(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              Delete &ldquo;{deleteTarget?.name}&rdquo;?
            </AlertDialogTitle>
            <AlertDialogDescription>
              This erases the saved connectome permanently — every weight it learned since
              generation&nbsp;0. This can&apos;t be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel className="h-11" disabled={deleteBusy}>
              Cancel
            </AlertDialogCancel>
            <AlertDialogAction
              className="h-11 border-rose-500/40 bg-rose-600 text-white hover:bg-rose-500"
              disabled={deleteBusy}
              onClick={(e) => {
                e.preventDefault();
                void handleDelete();
              }}
            >
              {deleteBusy ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <Trash2 className="h-4 w-4" />
              )}
              Delete brain
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
