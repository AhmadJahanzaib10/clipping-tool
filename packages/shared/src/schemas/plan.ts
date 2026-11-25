import { z } from "zod";

/** SPEC §7.5–7.7 artifacts: section.json, analysis.json, plan.json, words.json (all per clip). */

/** storage/clips/{clipId}/section.json — the downloaded/cut part of the source. */
export const sectionInfoSchema = z.object({
  file: z.string(),
  /** Source time (s) that corresponds to t = 0 in section.mp4 (measured by audio alignment). */
  sourceStart: z.number(),
  duration: z.number().positive(),
  width: z.number().int().positive(),
  height: z.number().int().positive(),
  fps: z.number().positive(),
  bytes: z.number().int().nonnegative(),
  method: z.enum(["section", "full-fallback", "upload-cut"]),
  /** Normalized cross-correlation peak of the audio alignment (0–1); low = fell back to the requested start. */
  alignScore: z.number(),
});
export type SectionInfo = z.infer<typeof sectionInfoSchema>;

/** Normalized face box (0–1 of the frame), from the media service. */
export const faceBoxSchema = z.object({ x: z.number(), y: z.number(), w: z.number(), h: z.number(), score: z.number() });
export type FaceBox = z.infer<typeof faceBoxSchema>;

/** storage/clips/{clipId}/analysis.json — times in section time. */
export const analysisSchema = z.object({
  width: z.number().int().positive(),
  height: z.number().int().positive(),
  fps: z.number().positive(),
  duration: z.number().positive(),
  sampleFps: z.number().positive(),
  scenes: z.array(z.object({ s: z.number(), e: z.number() })),
  faces: z.array(z.object({ t: z.number(), faces: z.array(faceBoxSchema) })),
});
export type Analysis = z.infer<typeof analysisSchema>;

export const segmentSchema = z.object({
  kind: z.enum(["teaser", "transition", "main"]),
  /** Source time range (transition: both equal to the next segment's start, nothing played). */
  srcStart: z.number(),
  srcEnd: z.number(),
  outStart: z.number(),
  outEnd: z.number(),
});
export type Segment = z.infer<typeof segmentSchema>;

export const rectSchema = z.object({ x: z.number(), y: z.number(), w: z.number(), h: z.number() });
export type Rect = z.infer<typeof rectSchema>;

/** Crop window x (left edge, section pixels) at output time t; `jump` = hard cut to this value at t. */
export const cropKeyframeSchema = z.object({ t: z.number(), x: z.number(), jump: z.boolean().optional() });
export type CropKeyframe = z.infer<typeof cropKeyframeSchema>;

export const zoomKeyframeSchema = z.object({
  /** Output times: ease in start → full scale at `peak` → hold → ease out from `holdEnd` → back at `end`. */
  start: z.number(),
  peak: z.number(),
  holdEnd: z.number(),
  end: z.number(),
  scale: z.number().min(1),
});
export type ZoomKeyframe = z.infer<typeof zoomKeyframeSchema>;

export const cropPlanSchema = z.discriminatedUnion("mode", [
  z.object({ mode: z.literal("single"), w: z.number(), h: z.number(), y: z.number(), keyframes: z.array(cropKeyframeSchema).min(1) }),
  z.object({ mode: z.literal("split"), top: rectSchema, bottom: rectSchema }),
  z.object({ mode: z.literal("fit") }),
]);
export type CropPlan = z.infer<typeof cropPlanSchema>;

/** storage/clips/{clipId}/plan.json — everything RENDER_BASE needs. */
export const planSchema = z.object({
  version: z.literal(1),
  clipId: z.string(),
  layout: z.enum(["single", "split", "fit"]),
  layoutReason: z.string(),
  focus: z.enum(["auto", "left", "center", "right"]),
  section: z.object({ sourceStart: z.number(), width: z.number(), height: z.number(), fps: z.number() }),
  segments: z.array(segmentSchema).min(1),
  duration: z.number().positive(),
  crop: cropPlanSchema,
  zoom: z.array(zoomKeyframeSchema),
  /** Scene cuts in output time (also every jump cut from pacing). */
  cuts: z.array(z.number()),
  /** Automatic SFX cues with why they were placed (the cues themselves live in the clip's edit.sfxCues). */
  sfx: z.array(z.object({ at: z.number(), sfxId: z.string(), category: z.string(), reason: z.string(), gainDb: z.number() })).default([]),
  stats: z.object({
    removedPauses: z.number().int(),
    removedFillers: z.number().int(),
    savedSec: z.number(),
    coldOpen: z.boolean(),
  }),
});
export type Plan = z.infer<typeof planSchema>;

/** storage/clips/{clipId}/words.json — caption words in output time. */
export const planWordSchema = z.object({
  /** Index in the clip's source word list (stable id for wordEdits). */
  i: z.number().int(),
  w: z.string(),
  s: z.number(),
  e: z.number(),
  speaker: z.number().int().optional(),
  emphasis: z.boolean().optional(),
  teaser: z.boolean().optional(),
});
export type PlanWord = z.infer<typeof planWordSchema>;
