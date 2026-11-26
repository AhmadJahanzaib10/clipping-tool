import { applyClipPatch, clipUserPatchSchema, loadEnv } from "@clip/shared";
import { clipDetail } from "@/lib/clip-detail";
import { getDb } from "@/lib/db";
import { readJson, reviewErrorResponse, type IdParams } from "@/lib/clips-api";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** GET /api/clips/:id — the clip with its plan, words, nearby sentences, versions and SFX library. */
export async function GET(_req: Request, { params }: IdParams) {
  const d = clipDetail((await params).id);
  return d ? Response.json(d) : Response.json({ error: "not_found" }, { status: 404 });
}

/**
 * PATCH /api/clips/:id { edit?, title?, captionTiktok?, captionInstagram?, captionYoutube?, hashtags?, hookA?, hookB? }
 * Saves and queues the right re-render automatically: picture/timeline → full, text/SFX → fast, captions → none.
 */
export async function PATCH(req: Request, { params }: IdParams) {
  const b = await readJson(req, clipUserPatchSchema);
  if ("res" in b) return b.res;
  try {
    const r = applyClipPatch(getDb(), loadEnv().STORAGE_DIR, (await params).id, b.data);
    return Response.json({ clip: r.clip, render: r.render, tasks: r.tasks.map((t) => ({ id: t.id, type: t.type })) });
  } catch (e) {
    return reviewErrorResponse(e);
  }
}
