import type { Word } from "../schemas/transcript";

/**
 * Filler flagging (SPEC §7.2): um, uh, erm, like (standalone), you know, I mean, so (sentence-initial).
 * Works for punctuated (Deepgram/Whisper) and unpunctuated (YouTube auto-caption) words: a pause
 * of >= PAUSE_SEC counts as a boundary when there is no punctuation.
 */
export const PAUSE_SEC = 0.5;

const ALWAYS = new Set(["um", "umm", "uh", "uhh", "erm", "er", "ah", "hmm", "mm", "mhm"]);

/** Lowercased token without surrounding punctuation. */
export const norm = (w: string) => w.toLowerCase().replace(/^[^\p{L}\p{N}']+|[^\p{L}\p{N}']+$/gu, "");
const endsClause = (w: string) => /[,;:—–-]$/.test(w.trim());
export const endsSentence = (w: string) => /[.?!…]["')\]]*$/.test(w.trim());

function boundaryBefore(words: Word[], i: number): boolean {
  if (i === 0) return true;
  const prev = words[i - 1]!;
  return endsSentence(prev.w) || endsClause(prev.w) || words[i]!.s - prev.e >= PAUSE_SEC || prev.speaker !== words[i]!.speaker;
}
function sentenceStart(words: Word[], i: number): boolean {
  if (i === 0) return true;
  const prev = words[i - 1]!;
  return endsSentence(prev.w) || words[i]!.s - prev.e >= PAUSE_SEC || prev.speaker !== words[i]!.speaker;
}
function boundaryAfter(words: Word[], i: number): boolean {
  const w = words[i]!;
  if (endsSentence(w.w) || endsClause(w.w)) return true;
  const next = words[i + 1];
  return !next || next.s - w.e >= PAUSE_SEC || next.speaker !== w.speaker;
}

/** Returns a copy of `words` with `filler: true` on filler tokens (and false elsewhere). */
export function flagFillers(words: Word[]): Word[] {
  const out = words.map((w) => ({ ...w, filler: false }));
  for (let i = 0; i < out.length; i++) {
    const t = norm(out[i]!.w);
    const next = out[i + 1] ? norm(out[i + 1]!.w) : "";
    if (ALWAYS.has(t)) {
      out[i]!.filler = true;
    } else if (t === "like") {
      // "like" is a filler when set off by boundaries on both sides: "it was, like, huge".
      if (boundaryBefore(out, i) && boundaryAfter(out, i) && out.length > 1) out[i]!.filler = true;
    } else if ((t === "you" && next === "know") || (t === "i" && next === "mean")) {
      // Two-word fillers: only when standalone ("you know," / "I mean,") — not "you know the answer".
      if (boundaryAfter(out, i + 1) && (boundaryBefore(out, i) || endsClause(out[i + 1]!.w))) {
        out[i]!.filler = true;
        out[i + 1]!.filler = true;
        i++;
      }
    } else if (t === "so" && sentenceStart(out, i) && !endsSentence(out[i]!.w) && out[i + 1]) {
      // Sentence-initial "so" that leads into more words: "So I said…", "So, here's the thing".
      out[i]!.filler = true;
    }
  }
  return out;
}
