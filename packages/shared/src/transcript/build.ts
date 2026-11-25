import type { Transcript, Word } from "../schemas/transcript";
import { endsSentence, flagFillers } from "./fillers";

/** Gap that ends a sentence when the provider gives no punctuation (YouTube auto-captions). */
export const SENTENCE_GAP_SEC = 0.8;
/** Hard cap so unpunctuated text still yields usable sentences. */
export const MAX_SENTENCE_WORDS = 40;

/** Group words into sentences: terminal punctuation, speaker change, long pause or the word cap. */
export function buildSentences(words: Word[]): Transcript["sentences"] {
  const out: Transcript["sentences"] = [];
  let cur: Word[] = [];
  const flush = () => {
    if (!cur.length) return;
    out.push({
      s: cur[0]!.s,
      e: cur[cur.length - 1]!.e,
      text: cur.map((w) => w.w).join(" "),
      ...(cur[0]!.speaker !== undefined ? { speaker: cur[0]!.speaker } : {}),
    });
    cur = [];
  };
  for (let i = 0; i < words.length; i++) {
    const w = words[i]!;
    const prev = cur[cur.length - 1];
    if (prev && (w.speaker !== prev.speaker || w.s - prev.e >= SENTENCE_GAP_SEC || cur.length >= MAX_SENTENCE_WORDS)) flush();
    cur.push(w);
    if (endsSentence(w.w)) flush();
  }
  flush();
  return out;
}

/** Normalize provider words (sort, clamp, drop empties), flag fillers and build sentences. */
export function makeTranscript(provider: Transcript["provider"], quality: Transcript["quality"], raw: Word[]): Transcript {
  const words = raw
    .map((w) => ({ ...w, w: w.w.trim() }))
    .filter((w) => w.w.length > 0 && Number.isFinite(w.s) && Number.isFinite(w.e))
    .sort((a, b) => a.s - b.s)
    .map((w) => ({ ...w, s: Math.max(0, w.s), e: Math.max(w.s, w.e) }));
  const flagged = flagFillers(words);
  return { provider, quality, words: flagged, sentences: buildSentences(flagged) };
}
