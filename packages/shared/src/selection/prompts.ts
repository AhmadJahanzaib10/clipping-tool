import { z } from "zod";
import { clipScoresSchema } from "../schemas/clip";

/** SPEC §8 prompts and the zod schemas for their responses. */

// ---------- SCOUT ----------

export const SCOUT_SYSTEM = "You find candidate viral moments in transcripts. Return ONLY JSON.";

export function scoutUser(p: { niche: string; idealLengthSec: number; min: number; max: number; lines: string }): string {
  return `Niche: ${p.niche}. Ideal clip length: ${p.idealLengthSec} s (allowed ${p.min}–${p.max}).
Transcript window (start time in seconds, speaker):
${p.lines}

List up to 4 self-contained moments that could stop a scroll: a strong or contrarian opinion, a surprising fact or number, a story with a payoff, conflict or tension, a funny line, a vulnerable admission, or practical advice. Return start, end (from the timestamps), summary (one line), roughScore 0–100.

Respond with a JSON object: {"moments": [{"start": number, "end": number, "summary": string, "roughScore": number}]}`;
}

const num = z.coerce.number();
export const scoutMomentSchema = z.object({
  start: num.min(0),
  end: num.min(0),
  summary: z.string().min(1).max(500),
  roughScore: num.min(0).max(100),
});
/** Accepts {moments:[…]} or a bare array. */
export const scoutResponseSchema = z
  .union([z.object({ moments: z.array(scoutMomentSchema).max(10) }), z.array(scoutMomentSchema).max(10)])
  .transform((r) => (Array.isArray(r) ? r : r.moments));
export type ScoutMoment = z.infer<typeof scoutMomentSchema>;

// ---------- EDIT ----------

export const EDIT_SYSTEM =
  "You are a senior short-form editor whose clips regularly reach millions of views. You choose the best moments and write hooks that create a curiosity gap in the first 2 seconds without lying. Return ONLY JSON matching the schema.";

export interface EditPromptInput {
  niche: string;
  briefNotes: string;
  bannedWords: string[];
  idealLengthSec: number;
  min: number;
  max: number;
  fewShot: string;
  candidates: string;
  n: number;
}

export function editUser(p: EditPromptInput): string {
  return `Campaign niche: ${p.niche}
Brief notes: ${p.briefNotes || "(none)"}
Never use: ${p.bannedWords.length ? p.bannedWords.join(", ") : "(none)"}
Ideal length ${p.idealLengthSec} s (allowed ${p.min}–${p.max}).

Examples of our best past clips (hook → views):
${p.fewShot || "(none yet)"}

Candidates (id, times, text, ±20 s context):
${p.candidates}

Pick the best ${p.n}. For each:
- id, start, end: tighten so the first spoken line is already interesting (no warm-up, no "so", "um", "and") and it ends right after the payoff.
- scores (0–10 each): hook (first 3 s), standalone (makes sense alone), payoff (clear ending), emotion, novelty, quotability.
- hookA and hookB: on-screen text, max 7 words each, two different angles from this list: curiosity gap, bold claim, number/stat, question, "POV:"/story setup, contrarian. Must match what is actually said. No emojis, no ALL CAPS sentences.
- coldOpen: optional {start, end} of a 2–4 s punchline line from inside the clip that would work as a teaser at the very start; null if not clearly better.
- title (YouTube, max 70 chars), captionTiktok, captionInstagram, captionYoutube (different wording, max 150 chars, no hashtags), hashtags (3–5, niche-specific, no generic #fyp spam), emphasisWords (2–6 single words spoken in the clip).
- reason: one sentence.

Respond with a JSON object: {"clips": [{"id": string, "start": number, "end": number, "scores": {"hook": number, "standalone": number, "payoff": number, "emotion": number, "novelty": number, "quotability": number}, "hookA": string, "hookB": string, "coldOpen": {"start": number, "end": number} | null, "title": string, "captionTiktok": string, "captionInstagram": string, "captionYoutube": string, "hashtags": string[], "emphasisWords": string[], "reason": string}]}`;
}

export const editClipSchema = z.object({
  id: z.string().min(1),
  start: num.min(0),
  end: num.min(0),
  scores: clipScoresSchema,
  hookA: z.string(),
  hookB: z.string(),
  coldOpen: z.object({ start: num, end: num }).nullish(),
  title: z.string().default(""),
  captionTiktok: z.string().default(""),
  captionInstagram: z.string().default(""),
  captionYoutube: z.string().default(""),
  hashtags: z.array(z.string()).default([]),
  emphasisWords: z.array(z.string()).default([]),
  reason: z.string().default(""),
});
export const editResponseSchema = z
  .union([z.object({ clips: z.array(editClipSchema).min(1).max(20) }), z.array(editClipSchema).min(1).max(20)])
  .transform((r) => (Array.isArray(r) ? r : r.clips));
export type EditClip = z.infer<typeof editClipSchema>;

// ---------- JSON extraction ----------

/** Parse JSON from a model reply, tolerating ```json fences and prose around the object. */
export function extractJson(text: string): unknown {
  const t = text.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```\s*$/, "");
  try {
    return JSON.parse(t);
  } catch {
    const first = t.search(/[[{]/);
    const last = Math.max(t.lastIndexOf("}"), t.lastIndexOf("]"));
    if (first >= 0 && last > first) return JSON.parse(t.slice(first, last + 1));
    throw new Error("no JSON object found in model reply");
  }
}
