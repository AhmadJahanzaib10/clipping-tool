import { asc } from "drizzle-orm";
import { schema } from "@clip/shared/db";
import { getDb } from "@/lib/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** GET /api/sfx — the whole library (including disabled and missing files). */
export function GET() {
  const rows = getDb().select().from(schema.sfx).orderBy(asc(schema.sfx.category), asc(schema.sfx.file)).all();
  return Response.json({ sfx: rows });
}
