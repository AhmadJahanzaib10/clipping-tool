import fs from "node:fs";
import path from "node:path";
import { eq } from "drizzle-orm";
import { findRepoRoot, overlayFileName } from "@clip/shared";
import { schema } from "@clip/shared/db";
import { getDb } from "@/lib/db";
import type { IdParams } from "@/lib/clips-api";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_BYTES = 5 * 1024 * 1024;
const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** POST — raw PNG body (`x-filename` header) → assets/overlays/<safe name>.png. Returns the stored file name. */
export async function POST(req: Request, { params }: IdParams) {
  const id = (await params).id;
  if (!getDb().select().from(schema.campaigns).where(eq(schema.campaigns.id, id)).get()) return Response.json({ error: "not_found" }, { status: 404 });
  const buf = Buffer.from(await req.arrayBuffer());
  if (buf.length > MAX_BYTES) return Response.json({ error: "overlay must be under 5 MB" }, { status: 413 });
  if (!buf.subarray(0, 8).equals(PNG_MAGIC)) return Response.json({ error: "overlay must be a PNG (transparent background recommended)" }, { status: 400 });
  const name = overlayFileName(decodeURIComponent(req.headers.get("x-filename") ?? "overlay.png"));
  const dir = path.join(findRepoRoot(), "assets", "overlays");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, name), buf);
  return Response.json({ file: name, bytes: buf.length });
}

/** GET ?file=<name> — preview an uploaded overlay. */
export async function GET(req: Request) {
  const name = path.basename(new URL(req.url).searchParams.get("file") ?? "");
  const file = path.join(findRepoRoot(), "assets", "overlays", name);
  if (!name.endsWith(".png") || !fs.existsSync(file)) return new Response("not found", { status: 404 });
  return new Response(fs.readFileSync(file), { headers: { "content-type": "image/png" } });
}
