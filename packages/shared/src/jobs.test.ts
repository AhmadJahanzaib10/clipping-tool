import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { openDb, type Db } from "./db/client";
import { campaigns, operators, tasks } from "./db/schema";
import { seedDb } from "./seed";
import { claimTask } from "./queue/queue";
import { createJob, findUploadFile, getUsage, JobError, jobDetail, markSourceFailed, releaseDeepgram, reserveDeepgram, updateSource } from "./jobs";

let db: Db;
let storage: string;
let campaignId: string;
let operatorId: string;
const NOW = new Date("2026-03-01T12:00:00.000Z");

beforeEach(() => {
  db = openDb(":memory:").db;
  seedDb(db);
  campaignId = db.select().from(campaigns).get()!.id;
  operatorId = db.select().from(operators).get()!.id;
  storage = fs.mkdtempSync(path.join(os.tmpdir(), "clip-storage-"));
});
afterEach(() => fs.rmSync(storage, { recursive: true, force: true }));

describe("Deepgram daily cap", () => {
  it("reserves within the cap and refuses beyond it", () => {
    const cap = 600;
    expect(reserveDeepgram(db, 400, cap, NOW)).toBe(true);
    expect(reserveDeepgram(db, 300, cap, NOW)).toBe(false);
    expect(getUsage(db, NOW).deepgramSeconds).toBe(400);
    expect(reserveDeepgram(db, 200, cap, NOW)).toBe(true);
    expect(getUsage(db, NOW).deepgramSeconds).toBe(600);
  });

  it("release refunds a failed request, never below zero", () => {
    reserveDeepgram(db, 100, 600, NOW);
    releaseDeepgram(db, 100, NOW);
    expect(getUsage(db, NOW).deepgramSeconds).toBe(0);
    releaseDeepgram(db, 50, NOW);
    expect(getUsage(db, NOW).deepgramSeconds).toBe(0);
  });

  it("the budget resets per UTC day", () => {
    expect(reserveDeepgram(db, 600, 600, NOW)).toBe(true);
    expect(reserveDeepgram(db, 1, 600, new Date("2026-03-02T00:00:01Z"))).toBe(true);
  });
});

describe("createJob", () => {
  it("creates a source + INGEST task per URL, oldest first", () => {
    const srcs = createJob(db, storage, { urls: ["https://youtu.be/a", "https://youtu.be/b"], campaignId, operatorId }, NOW);
    expect(srcs.map((s) => s.url)).toEqual(["https://youtu.be/a", "https://youtu.be/b"]);
    const first = claimTask(db, { workerId: "w" }, NOW)!;
    expect(first.type).toBe("INGEST");
    expect(first.sourceId).toBe(srcs[0]!.id);
  });

  it("moves uploads into the source folder", () => {
    fs.mkdirSync(path.join(storage, "uploads"));
    fs.writeFileSync(path.join(storage, "uploads", "UPLOADid_123.mp4"), "data");
    const [src] = createJob(db, storage, { uploadIds: ["UPLOADid_123"], campaignId, operatorId }, NOW);
    expect(src!.kind).toBe("upload");
    const f = findUploadFile(storage, src!.id)!;
    expect(path.basename(f)).toBe("upload.mp4");
    expect(fs.readFileSync(f, "utf8")).toBe("data");
    expect(fs.existsSync(path.join(storage, "uploads", "UPLOADid_123.mp4"))).toBe(false);
  });

  it("validates input", () => {
    expect(() => createJob(db, storage, { campaignId, operatorId })).toThrow();
    expect(() => createJob(db, storage, { urls: ["not a url"], campaignId, operatorId })).toThrow();
    expect(() => createJob(db, storage, { urls: ["https://x.y"], campaignId: "nope", operatorId })).toThrow(JobError);
    expect(() => createJob(db, storage, { uploadIds: ["missingUpload1"], campaignId, operatorId })).toThrow(/not found/);
    expect(() => createJob(db, storage, { uploadIds: ["../../etc/passwd"], campaignId, operatorId })).toThrow();
  });
});

describe("source updates", () => {
  it("patches fields, logs failures and reports detail", () => {
    const [src] = createJob(db, storage, { urls: ["https://youtu.be/a"], campaignId, operatorId }, NOW);
    updateSource(db, src!.id, { status: "transcribing", title: "Ep 1", durationSec: 600 });
    markSourceFailed(db, src!.id, "yt-dlp exploded\nstack…");
    const d = jobDetail(db, src!.id)!;
    expect(d.source).toMatchObject({ title: "Ep 1", durationSec: 600, status: "failed", error: "yt-dlp exploded\nstack…" });
    expect(d.events.map((e) => e.message)).toContain("Failed: yt-dlp exploded");
    expect(d.tasks).toHaveLength(1);
    expect(() => updateSource(db, src!.id, { status: "bogus" as never })).toThrow();
    expect(db.select().from(tasks).where(eq(tasks.sourceId, src!.id)).all()).toHaveLength(1);
  });
});
