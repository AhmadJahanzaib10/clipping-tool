import { eq } from "drizzle-orm";
import { QueueError, retryTask, updateSource, type SourceStatus, type TaskType } from "@clip/shared";
import { schema } from "@clip/shared/db";
import { getDb } from "@/lib/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const STATUS_FOR: Partial<Record<TaskType, SourceStatus>> = {
  INGEST: "queued",
  TRANSCRIBE: "transcribing",
  SCOUT: "selecting",
  EDIT: "selecting",
  FETCH_SECTIONS: "fetching",
};

/** POST /api/tasks/:id/retry — re-queue a failed task and un-fail its source (Overview "Retry"). */
export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const db = getDb();
  const id = (await params).id;
  try {
    const task = retryTask(db, id);
    if (task.sourceId) {
      const src = db.select().from(schema.sources).where(eq(schema.sources.id, task.sourceId)).get();
      if (src?.status === "failed") updateSource(db, task.sourceId, { status: STATUS_FOR[task.type] ?? "queued", error: null });
    }
    return Response.json({ task });
  } catch (e) {
    if (e instanceof QueueError) return Response.json({ error: e.message }, { status: 404 });
    throw e;
  }
}
