import { loadEnv, requestRender } from "@clip/shared";
import { getDb } from "@/lib/db";
import { reviewErrorResponse, type IdParams } from "@/lib/clips-api";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** POST — fast re-render: COMPOSE only (captions, hook, SFX, overlay). */
export async function POST(_req: Request, { params }: IdParams) {
  try {
    return Response.json({ task: requestRender(getDb(), loadEnv().STORAGE_DIR, (await params).id, "compose") });
  } catch (e) {
    return reviewErrorResponse(e);
  }
}
