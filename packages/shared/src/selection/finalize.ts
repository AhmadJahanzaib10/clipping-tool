import { z } from "zod";
import type { CampaignConfig } from "../schemas/campaign";
import { clipScoresSchema, type ClipEdit, type ClipScores } from "../schemas/clip";
import type { Transcript } from "../schemas/transcript";
import { norm } from "../transcript/fillers";
import type { EditClip } from "./prompts";
import { finalScore, type ScoreWeights } from "./score";
import {
  clampText,
  cleanCaption,
  cleanHashtags,
  cleanHook,
  firstWords,
  findBanned,
  MAX_HOOK_WORDS,
  MAX_TITLE_CHARS,
  sameHook,
  stripBanned,
} from "./text";
import { overlapRatio, snapClip, textBetween, type Range } from "./timeline";

/** A merged SCOUT candidate, as sent to EDIT (id "c1"…). */
export interface Candidate extends Range {
  id: string;
  summary: string;
  roughScore: number;
}

/** A clip ready to insert (SPEC §6 clips). */
export const clipInputSchema = z.object({
  rank: z.number().int().min(1),
  score: z.number().min(0).max(100),
  scores: clipScoresSchema,
  startSec: z.number().min(0),
  endSec: z.number().min(0),
  hookA: z.string().min(1),
  hookB: z.string().min(1),
  title: z.string(),
  captionTiktok: z.string(),
  captionInstagram: z.string(),
  captionYoutube: z.string(),
  hashtags: z.array(z.string()),
  emphasisWords: z.array(z.string()),
  reason: z.string(),
  coldOpen: z.object({ start: z.number(), end: z.number() }).nullable(),
  candidateId: z.string(),
  source: z.enum(["edit", "scout-fallback"]),
});
export type ClipInput = z.infer<typeof clipInputSchema>;

export interface FinalizeOptions {
  transcript: Transcript;
  candidates: Candidate[];
  config: Pick<CampaignConfig, "minLengthSec" | "maxLengthSec" | "bannedWords">;
  weights: ScoreWeights;
  /** How many clips to return (8–10 by default). */
  n: number;
  /** Fill up from SCOUT candidates when EDIT yields fewer than this. */
  minClips: number;
  /** Max overlap between final clips (fraction of the shorter clip). */
  maxOverlap?: number;
}

/** Two distinct template hooks (≤ 7 words) when the model's hooks are missing or invalid (SPEC §8.4). */
export function templateHooks(summary: string, firstLine: string, banned: string[]): [string, string] {
  const a = cleanHook(firstWords(stripBanned(summary, banned), MAX_HOOK_WORDS), banned) ?? "Nobody talks about this";
  const fromLine = cleanHook(firstWords(stripBanned(firstLine, banned), 6) + "…", banned);
  const b = fromLine && !sameHook(fromLine, a) ? fromLine : sameHook(a, "Wait for the ending") ? "You need to hear this" : "Wait for the ending";
  return [a, b];
}

function pickHooks(c: { hookA?: string; hookB?: string }, summary: string, firstLine: string, banned: string[]): [string, string] {
  const [tA, tB] = templateHooks(summary, firstLine, banned);
  const a = cleanHook(c.hookA, banned) ?? cleanHook(c.hookB, banned) ?? tA;
  let b = cleanHook(c.hookB, banned);
  if (!b || sameHook(a, b)) b = [cleanHook(c.hookA, banned), tA, tB].find((h): h is string => !!h && !sameHook(a, h)) ?? "You need to hear this";
  return [a, b];
}

/** Emphasis words must be single words actually spoken inside the clip (2–6). */
function cleanEmphasis(words: string[], spoken: Set<string>, banned: string[]): string[] {
  const out: string[] = [];
  for (const w of words) {
    const k = norm(w.split(/\s+/)[0] ?? "");
    if (k && spoken.has(k) && !findBanned(k, banned).length && !out.includes(k)) out.push(k);
    if (out.length >= 6) break;
  }
  return out;
}

/** Cold-open teaser: inside the clip, 2–4 s, snapped to word boundaries; else null. */
function cleanColdOpen(t: Transcript, clip: Range, co: { start: number; end: number } | null | undefined): Range | null {
  if (!co || !(co.end > co.start)) return null;
  const inside = t.words.filter((w) => w.s >= clip.start - 1e-6 && w.e <= clip.end + 1e-6);
  const first = inside.find((w) => w.e > co.start);
  const last = [...inside].reverse().find((w) => w.s < co.end);
  if (!first || !last || last.e <= first.s) return null;
  const r = { start: first.s, end: last.e };
  const d = r.end - r.start;
  // Allow a little slack around 2–4 s for word snapping; a teaser at the very start adds nothing.
  if (d < 1.5 || d > 4.5 || r.start - clip.start < 3) return null;
  return r;
}

/**
 * EDIT output → final clips (SPEC §7.4 "Code then"): snap to sentences, drop leading/trailing fillers,
 * enforce length, filter banned words, compute the final score, drop > 50% overlaps, rank by score.
 * Tops up from SCOUT candidates (template hooks) if fewer than `minClips` survive.
 */
export function finalizeClips(edit: EditClip[], o: FinalizeOptions): ClipInput[] {
  const { transcript: t, config } = o;
  const banned = config.bannedWords;
  const byId = new Map(o.candidates.map((c) => [c.id, c]));
  const snapOpts = { minSec: config.minLengthSec, maxSec: config.maxLengthSec };
  const maxOverlap = o.maxOverlap ?? 0.5;

  const build = (
    cand: Candidate,
    start: number,
    end: number,
    e: Partial<EditClip> & { scores: ClipScores },
    source: ClipInput["source"],
  ): Omit<ClipInput, "rank"> | null => {
    const snapped = snapClip(t, start, end, snapOpts);
    if (!snapped) return null;
    const range = { start: snapped.start, end: snapped.end };
    const text = textBetween(t, range.start, range.end);
    const firstLine = t.words.slice(snapped.firstWord, snapped.firstWord + 12).map((w) => w.w).join(" ");
    const [hookA, hookB] = pickHooks(e, cand.summary, firstLine, banned);
    const spoken = new Set(text.split(/\s+/).map(norm).filter(Boolean));
    const title = clampText(stripBanned(e.title || cand.summary, banned), MAX_TITLE_CHARS);
    return {
      score: finalScore(e.scores, o.weights),
      scores: e.scores,
      startSec: range.start,
      endSec: range.end,
      hookA,
      hookB,
      title,
      captionTiktok: cleanCaption(e.captionTiktok || title, banned),
      captionInstagram: cleanCaption(e.captionInstagram || title, banned),
      captionYoutube: cleanCaption(e.captionYoutube || title, banned),
      hashtags: cleanHashtags(e.hashtags, banned),
      emphasisWords: cleanEmphasis(e.emphasisWords ?? [], spoken, banned),
      reason: stripBanned(e.reason || cand.summary, banned),
      coldOpen: cleanColdOpen(t, range, e.coldOpen),
      candidateId: cand.id,
      source,
    };
  };

  const out: Omit<ClipInput, "rank">[] = [];
  const accept = (c: Omit<ClipInput, "rank"> | null) => {
    if (!c) return;
    if (out.some((k) => overlapRatio({ start: k.startSec, end: k.endSec }, { start: c.startSec, end: c.endSec }) > maxOverlap)) return;
    out.push(c);
  };

  // Best model-scored clips claim their time range first.
  const ranked = edit
    .filter((e) => byId.has(e.id))
    .map((e) => ({ e, s: finalScore(e.scores, o.weights) }))
    .sort((a, b) => b.s - a.s);
  for (const { e } of ranked) {
    if (out.length >= o.n) break;
    accept(build(byId.get(e.id)!, e.start, e.end, e, "edit"));
  }

  if (out.length < o.minClips) {
    const used = new Set(out.map((c) => c.candidateId));
    for (const cand of [...o.candidates].sort((a, b) => b.roughScore - a.roughScore)) {
      if (out.length >= o.minClips) break;
      if (used.has(cand.id)) continue;
      const s = Math.round((cand.roughScore / 10) * 10) / 10;
      const scores = { hook: s, standalone: s, payoff: s, emotion: s, novelty: s, quotability: s };
      accept(build(cand, cand.start, cand.end, { scores, reason: `Scout pick: ${cand.summary}` }, "scout-fallback"));
    }
  }

  return out
    .sort((a, b) => b.score - a.score || a.startSec - b.startSec)
    .slice(0, o.n)
    .map((c, i) => ({ ...c, rank: i + 1 }));
}

/** Initial ClipEdit for a new clip (SPEC §6.2); layout/focus are decided in PREP_CLIP (M4). */
export function initialClipEdit(c: ClipInput, config: CampaignConfig): ClipEdit {
  return {
    trim: { start: c.startSec, end: c.endSec },
    layout: "single",
    focus: "auto",
    pacing: { ...config.pacing },
    coldOpen: c.coldOpen && config.coldOpen !== "off" ? { enabled: true, start: c.coldOpen.start, end: c.coldOpen.end } : null,
    zoom: config.zoom,
    captionPreset: config.captionPreset,
    hookChoice: "A",
    wordEdits: [],
    emphasisWords: c.emphasisWords,
    sfxCues: [],
    overlay: Boolean(config.overlay),
  };
}
