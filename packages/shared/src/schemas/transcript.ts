import { z } from "zod";

/** SPEC §7.2 */
export const wordSchema = z.object({
  w: z.string(),
  s: z.number().min(0),
  e: z.number().min(0),
  speaker: z.number().int().optional(),
  conf: z.number().min(0).max(1).optional(),
  filler: z.boolean().optional(),
});
export type Word = z.infer<typeof wordSchema>;

export const transcriptSchema = z.object({
  provider: z.enum(["youtube", "deepgram", "whisper"]),
  quality: z.enum(["rough", "precise"]),
  words: z.array(wordSchema),
  sentences: z.array(
    z.object({ s: z.number(), e: z.number(), text: z.string(), speaker: z.number().int().optional() }),
  ),
});
export type Transcript = z.infer<typeof transcriptSchema>;
