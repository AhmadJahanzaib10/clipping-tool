import { z } from "zod";
import { pacingSchema, ZOOM_LEVELS } from "./campaign";

/** SPEC §6.2 — everything the editor can change. */
export const clipEditSchema = z
  .object({
    trim: z.object({ start: z.number().min(0), end: z.number().min(0) }),
    layout: z.enum(["single", "split", "fit"]),
    focus: z.enum(["auto", "left", "center", "right"]).optional(),
    pacing: pacingSchema,
    coldOpen: z.object({ enabled: z.boolean(), start: z.number().min(0), end: z.number().min(0) }).nullable(),
    zoom: z.enum(ZOOM_LEVELS),
    captionPreset: z.string(),
    hookChoice: z.enum(["A", "B"]),
    hookOverride: z.string().optional(),
    wordEdits: z.array(
      z.object({ index: z.number().int().min(0), text: z.string().optional(), hidden: z.boolean().optional() }),
    ),
    emphasisWords: z.array(z.string()),
    sfxCues: z.array(
      z.object({
        id: z.string(),
        sfxId: z.string(),
        at: z.number().min(0),
        gainDb: z.number(),
        source: z.enum(["auto", "manual"]),
      }),
    ),
    overlay: z.boolean(),
  })
  .refine((e) => e.trim.end > e.trim.start, { message: "trim.end must be after trim.start", path: ["trim"] });
export type ClipEdit = z.infer<typeof clipEditSchema>;

/** Fields whose change requires RENDER_BASE (picture/timeline); everything else only needs COMPOSE. */
export const BASE_EDIT_FIELDS = ["trim", "layout", "focus", "pacing", "coldOpen", "zoom"] as const satisfies readonly (keyof ClipEdit)[];

/** SPEC §8.3 per-criterion scores, 0–10 each. */
export const clipScoresSchema = z.object({
  hook: z.number().min(0).max(10),
  standalone: z.number().min(0).max(10),
  payoff: z.number().min(0).max(10),
  emotion: z.number().min(0).max(10),
  novelty: z.number().min(0).max(10),
  quotability: z.number().min(0).max(10),
});
export type ClipScores = z.infer<typeof clipScoresSchema>;
