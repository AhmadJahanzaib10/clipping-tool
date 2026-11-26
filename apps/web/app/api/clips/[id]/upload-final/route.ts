import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { ReadableStream as NodeReadableStream } from "node:stream/web";
import { eq } from "drizzle-orm";
import { addEvent, clipFiles, loadEnv } from "@clip/shared";
import { schema } from "@clip/shared/db";
import { getDb } from "@/lib/db";
import type { IdParams } from "@/lib/clips-api";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * POST /api/clips/:id/upload-final — raw MP4 body (e.g. edited in CapCut). Stored as the next version
 * (clip.vN.mp4) and used for delivery; the previous version stays for compare.
 */
export async function POST(req: Request, { params }: IdParams) {
  const id = (await params).id;
  const env = loadEnv();
  const db = getDb();
  const clip = db.select().from(schema.clips).where(eq(schema.clips.id, id)).get();
  if (!clip) return Response.json({ error: "not_found" }, { status: 404 });
  if (clip.status === "approved") return Response.json({ error: "clip is approved; re-open it first" }, { status: 409 });
  if (!req.body) return Response.json({ error: "empty body" }, { status: 400 });

  const cf = clipFiles(env.STORAGE_DIR, id);
  fs.mkdirSync(cf.dir, { recursive: true });
  const version = clip.composeVersion + 1;
  const out = cf.output(version);
  const tmp = `${out}.upload`;
  try {
    await pipeline(Readable.fromWeb(req.body as unknown as NodeReadableStream), fs.createWriteStream(tmp));
  } catch (e) {
    fs.rmSync(tmp, { force: true });
    return Response.json({ error: `upload failed: ${e instanceof Error ? e.message : e}` }, { status: 500 });
  }

  // Must be a real video with audio.
  const probe = spawnSync(env.FFPROBE_PATH, ["-v", "error", "-show_entries", "stream=codec_type,width,height:format=duration", "-of", "json", tmp], { encoding: "utf8" });
  let info: { streams?: { codec_type: string; width?: number; height?: number }[]; format?: { duration?: string } } = {};
  try {
    info = JSON.parse(probe.stdout || "{}");
  } catch {
    // handled below
  }
  const video = info.streams?.find((s) => s.codec_type === "video");
  const hasAudio = info.streams?.some((s) => s.codec_type === "audio");
  if (probe.status !== 0 || !video || !hasAudio) {
    fs.rmSync(tmp, { force: true });
    return Response.json({ error: "not a video with sound (expected an MP4 with video and audio)" }, { status: 400 });
  }
  fs.renameSync(tmp, out);
  spawnSync(env.FFMPEG_PATH, ["-hide_banner", "-nostdin", "-loglevel", "error", "-y", "-ss", "1", "-i", out, "-frames:v", "1", "-q:v", "3", cf.thumb]);
  for (let v = version - 2; v >= 1; v--) fs.rmSync(cf.output(v), { force: true });

  const rel = (p: string) => path.relative(env.STORAGE_DIR, p).split(path.sep).join("/");
  const updated = db
    .update(schema.clips)
    .set({ composeVersion: version, outputPath: rel(out), thumbPath: rel(cf.thumb), finalUploaded: true, status: "rendered", updatedAt: new Date().toISOString() })
    .where(eq(schema.clips.id, id))
    .returning()
    .get();
  const portrait = video.width && video.height ? `${video.width}×${video.height}` : "?";
  addEvent(db, { sourceId: clip.sourceId, clipId: id, level: video.width === 1080 && video.height === 1920 ? "info" : "warn", message: `Final uploaded as v${version} (${portrait}, ${Number(info.format?.duration ?? 0).toFixed(1)} s)` });
  return Response.json({ clip: updated, version, size: portrait });
}
