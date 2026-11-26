import { loadEnv, requestRender } from "@clip/shared";
import { getDb } from "@/lib/db";
import { reviewErrorResponse, type IdParams } from "@/lib/clips-api";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** POST — full re-render: re-plan (re-fetch the section if needed) → RENDER_BASE → COMPOSE. */
export async function POST(_req: Request, { params }: IdParams) {
  try {
    return Response.json({ task: requestRender(getDb(), loadEnv().STORAGE_DIR, (await params).id, "base") });
  } catch (e) {
    return reviewErrorResponse(e);
  }
}
