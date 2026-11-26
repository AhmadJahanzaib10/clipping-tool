import { reopenClip } from "@clip/shared";
import { getDb } from "@/lib/db";
import { reviewErrorResponse, type IdParams } from "@/lib/clips-api";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** POST — re-open an approved/rejected clip for editing. */
export async function POST(_req: Request, { params }: IdParams) {
  try {
    return Response.json({ clip: reopenClip(getDb(), (await params).id) });
  } catch (e) {
    return reviewErrorResponse(e);
  }
}
