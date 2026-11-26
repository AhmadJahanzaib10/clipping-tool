import { performanceSchema, setPerformance } from "@clip/shared";
import { getDb } from "@/lib/db";
import { readJson, reviewErrorResponse, type IdParams } from "@/lib/clips-api";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** POST { views72h, platform } — views at 72 h (SPEC §9 learning loop). */
export async function POST(req: Request, { params }: IdParams) {
  const b = await readJson(req, performanceSchema);
  if ("res" in b) return b.res;
  try {
    return Response.json({ clip: setPerformance(getDb(), (await params).id, b.data) });
  } catch (e) {
    return reviewErrorResponse(e);
  }
}
