import fs from "node:fs";
import path from "node:path";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { sfxCacheDir, sfxPatchSchema, updateSfx } from "@clip/shared";
import { schema } from "@clip/shared/db";
import { getDb } from "@/lib/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

/** GET /api/sfx/:id — the row; ?asset=audio streams the normalized WAV, ?asset=waveform the PNG. */
export async function GET(req: Request, { params }: Ctx) {
  const row = getDb().select().from(schema.sfx).where(eq(schema.sfx.id, (await params).id)).get();
  if (!row) return Response.json({ error: "not_found" }, { status: 404 });
  const asset = new URL(req.url).searchParams.get("asset");
  if (!asset) return Response.json({ sfx: row });
  const name = asset === "audio" ? row.cachedPath : asset === "waveform" ? row.waveformPath : null;
  if (!name) return Response.json({ error: "unknown asset" }, { status: 400 });
  // Cache file names are generated ids; still refuse anything that would leave the cache folder.
  const file = path.join(sfxCacheDir(), path.basename(name));
  if (!fs.existsSync(file)) return Response.json({ error: "not cached: rescan" }, { status: 404 });
  return new Response(fs.readFileSync(file), {
    headers: { "content-type": asset === "audio" ? "audio/wav" : "image/png", "cache-control": `private, max-age=60` },
  });
}

/** PATCH /api/sfx/:id { enabled?, defaultGainDb?, tags? } */
export async function PATCH(req: Request, { params }: Ctx) {
  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return Response.json({ error: "invalid JSON body" }, { status: 400 });
  }
  const p = sfxPatchSchema.safeParse(raw);
  if (!p.success) return Response.json({ error: "invalid body", issues: z.treeifyError(p.error) }, { status: 400 });
  const row = updateSfx(getDb(), (await params).id, p.data);
  return row ? Response.json({ sfx: row }) : Response.json({ error: "not_found" }, { status: 404 });
}
