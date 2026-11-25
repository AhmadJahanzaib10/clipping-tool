import type { Transcript, Word } from "../schemas/transcript";
import { endsSentence, norm } from "../transcript/fillers";

/** Pure time-range helpers for moment selection (SPEC §7.4). */

export interface Range {
  start: number;
  end: number;
}

/** Overlap as a fraction of the shorter range (0–1). ">50% overlap" means > 0.5 here. */
export function overlapRatio(a: Range, b: Range): number {
  const inter = Math.min(a.end, b.end) - Math.max(a.start, b.start);
  const shorter = Math.min(a.end - a.start, b.end - b.start);
  return inter <= 0 || shorter <= 0 ? 0 : inter / shorter;
}

export interface ScoredRange extends Range {
  roughScore: number;
}

/** Drop candidates overlapping a better one by > maxOverlap, keep the best `keep`, return them in time order. */
export function mergeCandidates<T extends ScoredRange>(cands: T[], keep = 15, maxOverlap = 0.5): T[] {
  const valid = cands.filter((c) => Number.isFinite(c.start) && Number.isFinite(c.end) && c.end > c.start);
  const sorted = [...valid].sort((a, b) => b.roughScore - a.roughScore || a.start - b.start);
  const kept: T[] = [];
  for (const c of sorted) {
    if (kept.some((k) => overlapRatio(k, c) > maxOverlap)) continue;
    kept.push(c);
    if (kept.length >= keep) break;
  }
  return kept.sort((a, b) => a.start - b.start);
}

// ---------- windows for SCOUT ----------

export interface Window {
  index: number;
  start: number;
  end: number;
  /** "[123.4] S0: text" lines, one per sentence. */
  lines: string;
}

export function formatLine(s: Transcript["sentences"][number]): string {
  return `[${s.s.toFixed(1)}]${s.speaker !== undefined ? ` S${s.speaker}` : ""}: ${s.text}`;
}

/** ~8-min windows with 1-min overlap (SPEC §7.4). Sentences are assigned by start time. */
export function buildWindows(t: Transcript, windowSec = 480, overlapSec = 60): Window[] {
  if (!t.sentences.length) return [];
  const total = t.sentences[t.sentences.length - 1]!.e;
  const step = Math.max(1, windowSec - overlapSec);
  const out: Window[] = [];
  for (let start = 0; start < total; start += step) {
    const end = start + windowSec;
    const sents = t.sentences.filter((s) => s.s >= start && s.s < end);
    if (sents.length) out.push({ index: out.length, start, end: Math.min(end, total), lines: sents.map(formatLine).join("\n") });
    if (end >= total) break;
  }
  return out;
}

// ---------- sentence snapping, edge-filler trimming, length enforcement ----------

/** Words never allowed as the first word of a clip (beyond flagged fillers). */
export const LEADING_DROP = new Set(["so", "and", "but", "or", "um", "uh", "erm", "well", "like", "also", "because", "anyway", "okay", "ok", "yeah"]);
/** Words never allowed as the last word of a clip. */
export const TRAILING_DROP = new Set(["and", "so", "but", "or", "um", "uh", "erm", "like", "because", "the", "a", "to", "of"]);

/** Sentence boundaries as word-index ranges [first, last] (inclusive). */
export function sentenceWordRanges(t: Transcript): [number, number][] {
  const out: [number, number][] = [];
  let wi = 0;
  for (const s of t.sentences) {
    while (wi < t.words.length && t.words[wi]!.s < s.s - 1e-6) wi++;
    const first = wi;
    while (wi < t.words.length && t.words[wi]!.e <= s.e + 1e-6 && t.words[wi]!.s <= s.e + 1e-6) wi++;
    if (wi > first) out.push([first, wi - 1]);
  }
  return out;
}

/** True when the transcript carries real punctuation (Whisper, Deepgram); YouTube auto-captions don't. */
export function isPunctuated(t: Transcript): boolean {
  // Counted per word, not per sentence piece: long run-on sentences are split into 40-word pieces.
  const ends = t.words.filter((w) => endsSentence(w.w)).length;
  return ends >= 2 && ends * 100 >= t.words.length;
}

/**
 * Boundaries to snap clips to. Transcript sentences are also split at long pauses and at 40 words
 * (needed for unpunctuated captions); with real punctuation those pieces are merged back into full
 * sentences, so clips start after a "." and end on one, not at a mid-sentence pause.
 */
export function snapRanges(t: Transcript): [number, number][] {
  const pieces = sentenceWordRanges(t);
  if (!isPunctuated(t)) return pieces;
  const out: [number, number][] = [];
  let cur: [number, number] | null = null;
  for (const [a, b] of pieces) {
    cur = cur ? [cur[0], b] : [a, b];
    if (endsSentence(t.words[b]!.w)) {
      out.push(cur);
      cur = null;
    }
  }
  if (cur) out.push(cur);
  return out;
}

export const badLead = (w: Word) => w.filler === true || LEADING_DROP.has(norm(w.w));
export const badTail = (w: Word) => w.filler === true || TRAILING_DROP.has(norm(w.w));

/** Move [i0, i1] inward past leading/trailing fillers and conjunctions. Returns null if nothing is left. */
export function trimEdges(words: Word[], i0: number, i1: number): [number, number] | null {
  while (i0 <= i1 && badLead(words[i0]!)) i0++;
  while (i1 >= i0 && badTail(words[i1]!)) i1--;
  return i0 <= i1 ? [i0, i1] : null;
}

export interface SnapOptions {
  minSec: number;
  maxSec: number;
}

export interface Snapped {
  start: number;
  end: number;
  firstWord: number;
  lastWord: number;
}

/**
 * Snap an LLM-proposed [start, end] to sentence boundaries (never mid-word), drop leading/trailing
 * fillers and conjunctions, and enforce min/max length by adding or removing whole sentences.
 * Returns null when no valid clip fits.
 */
export function snapClip(t: Transcript, start: number, end: number, o: SnapOptions): Snapped | null {
  const ranges = snapRanges(t);
  if (!ranges.length || !(end > start)) return null;
  const sStart = (i: number) => t.words[ranges[i]![0]]!.s;
  const sEnd = (i: number) => t.words[ranges[i]![1]]!.e;

  // Start: the sentence containing `start`, or the next one if `start` is past its midpoint / in a gap.
  let a = ranges.findIndex((_, i) => sEnd(i) > start);
  if (a < 0) return null;
  if (start > sStart(a) && start - sStart(a) > (sEnd(a) - sStart(a)) / 2 && a + 1 < ranges.length) a++;
  // End: the sentence containing `end`, or the previous one if `end` is before its midpoint.
  let b = ranges.length - 1;
  for (let i = ranges.length - 1; i >= 0; i--) {
    if (sStart(i) < end) {
      b = i;
      break;
    }
  }
  if (end < sEnd(b) && end - sStart(b) < (sEnd(b) - sStart(b)) / 2 && b - 1 >= a) b--;
  if (b < a) b = a;

  const span = (x: number, y: number) => {
    const tr = trimEdges(t.words, ranges[x]![0], ranges[y]![1]);
    return tr ? { tr, dur: t.words[tr[1]]!.e - t.words[tr[0]]!.s } : null;
  };

  // Too long: drop sentences from the end.
  let cur = span(a, b);
  while (cur && cur.dur > o.maxSec && b > a) cur = span(a, --b);
  // Too short: add following sentences, then earlier ones, while staying within max.
  while (cur && cur.dur < o.minSec && b + 1 < ranges.length) {
    const next = span(a, b + 1);
    if (!next || next.dur > o.maxSec) break;
    b++;
    cur = next;
  }
  while (cur && cur.dur < o.minSec && a > 0) {
    const prev = span(a - 1, b);
    if (!prev || prev.dur > o.maxSec) break;
    a--;
    cur = prev;
  }
  if (!cur) return null;

  let [i0, i1] = cur.tr;
  // A single sentence longer than max. With real punctuation, a cut would end mid-thought: drop the clip
  // (EDIT's top-up refills from SCOUT). Unpunctuated captions: cut at the last word boundary that fits.
  if (cur.dur > o.maxSec && isPunctuated(t)) return null;
  if (cur.dur > o.maxSec) {
    while (i1 > i0 && t.words[i1]!.e - t.words[i0]!.s > o.maxSec) i1--;
    const tr = trimEdges(t.words, i0, i1);
    if (!tr) return null;
    [i0, i1] = tr;
  }
  const s = t.words[i0]!.s;
  const e = t.words[i1]!.e;
  if (e - s < o.minSec || e - s > o.maxSec) return null;
  return { start: s, end: e, firstWord: i0, lastWord: i1 };
}

/** Text of words in [start, end]. */
export function textBetween(t: Transcript, start: number, end: number): string {
  return t.words
    .filter((w) => w.s >= start - 1e-6 && w.e <= end + 1e-6)
    .map((w) => w.w)
    .join(" ");
}
