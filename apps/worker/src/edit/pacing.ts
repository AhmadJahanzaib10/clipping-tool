import type { Pacing, Segment, Word } from "@clip/shared";

/**
 * Pacing (SPEC §7.7 step 2): shorten long pauses to ~0.15 s and drop flagged fillers, but only where
 * the cut lands in silence (≥ 60 ms gap on both sides) so no syllable is clipped. The result is a
 * timeline map: the kept source ranges and where each lands in output time.
 */

export const KEEP_GAP_SEC = 0.15;
export const FILLER_MIN_GAP_SEC = 0.06;
/** A cut shorter than this isn't worth a jump cut. */
export const MIN_CUT_SEC = 0.08;

export interface Timeline {
  segments: Segment[];
  duration: number;
  /** Source-word indices (into the clip's word list) that were removed. */
  removedWords: Set<number>;
  removedPauses: number;
  removedFillers: number;
}

interface Cut {
  s: number;
  e: number;
}

/** Words that fall inside [start, end] (clip words, source time). */
export function clipWords(words: Word[], start: number, end: number): Word[] {
  return words.filter((w) => w.s >= start - 1e-3 && w.e <= end + 1e-3);
}

/**
 * Build the main-clip timeline. `words` are the clip's words in source time, sorted.
 * Output time starts at `outOffset` (non-zero when a cold open is prepended).
 */
export function buildTimeline(words: Word[], start: number, end: number, p: Pacing, outOffset = 0): Timeline {
  const cuts: Cut[] = [];
  const removedWords = new Set<number>();
  let removedPauses = 0;
  let removedFillers = 0;

  // 1. Decide which filler runs can go: a run of consecutive fillers is removable when the gaps to the
  //    kept words on both sides are ≥ 60 ms (silence to cut in). The first/last word never goes.
  const keep = words.map(() => true);
  if (p.trimFillers) {
    let i = 1;
    while (i < words.length - 1) {
      if (!words[i]!.filler) {
        i++;
        continue;
      }
      let j = i;
      while (j + 1 < words.length - 1 && words[j + 1]!.filler) j++;
      const before = words[i]!.s - words[i - 1]!.e;
      const after = words[j + 1]!.s - words[j]!.e;
      if (before >= FILLER_MIN_GAP_SEC && after >= FILLER_MIN_GAP_SEC) {
        for (let k = i; k <= j; k++) {
          keep[k] = false;
          removedWords.add(k);
        }
        removedFillers += j - i + 1;
      }
      i = j + 1;
    }
  }

  // 2. Between consecutive kept words, cut out silence: always where fillers were removed,
  //    and for pauses longer than maxPauseSec when tightening is on.
  const kept = words.map((w, i) => ({ w, i })).filter((x) => keep[x.i]);
  for (let k = 0; k + 1 < kept.length; k++) {
    const a = kept[k]!;
    const b = kept[k + 1]!;
    const hadFillers = b.i - a.i > 1;
    const firstAfterA = words[a.i + 1]!; // a removed filler, or b
    const lastBeforeB = words[b.i - 1]!; // a removed filler, or a
    const gapA = firstAfterA.s - a.w.e; // silence right after a
    const gapB = b.w.s - lastBeforeB.e; // silence right before b
    const pause = b.w.s - a.w.e;
    let keepA: number;
    let keepB: number;
    if (p.tightenPauses && pause > p.maxPauseSec) {
      keepA = Math.min(KEEP_GAP_SEC / 2, gapA);
      keepB = Math.min(KEEP_GAP_SEC / 2, gapB);
      removedPauses++;
    } else if (hadFillers) {
      // Keep the natural breath on each side (half of each silence, at most 0.12 s).
      keepA = Math.min(gapA / 2, 0.12);
      keepB = Math.min(gapB / 2, 0.12);
    } else continue;
    const cut = { s: a.w.e + keepA, e: b.w.s - keepB };
    if (cut.e - cut.s >= MIN_CUT_SEC) cuts.push(cut);
  }

  // 3. Kept ranges = [start, end] minus the cuts.
  const segments: Segment[] = [];
  let cursor = start;
  let out = outOffset;
  for (const c of cuts) {
    if (c.s > cursor) {
      segments.push({ kind: "main", srcStart: cursor, srcEnd: c.s, outStart: out, outEnd: out + (c.s - cursor) });
      out += c.s - cursor;
    }
    cursor = Math.max(cursor, c.e);
  }
  if (end > cursor) segments.push({ kind: "main", srcStart: cursor, srcEnd: end, outStart: out, outEnd: out + (end - cursor) });
  return { segments, duration: out + (end - cursor) - outOffset, removedWords, removedPauses, removedFillers };
}

/** Source time → output time, or null if `t` was cut. Segments must be in output order. */
export function srcToOut(segments: Segment[], t: number, kinds: Segment["kind"][] = ["main"]): number | null {
  for (const s of segments) {
    if (!kinds.includes(s.kind)) continue;
    if (t >= s.srcStart - 1e-6 && t <= s.srcEnd + 1e-6) return s.outStart + (Math.min(Math.max(t, s.srcStart), s.srcEnd) - s.srcStart);
  }
  return null;
}

/** Output time → source time, or null inside a transition. */
export function outToSrc(segments: Segment[], t: number): number | null {
  for (const s of segments) {
    if (t >= s.outStart - 1e-6 && t <= s.outEnd + 1e-6) return s.kind === "transition" ? null : s.srcStart + (t - s.outStart);
  }
  return null;
}

/** Output times where the picture jumps (segment boundaries), excluding 0 and the end. */
export function jumpCuts(segments: Segment[]): number[] {
  return segments.slice(1).map((s) => s.outStart);
}
