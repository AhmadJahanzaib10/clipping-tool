import { z } from "zod";

export const CAPTION_PRESETS = ["bold-yellow", "white-box", "clean-white"] as const;
export const HOOK_STYLES = ["top-banner", "center-pop"] as const;
export const ZOOM_LEVELS = ["off", "subtle", "punchy"] as const;
export const SFX_INTENSITIES = ["off", "subtle", "normal", "heavy"] as const;
export const PLATFORMS = ["tiktok", "instagram", "youtube"] as const;

export const pacingSchema = z.object({
  tightenPauses: z.boolean().default(true),
  maxPauseSec: z.number().min(0.1).max(5).default(0.45),
  trimFillers: z.boolean().default(true),
});
export type Pacing = z.infer<typeof pacingSchema>;

export const overlaySchema = z.object({
  file: z.string().min(1),
  position: z.enum(["top", "bottom", "top-left", "top-right"]),
  widthPct: z.number().min(1).max(100),
  opacity: z.number().min(0).max(1),
});

export const DEFAULT_SFX_CATEGORIES = ["whoosh", "pop", "impact", "transition"];

/** SPEC §6.1 */
export const campaignConfigSchema = z
  .object({
    minLengthSec: z.number().positive().default(20),
    maxLengthSec: z.number().positive().default(60),
    idealLengthSec: z.number().positive().default(35),
    requiredHashtags: z.array(z.string()).default([]),
    requiredMentions: z.array(z.string()).default([]),
    overlay: overlaySchema.optional(),
    showNameOnScreen: z.string().optional(),
    captionPreset: z.enum(CAPTION_PRESETS).default("bold-yellow"),
    hookStyle: z.enum(HOOK_STYLES).default("top-banner"),
    pacing: pacingSchema.prefault({}),
    coldOpen: z.enum(["off", "auto", "always"]).default("auto"),
    zoom: z.enum(ZOOM_LEVELS).default("subtle"),
    sfx: z
      .object({
        intensity: z.enum(SFX_INTENSITIES).default("normal"),
        categories: z.array(z.string()).default(DEFAULT_SFX_CATEGORIES),
        gainDb: z.number().min(-60).max(12).default(-14),
      })
      .prefault({}),
    bannedWords: z.array(z.string()).default([]),
    briefNotes: z.string().default(""),
  })
  .refine((c) => c.minLengthSec <= c.idealLengthSec && c.idealLengthSec <= c.maxLengthSec, {
    message: "Lengths must satisfy minLengthSec <= idealLengthSec <= maxLengthSec",
    path: ["idealLengthSec"],
  });
export type CampaignConfig = z.infer<typeof campaignConfigSchema>;
export type CampaignConfigInput = z.input<typeof campaignConfigSchema>;
