import { NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";

/**
 * /api/brains — the persistence layer for saved fly brains.
 *
 *   GET  /api/brains?task=dino   → list metadata only (NEVER the snapshot JSON)
 *   POST /api/brains             → validate + store a BrainSnapshot
 */

export const dynamic = "force-dynamic";

// 2 MB cap on the serialized snapshot (they are typically 25–100 KB)
const MAX_SNAPSHOT_CHARS = 2 * 1024 * 1024;

// ---------------------------------------------------------------------------
// naive in-memory rate limiting for POST: 30 saves / minute / IP
// ---------------------------------------------------------------------------

const RATE_WINDOW_MS = 60_000;
const RATE_LIMIT = 30;
const postHits = new Map<string, number[]>();

function clientKey(req: Request): string {
  const fwd = req.headers.get("x-forwarded-for");
  if (fwd) return fwd.split(",")[0]?.trim() || "local";
  return req.headers.get("x-real-ip") ?? "local";
}

function rateLimited(key: string): boolean {
  const now = Date.now();
  const recent = (postHits.get(key) ?? []).filter((t) => now - t < RATE_WINDOW_MS);
  if (recent.length >= RATE_LIMIT) {
    postHits.set(key, recent);
    return true;
  }
  recent.push(now);
  postHits.set(key, recent);
  // opportunistic cleanup so the map can't grow forever
  if (postHits.size > 5000) {
    for (const [k, hits] of postHits) {
      if (hits.every((t) => now - t >= RATE_WINDOW_MS)) postHits.delete(k);
    }
  }
  return false;
}

// ---------------------------------------------------------------------------
// zod validation
// ---------------------------------------------------------------------------

const finiteNumber = z
  .number()
  .refine((n) => Number.isFinite(n), { message: "must be a finite number" });

const finiteInt = z
  .number()
  .int()
  .refine((n) => Number.isFinite(n), { message: "must be a finite integer" });

/** plastic weight vectors — every entry must be a finite number */
const weightsSchema = z.object({
  kenyonToMbon: z.array(finiteNumber),
  mbonToMotor: z.array(finiteNumber),
  lobulaToMotor: z.array(finiteNumber).optional(),
  mbonBias: z.array(finiteNumber),
  motorBias: z.array(finiteNumber),
});

/** fixed wiring — enough to deterministically rebuild the brain */
const archSchema = z.object({
  retinaCols: finiteInt,
  retinaRows: finiteInt,
  medullaChannels: finiteInt,
  medullaPools: finiteInt,
  lobulaCount: finiteInt,
  kenyonCount: finiteInt,
  mbonCount: finiteInt,
  motorCount: finiteInt,
  seed: finiteNumber,
});

/**
 * The snapshot schema validates the fields we rely on; unknown extra keys
 * (meta, createdAt, …) are allowed to pass through untouched — we always
 * store the ORIGINAL object, never the stripped zod output.
 */
const snapshotSchema = z.object({
  version: z.literal(1),
  task: z.string().min(1).max(40),
  name: z.string().min(1).max(80),
  arch: archSchema,
  weights: weightsSchema,
});

const createBrainSchema = z.object({
  name: z.string().trim().min(1).max(80),
  task: z.enum(["dino", "bicycle", "lab"]),
  generation: finiteInt.min(0).max(1_000_000).optional(),
  score: finiteNumber.optional(),
  note: z.string().trim().max(200).optional(),
  snapshot: snapshotSchema,
});

function firstIssue(err: z.ZodError): string {
  const issue = err.issues[0];
  if (!issue) return "invalid request body";
  const path = issue.path.map(String).join(".");
  return path ? `${path} ${issue.message}` : issue.message;
}

// ---------------------------------------------------------------------------
// GET — list (metadata only, snapshot JSON is deliberately excluded)
// ---------------------------------------------------------------------------

export async function GET(req: Request) {
  try {
    const { searchParams } = new URL(req.url);
    const task = searchParams.get("task")?.trim().toLowerCase() || null;

    const rows = await db.brain.findMany({
      where: task ? { task } : undefined,
      orderBy: { createdAt: "desc" },
    });

    const brains = rows.map((b) => ({
      id: b.id,
      name: b.name,
      task: b.task,
      generation: b.generation,
      score: b.score,
      note: b.note,
      createdAt: b.createdAt,
      updatedAt: b.updatedAt,
      snapshotBytes: b.snapshot.length,
    }));

    return NextResponse.json({ brains, count: brains.length });
  } catch (err) {
    console.error("GET /api/brains failed:", err);
    return NextResponse.json({ error: "Failed to list brains" }, { status: 500 });
  }
}

// ---------------------------------------------------------------------------
// POST — create (accepts `snapshot` as an OBJECT, stores it stringified)
// ---------------------------------------------------------------------------

export async function POST(req: Request) {
  const key = clientKey(req);
  if (rateLimited(key)) {
    return NextResponse.json(
      { error: "Too many saves — try again in a minute" },
      { status: 429 }
    );
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Request body must be valid JSON" }, { status: 400 });
  }

  const parsed = createBrainSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: `Invalid brain — ${firstIssue(parsed.error)}` },
      { status: 400 }
    );
  }

  const { name, task, generation, score, note } = parsed.data;

  // store the ORIGINAL snapshot object (keeps meta / createdAt / extras),
  // not zod's stripped output — validated above, stringified here.
  const rawSnapshot = (body as { snapshot?: unknown }).snapshot;
  let serialized: string;
  try {
    serialized = JSON.stringify(rawSnapshot);
  } catch {
    return NextResponse.json(
      { error: "Snapshot is not JSON-serializable" },
      { status: 400 }
    );
  }
  if (typeof serialized !== "string" || serialized.length === 0) {
    return NextResponse.json({ error: "Snapshot is empty" }, { status: 400 });
  }
  if (serialized.length > MAX_SNAPSHOT_CHARS) {
    return NextResponse.json(
      {
        error: `Snapshot too large (${(serialized.length / (1024 * 1024)).toFixed(
          1
        )} MB) — the limit is 2 MB`,
      },
      { status: 413 }
    );
  }

  // fall back to the snapshot's own generation/score when the body omits them
  const snapAny = rawSnapshot as { generation?: unknown; score?: unknown };
  const fallbackGeneration =
    typeof snapAny.generation === "number" && Number.isFinite(snapAny.generation)
      ? Math.max(0, Math.trunc(snapAny.generation))
      : 0;
  const fallbackScore =
    typeof snapAny.score === "number" && Number.isFinite(snapAny.score) ? snapAny.score : 0;

  try {
    const created = await db.brain.create({
      data: {
        name,
        task,
        generation: generation ?? fallbackGeneration,
        score: score ?? fallbackScore,
        note: note && note.length > 0 ? note : null,
        snapshot: serialized,
      },
    });

    return NextResponse.json(
      {
        brain: {
          id: created.id,
          name: created.name,
          task: created.task,
          generation: created.generation,
          score: created.score,
          createdAt: created.createdAt,
        },
      },
      { status: 201 }
    );
  } catch (err) {
    console.error("POST /api/brains failed:", err);
    return NextResponse.json({ error: "Failed to save brain" }, { status: 500 });
  }
}
