import { desc } from "drizzle-orm";
import { z } from "zod";
import { createJob, createJobSchema, JobError, loadEnv } from "@clip/shared";
import { schema } from "@clip/shared/db";
import { getDb } from "@/lib/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export function GET() {
  const sources = getDb().select().from(schema.sources).orderBy(desc(schema.sources.createdAt)).limit(100).all();
  return Response.json({ sources });
}

/** POST /api/jobs { urls?, uploadIds?, campaignId, operatorId, options? } → one source + INGEST task each. */
export async function POST(req: Request) {
  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return Response.json({ error: "invalid JSON body" }, { status: 400 });
  }
  const parsed = createJobSchema.safeParse(raw);
  if (!parsed.success) return Response.json({ error: "invalid body", issues: z.treeifyError(parsed.error) }, { status: 400 });
  try {
    const sources = createJob(getDb(), loadEnv().STORAGE_DIR, parsed.data);
    return Response.json({ sources }, { status: 201 });
  } catch (e) {
    if (e instanceof JobError) return Response.json({ error: e.message }, { status: 400 });
    throw e;
  }
}
