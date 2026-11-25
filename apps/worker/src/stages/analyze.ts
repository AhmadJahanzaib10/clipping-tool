import fs from "node:fs";
import path from "node:path";
import { clipFiles, findRepoRoot } from "@clip/shared";
import { z } from "zod";
import { PermanentError, requireSourceId, type StageHandler } from "../context";

const analyzeResult = z.object({ out: z.string(), scenes: z.number(), samples: z.number(), samplesWithFace: z.number(), width: z.number(), height: z.number() });

export const faceModelDir = () => path.join(findRepoRoot(), "assets", ".cache", "models");

/** ANALYZE (SPEC §7.6): scenes + faces on the clip's section only (heavy task). */
export const analyze: StageHandler = async (task, { env, api, media, signal }) => {
  const sourceId = requireSourceId(task);
  if (!task.clipId) throw new PermanentError("ANALYZE needs a clipId");
  const cf = clipFiles(env.STORAGE_DIR, task.clipId);
  if (!fs.existsSync(cf.section)) throw new PermanentError("section.mp4 is missing: run FETCH_SECTIONS first");
  const t0 = Date.now();
  const r = await media.call(
    "analyze",
    { section: cf.section, out: cf.analysis, sampleFps: 3, modelDir: faceModelDir(), ffmpegPath: env.FFMPEG_PATH, ffprobePath: env.FFPROBE_PATH },
    analyzeResult,
    { signal },
  );
  await api.event({
    sourceId,
    clipId: task.clipId,
    level: "info",
    message: `Analysis in ${((Date.now() - t0) / 1000).toFixed(1)} s: ${r.scenes} scene(s), a face in ${r.samplesWithFace}/${r.samples} samples (${r.width}×${r.height})`,
  });
  return [{ type: "PREP_CLIP", sourceId, clipId: task.clipId, payload: task.payload }];
};
