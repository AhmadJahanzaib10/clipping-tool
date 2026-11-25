import type { Transcript } from "../schemas/transcript";
import { norm } from "../transcript/fillers";
import { findBanned, MAX_HOOK_WORDS, sameHook, wordCount } from "./text";
import { badLead, badTail, isPunctuated, LEADING_DROP, overlapRatio, TRAILING_DROP } from "./timeline";
import { endsSentence } from "../transcript/fillers";

export interface CheckableClip {
  rank?: number | null;
  startSec: number;
  endSec: number;
  hookA: string | null;
  hookB: string | null;
  title?: string | null;
  captionTiktok?: string | null;
  captionInstagram?: string | null;
  captionYoutube?: string | null;
}

export interface SelectionCheck {
  name: string;
  pass: boolean;
  detail: string;
}

const EPS = 0.002;

/** M3 acceptance criteria (SPEC §14) evaluated on real output. */
export function checkSelection(
  clips: CheckableClip[],
  t: Transcript,
  cfg: { minLengthSec: number; maxLengthSec: number; bannedWords: string[] },
  expected: { min: number; max: number } = { min: 8, max: 10 },
): SelectionCheck[] {
  const out: SelectionCheck[] = [];
  const label = (c: CheckableClip, i: number) => `#${c.rank ?? i + 1} ${c.startSec.toFixed(1)}–${c.endSec.toFixed(1)}`;

  out.push({ name: `${expected.min}–${expected.max} clips`, pass: clips.length >= expected.min && clips.length <= expected.max, detail: `${clips.length} clips` });

  const badLen = clips.filter((c) => c.endSec - c.startSec < cfg.minLengthSec - EPS || c.endSec - c.startSec > cfg.maxLengthSec + EPS);
  const lens = clips.map((c) => c.endSec - c.startSec);
  out.push({
    name: `length within ${cfg.minLengthSec}–${cfg.maxLengthSec} s`,
    pass: badLen.length === 0,
    detail: badLen.length ? badLen.map((c) => `${label(c, 0)} = ${(c.endSec - c.startSec).toFixed(1)} s`).join("; ") : `${Math.min(...lens).toFixed(1)}–${Math.max(...lens).toFixed(1)} s`,
  });

  const overlaps: string[] = [];
  let worst = 0;
  clips.forEach((a, i) =>
    clips.slice(i + 1).forEach((b, j) => {
      const r = overlapRatio({ start: a.startSec, end: a.endSec }, { start: b.startSec, end: b.endSec });
      worst = Math.max(worst, r);
      if (r > 0.5) overlaps.push(`${label(a, i)} vs ${label(b, i + j + 1)}: ${(r * 100).toFixed(0)}%`);
    }),
  );
  out.push({ name: "no > 50% overlap", pass: overlaps.length === 0, detail: overlaps.join("; ") || `max overlap ${(worst * 100).toFixed(0)}%` });

  const edgeProblems: string[] = [];
  clips.forEach((c, i) => {
    const first = t.words.find((w) => Math.abs(w.s - c.startSec) < EPS);
    const last = t.words.find((w) => Math.abs(w.e - c.endSec) < EPS);
    if (!first) edgeProblems.push(`${label(c, i)}: start is not a word start (mid-word)`);
    else if (first.filler || LEADING_DROP.has(norm(first.w))) edgeProblems.push(`${label(c, i)}: starts on "${first.w}"`);
    if (!last) edgeProblems.push(`${label(c, i)}: end is not a word end (mid-word)`);
    else if (last.filler || TRAILING_DROP.has(norm(last.w))) edgeProblems.push(`${label(c, i)}: ends on "${last.w}"`);
    // A word straddling the boundary would be cut.
    const cut = t.words.find((w) => (w.s < c.startSec - EPS && w.e > c.startSec + EPS) || (w.s < c.endSec - EPS && w.e > c.endSec + EPS));
    if (cut) edgeProblems.push(`${label(c, i)}: cuts through "${cut.w}"`);
  });
  out.push({ name: "no mid-word or filler start/end", pass: edgeProblems.length === 0, detail: edgeProblems.join("; ") || "all edges on clean word boundaries" });

  // With a punctuated transcript, clips must also start and end at real sentence boundaries
  // (skipping only the fillers/conjunctions that edge trimming removed).
  if (isPunctuated(t)) {
    const sentenceProblems: string[] = [];
    clips.forEach((c, i) => {
      const fi = t.words.findIndex((w) => Math.abs(w.s - c.startSec) < EPS);
      const li = t.words.findIndex((w) => Math.abs(w.e - c.endSec) < EPS);
      if (fi < 0 || li < 0) return; // already reported as mid-word
      let p = fi - 1;
      while (p >= 0 && badLead(t.words[p]!) && !endsSentence(t.words[p]!.w)) p--;
      if (p >= 0 && !endsSentence(t.words[p]!.w)) sentenceProblems.push(`${label(c, i)}: starts mid-sentence ("…${t.words[p]!.w} ${t.words[fi]!.w}")`);
      let n = li;
      while (n < t.words.length - 1 && !endsSentence(t.words[n]!.w) && badTail(t.words[n + 1]!)) n++;
      if (!endsSentence(t.words[n]!.w) && li < t.words.length - 1) sentenceProblems.push(`${label(c, i)}: ends mid-sentence ("${t.words[li]!.w} ${t.words[li + 1]!.w}…")`);
    });
    out.push({ name: "starts and ends on full sentences", pass: sentenceProblems.length === 0, detail: sentenceProblems.join("; ") || "all clips are whole sentences" });
  }

  const hookProblems: string[] = [];
  clips.forEach((c, i) => {
    const a = c.hookA ?? "";
    const b = c.hookB ?? "";
    if (!a || !b) hookProblems.push(`${label(c, i)}: missing hook`);
    if (wordCount(a) > MAX_HOOK_WORDS || wordCount(b) > MAX_HOOK_WORDS) hookProblems.push(`${label(c, i)}: hook > ${MAX_HOOK_WORDS} words`);
    if (a && b && sameHook(a, b)) hookProblems.push(`${label(c, i)}: hooks not distinct`);
  });
  out.push({ name: `two distinct hooks ≤ ${MAX_HOOK_WORDS} words`, pass: hookProblems.length === 0, detail: hookProblems.join("; ") || "ok" });

  const bannedHits = clips.flatMap((c, i) =>
    [c.hookA, c.hookB, c.title, c.captionTiktok, c.captionInstagram, c.captionYoutube]
      .flatMap((s) => findBanned(s ?? "", cfg.bannedWords))
      .map((w) => `${label(c, i)}: "${w}"`),
  );
  out.push({ name: "no banned words in generated text", pass: bannedHits.length === 0, detail: bannedHits.join("; ") || (cfg.bannedWords.length ? "none found" : "no banned words configured") });

  return out;
}
