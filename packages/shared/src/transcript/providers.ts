import { z } from "zod";
import type { Word } from "../schemas/transcript";

// ---------- YouTube json3 captions ----------

const json3Schema = z.object({
  events: z
    .array(
      z.object({
        tStartMs: z.number().optional(),
        dDurationMs: z.number().optional(),
        aAppend: z.number().optional(),
        segs: z.array(z.object({ utf8: z.string().optional(), tOffsetMs: z.number().optional() })).optional(),
      }),
    )
    .default([]),
});

/** Drop "[Music]", "[Applause]", ">>" speaker marks and similar non-speech annotations. */
const NON_SPEECH = /^\[[^\]]*\]$|^\([^)]*\)$|^>>$|^♪+$/;

/**
 * YouTube json3 → Word[] (SPEC §7.3 step 1, quality "rough").
 * Auto-captions carry one seg per word with tOffsetMs; a word ends where the next starts (or at the event end).
 * Manual captions carry whole lines; their duration is spread over the words by character length.
 */
export function parseYoutubeJson3(input: unknown): Word[] {
  const { events } = json3Schema.parse(input);
  const words: Word[] = [];
  for (const ev of events) {
    if (ev.aAppend || !ev.segs || ev.tStartMs === undefined) continue;
    const evStart = ev.tStartMs / 1000;
    const evEnd = (ev.tStartMs + (ev.dDurationMs ?? 0)) / 1000;
    const segs = ev.segs.filter((s) => (s.utf8 ?? "").trim() !== "");
    if (!segs.length) continue;

    const timed = segs.length > 1 || segs[0]!.tOffsetMs !== undefined;
    const tokens: { w: string; s: number; e?: number }[] = [];
    if (timed && segs.every((s) => s.utf8!.trim().split(/\s+/).length === 1)) {
      segs.forEach((seg) => tokens.push({ w: seg.utf8!.trim(), s: evStart + (seg.tOffsetMs ?? 0) / 1000 }));
    } else {
      const text = segs.map((s) => s.utf8).join("").replace(/\s+/g, " ").trim();
      const parts = text.split(" ");
      const total = parts.reduce((n, p) => n + p.length + 1, 0);
      let t = evStart;
      for (const p of parts) {
        const d = ((evEnd - evStart) * (p.length + 1)) / total;
        tokens.push({ w: p, s: t, e: t + d });
        t += d;
      }
    }
    tokens.forEach((tok, i) => {
      const e = tok.e ?? tokens[i + 1]?.s ?? Math.max(evEnd, tok.s + 0.2);
      words.push({ w: tok.w, s: tok.s, e: Math.max(tok.s, e) });
    });
  }
  // Rolling auto-captions can overlap the next event: cap each word's end at the next word's start.
  words.sort((a, b) => a.s - b.s);
  for (let i = 0; i < words.length - 1; i++) words[i]!.e = Math.min(words[i]!.e, Math.max(words[i]!.s, words[i + 1]!.s));
  return words.filter((w) => !NON_SPEECH.test(w.w));
}

// ---------- Deepgram ----------

export const deepgramResponseSchema = z.object({
  metadata: z.object({ duration: z.number().optional() }).passthrough().optional(),
  results: z.object({
    channels: z
      .array(
        z.object({
          alternatives: z.array(
            z.object({
              words: z.array(
                z.object({
                  word: z.string(),
                  punctuated_word: z.string().optional(),
                  start: z.number(),
                  end: z.number(),
                  confidence: z.number().optional(),
                  speaker: z.number().int().optional(),
                }),
              ),
            }),
          ),
        }),
      )
      .min(1),
  }),
});

/** Deepgram pre-recorded response → Word[] using `punctuated_word` (SPEC §7.3 step 2). */
export function parseDeepgram(input: unknown): { words: Word[]; durationSec?: number } {
  const r = deepgramResponseSchema.parse(input);
  const alt = r.results.channels[0]!.alternatives[0];
  const words: Word[] = (alt?.words ?? []).map((w) => ({
    w: w.punctuated_word ?? w.word,
    s: w.start,
    e: w.end,
    ...(w.speaker !== undefined ? { speaker: w.speaker } : {}),
    ...(w.confidence !== undefined ? { conf: w.confidence } : {}),
  }));
  return { words, durationSec: r.metadata?.duration };
}

export interface DeepgramQueryOptions {
  model: string;
  diarize: boolean;
}

/** Query string for POST /v1/listen (params checked against Deepgram docs, Nov 2026). */
export function deepgramQuery(o: DeepgramQueryOptions): string {
  const p = new URLSearchParams({
    model: o.model,
    smart_format: "true",
    punctuate: "true",
    diarize: String(o.diarize),
    utterances: "true",
    filler_words: "true",
    language: "en",
  });
  return p.toString();
}
