import { describe, expect, it } from "vitest";
import type { PlanWord } from "@clip/shared";
import { assColor, buildAss, buildLines, buildSrt, captionWords, FRAME_H, PRESETS, SAFE, wrapHook } from "./ass";

const W = (i: number, w: string, s: number, e: number, extra: Partial<PlanWord> = {}): PlanWord => ({ i, w, s, e, ...extra });
/** A sentence of words 0.3 s apart, starting at t. */
function sentence(text: string, t: number, startIndex = 0): PlanWord[] {
  return text.split(" ").map((w, k) => W(startIndex + k, w, t + k * 0.3, t + k * 0.3 + 0.25));
}
const edit = (o: Partial<{ captionPreset: string; wordEdits: { index: number; text?: string; hidden?: boolean }[]; emphasisWords: string[] }> = {}) => ({
  captionPreset: "bold-yellow",
  wordEdits: [],
  emphasisWords: [],
  ...o,
});

describe("lines", () => {
  it("2–3 words, ≤ 16 chars, break on punctuation and > 0.35 s gaps", () => {
    const words = captionWords(
      [...sentence("We raised money fast. Then everything broke", 0), W(7, "completely.", 2.5, 2.8), W(8, "Again", 3.5, 3.8)],
      [],
      [],
    );
    const lines = buildLines(words).map((l) => l.words.map((w) => w.text).join(" "));
    expect(lines).toEqual(["We raised money", "fast.", "Then everything", "broke", "completely.", "Again"]);
    for (const l of lines) {
      expect(l.split(" ").length).toBeLessThanOrEqual(3);
      expect(l.length).toBeLessThanOrEqual(16 + 11); // a single long word may exceed 16 chars on its own
    }
  });

  it("lines never overlap and stay up briefly after their last word", () => {
    const lines = buildLines(captionWords(sentence("one two three four five six seven", 0), [], []));
    for (let k = 1; k < lines.length; k++) expect(lines[k]!.start).toBeGreaterThanOrEqual(lines[k - 1]!.end - 1e-9);
    expect(lines.at(-1)!.end).toBeCloseTo(lines.at(-1)!.words.at(-1)!.e + 0.4, 6);
  });

  it("word edits replace text (keeping timing) and hide words", () => {
    const words = captionWords(sentence("um this is grate", 1), [{ index: 0, hidden: true }, { index: 3, text: "great" }], []);
    expect(words.map((w) => w.text)).toEqual(["this", "is", "great"]);
    expect(words[2]!.s).toBeCloseTo(1.9, 6);
  });

  it("emphasis from the words or the edit's emphasis list", () => {
    const words = captionWords([W(0, "Money,", 0, 0.3), W(1, "time", 0.4, 0.6, { emphasis: true }), W(2, "and", 0.7, 0.8)], [], ["money"]);
    expect(words.map((w) => w.emphasis)).toEqual([true, true, false]);
  });
});

describe("ASS output", () => {
  const words = [...sentence("Nobody tells you this about money", 0.2), ...sentence("It compounds quietly every single year.", 2.6, 6)];
  const base = { words, edit: edit({ emphasisWords: ["money"] }), hook: "The money rule nobody teaches you", hookStyle: "top-banner" as const, layout: "single" as const, duration: 6 };

  it("is a 1080×1920 script with the preset font and the hook in the first 2.8 s", () => {
    const { ass } = buildAss(base);
    expect(ass).toContain("PlayResX: 1080");
    expect(ass).toContain("PlayResY: 1920");
    expect(ass).toMatch(/Style: Caption,Montserrat ExtraBold,80,/);
    expect(ass).toMatch(/Dialogue: 2,0:00:00\.00,0:00:02\.80,HookBanner/);
  });

  it("highlights the active word and pops emphasis words over 120 ms", () => {
    const { ass } = buildAss(base);
    const y = PRESETS["bold-yellow"]!;
    expect(ass).toContain(`{\\c${y.active}}NOBODY`);
    // Pop: bigger, easing back to the line's scale over 120 ms (a wide line is slightly shrunk to stay in the safe width).
    const pop = /\\fscx(\d+)\\fscy\1\\t\(0,120,\\fscx(\d+)\\fscy\2\)\}MONEY/.exec(ass)!;
    expect(Number(pop[1])).toBe(Math.round(1.15 * Number(pop[2])));
    // One event per active word: word k's event starts at its own start time.
    const tells = ass.split("\n").find((l) => l.includes(`{\\c${y.active}}TELLS`))!;
    expect(tells.startsWith("Dialogue: 1,0:00:00.50,")).toBe(true);
  });

  it("escapes ASS control characters from transcript text", () => {
    const { ass } = buildAss({ ...base, words: [W(0, "{evil}\\N", 0, 0.5)], hook: "" });
    expect(ass).not.toContain("{evil}");
    expect(ass).toContain("EVILN");
  });

  it("white-box and clean-white presets use Inter and a box / soft shadow", () => {
    expect(buildAss({ ...base, edit: edit({ captionPreset: "white-box" }) }).ass).toMatch(/Style: Caption,Inter,64,.*,-1,0,0,0,100,100,0,0,3,14,0,/);
    expect(buildAss({ ...base, edit: edit({ captionPreset: "clean-white" }) }).ass).toMatch(/Style: Caption,Inter,68,.*,1,1\.5,4,/);
    expect(assColor("#FFD400")).toBe("&H0000D4FF");
    expect(assColor("#000000", 0.7)).toBe("&H4D000000");
  });

  it("centre-pop hook animates in; name label at the top", () => {
    const { ass } = buildAss({ ...base, hookStyle: "center-pop", showNameOnScreen: "Eric Ries" });
    expect(ass).toMatch(/HookPop,,0,0,0,,\{\\an5\\pos\(\d+,\d+\)\\fs\d+\\fscx\d+\\fscy\d+\\t\(0,180,/);
    expect(ass).toMatch(/,Name,,0,0,0,,\{\\an5\\pos\(\d+,144\)\}Eric Ries/);
  });

  it("wraps hooks into at most 2 balanced lines", () => {
    expect(wrapHook("Short hook")).toEqual(["Short hook"]);
    const two = wrapHook("The money rule nobody teaches you");
    expect(two).toHaveLength(2);
    expect(two.every((l) => l.length <= 20)).toBe(true);
  });
});

describe("safe zones (SPEC §7.9)", () => {
  const long = "Extraordinarily unbelievable transformation happened overnight in Massachusetts";
  const words = [...sentence(long, 0), ...sentence("I mean that literally, every word.", 4, 20)];
  for (const preset of Object.keys(PRESETS)) {
    for (const layout of ["single", "fit", "split"] as const) {
      it(`${preset} / ${layout}: nothing in the bottom 20 % or right 12 %; captions and hook in their bands`, () => {
        const { boxes } = buildAss({ words, edit: edit({ captionPreset: preset, emphasisWords: ["literally"] }), hook: "Seven words that absolutely nobody ever expects", hookStyle: "top-banner", layout, duration: 8, showNameOnScreen: "Guest Name" });
        expect(boxes.length).toBeGreaterThan(3);
        for (const b of boxes) {
          expect(b.y1).toBeLessThanOrEqual(SAFE.bottom);
          expect(b.x1).toBeLessThanOrEqual(SAFE.right + 1e-6);
          expect(b.x0).toBeGreaterThanOrEqual(SAFE.left - 1e-6);
        }
        for (const b of boxes.filter((x) => x.kind === "caption")) {
          const cy = (b.y0 + b.y1) / 2;
          if (layout === "split") expect(cy).toBe(FRAME_H / 2);
          else {
            expect(cy).toBeGreaterThanOrEqual(SAFE.captionBand[0]);
            expect(cy).toBeLessThanOrEqual(SAFE.captionBand[1]);
          }
        }
        const hook = boxes.find((x) => x.kind === "hook")!;
        expect(hook.y0).toBeGreaterThanOrEqual(SAFE.hookBand[0] - 1);
        expect(hook.y1).toBeLessThanOrEqual(SAFE.hookBand[1] + 1);
      });
    }
  }
});

describe("SRT", () => {
  it("one cue per caption line", () => {
    const lines = buildLines(captionWords(sentence("one two three four", 1.5), [], []));
    expect(buildSrt(lines)).toBe("1\n00:00:01,500 --> 00:00:02,400\none two three\n\n2\n00:00:02,400 --> 00:00:03,050\nfour\n");
  });
});
