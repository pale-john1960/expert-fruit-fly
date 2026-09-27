"use client";

/**
 * BrainLibrary — save / load / export / import learned brains.
 * PLACEHOLDER — will be replaced by the persistence agent.
 *
 * CONTRACT:
 * - lists saved brains from GET /api/brains (name, task, generation, score, date)
 * - "Load" → GET /api/brains/[id] → useBrainStore.requestLoad(task, snapshot)
 * - "Delete" → DELETE /api/brains/[id]
 * - "Export" → download snapshot JSON
 * - "Import" → file picker → POST /api/brains
 */

export type BrainLibraryProps = Record<string, never>;

export function BrainLibrary(_props: BrainLibraryProps = {}) {
  return (
    <div className="flex h-64 items-center justify-center rounded-xl border border-border bg-muted/30 text-muted-foreground">
      Brain library loading…
    </div>
  );
}
