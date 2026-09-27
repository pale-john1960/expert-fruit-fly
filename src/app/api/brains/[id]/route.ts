import { NextResponse } from "next/server";
import { db } from "@/lib/db";

/**
 * /api/brains/[id] — fetch one saved brain (with its FULL parsed snapshot)
 * or erase it.
 *
 *   GET    /api/brains/[id]  → { brain: {…}, snapshot: BrainSnapshot }
 *   DELETE /api/brains/[id]  → { ok: true }
 */

export const dynamic = "force-dynamic";

function notFound() {
  return NextResponse.json({ error: "Brain not found" }, { status: 404 });
}

// ---------------------------------------------------------------------------
// GET — one brain, snapshot parsed back into an object
// ---------------------------------------------------------------------------

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;

    const row = await db.brain.findUnique({ where: { id } });
    if (!row) return notFound();

    let snapshot: unknown;
    try {
      snapshot = JSON.parse(row.snapshot);
    } catch (err) {
      console.error(`Stored snapshot for brain ${id} is corrupt:`, err);
      return NextResponse.json({ error: "Stored snapshot is corrupt" }, { status: 500 });
    }

    return NextResponse.json({
      brain: {
        id: row.id,
        name: row.name,
        task: row.task,
        generation: row.generation,
        score: row.score,
        note: row.note,
        createdAt: row.createdAt,
      },
      snapshot,
    });
  } catch (err) {
    console.error("GET /api/brains/[id] failed:", err);
    return NextResponse.json({ error: "Failed to fetch brain" }, { status: 500 });
  }
}

// ---------------------------------------------------------------------------
// DELETE — erase a saved brain
// ---------------------------------------------------------------------------

export async function DELETE(
  _req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;

    // Prisma throws P2025 when the record doesn't exist
    await db.brain.delete({ where: { id } });
    return NextResponse.json({ ok: true });
  } catch (err: unknown) {
    if ((err as { code?: string })?.code === "P2025") {
      return notFound();
    }
    console.error("DELETE /api/brains/[id] failed:", err);
    return NextResponse.json({ error: "Failed to delete brain" }, { status: 500 });
  }
}
