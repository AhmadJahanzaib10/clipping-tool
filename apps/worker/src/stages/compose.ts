import fs from "node:fs";
import path from "node:path";
import { clipFiles, findRepoRoot, planSchema, planWordSchema, sfxCacheDir } from "@clip/shared";
import { z } from "zod";
import { PermanentError, requireSourceId, type StageHandler } from "../context";
import { runProcess } from "../proc";
import { buildAss, buildSrt, PRESETS } from "../render/ass";
import { runEncode } from "../render/encode";
import { buildComposeArgs, thumbnailArgs, type SfxInput } from "../render/ffmpegCompose";
import { parseLoudnorm } from "../render/ffmpegBase";

export const fontsDir = () => path.join(findRepoRoot(), "assets", "fonts");
export const overlaysDir = () => path.join(findRepoRoot(), "assets", "overlays");

/**
 * COMPOSE (SPEC §7.10, the fast pass after every text/SFX edit): captions.ass from words.json + the edit,
 * overlay, progress bar, SFX mix and loudness → clip.vN.mp4 + thumb.jpg. The previous version is kept for
 * side-by-side compare; older ones are removed.
 */
export const compose: StageHandler = async (task, { env, api, signal }) => {
  const sourceId = requireSourceId(task);
  const clipId = task.clipId;
  if (!clipId) throw new PermanentError("COMPOSE needs a clipId");
  const cf = clipFiles(env.STORAGE_DIR, clipId);
  if (!fs.existsSync(cf.base)) throw new PermanentError("base.mp4 missing: run RENDER_BASE first");
  const plan = planSchema.parse(JSON.parse(fs.readFileSync(cf.plan, "utf8")));
  const words = z.array(planWordSchema).parse(JSON.parse(fs.readFileSync(cf.words, "utf8")));
  const { clip, campaign } = await api.clip(clipId);
  const edit = clip.edit;
  if (!edit) throw new PermanentError("clip has no edit");
  const cfg = campaign.config;

  // Captions + hook (SPEC §7.9). Hook: custom text, else the chosen A/B hook.
  const hook = edit.hookOverride?.trim() || (edit.hookChoice === "B" ? clip.hookB : clip.hookA) || "";
  const { ass, lines } = buildAss({ words, edit, hook, hookStyle: cfg.hookStyle, layout: plan.layout, duration: plan.duration, showNameOnScreen: cfg.showNameOnScreen });
  fs.writeFileSync(cf.ass, ass);
  fs.writeFileSync(cf.srt, buildSrt(lines, PRESETS[edit.captionPreset]?.uppercase ?? false));

  // SFX cues → cached normalized WAVs; cues whose sound is gone are skipped.
  const library = new Map((await api.sfxLibrary()).map((s) => [s.id, s]));
  const sfx: SfxInput[] = [];
  let missing = 0;
  for (const c of edit.sfxCues) {
    const s = library.get(c.sfxId);
    const file = s?.cachedPath ? path.join(sfxCacheDir(), s.cachedPath) : null;
    if (!file || !fs.existsSync(file) || c.at >= plan.duration) {
      missing++;
      continue;
    }
    sfx.push({ file, at: c.at, gainDb: c.gainDb });
  }

  // Campaign overlay (SPEC §6.1), if required and switched on in the edit.
  let overlay = null as Parameters<typeof buildComposeArgs>[0]["overlay"];
  if (cfg.overlay && edit.overlay) {
    const file = path.join(overlaysDir(), path.basename(cfg.overlay.file));
    if (fs.existsSync(file)) overlay = { ...cfg.overlay, file };
    else await api.event({ sourceId, clipId, level: "warn", message: `Overlay ${cfg.overlay.file} not found in assets/overlays; rendered without it` });
  }

  const measured = fs.existsSync(cf.baseLoudness) ? parseLoudnorm(fs.readFileSync(cf.baseLoudness, "utf8")) : null;
  const version = clip.composeVersion + 1;
  const out = cf.output(version);
  const tmp = `${out}.part.mp4`;
  const r = await runEncode(
    env,
    (encoder) =>
      buildComposeArgs({ base: cf.base, ass: cf.ass, fontsDir: fontsDir(), duration: plan.duration, overlay, sfx, targetLufs: env.TARGET_LUFS, measured, encoder, threads: env.FFMPEG_THREADS, fps: env.OUTPUT_FPS, out: tmp }),
    signal,
  );
  fs.renameSync(tmp, out);
  await runProcess(env.FFMPEG_PATH, thumbnailArgs(out, cf.thumb, Math.min(1, plan.duration / 2)), { lowPriority: env.LOW_PRIORITY, signal });
  if (r.fellBack) await api.event({ sourceId, clipId, level: "warn", message: `h264_qsv failed, composed with libx264 instead: ${r.qsvError}` });

  // Keep this and the previous version (for compare); drop anything older.
  for (let v = version - 2; v >= 1; v--) fs.rmSync(cf.output(v), { force: true });

  const rel = (p: string) => path.relative(env.STORAGE_DIR, p).split(path.sep).join("/");
  await api.patchClip(clipId, { composeVersion: version, outputPath: rel(out), thumbPath: rel(cf.thumb), status: "rendered" });
  await api.event({
    sourceId,
    clipId,
    level: missing ? "warn" : "info",
    message: `Composed v${version} (${r.encoder}) in ${(r.ms / 1000).toFixed(1)} s: ${plan.duration.toFixed(1)} s, ${edit.captionPreset}, ${sfx.length} SFX${missing ? ` (${missing} cue(s) skipped: sound missing)` : ""}${overlay ? ", overlay" : ""}`,
    data: { ms: r.ms, encoder: r.encoder, version },
  });

  // All clips of the source rendered → the source is done.
  const clips = await api.sourceClips(sourceId);
  if (clips.length && clips.every((c) => ["rendered", "approved", "rejected"].includes(c.status))) await api.patchSource(sourceId, { status: "done" });
  return [];
};
