import { beforeEach, describe, expect, it } from "vitest";
import { openDb, type Db } from "./db/client";
import { campaignConfigSchema } from "./schemas/campaign";
import { getScoreWeights } from "./clips";
import { createCampaign, createOperator, overlayFileName, setScoreWeights, updateCampaign, updateOperator } from "./admin";

let db: Db;
beforeEach(() => {
  db = openDb(":memory:").db;
});

describe("campaigns", () => {
  it("creates with defaults and a unique slug; updates the config", () => {
    const a = createCampaign(db, { name: "Money Talks!", config: {} });
    const b = createCampaign(db, { name: "Money talks", config: {} });
    expect(a.slug).toBe("money-talks");
    expect(b.slug).toBe("money-talks-2");
    expect(a.allowedPlatforms).toEqual(["tiktok", "instagram", "youtube"]);
    const cfg = campaignConfigSchema.parse({ ...a.config, sfx: { intensity: "heavy", categories: ["whoosh", "pop", "ding", "click"], gainDb: -12 }, requiredHashtags: ["#money"] });
    const u = updateCampaign(db, a.id, { config: cfg, niche: "personal finance" });
    expect(u.config.sfx.categories).toContain("ding");
    expect(u.niche).toBe("personal finance");
    expect(u.slug).toBe("money-talks");
  });

  it("rejects invalid configs", () => {
    const a = createCampaign(db, { name: "X", config: {} });
    expect(() => updateCampaign(db, a.id, { config: { minLengthSec: 50, idealLengthSec: 30 } as never })).toThrow();
    expect(() => createCampaign(db, { name: "", config: {} })).toThrow();
  });
});

describe("operators and settings", () => {
  it("operators get slugs; drive folder editable", () => {
    const o = createOperator(db, { name: "Sara K." });
    expect(o.slug).toBe("sara-k");
    expect(updateOperator(db, o.id, { driveFolder: "Sara" }).driveFolder).toBe("Sara");
  });

  it("score weights are stored and used", () => {
    setScoreWeights(db, { hook: 0.5, standalone: 0.1, payoff: 0.1, emotion: 0.1, novelty: 0.1, quotability: 0.1 });
    expect(getScoreWeights(db).hook).toBe(0.5);
    expect(() => setScoreWeights(db, { hook: -1 } as never)).toThrow();
  });

  it("overlay file names are safe PNG names", () => {
    expect(overlayFileName("My Logo (final).PNG")).toBe("my-logo-final.png");
    expect(overlayFileName("../../evil.png")).toBe("evil.png");
  });
});
