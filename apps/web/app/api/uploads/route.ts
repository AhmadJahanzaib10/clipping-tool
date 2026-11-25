import fs from "node:fs";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { ReadableStream as NodeReadableStream } from "node:stream/web";
import { nanoid } from "nanoid";
import { loadEnv, UPLOAD_EXTS, uploadsDir } from "@clip/shared";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * POST /api/uploads — raw file body (streamed to disk, never buffered), filename in `x-filename`.
 * Returns { uploadId }; pass it to POST /api/jobs.
 */
export async function POST(req: Request) {
  const name = decodeURIComponent(req.headers.get("x-filename") ?? "");
  const ext = path.extname(name).toLowerCase();
  if (!(UPLOAD_EXTS as readonly string[]).includes(ext)) {
    return Response.json({ error: `unsupported file type '${ext || "none"}'; allowed: ${UPLOAD_EXTS.join(", ")}` }, { status: 400 });
  }
  if (!req.body) return Response.json({ error: "empty body" }, { status: 400 });

  const dir = uploadsDir(loadEnv().STORAGE_DIR);
  fs.mkdirSync(dir, { recursive: true });
  const uploadId = nanoid();
  const final = path.join(dir, `${uploadId}${ext}`);
  const part = `${final}.part`;
  try {
    await pipeline(Readable.fromWeb(req.body as unknown as NodeReadableStream), fs.createWriteStream(part));
    fs.renameSync(part, final);
  } catch (e) {
    fs.rmSync(part, { force: true });
    return Response.json({ error: `upload failed: ${e instanceof Error ? e.message : e}` }, { status: 500 });
  }
  return Response.json({ uploadId, bytes: fs.statSync(final).size, name });
}
