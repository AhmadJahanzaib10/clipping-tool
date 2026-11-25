import { describe, expect, it } from "vitest";
import { campaignConfigSchema } from "./campaign";
import { clipEditSchema } from "./clip";
import { envSchema } from "../env";
import { openDb } from "../db/client";
import { seedDb } from "../seed";
import { campaigns, operators } from "../db/schema";

describe("CampaignConfig", () => {
  it("fills SPEC §6.1 defaults from an empty object", () => {
    const c = campaignConfigSchema.parse({});
    expect(c).toMatchObject({
      minLengthSec: 20,
      maxLengthSec: 60,
      idealLengthSec: 35,
      captionPreset: "bold-yellow",
      hookStyle: "top-banner",
      pacing: { tightenPauses: true, maxPauseSec: 0.45, trimFillers: true },
      coldOpen: "auto",
      zoom: "subtle",
      sfx: { intensity: "normal", categories: ["whoosh", "pop", "impact", "transition"], gainDb: -14 },
      bannedWords: [],
    });
  });

  it("rejects inconsistent lengths and unknown presets", () => {
    expect(campaignConfigSchema.safeParse({ minLengthSec: 50, idealLengthSec: 35 }).success).toBe(false);
    expect(campaignConfigSchema.safeParse({ captionPreset: "comic-sans" }).success).toBe(false);
  });
});

describe("ClipEdit", () => {
  const base = {
    trim: { start: 10, end: 40 },
    layout: "single",
    pacing: { tightenPauses: true, maxPauseSec: 0.45, trimFillers: true },
    coldOpen: null,
    zoom: "subtle",
    captionPreset: "bold-yellow",
    hookChoice: "A",
    wordEdits: [],
    emphasisWords: [],
    sfxCues: [],
    overlay: true,
  };
  it("accepts a valid edit", () => expect(clipEditSchema.safeParse(base).success).toBe(true));
  it("rejects end before start", () =>
    expect(clipEditSchema.safeParse({ ...base, trim: { start: 40, end: 10 } }).success).toBe(false));
});

describe("env", () => {
  it("treats blank values as unset and applies defaults", () => {
    const e = envSchema.parse({ DEEPGRAM_API_KEY: "", LOW_PRIORITY: "", PORT: "", SECTION_DOWNLOAD: "false" });
    expect(e.DEEPGRAM_API_KEY).toBeUndefined();
    expect(e.LOW_PRIORITY).toBe(true);
    expect(e.PORT).toBe(3000);
    expect(e.SECTION_DOWNLOAD).toBe(false);
    expect(e.TARGET_LUFS).toBe(-14);
  });
});

describe("seed", () => {
  it("creates 2 operators and 1 campaign, idempotently", () => {
    const { db } = openDb(":memory:");
    expect(seedDb(db)).toEqual({ operators: 2, campaigns: 1 });
    expect(seedDb(db)).toEqual({ operators: 0, campaigns: 0 });
    expect(db.select().from(operators).all()).toHaveLength(2);
    const [c] = db.select().from(campaigns).all();
    expect(campaignConfigSchema.parse(c!.config).requiredHashtags).toEqual(["#examplepodcast"]);
  });
});
