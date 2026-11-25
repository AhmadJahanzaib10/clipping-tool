import { describe, expect, it } from "vitest";
import { campaignConfigSchema, type Analysis, type ClipEdit, type FaceBox, type SectionInfo, type Word } from "@clip/shared";
import { coldOpenSegments, TRANSITION_SEC, useColdOpen } from "./coldOpen";
import { buildTimeline, outToSrc, srcToOut } from "./pacing";
import { buildPlan } from "./plan";
import { zoomAt, zoomKeyframes } from "./zoom";
import { chooseLayout, maxPanSpeed, singleCrop, splitCrop } from "../render/crop";

const pacing = { tightenPauses: true, maxPauseSec: 0.45, trimFillers: true };
const W = (w: string, s: number, e: number, filler = false): Word => ({ w, s, e, ...(filler ? { filler: true } : {}) });

describe("timeline map: pause tightening", () => {
  // "one two" … 1.0 s pause … "three four"
  const words = [W("one", 10, 10.3), W("two", 10.35, 10.6), W("three", 11.6, 11.9), W("four", 11.95, 12.2)];

  it("cuts a long pause down to 0.15 s and remaps word times exactly", () => {
    const tl = buildTimeline(words, 10, 12.2, pacing);
    expect(tl.segments).toHaveLength(2);
    expect(tl.removedPauses).toBe(1);
    expect(tl.duration).toBeCloseTo(2.2 - (1.0 - 0.15), 6);
    // Word times after the pause move earlier by exactly the cut length (0.85 s).
    expect(srcToOut(tl.segments, 10)).toBeCloseTo(0, 6);
    expect(srcToOut(tl.segments, 10.6)).toBeCloseTo(0.6, 6);
    expect(srcToOut(tl.segments, 11.6)).toBeCloseTo(1.6 - 0.85, 6);
    expect(srcToOut(tl.segments, 12.2)).toBeCloseTo(2.2 - 0.85, 6);
    // The gap between "two" and "three" is now exactly 0.15 s.
    expect(srcToOut(tl.segments, 11.6)! - srcToOut(tl.segments, 10.6)!).toBeCloseTo(0.15, 6);
    // Times inside the cut map to nothing; output → source round-trips.
    expect(srcToOut(tl.segments, 11.1)).toBeNull();
    expect(outToSrc(tl.segments, srcToOut(tl.segments, 11.9)!)).toBeCloseTo(11.9, 6);
  });

  it("keeps pauses up to maxPauseSec and does nothing when tightening is off", () => {
    const short = [W("a", 0, 0.3), W("b", 0.7, 1)]; // 0.4 s pause
    expect(buildTimeline(short, 0, 1, pacing).segments).toHaveLength(1);
    expect(buildTimeline(words, 10, 12.2, { ...pacing, tightenPauses: false }).duration).toBeCloseTo(2.2, 6);
  });

  it("output segments are contiguous and in order", () => {
    const many = Array.from({ length: 20 }, (_, i) => W(`w${i}`, i * 1.2, i * 1.2 + 0.4));
    const tl = buildTimeline(many, 0, many.at(-1)!.e, pacing);
    tl.segments.forEach((s, i) => {
      expect(s.outEnd - s.outStart).toBeCloseTo(s.srcEnd - s.srcStart, 6);
      if (i) expect(s.outStart).toBeCloseTo(tl.segments[i - 1]!.outEnd, 6);
    });
    expect(tl.duration).toBeCloseTo(many.at(-1)!.e - 19 * (0.8 - 0.15), 6);
  });
});

describe("timeline map: filler trimming", () => {
  it("removes a filler with ≥ 60 ms silence on both sides", () => {
    const words = [W("I", 0, 0.2), W("um", 0.3, 0.5, true), W("think", 0.6, 0.9)];
    const tl = buildTimeline(words, 0, 0.9, pacing);
    expect(tl.removedFillers).toBe(1);
    expect([...tl.removedWords]).toEqual([1]);
    // "think" now starts 0.2 s after "I" ends (half of each 0.1 s silence kept).
    expect(srcToOut(tl.segments, 0.6)! - srcToOut(tl.segments, 0.2)!).toBeCloseTo(0.1, 6);
  });

  it("keeps a filler when the cut would clip a syllable (< 60 ms gap)", () => {
    const words = [W("I", 0, 0.2), W("um", 0.23, 0.5, true), W("think", 0.6, 0.9)];
    const tl = buildTimeline(words, 0, 0.9, pacing);
    expect(tl.removedFillers).toBe(0);
    expect(tl.segments).toHaveLength(1);
  });

  it("removes multi-word filler runs as one unit, and never the first/last word", () => {
    const words = [W("It", 0, 0.2), W("you", 0.3, 0.45, true), W("know", 0.46, 0.6, true), W("works", 0.7, 1), W("um", 1.1, 1.3, true)];
    const tl = buildTimeline(words, 0, 1.3, pacing);
    expect([...tl.removedWords].sort()).toEqual([1, 2]);
    expect(srcToOut(tl.segments, 1.1)).not.toBeNull(); // trailing filler stays (it's the last word)
  });

  it("does nothing when trimFillers is off", () => {
    const words = [W("I", 0, 0.2), W("um", 0.3, 0.5, true), W("think", 0.6, 0.9)];
    expect(buildTimeline(words, 0, 0.9, { ...pacing, trimFillers: false }).removedFillers).toBe(0);
  });
});

describe("cold open", () => {
  it("uses a 1.5–4.5 s teaser unless off/disabled", () => {
    expect(useColdOpen("auto", { enabled: true, start: 20, end: 23 })).toEqual({ start: 20, end: 23 });
    expect(useColdOpen("off", { enabled: true, start: 20, end: 23 })).toBeNull();
    expect(useColdOpen("auto", { enabled: false, start: 20, end: 23 })).toBeNull();
    expect(useColdOpen("auto", { enabled: true, start: 20, end: 30 })).toBeNull();
    expect(useColdOpen("always", null)).toBeNull();
  });

  it("teaser → 0.2 s transition → main clip", () => {
    const { segments, mainOffset } = coldOpenSegments({ start: 20, end: 23 });
    expect(segments.map((s) => s.kind)).toEqual(["teaser", "transition"]);
    expect(mainOffset).toBeCloseTo(3 + TRANSITION_SEC, 6);
    expect(segments[1]!.outEnd).toBeCloseTo(3.2, 6);
  });
});

describe("zoom keyframes", () => {
  it("one zoom per 4 s, never across a cut, never past the end", () => {
    const z = zoomKeyframes([1, 2, 6, 9, 14, 29], [9.5], "subtle", 30);
    expect(z.map((k) => k.start)).toEqual([1, 6, 14]); // 2 too close, 9 crosses the cut at 9.5, 29 runs past the end
    expect(z[0]).toMatchObject({ peak: 1.15, holdEnd: 2.2, scale: 1.06 });
    expect(zoomKeyframes([1], [], "punchy", 30)[0]!.scale).toBe(1.12);
    expect(zoomKeyframes([1], [], "off", 30)).toEqual([]);
  });

  it("eases in over 150 ms, holds, eases back", () => {
    const z = zoomKeyframes([1], [], "subtle", 30);
    expect(zoomAt(z, 0.9)).toBe(1);
    expect(zoomAt(z, 1.075)).toBeCloseTo(1.03, 3);
    expect(zoomAt(z, 1.5)).toBe(1.06);
    expect(zoomAt(z, 2.5)).toBe(1);
  });
});

// ---------- layout + crop ----------

const face = (x: number, w = 0.12, score = 0.9): FaceBox => ({ x, y: 0.25, w, h: w * 1.7, score });
function analysis(frames: FaceBox[][], scenes: { s: number; e: number }[] = [{ s: 0, e: 60 }]): Analysis {
  return { width: 1920, height: 1080, fps: 30, duration: frames.length / 3, sampleFps: 3, scenes, faces: frames.map((faces, i) => ({ t: i / 3, faces })) };
}
const segs = (dur: number) => [{ kind: "main" as const, srcStart: 100, srcEnd: 100 + dur, outStart: 0, outEnd: dur }];

describe("layout choice", () => {
  it("one speaker → single, two side by side → split, no faces → fit", () => {
    expect(chooseLayout(analysis(Array.from({ length: 90 }, () => [face(0.45)]))).layout).toBe("single");
    expect(chooseLayout(analysis(Array.from({ length: 90 }, () => [face(0.2), face(0.65)]))).layout).toBe("split");
    expect(chooseLayout(analysis(Array.from({ length: 90 }, () => []))).layout).toBe("fit");
  });

  it("split needs two faces in > 60% of frames; tiny/low-score faces don't count", () => {
    const mostlyOne = Array.from({ length: 90 }, (_, i) => (i % 2 ? [face(0.2), face(0.65)] : [face(0.2)]));
    expect(chooseLayout(analysis(mostlyOne)).layout).toBe("single");
    const poster = Array.from({ length: 90 }, () => [face(0.4, 0.15), face(0.8, 0.03)]);
    expect(chooseLayout(analysis(poster)).layout).toBe("single");
    const weak = Array.from({ length: 90 }, () => [face(0.4, 0.15, 0.3)]);
    expect(chooseLayout(analysis(weak)).layout).toBe("fit");
  });

  it("a vertical source is always fit", () => {
    const a = { ...analysis(Array.from({ length: 30 }, () => [face(0.4)])), width: 1080, height: 1920 };
    expect(chooseLayout(a).layout).toBe("fit");
  });
});

describe("single crop", () => {
  it("is 9:16 of full height and centres the face", () => {
    const c = singleCrop({ analysis: analysis(Array.from({ length: 60 }, () => [face(0.6)])), sectionStart: 100, segments: segs(20), focus: "auto" });
    expect(c.w).toBe(608);
    expect(c.h).toBe(1080);
    expect(c.keyframes).toHaveLength(1);
    expect(c.keyframes[0]!.x + c.w / 2).toBeCloseTo(0.66 * 1920, -1);
  });

  it("ignores small head movement inside the dead zone", () => {
    const jitter = Array.from({ length: 90 }, (_, i) => [face(0.45 + (i % 2 ? 0.02 : -0.02))]);
    const c = singleCrop({ analysis: analysis(jitter), sectionStart: 100, segments: segs(30), focus: "auto" });
    expect(new Set(c.keyframes.map((k) => k.x)).size).toBe(1);
  });

  it("follows a walking speaker smoothly (EMA, ≤ 2 keyframes/s, bounded pan speed)", () => {
    const walk = Array.from({ length: 90 }, (_, i) => [face(0.2 + (0.5 * i) / 90)]);
    const c = singleCrop({ analysis: analysis(walk), sectionStart: 100, segments: segs(30), focus: "auto" });
    expect(c.keyframes.length).toBeGreaterThan(3);
    for (let k = 1; k < c.keyframes.length; k++) expect(c.keyframes[k]!.t - c.keyframes[k - 1]!.t).toBeGreaterThanOrEqual(0.5 - 1e-9);
    expect(maxPanSpeed(c)).toBeLessThan(200); // px/s on a 1920-wide source
    expect(c.keyframes.at(-1)!.x).toBeGreaterThan(c.keyframes[0]!.x);
  });

  it("re-centres instantly at a scene cut", () => {
    const frames = Array.from({ length: 60 }, (_, i) => [face(i < 30 ? 0.15 : 0.75)]);
    const c = singleCrop({ analysis: analysis(frames, [{ s: 0, e: 10 }, { s: 10, e: 20 }]), sectionStart: 100, segments: segs(20), focus: "auto" });
    const jump = c.keyframes.find((k) => k.jump && k.t > 0)!;
    expect(jump.t).toBeCloseTo(10, 1);
    expect(jump.x).toBeGreaterThan(1000);
  });

  it("focus override pins the window", () => {
    const a = analysis(Array.from({ length: 30 }, () => [face(0.6)]));
    expect(singleCrop({ analysis: a, sectionStart: 100, segments: segs(10), focus: "left" }).keyframes[0]!.x).toBe(0);
    expect(singleCrop({ analysis: a, sectionStart: 100, segments: segs(10), focus: "right" }).keyframes[0]!.x).toBe(1920 - 608);
  });

  it("maps keyframes through pacing cuts (jump at each segment start)", () => {
    const walk = Array.from({ length: 90 }, (_, i) => [face(0.2 + (0.5 * i) / 90)]);
    const two = [
      { kind: "main" as const, srcStart: 100, srcEnd: 110, outStart: 0, outEnd: 10 },
      { kind: "main" as const, srcStart: 115, srcEnd: 130, outStart: 10, outEnd: 25 },
    ];
    const c = singleCrop({ analysis: analysis(walk), sectionStart: 100, segments: two, focus: "auto" });
    expect(c.keyframes.filter((k) => k.jump).map((k) => k.t)).toEqual([0, 10]);
    expect(c.keyframes.every((k) => k.t <= 25)).toBe(true);
  });
});

describe("missed cuts", () => {
  it("re-centres instantly (no fast pan) when the face jumps far away and stays there", () => {
    // Face at 0.2 for 4 s, then (an insert the scene detector missed) at 0.75.
    const frames = Array.from({ length: 60 }, (_, i) => [face(i < 12 ? 0.2 : 0.75)]);
    const c = singleCrop({ analysis: analysis(frames), sectionStart: 100, segments: segs(20), focus: "auto" });
    const jumps = c.keyframes.filter((k) => k.jump && k.t > 0);
    expect(jumps).toHaveLength(1);
    expect(jumps[0]!.t).toBeGreaterThan(4);
    expect(jumps[0]!.t).toBeLessThan(5);
    expect(maxPanSpeed(c)).toBe(0);
  });

  it("a single far-off sample (detector glitch) does not move the window", () => {
    const frames = Array.from({ length: 60 }, (_, i) => [face(i === 20 ? 0.8 : 0.3)]);
    const c = singleCrop({ analysis: analysis(frames), sectionStart: 100, segments: segs(20), focus: "auto" });
    expect(new Set(c.keyframes.map((k) => k.x)).size).toBe(1);
  });
});

describe("split crop", () => {
  it("left speaker on top, right below, 9:8 regions inside the frame", () => {
    const c = splitCrop(analysis(Array.from({ length: 60 }, () => [face(0.15), face(0.7)])));
    for (const r of [c.top, c.bottom]) {
      expect(r.w / r.h).toBeCloseTo(9 / 8, 1);
      expect(r.x).toBeGreaterThanOrEqual(0);
      expect(r.x + r.w).toBeLessThanOrEqual(1920);
      expect(r.y + r.h).toBeLessThanOrEqual(1080);
    }
    expect(c.top.x).toBeLessThan(c.bottom.x);
  });

  it("video-call tiles: each region shows only its speaker and stays inside the frame", () => {
    // Two 960-wide tiles with big faces centred at 25% and 75%.
    const c = splitCrop(analysis(Array.from({ length: 60 }, () => [face(0.17, 0.16), face(0.67, 0.16)])));
    for (const r of [c.top, c.bottom]) {
      expect(r.w).toBeLessThanOrEqual(960);
      expect(r.x + r.w).toBeLessThanOrEqual(1920);
      expect(r.y + r.h).toBeLessThanOrEqual(1080);
      expect(r.w % 2 + r.h % 2 + r.x % 2 + r.y % 2).toBe(0);
    }
    expect(c.top.x + c.top.w).toBeLessThanOrEqual(c.bottom.x + 2); // no overlap into the other tile
  });
});

// ---------- full plan ----------

describe("buildPlan", () => {
  const words: Word[] = [];
  for (let i = 0; i < 60; i++) words.push(W(i % 10 === 5 ? "money" : i === 20 ? "um" : `w${i}`, 100 + i * 0.5, 100 + i * 0.5 + 0.3, i === 20));
  words.splice(30, 0); // keep order
  // a 1.2 s pause after word 40
  for (let i = 41; i < words.length; i++) words[i] = { ...words[i]!, s: words[i]!.s + 1.2, e: words[i]!.e + 1.2 };
  const end = words.at(-1)!.e;
  const edit: ClipEdit = {
    trim: { start: 100, end },
    layout: "single",
    focus: "auto",
    pacing,
    coldOpen: { enabled: true, start: 120, end: 122.8 },
    zoom: "subtle",
    captionPreset: "bold-yellow",
    hookChoice: "A",
    wordEdits: [],
    emphasisWords: ["money"],
    sfxCues: [],
    overlay: false,
  };
  const section: SectionInfo = { file: "section.mp4", sourceStart: 98, duration: end - 98 + 2, width: 1920, height: 1080, fps: 30, bytes: 1, method: "section", alignScore: 0.9 };
  const a = { ...analysis(Array.from({ length: Math.ceil((end - 98 + 2) * 3) }, () => [face(0.5)])), duration: end - 98 + 2 };
  const cfg = campaignConfigSchema.parse({});

  it("builds teaser → transition → paced main with remapped words", () => {
    const { plan, words: pw } = buildPlan({ clipId: "c1", words, edit, config: cfg, analysis: a, section, autoLayout: true });
    expect(plan.segments[0]!.kind).toBe("teaser");
    expect(plan.segments[1]!.kind).toBe("transition");
    // 2 pauses: the 1.2 s one, plus the 0.7 s silence left where "um" was removed (> maxPauseSec).
    expect(plan.stats).toMatchObject({ coldOpen: true, removedPauses: 2, removedFillers: 1 });
    expect(plan.layout).toBe("single");
    // Teaser words come first and are flagged; the filler is gone from the main words.
    expect(pw[0]!.teaser).toBe(true);
    expect(pw.filter((w) => !w.teaser).some((w) => w.w === "um")).toBe(false);
    // Main words are monotonic and inside the output duration.
    const main = pw.filter((w) => !w.teaser);
    main.forEach((w, i) => {
      expect(w.e).toBeGreaterThanOrEqual(w.s);
      if (i) expect(w.s).toBeGreaterThanOrEqual(main[i - 1]!.e - 1e-9);
    });
    expect(main.at(-1)!.e).toBeCloseTo(plan.duration, 6);
    // Zooms only on emphasis words, ≥ 4 s apart.
    expect(plan.zoom.length).toBeGreaterThan(0);
    for (let i = 1; i < plan.zoom.length; i++) expect(plan.zoom[i]!.start - plan.zoom[i - 1]!.start).toBeGreaterThanOrEqual(4);
    expect(plan.cuts.length).toBeGreaterThanOrEqual(2); // transition end + pause cut
  });

  it("respects the edit's layout after the first plan, and rejects ranges outside the section", () => {
    const { plan } = buildPlan({ clipId: "c1", words, edit: { ...edit, layout: "fit", coldOpen: null }, config: cfg, analysis: a, section, autoLayout: false });
    expect(plan.layout).toBe("fit");
    expect(plan.crop.mode).toBe("fit");
    expect(plan.layoutReason).toMatch(/set in editor/);
    expect(plan.zoom).toEqual([]);
    expect(() => buildPlan({ clipId: "c1", words, edit: { ...edit, trim: { start: 50, end: 60 } }, config: cfg, analysis: a, section, autoLayout: true })).toThrow(/outside the section/);
  });
});
