import fs from "node:fs";
import path from "node:path";
import { analysisSchema, clipFiles, makeTranscript, sectionInfoSchema, type Word } from "@clip/shared";
import { z } from "zod";
import { PermanentError, requireSourceId, type StageContext, type StageHandler } from "../context";
import { buildPlan } from "../edit/plan";
import { planSfx } from "../edit/sfxPlanner";
import { readTranscript } from "./selection";

const whisperResult = z.object({
  words: z.array(z.object({ w: z.string(), s: z.number(), e: z.number(), conf: z.number().optional() })),
  durationSec: z.number(),
  model: z.string(),
});

/**
 * Caption words (SPEC §7.7 step 1): a precise transcript is sliced; a rough one (YouTube captions)
 * is replaced by local Whisper on the section audio (model already loaded in the media service).
 */
async function clipWordsFor(ctx: StageContext, sourceId: string, clipId: string, quality: "rough" | "precise" | null, sectionStart: number): Promise<{ words: Word[]; from: string }> {
  if (quality === "precise") return { words: readTranscript(ctx.env, sourceId).words, from: "transcript" };
  const cf = clipFiles(ctx.env.STORAGE_DIR, clipId);
  const cache = path.join(cf.dir, "section-words.json");
  if (fs.existsSync(cache)) return { words: JSON.parse(fs.readFileSync(cache, "utf8")) as Word[], from: "whisper (cached)" };
  const r = await ctx.media.call(
    "transcribe",
    { audio: cf.section, model: ctx.env.WHISPER_MODEL, threads: ctx.env.WHISPER_THREADS, language: "en" },
    whisperResult,
    { signal: ctx.signal },
  );
  // Section time → source time; flag fillers like any transcript.
  const words = makeTranscript("whisper", "precise", r.words.map((w) => ({ ...w, s: w.s + sectionStart, e: w.e + sectionStart }))).words;
  fs.writeFileSync(cache, JSON.stringify(words));
  return { words, from: "whisper on section" };
}

/** PREP_CLIP (SPEC §7.7): words, pacing/timeline map, cold open, layout/crop, zoom → plan.json + words.json. */
export const prepClip: StageHandler = async (task, ctx) => {
  const sourceId = requireSourceId(task);
  const clipId = task.clipId;
  if (!clipId) throw new PermanentError("PREP_CLIP needs a clipId");
  const { api, env } = ctx;
  const { clip, source, campaign } = await api.clip(clipId);
  if (!clip.edit) throw new PermanentError("clip has no edit");
  const cf = clipFiles(env.STORAGE_DIR, clipId);
  if (!fs.existsSync(cf.sectionInfo) || !fs.existsSync(cf.analysis)) throw new PermanentError("section.json / analysis.json missing: run FETCH_SECTIONS and ANALYZE first");
  const section = sectionInfoSchema.parse(JSON.parse(fs.readFileSync(cf.sectionInfo, "utf8")));
  const analysis = analysisSchema.parse(JSON.parse(fs.readFileSync(cf.analysis, "utf8")));

  const { words, from } = await clipWordsFor(ctx, sourceId, clipId, source.transcriptQuality, section.sourceStart);
  // First plan: decide layout automatically. After a render, the editor's choices are respected.
  const autoLayout = clip.baseVersion === 0;
  const { plan, words: planWords } = buildPlan({ clipId, words, edit: clip.edit, config: campaign.config, analysis, section, autoLayout });

  // SFX cues (SPEC §7.7 step 6, §10.3): auto cues are re-planned, manual ones from the editor are kept.
  const library = await api.sfxLibrary();
  const manual = clip.edit.sfxCues.filter((c) => c.source === "manual");
  const auto = planSfx({ clipId, plan, words: planWords, library, sfx: campaign.config.sfx, manual });
  plan.sfx = auto.map((c) => ({ at: c.at, sfxId: c.sfxId, category: c.category, reason: c.reason, gainDb: c.gainDb }));

  fs.writeFileSync(cf.plan, JSON.stringify(plan, null, 2));
  fs.writeFileSync(cf.words, JSON.stringify(planWords));
  const sfxCues = [...manual, ...auto.map(({ category: _c, reason: _r, ...cue }) => cue)].sort((a, b) => a.at - b.at);
  await api.patchClip(clipId, { edit: { ...clip.edit, ...(autoLayout ? { layout: plan.layout } : {}), sfxCues } });

  const keyframes = plan.crop.mode === "single" ? `, ${plan.crop.keyframes.length} crop keyframes` : "";
  await api.event({
    sourceId,
    clipId,
    level: "info",
    message: `Plan: ${plan.layout} (${plan.layoutReason})${keyframes}; ${plan.duration.toFixed(1)} s after pacing (−${plan.stats.savedSec} s: ${plan.stats.removedPauses} pauses, ${plan.stats.removedFillers} fillers)${plan.stats.coldOpen ? ", cold open" : ""}, ${plan.zoom.length} zooms, ${auto.length} SFX cues${library.length ? "" : " (library empty)"}; words from ${from}`,
  });
  return [{ type: "RENDER_BASE", sourceId, clipId, payload: task.payload }];
};
