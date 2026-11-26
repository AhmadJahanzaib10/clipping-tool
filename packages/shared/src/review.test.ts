import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { openDb, type Db } from "./db/client";
import { campaigns, clips, operators, tasks } from "./db/schema";
import { seedDb } from "./seed";
import { createJob } from "./jobs";
import { clipFiles, getSourceContext, replaceSourceClips } from "./clips";
import { claimTask } from "./queue/queue";
import { deliveryTarget, hookAngle, planCleanup, platformCaption, renderKindFor, sidecarText, slugify, trimInsideSection } from "./review";
import { applyClipPatch, approveClip, fewShotExamples, performanceTables, rejectClip, ReviewError, setPerformance } from "./reviewDb";
import type { ClipEdit } from "./schemas/clip";

const edit = (o: Partial<ClipEdit> = {}): ClipEdit => ({
  trim: { start: 100, end: 130 },
  layout: "single",
  focus: "auto",
  pacing: { tightenPauses: true, maxPauseSec: 0.45, trimFillers: true },
  coldOpen: null,
  zoom: "subtle",
  captionPreset: "bold-yellow",
  hookChoice: "A",
  wordEdits: [],
  emphasisWords: [],
  sfxCues: [],
  overlay: false,
  ...o,
});
const prev = { edit: edit(), hookA: "Hook A", hookB: "Hook B" };

describe("renderKindFor (SPEC §6.2)", () => {
  it("picture/timeline fields → full re-render", () => {
    expect(renderKindFor(prev, { edit: edit({ trim: { start: 99.5, end: 130 } }) })).toBe("base");
    expect(renderKindFor(prev, { edit: edit({ layout: "fit" }) })).toBe("base");
    expect(renderKindFor(prev, { edit: edit({ focus: "left" }) })).toBe("base");
    expect(renderKindFor(prev, { edit: edit({ pacing: { tightenPauses: false, maxPauseSec: 0.45, trimFillers: true } }) })).toBe("base");
    expect(renderKindFor(prev, { edit: edit({ coldOpen: { enabled: true, start: 110, end: 113 } }) })).toBe("base");
    expect(renderKindFor(prev, { edit: edit({ zoom: "punchy" }) })).toBe("base");
  });

  it("hook / captions / SFX / words → fast re-render only", () => {
    expect(renderKindFor(prev, { edit: edit({ hookChoice: "B" }) })).toBe("compose");
    expect(renderKindFor(prev, { edit: edit({ hookOverride: "My own hook" }) })).toBe("compose");
    expect(renderKindFor(prev, { edit: edit({ captionPreset: "white-box" }) })).toBe("compose");
    expect(renderKindFor(prev, { edit: edit({ wordEdits: [{ index: 3, hidden: true }] }) })).toBe("compose");
    expect(renderKindFor(prev, { edit: edit({ sfxCues: [{ id: "m", sfxId: "x", at: 2, gainDb: -14, source: "manual" }] }) })).toBe("compose");
    expect(renderKindFor(prev, { hookA: "Better hook A" })).toBe("compose"); // text of the hook on screen
  });

  it("title / platform captions / the hook not shown → no render", () => {
    expect(renderKindFor(prev, { title: "New title", captionTiktok: "x", hashtags: ["#a"] })).toBe("none");
    expect(renderKindFor(prev, { hookB: "Unused hook B" })).toBe("none");
    expect(renderKindFor(prev, { edit: edit() })).toBe("none");
  });

  it("trim must stay inside the downloaded section", () => {
    expect(trimInsideSection({ start: 99, end: 131 }, { sourceStart: 98, duration: 34 })).toBe(true);
    expect(trimInsideSection({ start: 97, end: 131 }, { sourceStart: 98, duration: 34 })).toBe(false);
    expect(trimInsideSection({ start: 99, end: 131 }, null)).toBe(false);
  });
});

describe("delivery (SPEC §7.11)", () => {
  it("operator / campaign / date folders, safe names, Drive mirror when configured", () => {
    const t = deliveryTarget({ storageDir: "C:/st", driveRoot: "G:/My Drive/Clips", operator: { slug: "operator-one", driveFolder: "Op One/../x" }, campaignSlug: "example-podcast", clipId: "abc", title: "Why Costco won't raise $1.50!", date: new Date("2026-11-26T10:00:00Z") });
    expect(t.outDir).toBe(path.join("C:/st", "out", "operator-one", "example-podcast", "2026-11-26"));
    expect(t.driveDir).toBe(path.join("G:/My Drive/Clips", "op-one-x", "example-podcast", "2026-11-26"));
    expect(t.fileName).toBe("abc-why-costco-won-t-raise-1-50.mp4");
    expect(t.sidecarName).toBe("abc.txt");
    expect(deliveryTarget({ storageDir: "s", operator: { slug: "o", driveFolder: null }, campaignSlug: "c", clipId: "x", title: null, date: new Date() }).driveDir).toBeNull();
    expect(slugify("¡Ünïcode — Title!")).toBe("unicode-title");
  });

  it("sidecar: every platform, required hashtags + mentions always appended once", () => {
    const cfg = { requiredHashtags: ["#examplepodcast"], requiredMentions: ["@examplepodcast"] };
    const txt = sidecarText({ id: "abc", title: "Title", captionTiktok: "Watch this #examplepodcast", captionInstagram: "IG text", captionYoutube: "YT text", hashtags: ["#money"] }, cfg);
    expect(txt).toContain("== TikTok ==\nWatch this #examplepodcast\n\n@examplepodcast #money");
    expect(txt).toContain("== Instagram ==\nIG text\n\n@examplepodcast #examplepodcast #money");
    expect(txt).toContain("Title: Title");
    expect(platformCaption(null, null, cfg)).toBe("@examplepodcast #examplepodcast");
  });
});

describe("cleanup plan (SPEC §7.12)", () => {
  const now = new Date("2026-11-26T00:00:00Z");
  const days = (n: number) => new Date(now.getTime() - n * 86_400_000).toISOString();
  it("old sources, delivered clips after 2 days, rejected clips after KEEP_REJECTED_DAYS", () => {
    const p = planCleanup({
      now,
      keepSourcesDays: 3,
      keepRejectedDays: 2,
      sources: [{ id: "old", createdAt: days(4) }, { id: "new", createdAt: days(1) }],
      clips: [
        { id: "d-old", sourceId: "old", status: "approved", deliveredAt: days(3), updatedAt: days(3) },
        { id: "d-new", sourceId: "old", status: "approved", deliveredAt: days(1), updatedAt: days(1) },
        { id: "a-undelivered", sourceId: "old", status: "approved", deliveredAt: null, updatedAt: days(9) },
        { id: "r-old", sourceId: "old", status: "rejected", deliveredAt: null, updatedAt: days(3) },
        { id: "r-new", sourceId: "new", status: "rejected", deliveredAt: null, updatedAt: days(1) },
        { id: "c", sourceId: "new", status: "rendered", deliveredAt: null, updatedAt: days(30) },
      ],
    });
    expect(p).toEqual({ sources: ["old"], deliveredClips: ["d-old"], rejectedClips: ["r-old"] });
  });
});

describe("hook angle", () => {
  it("classifies roughly", () => {
    expect(hookAngle("Why does nobody talk about this?")).toBe("question");
    expect(hookAngle("75,000 signups overnight")).toBe("number");
    expect(hookAngle("POV: you quit your job")).toBe("pov/story");
    expect(hookAngle("Stop trusting customer interviews")).toBe("contrarian");
    expect(hookAngle("The secret behind Costco")).toBe("curiosity gap");
    expect(hookAngle("Mission beats money")).toBe("bold claim");
  });
});

// ---------- DB flows ----------

let db: Db;
let storage: string;
let clipId: string;
let sourceId: string;
beforeEach(() => {
  db = openDb(":memory:").db;
  seedDb(db);
  storage = fs.mkdtempSync(path.join(os.tmpdir(), "review-"));
  const [src] = createJob(db, storage, { urls: ["https://youtu.be/x"], campaignId: db.select().from(campaigns).get()!.id, operatorId: db.select().from(operators).get()!.id });
  sourceId = src!.id;
  const [c] = replaceSourceClips(db, sourceId, [
    { rank: 1, score: 80, scores: { hook: 8, standalone: 8, payoff: 8, emotion: 8, novelty: 8, quotability: 8 }, startSec: 100, endSec: 130, hookA: "Hook A", hookB: "Hook B", title: "T", captionTiktok: "tt", captionInstagram: "ig", captionYoutube: "yt", hashtags: [], emphasisWords: [], reason: "r", coldOpen: null, candidateId: "c1", source: "edit" },
  ]);
  clipId = c!.id;
  db.update(clips).set({ outputPath: `clips/${clipId}/clip.v1.mp4`, status: "rendered", composeVersion: 1, baseVersion: 1 }).where(eq(clips.id, clipId)).run();
  // A section covering 98–132 s.
  fs.mkdirSync(clipFiles(storage, clipId).dir, { recursive: true });
  fs.writeFileSync(clipFiles(storage, clipId).sectionInfo, JSON.stringify({ file: "section.mp4", sourceStart: 98, duration: 34, width: 1920, height: 1080, fps: 30, bytes: 1, method: "section", alignScore: 1 }));
  db.delete(tasks).run();
});
afterEach(() => fs.rmSync(storage, { recursive: true, force: true }));

const queued = () => db.select().from(tasks).all().map((t) => `${t.type}${t.payload && (t.payload as { clipIds?: string[] }).clipIds ? "(clip)" : ""}@${t.priority}`);

describe("applyClipPatch: the right re-render, at the front of the queue", () => {
  it("hook edit → COMPOSE only (fast)", () => {
    const c = db.select().from(clips).get()!;
    const r = applyClipPatch(db, storage, clipId, { edit: { ...c.edit!, hookOverride: "Brand new hook" } });
    expect(r.render).toBe("compose");
    expect(queued()).toEqual(["COMPOSE@100"]);
    expect(r.clip.status).toBe("rendering");
  });

  it("trim change inside the section → PREP_CLIP (→ RENDER_BASE → COMPOSE)", () => {
    const c = db.select().from(clips).get()!;
    const r = applyClipPatch(db, storage, clipId, { edit: { ...c.edit!, trim: { start: 101, end: 129.5 } } });
    expect(r.render).toBe("base");
    expect(queued()).toEqual(["PREP_CLIP@100"]);
    expect(r.clip).toMatchObject({ startSec: 101, endSec: 129.5 });
  });

  it("trim beyond the section → re-fetch only this clip's section first", () => {
    const c = db.select().from(clips).get()!;
    applyClipPatch(db, storage, clipId, { edit: { ...c.edit!, trim: { start: 90, end: 130 } } });
    expect(queued()).toEqual(["FETCH_SECTIONS(clip)@100"]);
  });

  it("title / caption edits save without rendering; approved clips are locked", () => {
    expect(applyClipPatch(db, storage, clipId, { title: "Better title", captionTiktok: "new" }).render).toBe("none");
    expect(queued()).toEqual([]);
    approveClip(db, clipId);
    expect(() => applyClipPatch(db, storage, clipId, { title: "x" })).toThrow(ReviewError);
  });

  it("user renders are claimed before older background work", () => {
    const c = db.select().from(clips).get()!;
    db.insert(tasks).values({ id: "bg", type: "RENDER_BASE", sourceId, clipId, payload: {}, priority: 0, status: "pending", attempts: 0, maxAttempts: 3, createdAt: "2020-01-01T00:00:00.000Z", updatedAt: "2020-01-01T00:00:00.000Z" }).run();
    applyClipPatch(db, storage, clipId, { edit: { ...c.edit!, captionPreset: "clean-white" } });
    expect(claimTask(db, { workerId: "w" })!.type).toBe("COMPOSE");
  });
});

describe("approve / reject / performance / few-shot", () => {
  it("approve queues DELIVER; needs a render first", () => {
    const { clip, task } = approveClip(db, clipId);
    expect(clip.status).toBe("approved");
    expect(clip.approvedAt).toBeTruthy();
    expect(task).toMatchObject({ type: "DELIVER", clipId, priority: 100 });
    db.update(clips).set({ outputPath: null, status: "candidate" }).where(eq(clips.id, clipId)).run();
    expect(() => approveClip(db, clipId)).toThrow(/render the clip/);
    expect(rejectClip(db, clipId).status).toBe("rejected");
  });

  it("views at 72 h feed the few-shot examples of the same niche and the performance tables", () => {
    setPerformance(db, clipId, { views72h: 120_000, platform: "tiktok" });
    fs.writeFileSync(clipFiles(storage, clipId).words, JSON.stringify([{ i: 0, w: "Costco", s: 0, e: 0.3 }, { i: 1, w: "sells", s: 0.4, e: 0.6 }]));
    const niche = db.select().from(campaigns).get()!.niche;
    expect(fewShotExamples(db, storage, niche)).toEqual([{ hook: "Hook A", firstLine: "Costco sells", lengthSec: 30, views: 120_000 }]);
    expect(fewShotExamples(db, storage, "another niche")).toEqual([]);
    expect(getSourceContext(db, sourceId, storage)!.fewShot).toHaveLength(1);
    expect(performanceTables(db).byPreset).toEqual([{ key: "bold-yellow", clips: 1, avgViews: 120_000 }]);
  });
});
