import fs from "node:fs";
import path from "node:path";
import { clipFiles, planSchema } from "@clip/shared";
import { PermanentError, requireSourceId, type StageHandler } from "../context";
import { runProcess } from "../proc";
import { runEncode } from "../render/encode";
import { buildBaseArgs, measureLoudnessArgs, parseLoudnorm } from "../render/ffmpegBase";

/**
 * RENDER_BASE (SPEC §7.8, heavy): section.mp4 + plan.json → base.mp4 (1080×1920, cuts, crop/zoom, voice
 * clean-up), then measure its loudness once so COMPOSE can normalize in a single pass.
 */
export const renderBase: StageHandler = async (task, { env, api, signal }) => {
  const sourceId = requireSourceId(task);
  const clipId = task.clipId;
  if (!clipId) throw new PermanentError("RENDER_BASE needs a clipId");
  const cf = clipFiles(env.STORAGE_DIR, clipId);
  if (!fs.existsSync(cf.plan) || !fs.existsSync(cf.section)) throw new PermanentError("plan.json / section.mp4 missing: run PREP_CLIP first");
  const plan = planSchema.parse(JSON.parse(fs.readFileSync(cf.plan, "utf8")));
  const { clip } = await api.clip(clipId);
  await api.patchClip(clipId, { status: "rendering" });

  const tmp = `${cf.base}.part.mp4`;
  const r = await runEncode(env, (encoder) => buildBaseArgs({ section: cf.section, plan, out: tmp, encoder, threads: env.FFMPEG_THREADS, fps: env.OUTPUT_FPS }), signal);
  fs.renameSync(tmp, cf.base);
  if (r.fellBack) await api.event({ sourceId, clipId, level: "warn", message: `h264_qsv failed, rendered with libx264 instead: ${r.qsvError}` });

  // First loudnorm pass on the voice-only base; COMPOSE applies it in one pass (SPEC §7.10).
  const res = await runProcess(env.FFMPEG_PATH, measureLoudnessArgs(cf.base, env.TARGET_LUFS), { lowPriority: env.LOW_PRIORITY, signal }).catch((e: Error) => ({ stderr: e.message }));
  const measured = parseLoudnorm(res.stderr);
  if (measured) fs.writeFileSync(cf.baseLoudness, JSON.stringify(measured, null, 2));
  else fs.rmSync(cf.baseLoudness, { force: true });

  await api.patchClip(clipId, { baseVersion: clip.baseVersion + 1, basePath: path.relative(env.STORAGE_DIR, cf.base).split(path.sep).join("/") });
  await api.event({
    sourceId,
    clipId,
    level: "info",
    message: `Base render (${r.encoder}) in ${(r.ms / 1000).toFixed(1)} s for a ${plan.duration.toFixed(1)} s clip (${plan.layout})${measured ? `; voice at ${measured.input_i} LUFS` : "; loudness not measured"}`,
    data: { ms: r.ms, encoder: r.encoder, duration: plan.duration },
  });
  return [{ type: "COMPOSE", sourceId, clipId, payload: task.payload }];
};
