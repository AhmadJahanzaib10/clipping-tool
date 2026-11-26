import { rejectClip } from "@clip/shared";
import { getDb } from "@/lib/db";
import { reviewErrorResponse, type IdParams } from "@/lib/clips-api";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** POST — reject (cleanup removes rejected clips after KEEP_REJECTED_DAYS). */
export async function POST(_req: Request, { params }: IdParams) {
  try {
    return Response.json({ clip: rejectClip(getDb(), (await params).id) });
  } catch (e) {
    return reviewErrorResponse(e);
  }
}
