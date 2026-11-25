import fs from "node:fs";
import { findUploadFile, sourceFiles } from "@clip/shared";
import { z } from "zod";
import { PermanentError, requireSourceId, type StageHandler } from "../context";
import { runProcess } from "../proc";
import { extractAudioArgs, parseProbe, probeArgs } from "../render/audio";

export const downloadResultSchema = z.object({
  title: z.string().nullish(),
  durationSec: z.number().nullish(),
  width: z.number().nullish(),
  height: z.number().nullish(),
  audioPath: z.string(),
  audioBytes: z.number(),
  audioFormat: z.object({ formatId: z.string().nullish(), ext: z.string().nullish(), acodec: z.string().nullish(), vcodec: z.string().nullish() }),
  captionsPath: z.string().nullable(),
  captionsKind: z.enum(["manual", "auto"]).nullable(),
  captionsLang: z.string().nullable(),
});

const mb = (n: number) => `${(n / 1024 / 1024).toFixed(1)} MB`;

/**
 * INGEST (SPEC §7.1), audio first:
 *  - URL: yt-dlp best audio only + English json3 captions + metadata (no video bytes)
 *  - upload: ffprobe metadata, audio extracted with -vn (no video decode)
 * Both end with audio.wav (16 kHz mono) + audio.opus (32 kbps).
 */
export const ingest: StageHandler = async (task, { env, api, media, signal }) => {
  const sourceId = requireSourceId(task);
  const src = await api.getSource(sourceId);
  await api.patchSource(sourceId, { status: "ingesting", error: null });
  const files = sourceFiles(env.STORAGE_DIR, sourceId);
  fs.mkdirSync(files.dir, { recursive: true });

  let input: string;
  let rawAudio: string | null = null;
  if (src.kind === "url") {
    if (!src.url) throw new PermanentError("URL source without url");
    const r = await media.call("download_audio", { url: src.url, outDir: files.dir, nodePath: process.execPath }, downloadResultSchema, { signal });
    if (r.audioFormat.vcodec && r.audioFormat.vcodec !== "none") {
      throw new PermanentError(`downloaded format ${r.audioFormat.formatId} contains video (${r.audioFormat.vcodec}); refusing`);
    }
    await api.patchSource(sourceId, { title: r.title ?? null, durationSec: r.durationSec ?? null, width: r.width ?? null, height: r.height ?? null });
    await api.event({
      sourceId,
      level: "info",
      message: `Audio downloaded: ${mb(r.audioBytes)} (format ${r.audioFormat.formatId}, ${r.audioFormat.acodec}, video: none). Captions: ${r.captionsKind ? `${r.captionsKind} ${r.captionsLang}` : "none"}`,
      data: { audioBytes: r.audioBytes, format: r.audioFormat, captions: r.captionsKind },
    });
    input = r.audioPath;
    rawAudio = r.audioPath;
  } else {
    const upload = findUploadFile(env.STORAGE_DIR, sourceId);
    if (!upload) throw new PermanentError("uploaded file is missing");
    const probe = parseProbe(JSON.parse((await runProcess(env.FFPROBE_PATH, probeArgs(upload), { signal })).stdout));
    if (!probe.hasAudio) throw new PermanentError("uploaded video has no audio track");
    await api.patchSource(sourceId, { durationSec: probe.durationSec, width: probe.width, height: probe.height });
    await api.event({ sourceId, level: "info", message: `Upload probed: ${probe.width}x${probe.height}, ${Math.round(probe.durationSec ?? 0)} s` });
    input = upload;
  }

  const t0 = Date.now();
  await runProcess(env.FFMPEG_PATH, extractAudioArgs(input, files.wav, files.opus, env.FFMPEG_THREADS), { lowPriority: env.LOW_PRIORITY, signal });
  if (rawAudio && rawAudio !== files.wav && rawAudio !== files.opus) fs.rmSync(rawAudio, { force: true });
  await api.event({
    sourceId,
    level: "info",
    message: `Audio extracted in ${((Date.now() - t0) / 1000).toFixed(1)} s: wav ${mb(fs.statSync(files.wav).size)}, opus ${mb(fs.statSync(files.opus).size)}`,
  });
  return [{ type: "TRANSCRIBE", sourceId }];
};
