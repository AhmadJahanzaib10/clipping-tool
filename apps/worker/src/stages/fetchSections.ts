import fs from "node:fs";
import path from "node:path";
import { clipFiles, findUploadFile, sourceFiles, type SectionInfo } from "@clip/shared";
import { z } from "zod";
import { PermanentError, requireSourceId, type StageContext, type StageHandler } from "../context";
import { runProcess } from "../proc";
import { cutSectionArgs, parseProbe, probeArgs } from "../render/audio";

/** Seconds of margin on each side of the clip (SPEC §7.5: start-2 … end+2). */
export const SECTION_PAD_SEC = 2;
const SECTION_ATTEMPTS = 2;
/** Below this, the alignment didn't find the audio: fall back to the requested start. */
const MIN_ALIGN_SCORE = 0.3;

const downloadResult = z.object({ file: z.string(), bytes: z.number(), fullSizeEstimate: z.number().nullable().optional() });
const fullResult = z.object({ file: z.string(), bytes: z.number(), cached: z.boolean().optional() });
const alignResult = z.object({ sourceStart: z.number(), score: z.number(), note: z.string().optional() });

const mb = (n: number) => `${(n / 1024 / 1024).toFixed(1)} MB`;

/** [start, end] of source to fetch for a clip: the trim (which contains any cold-open teaser) ± 2 s. */
export function sectionRange(trim: { start: number; end: number }, sourceDuration: number | null): { start: number; end: number } {
  const start = Math.max(0, trim.start - SECTION_PAD_SEC);
  const end = sourceDuration ? Math.min(sourceDuration, trim.end + SECTION_PAD_SEC) : trim.end + SECTION_PAD_SEC;
  return { start, end };
}

async function probeSection(ctx: StageContext, file: string) {
  const p = parseProbe(JSON.parse((await runProcess(ctx.env.FFPROBE_PATH, probeArgs(file), { signal: ctx.signal })).stdout));
  if (!p.hasVideo || !p.width || !p.height || !p.durationSec) throw new Error(`section ${file} has no usable video stream`);
  return p;
}

/**
 * FETCH_SECTIONS (SPEC §7.5): per clip, only its section of the video.
 *  - URL: yt-dlp section download (2 attempts), else one cached full download, cut with -c copy
 *  - upload: -c copy cut from the uploaded file
 * Each section's true start is measured by aligning its audio with the source audio.
 */
export const fetchSections: StageHandler = async (task, ctx) => {
  const sourceId = requireSourceId(task);
  const { api, env, media, signal } = ctx;
  const src = await api.getSource(sourceId);
  const clips = (await api.sourceClips(sourceId)).filter((c) => c.edit);
  if (!clips.length) throw new PermanentError("source has no clips to fetch");
  await api.patchSource(sourceId, { status: "fetching", error: null });
  const sf = sourceFiles(env.STORAGE_DIR, sourceId);
  if (!fs.existsSync(sf.wav)) throw new PermanentError("source audio.wav is missing (needed to align sections)");
  const fullFile = path.join(sf.dir, "full.mp4");

  let totalBytes = 0;
  let fullEstimate: number | null = null;
  let usedFallback = false;
  const methods: Record<string, number> = {};

  for (const clip of clips) {
    if (signal.aborted) throw new Error("aborted");
    const cf = clipFiles(env.STORAGE_DIR, clip.id);
    fs.mkdirSync(cf.dir, { recursive: true });
    const range = sectionRange(clip.edit!.trim, src.durationSec);

    // Idempotent on retry: keep a section that already covers the range.
    if (fs.existsSync(cf.sectionInfo) && fs.existsSync(cf.section)) {
      const prev = JSON.parse(fs.readFileSync(cf.sectionInfo, "utf8")) as SectionInfo;
      if (prev.sourceStart <= clip.edit!.trim.start && prev.sourceStart + prev.duration >= clip.edit!.trim.end) {
        totalBytes += prev.bytes;
        methods[prev.method] = (methods[prev.method] ?? 0) + 1;
        continue;
      }
    }

    let method: SectionInfo["method"];
    const cut = (input: string) => runProcess(env.FFMPEG_PATH, cutSectionArgs(input, range.start, range.end - range.start, cf.section), { lowPriority: env.LOW_PRIORITY, signal });
    if (src.kind === "upload") {
      const up = findUploadFile(env.STORAGE_DIR, sourceId);
      if (!up) throw new PermanentError("uploaded file is missing");
      await cut(up);
      method = "upload-cut";
    } else {
      if (!src.url) throw new PermanentError("URL source without url");
      let ok = false;
      if (!usedFallback && env.SECTION_DOWNLOAD) {
        for (let attempt = 1; attempt <= SECTION_ATTEMPTS && !ok; attempt++) {
          try {
            const r = await media.call(
              "download_section",
              { url: src.url, start: range.start, end: range.end, outFile: cf.section, nodePath: process.execPath },
              downloadResult,
              { signal },
            );
            fullEstimate ??= r.fullSizeEstimate ?? null;
            ok = true;
          } catch (e) {
            if (signal.aborted) throw e;
            await api.event({ sourceId, clipId: clip.id, level: "warn", message: `Section download attempt ${attempt} failed: ${e instanceof Error ? e.message : e}` });
          }
        }
      }
      if (ok) method = "section";
      else {
        // SPEC §7.5 fallback: one full download, cached for every remaining clip of this source.
        if (!usedFallback) await api.event({ sourceId, level: "warn", message: env.SECTION_DOWNLOAD ? "Falling back to one full download for this source" : "SECTION_DOWNLOAD=false: using one full download" });
        usedFallback = true;
        const r = await media.call("download_full", { url: src.url, outFile: fullFile, nodePath: process.execPath }, fullResult, { signal });
        if (!r.cached) totalBytes += r.bytes;
        await cut(fullFile);
        method = "full-fallback";
      }
    }

    // Where does this section really start? (keyframe-aligned cuts start a little early)
    const al = await media.call(
      "align_section",
      { section: cf.section, sourceWav: sf.wav, approxStart: range.start, ffmpegPath: env.FFMPEG_PATH },
      alignResult,
      { signal },
    );
    const aligned = al.score >= MIN_ALIGN_SCORE;
    if (!aligned) await api.event({ sourceId, clipId: clip.id, level: "warn", message: `Section audio alignment weak (score ${al.score.toFixed(2)}); using the requested start` });
    const p = await probeSection(ctx, cf.section);
    const info: SectionInfo = {
      file: path.basename(cf.section),
      sourceStart: aligned ? al.sourceStart : range.start,
      duration: p.durationSec!,
      width: p.width!,
      height: p.height!,
      fps: p.fps ?? 30,
      bytes: fs.statSync(cf.section).size,
      method,
      alignScore: Math.round(al.score * 1000) / 1000,
    };
    fs.writeFileSync(cf.sectionInfo, JSON.stringify(info, null, 2));
    if (method === "section") totalBytes += info.bytes;
    methods[method] = (methods[method] ?? 0) + 1;
  }

  const how = Object.entries(methods).map(([m, n]) => `${n}× ${m}`).join(", ");
  const estimate = fullEstimate ? ` vs full video ≈ ${mb(fullEstimate)} (${Math.round((100 * totalBytes) / fullEstimate)}%)` : "";
  await api.event({
    sourceId,
    level: usedFallback ? "warn" : "info",
    message: `Sections for ${clips.length} clips (${how}): downloaded ${mb(totalBytes)}${estimate}`,
    data: { totalBytes, fullEstimate, methods },
  });
  await api.patchSource(sourceId, { status: "clipping" });
  return clips.map((c) => ({ type: "ANALYZE" as const, sourceId, clipId: c.id, payload: task.payload }));
};
