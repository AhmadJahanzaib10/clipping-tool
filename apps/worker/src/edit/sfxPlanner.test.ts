import { describe, expect, it } from "vitest";
import type { PlanWord, Segment } from "@clip/shared";
import { avoidSentenceStart, isNumberWord, MIN_GAP_SEC, planSfx, seededRandom, sentenceStarts, type LibrarySound, type PlannerInput } from "./sfxPlanner";

const lib = (spec: Record<string, number>): LibrarySound[] =>
  Object.entries(spec).flatMap(([cat, n]) => Array.from({ length: n }, (_, i) => ({ id: `${cat}${i}`, category: cat, file: `${cat}/${i}.mp3`, durationSec: 0.4, defaultGainDb: i === 0 ? -2 : 0 })));
const ALL = ["whoosh", "pop", "impact", "transition", "click", "ding"];

/** Words every 0.4 s; "." every 8 words; emphasis on every 5th; a number every 13th. */
function words(duration: number): PlanWord[] {
  const out: PlanWord[] = [];
  let i = 0;
  for (let t = 0.2; t < duration - 0.5; t += 0.4, i++) {
    out.push({ i, w: i % 13 === 7 ? "75,000" : `w${i}${i % 8 === 7 ? "." : ""}`, s: t, e: t + 0.3, ...(i % 5 === 3 ? { emphasis: true } : {}) });
  }
  return out;
}
const main = (d: number): Segment[] => [{ kind: "main", srcStart: 100, srcEnd: 100 + d, outStart: 0, outEnd: d }];

function input(o: Partial<PlannerInput> & { duration?: number } = {}): PlannerInput {
  const duration = o.duration ?? 40;
  return {
    clipId: "clip-1",
    plan: { segments: main(duration), duration, zoom: [{ start: 27, peak: 27.15, holdEnd: 28.2, end: 28.35, scale: 1.06 }], cuts: [12, 25] },
    words: words(duration),
    library: lib({ whoosh: 3, pop: 4, impact: 2, transition: 2, click: 2, ding: 2 }),
    sfx: { intensity: "normal", categories: ALL, gainDb: -14 },
    ...o,
  };
}

/** The two hard rules from the M5 acceptance check. */
function assertRules(cues: { at: number; sfxId: string }[], gap: number) {
  const sorted = [...cues].sort((a, b) => a.at - b.at);
  for (let k = 1; k < sorted.length; k++) {
    expect(sorted[k]!.at - sorted[k - 1]!.at).toBeGreaterThanOrEqual(gap - 1e-9);
    expect(sorted[k]!.sfxId).not.toBe(sorted[k - 1]!.sfxId);
  }
}

describe("sfx planner: SPEC §10.3 table", () => {
  it("whoosh at 0.0 s for every intensity except off", () => {
    for (const intensity of ["subtle", "normal", "heavy"] as const) {
      const c = planSfx(input({ sfx: { intensity, categories: ALL, gainDb: -14 } }));
      expect(c[0]).toMatchObject({ at: 0, category: "whoosh", source: "auto" });
    }
    expect(planSfx(input({ sfx: { intensity: "off", categories: ALL, gainDb: -14 } }))).toEqual([]);
  });

  it("subtle = hook (+ cold-open transition) only", () => {
    const segs: Segment[] = [
      { kind: "teaser", srcStart: 120, srcEnd: 123, outStart: 0, outEnd: 3 },
      { kind: "transition", srcStart: 123, srcEnd: 123, outStart: 3, outEnd: 3.2 },
      { kind: "main", srcStart: 100, srcEnd: 140, outStart: 3.2, outEnd: 43.2 },
    ];
    const c = planSfx(input({ duration: 43.2, plan: { segments: segs, duration: 43.2, zoom: [], cuts: [] }, sfx: { intensity: "subtle", categories: ALL, gainDb: -14 } }));
    expect(c.map((x) => [x.at, x.reason])).toEqual([
      [0, "hook"],
      [3, "cold open → clip"],
    ]);
    expect(["whoosh", "transition"]).toContain(c[1]!.category);
  });

  it("normal adds payoff impact, numbers, every 2nd emphasis and zoom clicks; heavy adds every emphasis and cuts", () => {
    const normal = planSfx(input());
    const heavy = planSfx(input({ sfx: { intensity: "heavy", categories: ALL, gainDb: -14 } }));
    const cats = (c: typeof normal) => new Set(c.map((x) => x.category));
    expect([...cats(normal)].sort()).toEqual(["click", "ding", "impact", "pop", "whoosh"]);
    expect(heavy.filter((x) => x.category === "pop").length).toBeGreaterThan(normal.filter((x) => x.category === "pop").length);
    expect(normal.some((x) => x.category === "transition")).toBe(false);
    // Cut transitions are lowest priority: visible on a clip without emphasis words.
    const plain = input().words.map(({ emphasis: _e, ...w }) => w);
    const heavyPlain = planSfx(input({ words: plain, sfx: { intensity: "heavy", categories: ALL, gainDb: -14 } }));
    expect(heavyPlain.filter((x) => x.category === "transition").map((x) => x.at)).toEqual([12, 25]);
    const impact = normal.find((x) => x.category === "impact")!;
    expect(impact.at).toBeGreaterThan(40 - 5.5);
    expect(impact.at).toBeLessThan(40 - 1);
  });

  it("only uses the campaign's categories and categories that have files", () => {
    const c = planSfx(input({ sfx: { intensity: "heavy", categories: ["whoosh", "pop"], gainDb: -14 } }));
    expect(new Set(c.map((x) => x.category))).toEqual(new Set(["whoosh", "pop"]));
    const noImpact = planSfx(input({ library: lib({ whoosh: 2, pop: 2 }) }));
    expect(noImpact.some((x) => x.category === "impact")).toBe(false);
  });

  it("gain = campaign gainDb + file defaultGainDb", () => {
    for (const c of planSfx(input())) {
      const file = input().library.find((s) => s.id === c.sfxId)!;
      expect(c.gainDb).toBeCloseTo(-14 + file.defaultGainDb, 6);
    }
  });
});

describe("sfx planner: rules", () => {
  it("never two cues < 1.5 s apart (1.0 s on heavy), never the same file twice in a row", () => {
    assertRules(planSfx(input()), MIN_GAP_SEC.normal);
    assertRules(planSfx(input({ sfx: { intensity: "heavy", categories: ALL, gainDb: -14 } })), MIN_GAP_SEC.heavy);
  });

  it("holds the rules on 300 random clips, libraries and intensities (property test)", () => {
    const r = seededRandom("property");
    for (let n = 0; n < 300; n++) {
      const duration = 15 + r() * 45;
      const intensity = (["subtle", "normal", "heavy"] as const)[Math.floor(r() * 3)]!;
      const zoom = Array.from({ length: Math.floor(r() * 6) }, () => {
        const s = r() * duration;
        return { start: s, peak: s + 0.15, holdEnd: s + 1.2, end: s + 1.35, scale: 1.06 };
      });
      const cuts = Array.from({ length: Math.floor(r() * 10) }, () => r() * duration);
      const library = lib({ whoosh: 1 + Math.floor(r() * 3), pop: 1 + Math.floor(r() * 2), impact: Math.floor(r() * 2), transition: 1 + Math.floor(r() * 2), click: 1, ding: 1 });
      const manual = r() < 0.3 ? [{ id: "m1", sfxId: "pop0", at: r() * duration, gainDb: -10, source: "manual" as const }] : [];
      const cues = planSfx({ clipId: `c${n}`, plan: { segments: main(duration), duration, zoom, cuts }, words: words(duration), library, sfx: { intensity, categories: ALL, gainDb: -14 }, manual });
      assertRules([...cues, ...manual], MIN_GAP_SEC[intensity]);
      for (const c of cues) expect(c.at).toBeLessThanOrEqual(duration);
    }
  });

  it("an auto cue right before a manual cue never uses the manual cue's file", () => {
    const library = lib({ whoosh: 2, pop: 2 });
    for (let at = 3; at < 30; at += 0.7) {
      const manual = [{ id: "m", sfxId: "pop0", at, gainDb: -10, source: "manual" as const }];
      const c = planSfx(input({ library, manual, sfx: { intensity: "heavy", categories: ["whoosh", "pop"], gainDb: -14 } }));
      assertRules([...c, ...manual], MIN_GAP_SEC.heavy);
    }
  });

  it("a category with a single file is not repeated back-to-back (cue skipped instead)", () => {
    const c = planSfx(input({ library: lib({ whoosh: 1, pop: 1 }), sfx: { intensity: "heavy", categories: ["whoosh", "pop"], gainDb: -14 } }));
    assertRules(c, MIN_GAP_SEC.heavy);
  });

  it("is stable for the same clip id and differs between clips", () => {
    expect(planSfx(input())).toEqual(planSfx(input()));
    const a = planSfx(input()).map((c) => c.sfxId).join();
    const b = planSfx(input({ clipId: "clip-2" })).map((c) => c.sfxId).join();
    expect(a).not.toBe(b);
  });

  it("keeps clear of manual cues", () => {
    const manual = [{ id: "m1", sfxId: "pop1", at: 27.1, gainDb: -12, source: "manual" as const }];
    const c = planSfx(input({ manual }));
    expect(c.every((x) => Math.abs(x.at - 27.1) >= 1.5)).toBe(true);
    expect(c.every((x) => x.source === "auto")).toBe(true);
  });

  it("never lands on the first 0.3 s of a sentence: shifted into the gap before", () => {
    const w: PlanWord[] = [
      { i: 0, w: "End.", s: 1, e: 1.4 },
      { i: 1, w: "Next", s: 2, e: 2.3 },
    ];
    const starts = sentenceStarts(w);
    expect(starts).toEqual([1, 2]);
    expect(avoidSentenceStart(2.1, w, starts)).toBeCloseTo(1.88, 6);
    expect(avoidSentenceStart(2.4, w, starts)).toBe(2.4); // past the first 0.3 s: unchanged
    const cues = planSfx(input());
    const st = sentenceStarts(input().words);
    for (const c of cues.filter((x) => x.at > 0)) expect(st.some((s) => c.at >= s && c.at < s + 0.3)).toBe(false);
  });

  it("recognizes number / stat words", () => {
    for (const w of ["75,000", "$7.", "40%", "2007", "million", "3x", "Half", "4K", "1990s", "21st,"]) expect(isNumberWord(w)).toBe(true);
    for (const w of ["one", "money", "the", "x", "B2B", "MP3", "w4", "COVID-19"]) expect(isNumberWord(w)).toBe(false);
  });
});
