import { describe, expect, it } from "vitest";
import type { Word } from "../schemas/transcript";
import { makeTranscript } from "../transcript/build";
import { checkSelection } from "./check";
import { finalizeClips, initialClipEdit, templateHooks, type Candidate } from "./finalize";
import { editResponseSchema, editUser, extractJson, scoutResponseSchema, scoutUser, type EditClip } from "./prompts";
import { DEFAULT_SCORE_WEIGHTS, finalScore } from "./score";
import { cleanCaption, cleanHashtags, cleanHook, clampText, findBanned, sameHook, stripBanned } from "./text";
import { buildWindows, mergeCandidates, overlapRatio, snapClip, trimEdges } from "./timeline";
import { campaignConfigSchema } from "../schemas/campaign";

/**
 * Synthetic transcript: sentences of `n` words, 0.4 s per word (0.35 s spoken + 0.05 s gap),
 * 0.6 s pause between sentences. Each sentence is "<Lead> wordN … end." so edges are recognizable.
 */
function transcript(sentences: string[]) {
  const words: Word[] = [];
  let t = 0;
  for (const s of sentences) {
    for (const w of s.split(" ")) {
      words.push({ w, s: t, e: t + 0.35 });
      t += 0.4;
    }
    t += 0.6;
  }
  return makeTranscript("deepgram", "precise", words);
}
/** A sentence of exactly `n` words (≈ 0.4 n s). */
const sent = (n: number, lead = "This", tag = "x") => [lead, ...Array.from({ length: n - 2 }, (_, i) => `${tag}${i}`), "end."].join(" ");

const scores = (v: number) => ({ hook: v, standalone: v, payoff: v, emotion: v, novelty: v, quotability: v });

describe("overlap + merge", () => {
  it("overlapRatio is relative to the shorter range", () => {
    expect(overlapRatio({ start: 0, end: 10 }, { start: 5, end: 25 })).toBe(0.5);
    expect(overlapRatio({ start: 0, end: 10 }, { start: 2, end: 4 })).toBe(1);
    expect(overlapRatio({ start: 0, end: 10 }, { start: 10, end: 20 })).toBe(0);
  });

  it("drops candidates overlapping a better one by > 50%, keeps top N in time order", () => {
    const c = (start: number, end: number, roughScore: number) => ({ start, end, roughScore });
    const merged = mergeCandidates([c(0, 40, 70), c(10, 50, 90), c(100, 140, 60), c(120, 160, 50), c(300, 330, 80), c(5, 5, 99)], 3);
    expect(merged).toEqual([c(10, 50, 90), c(100, 140, 60), c(300, 330, 80)]);
  });

  it("keeps candidates that overlap exactly 50%", () => {
    expect(mergeCandidates([{ start: 0, end: 40, roughScore: 9 }, { start: 20, end: 60, roughScore: 8 }])).toHaveLength(2);
  });
});

describe("buildWindows", () => {
  it("makes 8-min windows with 1-min overlap", () => {
    const t = transcript(Array.from({ length: 200 }, () => sent(20))); // 200 × 8.6 s ≈ 1720 s
    const w = buildWindows(t);
    expect(w.map((x) => x.start)).toEqual([0, 420, 840, 1260]);
    expect(w[3]!.end).toBe(t.sentences.at(-1)!.e); // last window reaches the end, no extra window
    expect(w[0]!.lines.split("\n")[0]).toMatch(/^\[0\.0\]: This x0/);
    const firstTime = Number(/^\[([\d.]+)\]/.exec(w[1]!.lines)![1]);
    expect(firstTime).toBeGreaterThanOrEqual(420); // first sentence that starts inside the window
    expect(firstTime).toBeLessThan(430);
  });
});

describe("snapClip: sentence snapping", () => {
  // 10 sentences × 25 words ≈ 10.6 s each.
  const t = transcript(Array.from({ length: 10 }, (_, i) => sent(25, "Point", `s${i}w`)));
  const opts = { minSec: 20, maxSec: 60 };
  const sentStarts = t.sentences.map((s) => s.s);
  const sentEnds = t.sentences.map((s) => s.e);

  it("snaps mid-sentence times to sentence boundaries (never mid-word)", () => {
    const r = snapClip(t, sentStarts[2]! + 1.3, sentEnds[5]! - 0.7, opts)!;
    expect(r.start).toBe(sentStarts[2]);
    expect(r.end).toBe(sentEnds[5]);
  });

  it("a start past the sentence midpoint moves to the next sentence; an early end moves back", () => {
    const r = snapClip(t, sentStarts[2]! + 9, sentStarts[6]! + 1, opts)!;
    expect(r.start).toBe(sentStarts[3]);
    expect(r.end).toBe(sentEnds[5]);
  });

  it("enforces max by dropping whole sentences from the end", () => {
    const r = snapClip(t, 0, sentEnds[9]!, opts)!;
    expect(r.start).toBe(0);
    expect(r.end - r.start).toBeLessThanOrEqual(60);
    expect(sentEnds).toContain(r.end);
  });

  it("enforces min by adding following sentences", () => {
    const r = snapClip(t, sentStarts[4]!, sentEnds[4]!, opts)!;
    expect(r.end - r.start).toBeGreaterThanOrEqual(20);
    expect(r.start).toBe(sentStarts[4]);
    expect(sentEnds).toContain(r.end);
  });

  it("extends backwards at the end of the transcript", () => {
    const r = snapClip(t, sentStarts[9]!, sentEnds[9]!, opts)!;
    expect(r.end).toBe(sentEnds[9]);
    expect(r.end - r.start).toBeGreaterThanOrEqual(20);
  });

  it("returns null when nothing fits", () => {
    const short = transcript([sent(10)]);
    expect(snapClip(short, 0, 4, opts)).toBeNull();
    expect(snapClip(t, 50, 40, opts)).toBeNull();
  });

  it("drops an over-long single sentence when punctuated (no mid-thought ending)", () => {
    const long = transcript([sent(10, "Intro"), sent(200, "Start"), sent(10, "Outro")]); // middle ≈ 80 s
    const s = long.words.find((w) => w.w === "Start")!.s;
    expect(snapClip(long, s, s + 80, { minSec: 20, maxSec: 60 })).toBeNull();
  });

  it("cuts an over-long stretch at a word boundary when unpunctuated (YouTube captions)", () => {
    const words = Array.from({ length: 200 }, (_, i) => ({ w: `w${i}`, s: i * 0.4, e: i * 0.4 + 0.35 }));
    const rough = makeTranscript("youtube", "rough", words); // no punctuation, no pauses: 40-word pieces
    const r = snapClip(rough, 0, 15, { minSec: 8, maxSec: 12 })!; // one 40-word piece ≈ 16 s > max
    expect(r.end - r.start).toBeLessThanOrEqual(12);
    expect(r.end - r.start).toBeGreaterThanOrEqual(8);
    expect(rough.words.some((w) => w.e === r.end)).toBe(true);
  });
});

describe("snapping to real sentences in punctuated transcripts", () => {
  /** Words with explicit gaps: "|" inserts a 1 s pause (which splits transcript sentences). */
  function timed(text: string) {
    const words: Word[] = [];
    let t = 0;
    for (const tok of text.split(" ")) {
      if (tok === "|") {
        t += 1;
        continue;
      }
      words.push({ w: tok, s: t, e: t + 0.35 });
      t += 0.4;
    }
    return makeTranscript("whisper", "precise", words);
  }
  const filler = (n: number, tag: string) => Array.from({ length: n }, (_, i) => `${tag}${i}`).join(" ");

  it("never ends at a pause inside a sentence", () => {
    // Sentence 2 has a long pause in the middle: the transcript splits it, snapping must not.
    const t = timed(`First ${filler(20, "a")} done. Second ${filler(30, "b")} because | when ${filler(20, "c")} over. Third ${filler(20, "d")} end.`);
    expect(t.sentences.length).toBe(4); // pause split
    const pauseEnd = t.words.find((w) => w.w === "because")!.e;
    const r = snapClip(t, 0, pauseEnd, { minSec: 10, maxSec: 60 })!;
    const last = t.words[r.lastWord]!.w;
    expect(last.endsWith(".")).toBe(true);
    expect(last).not.toBe("because");
  });

  it("never starts after a pause inside a sentence", () => {
    const t = timed(`Opening ${filler(25, "a")} because | when ${filler(30, "b")} over. Next ${filler(30, "c")} end.`);
    const whenStart = t.words.find((w) => w.w === "when")!.s;
    const r = snapClip(t, whenStart, whenStart + 30, { minSec: 10, maxSec: 60 })!;
    expect(["Opening", "Next"]).toContain(t.words[r.firstWord]!.w);
  });

  it("checkSelection flags mid-sentence edges in punctuated transcripts only", () => {
    const t = timed(`Opening ${filler(25, "a")} because | when ${filler(30, "b")} over. Next ${filler(30, "c")} end.`);
    const when = t.words.find((w) => w.w === "when")!;
    const because = t.words.find((w) => w.w === "because")!;
    const bad = checkSelection([{ startSec: when.s, endSec: t.words.at(-1)!.e, hookA: "a b", hookB: "c d" }], t, { minLengthSec: 1, maxLengthSec: 999, bannedWords: [] }, { min: 1, max: 1 });
    expect(bad.find((c) => c.name === "starts and ends on full sentences")!.pass).toBe(false);
    const bad2 = checkSelection([{ startSec: 0, endSec: because.e, hookA: "a b", hookB: "c d" }], t, { minLengthSec: 1, maxLengthSec: 999, bannedWords: [] }, { min: 1, max: 1 });
    expect(bad2.find((c) => c.name === "starts and ends on full sentences")!.detail).toMatch(/ends mid-sentence/);
    // Unpunctuated (YouTube auto-captions): pauses are the only boundaries, check not applied.
    const rough = makeTranscript("youtube", "rough", t.words.map((w) => ({ ...w, w: w.w.replace(/[.]/g, "") })));
    expect(checkSelection([{ startSec: when.s, endSec: rough.words.at(-1)!.e, hookA: "a b", hookB: "c d" }], rough, { minLengthSec: 1, maxLengthSec: 999, bannedWords: [] }, { min: 1, max: 1 }).some((c) => c.name.includes("full sentences"))).toBe(false);
  });
});

describe("leading / trailing filler trimming", () => {
  it("drops leading fillers and conjunctions and trailing conjunctions", () => {
    const t = transcript(["So um and the market crashed hard and", "Everyone panicked overnight."]);
    const tr = trimEdges(t.words, 0, 7)!; // "So um and the market crashed hard and"
    expect(t.words[tr[0]]!.w).toBe("the");
    expect(t.words[tr[1]]!.w).toBe("hard");
  });

  it("snapClip never starts on 'So' / 'And' or a flagged filler", () => {
    const t = transcript([sent(30, "So"), sent(30, "And"), sent(30, "Um,"), sent(30, "Money")]);
    for (const s of t.sentences) {
      const r = snapClip(t, s.s, s.s + 25, { minSec: 20, maxSec: 60 });
      if (!r) continue;
      const first = t.words[r.firstWord]!.w.toLowerCase();
      expect(["so", "and", "um,"]).not.toContain(first);
    }
  });

  it("returns null when only fillers remain", () => {
    const t = transcript(["Um uh so and"]);
    expect(trimEdges(t.words, 0, 3)).toBeNull();
  });
});

describe("score formula", () => {
  it("matches SPEC §8.3 weights", () => {
    expect(finalScore({ hook: 10, standalone: 0, payoff: 0, emotion: 0, novelty: 0, quotability: 0 })).toBe(30);
    // 0.3·8 + 0.2·7 + 0.2·9 + 0.1·5 + 0.1·6 + 0.1·4 = 7.1 → 71
    expect(finalScore({ hook: 8, standalone: 7, payoff: 9, emotion: 5, novelty: 6, quotability: 4 })).toBe(71);
    expect(finalScore(scores(10))).toBe(100);
    expect(finalScore(scores(0))).toBe(0);
  });

  it("normalizes custom weights and clamps scores", () => {
    const w = { ...DEFAULT_SCORE_WEIGHTS, hook: 0.6 }; // sums to 1.3
    expect(finalScore(scores(5), w)).toBe(50);
    expect(finalScore({ ...scores(5), hook: 15 }, { ...DEFAULT_SCORE_WEIGHTS })).toBe(65);
  });
});

describe("banned-word filter", () => {
  const banned = ["crypto", "get rich", "#ad"];
  it("finds whole words and phrases, case-insensitive", () => {
    expect(findBanned("Why CRYPTO will get rich quick", banned)).toEqual(["CRYPTO", "get rich"]);
    expect(findBanned("cryptography is not it", banned)).toEqual([]);
    expect(findBanned("this is an #ad", banned)).toEqual(["#ad"]);
  });

  it("strips banned terms from captions and tidies spacing", () => {
    expect(stripBanned("Learn crypto, then get rich today.", banned)).toBe("Learn, then today.");
  });

  it("rejects banned or over-long hooks, fixes ALL CAPS, removes emojis", () => {
    expect(cleanHook("Crypto changed everything", banned)).toBeNull();
    expect(cleanHook("one two three four five six seven eight", [])).toBeNull();
    expect(cleanHook("THIS CHANGES EVERYTHING 🔥", [])).toBe("This changes everything");
    expect(cleanHook('"AI took my job"', [])).toBe("AI took my job");
  });

  it("cleans captions and hashtags", () => {
    expect(cleanCaption("Big lesson #money 🔥 about crypto", banned)).toBe("Big lesson about");
    expect(cleanHashtags(["#Money Tips", "fyp", "#viral", "crypto", "investing", "#investing", "a", "b", "c"], banned)).toEqual([
      "#moneytips",
      "#investing",
      "#a",
      "#b",
      "#c",
    ]);
    expect(clampText("word ".repeat(40), 70).length).toBeLessThanOrEqual(70);
  });

  it("detects near-duplicate hooks", () => {
    expect(sameHook("Nobody talks about this!", "nobody talks about this")).toBe(true);
    expect(sameHook("Why rich people rent", "The 3 money rules")).toBe(false);
  });
});

describe("prompts + parsing", () => {
  it("builds the SPEC prompts", () => {
    expect(scoutUser({ niche: "finance", idealLengthSec: 35, min: 20, max: 60, lines: "[0.0]: hi" })).toContain("Ideal clip length: 35 s (allowed 20–60)");
    const u = editUser({ niche: "finance", briefNotes: "", bannedWords: ["crypto"], idealLengthSec: 35, min: 20, max: 60, fewShot: "", candidates: "c1", n: 10 });
    expect(u).toContain("Never use: crypto");
    expect(u).toContain("Pick the best 10.");
    expect(u).toContain("(none yet)");
  });

  it("extracts JSON from fenced or chatty replies", () => {
    expect(extractJson('```json\n{"moments": []}\n```')).toEqual({ moments: [] });
    expect(extractJson('Here you go:\n{"a": 1}\nThanks!')).toEqual({ a: 1 });
    expect(() => extractJson("no json")).toThrow();
  });

  it("accepts wrapped or bare arrays and coerces numeric strings", () => {
    expect(scoutResponseSchema.parse([{ start: "10", end: 40, summary: "x", roughScore: 80 }])[0]!.start).toBe(10);
    expect(scoutResponseSchema.parse({ moments: [] })).toEqual([]);
    expect(() => editResponseSchema.parse({ clips: [{ id: "c1" }] })).toThrow();
  });
});

describe("finalizeClips", () => {
  // 40 sentences × 25 words ≈ 10.6 s each → ~424 s.
  const t = transcript(Array.from({ length: 40 }, (_, i) => sent(25, i % 3 === 0 ? "So" : "Money", `s${i}w`)));
  const S = (i: number) => t.sentences[i]!.s;
  const E = (i: number) => t.sentences[i]!.e;
  const cfg = campaignConfigSchema.parse({ bannedWords: ["scam"] });
  const candidates: Candidate[] = Array.from({ length: 12 }, (_, i) => ({ id: `c${i + 1}`, start: S(i * 3), end: E(i * 3 + 2), summary: `Moment ${i + 1} about money`, roughScore: 50 + i }));
  const edit = (i: number, v: number, extra: Partial<EditClip> = {}): EditClip => ({
    id: `c${i + 1}`,
    start: S(i * 3) + 0.5,
    end: E(i * 3 + 2) - 0.3,
    scores: scores(v),
    hookA: `Hook number ${i + 1} here`,
    hookB: `Why this works ${i + 1}?`,
    coldOpen: null,
    title: `Title ${i + 1}`,
    captionTiktok: "tt",
    captionInstagram: "ig",
    captionYoutube: "yt",
    hashtags: ["#money", "#fyp"],
    emphasisWords: [`s${i * 3}w3`, "notspoken"],
    reason: "Good.",
    ...extra,
  });
  const opts = { transcript: t, candidates, config: cfg, weights: { ...DEFAULT_SCORE_WEIGHTS }, n: 10, minClips: 8 };

  it("ranks by final score, snaps, cleans text and passes the acceptance checks", () => {
    const clips = finalizeClips(
      Array.from({ length: 10 }, (_, i) => edit(i, 5 + (i % 5), i === 2 ? { hookA: "This scam ruins everyone", hookB: "This scam ruins everyone" } : {})),
      opts,
    );
    expect(clips).toHaveLength(10);
    expect(clips.map((c) => c.rank)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    expect(clips[0]!.score).toBeGreaterThanOrEqual(clips[9]!.score);
    const c3 = clips.find((c) => c.candidateId === "c3")!;
    expect(c3.hookA).not.toMatch(/scam/i);
    expect(sameHook(c3.hookA, c3.hookB)).toBe(false);
    expect(clips[0]!.hashtags).toEqual(["#money"]);
    expect(clips.every((c) => c.emphasisWords.every((w) => w !== "notspoken"))).toBe(true);
    const checks = checkSelection(clips, t, cfg);
    expect(checks.filter((c) => !c.pass)).toEqual([]);
  });

  it("drops unknown ids and > 50% overlaps, then tops up from scout candidates to the minimum", () => {
    const dup = { ...edit(0, 9), id: "c2", start: S(0), end: E(2) }; // same range as c1
    const clips = finalizeClips([edit(0, 8), dup, { ...edit(1, 9), id: "nope" }], opts);
    expect(clips.length).toBe(8);
    expect(clips.filter((c) => c.source === "edit")).toHaveLength(1);
    expect(clips.filter((c) => c.source === "scout-fallback").every((c) => c.hookA && c.hookB && !sameHook(c.hookA, c.hookB))).toBe(true);
    expect(checkSelection(clips, t, cfg).filter((c) => !c.pass)).toEqual([]);
  });

  it("validates cold opens: inside the clip, 2–4 s, not at the very start", () => {
    const good = finalizeClips([edit(0, 9, { coldOpen: { start: S(2) + 0.1, end: S(2) + 3 } })], { ...opts, minClips: 1 })[0]!;
    expect(good.coldOpen).not.toBeNull();
    expect(good.coldOpen!.end - good.coldOpen!.start).toBeGreaterThanOrEqual(1.5);
    const bad = finalizeClips([edit(0, 9, { coldOpen: { start: S(0), end: S(0) + 10 } })], { ...opts, minClips: 1 })[0]!;
    expect(bad.coldOpen).toBeNull();
    const edit0 = initialClipEdit(good, cfg);
    expect(edit0.coldOpen).toMatchObject({ enabled: true });
    expect(edit0.trim).toEqual({ start: good.startSec, end: good.endSec });
  });

  it("template hooks are distinct and short", () => {
    const [a, b] = templateHooks("A very long summary about how interest rates quietly destroy savings", "Rates went up again.", []);
    expect(a.split(" ").length).toBeLessThanOrEqual(7);
    expect(b.split(" ").length).toBeLessThanOrEqual(7);
    expect(sameHook(a, b)).toBe(false);
  });
});

describe("checkSelection", () => {
  const t = transcript([sent(30, "Money"), sent(30, "So"), sent(30, "Money")]);
  const cfg = { minLengthSec: 5, maxLengthSec: 60, bannedWords: ["scam"] };
  it("flags mid-word cuts, filler starts, overlaps, bad hooks and banned words", () => {
    const w = t.words;
    const checks = checkSelection(
      [
        { startSec: w[0]!.s + 0.1, endSec: w[20]!.e, hookA: "One", hookB: "one" },
        { startSec: w[30]!.s, endSec: w[50]!.e, hookA: "A scam exposed", hookB: "one two three four five six seven eight" },
        { startSec: w[31]!.s, endSec: w[50]!.e, hookA: "x", hookB: "y" },
      ],
      t,
      cfg,
      { min: 8, max: 10 },
    );
    const failed = Object.fromEntries(checks.filter((c) => !c.pass).map((c) => [c.name, c.detail]));
    expect(Object.keys(failed)).toEqual(["8–10 clips", "no > 50% overlap", "no mid-word or filler start/end", "starts and ends on full sentences", "two distinct hooks ≤ 7 words", "no banned words in generated text"]);
    expect(failed["no mid-word or filler start/end"]).toMatch(/mid-word/);
    expect(failed["no mid-word or filler start/end"]).toMatch(/starts on "So"/);
  });
});
