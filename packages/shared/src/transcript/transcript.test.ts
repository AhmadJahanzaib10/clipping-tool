import { describe, expect, it } from "vitest";
import type { Word } from "../schemas/transcript";
import { flagFillers } from "./fillers";
import { buildSentences, makeTranscript } from "./build";
import { deepgramQuery, parseDeepgram, parseYoutubeJson3 } from "./providers";

/** Words spaced 0.3 s apart with 0.05 s gaps; "|" inserts a 1 s pause. */
function words(text: string, speaker?: number): Word[] {
  const out: Word[] = [];
  let t = 0;
  for (const tok of text.split(" ")) {
    if (tok === "|") {
      t += 1;
      continue;
    }
    out.push({ w: tok, s: t, e: t + 0.25, ...(speaker !== undefined ? { speaker } : {}) });
    t += 0.3;
  }
  return out;
}
const fillers = (text: string) =>
  flagFillers(words(text))
    .filter((w) => w.filler)
    .map((w) => w.w);

describe("flagFillers", () => {
  it("always flags um / uh / erm", () => {
    expect(fillers("I um think uh it was erm fine.")).toEqual(["um", "uh", "erm"]);
    expect(fillers("Um, okay.")).toEqual(["Um,"]);
  });

  it("flags standalone 'like' only", () => {
    expect(fillers("It was, like, huge.")).toEqual(["like,"]);
    expect(fillers("I like pizza.")).toEqual([]);
    expect(fillers("It looks like rain.")).toEqual([]);
  });

  it("flags 'you know' / 'I mean' only when set off", () => {
    expect(fillers("It was, you know, hard.")).toEqual(["you", "know,"]);
    expect(fillers("You know what I mean?")).toEqual([]);
    expect(fillers("Do you know the answer?")).toEqual([]);
    expect(fillers("I mean, it works.")).toEqual(["I", "mean,"]);
    expect(fillers("That is what I mean by it.")).toEqual([]);
  });

  it("flags sentence-initial 'so' only", () => {
    expect(fillers("So I went home.")).toEqual(["So"]);
    expect(fillers("It was great. So, here's the thing.")).toEqual(["So,"]);
    expect(fillers("It was so good.")).toEqual([]);
    expect(fillers("I think so.")).toEqual([]);
  });

  it("uses pauses as boundaries for unpunctuated (YouTube) text", () => {
    expect(fillers("we went home | so then we left")).toEqual(["so"]);
    expect(fillers("it was | like | huge")).toEqual(["like"]);
    expect(fillers("we were so tired")).toEqual([]);
  });

  it("does not mutate input and sets filler false elsewhere", () => {
    const input = words("um yes");
    const out = flagFillers(input);
    expect(input[0]!.filler).toBeUndefined();
    expect(out.map((w) => w.filler)).toEqual([true, false]);
  });
});

describe("buildSentences / makeTranscript", () => {
  it("splits on punctuation, pauses and speaker change", () => {
    const ws = [...words("Hello there. How are you"), ...words("Fine thanks.", 1).map((w) => ({ ...w, s: w.s + 5, e: w.e + 5 }))];
    const s = buildSentences(ws.map((w) => ({ speaker: 0, ...w })));
    expect(s.map((x) => x.text)).toEqual(["Hello there.", "How are you", "Fine thanks."]);
    expect(s[2]!.speaker).toBe(1);
    expect(buildSentences(words("one two | three four")).map((x) => x.text)).toEqual(["one two", "three four"]);
  });

  it("caps very long unpunctuated sentences", () => {
    const long = Array.from({ length: 100 }, () => "word").join(" ");
    expect(buildSentences(words(long)).length).toBe(3);
  });

  it("sorts, trims and drops empty words", () => {
    const t = makeTranscript("whisper", "precise", [
      { w: " world.", s: 1, e: 1.5 },
      { w: "", s: 0.5, e: 0.6 },
      { w: " Hello", s: 0, e: 0.4 },
    ]);
    expect(t.words.map((w) => w.w)).toEqual(["Hello", "world."]);
    expect(t.sentences).toEqual([{ s: 0, e: 1.5, text: "Hello world." }]);
  });
});

describe("parseYoutubeJson3", () => {
  it("parses auto-captions with per-word offsets and drops annotations", () => {
    const json3 = {
      events: [
        { tStartMs: 0, dDurationMs: 5000, id: 1, wpWinPosId: 1 },
        { tStartMs: 1000, dDurationMs: 3000, segs: [{ utf8: "hello" }, { utf8: " world", tOffsetMs: 400 }, { utf8: " again", tOffsetMs: 900 }] },
        { tStartMs: 2500, aAppend: 1, segs: [{ utf8: "\n" }] },
        { tStartMs: 4000, dDurationMs: 2000, segs: [{ utf8: "[Music]" }] },
        { tStartMs: 6000, dDurationMs: 1000, segs: [{ utf8: "bye" }] },
      ],
    };
    const ws = parseYoutubeJson3(json3);
    expect(ws.map((w) => w.w)).toEqual(["hello", "world", "again", "bye"]);
    expect(ws[0]).toMatchObject({ s: 1, e: 1.4 });
    expect(ws[1]).toMatchObject({ s: 1.4, e: 1.9 });
    expect(ws[2]!.s).toBe(1.9);
    expect(ws[2]!.e).toBeLessThanOrEqual(4);
    expect(ws[3]).toMatchObject({ s: 6, e: 7 });
  });

  it("spreads manual caption lines over their duration", () => {
    const ws = parseYoutubeJson3({ events: [{ tStartMs: 10_000, dDurationMs: 2000, segs: [{ utf8: "ab cd" }] }] });
    expect(ws.map((w) => w.w)).toEqual(["ab", "cd"]);
    expect(ws[0]!.s).toBe(10);
    expect(ws[1]!.e).toBeCloseTo(12, 5);
    expect(ws[0]!.e).toBeCloseTo(ws[1]!.s, 5);
  });

  it("rejects non-json3 input", () => {
    expect(() => parseYoutubeJson3({ events: "nope" })).toThrow();
  });
});

describe("Deepgram", () => {
  it("maps punctuated words, speakers and duration", () => {
    const r = parseDeepgram({
      metadata: { duration: 12.5, request_id: "x" },
      results: {
        channels: [
          {
            alternatives: [
              {
                transcript: "um hello there",
                words: [
                  { word: "um", punctuated_word: "Um,", start: 0.1, end: 0.3, confidence: 0.9, speaker: 0 },
                  { word: "hello", punctuated_word: "hello", start: 0.4, end: 0.7, confidence: 0.99, speaker: 0 },
                  { word: "there", start: 0.8, end: 1.0, speaker: 1 },
                ],
              },
            ],
          },
        ],
      },
    });
    expect(r.durationSec).toBe(12.5);
    expect(r.words).toEqual([
      { w: "Um,", s: 0.1, e: 0.3, speaker: 0, conf: 0.9 },
      { w: "hello", s: 0.4, e: 0.7, speaker: 0, conf: 0.99 },
      { w: "there", s: 0.8, e: 1.0, speaker: 1 },
    ]);
  });

  it("builds the SPEC §7.3 query", () => {
    const q = new URLSearchParams(deepgramQuery({ model: "nova-3", diarize: true }));
    expect(Object.fromEntries(q)).toEqual({
      model: "nova-3",
      smart_format: "true",
      punctuate: "true",
      diarize: "true",
      utterances: "true",
      filler_words: "true",
      language: "en",
    });
  });
});
