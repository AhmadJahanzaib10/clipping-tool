import { beforeEach, describe, expect, it } from "vitest";
import os from "node:os";
import { campaigns, claimTask, createJob, enqueueTask, operators, seedDb, type Db } from "./test-helpers";
import { openDb } from "@clip/shared/db";
import { handleCreateClips, handleDeepgramUsage, handleEvent, handleLlmUsage, handleSource, handleSourceContext, type DataApiDeps } from "./worker-data-api";
import { sourceClips } from "@clip/shared";
import { handleWorkerRequest } from "./worker-api";

const TOKEN = "tok";
let db: Db;
let deps: DataApiDeps;
let sourceId: string;

const req = (method: string, body?: unknown, token = TOKEN) =>
  new Request("http://localhost/x", {
    method,
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

beforeEach(() => {
  db = openDb(":memory:").db;
  seedDb(db);
  deps = { db, token: TOKEN, deepgramCapSec: 600 };
  const [s] = createJob(db, os.tmpdir(), {
    urls: ["https://youtu.be/x"],
    campaignId: db.select().from(campaigns).get()!.id,
    operatorId: db.select().from(operators).get()!.id,
  });
  sourceId = s!.id;
});

describe("sources", () => {
  it("requires the token", async () => {
    expect((await handleSource(req("GET", undefined, "nope"), sourceId, deps)).status).toBe(401);
  });

  it("gets and patches a source", async () => {
    expect((await (await handleSource(req("GET"), sourceId, deps)).json()).source.url).toBe("https://youtu.be/x");
    const r = await handleSource(req("PATCH", { status: "transcribing", durationSec: 600 }), sourceId, deps);
    expect((await r.json()).source).toMatchObject({ status: "transcribing", durationSec: 600 });
    expect((await handleSource(req("PATCH", { status: "nope" }), sourceId, deps)).status).toBe(400);
    expect((await handleSource(req("GET"), "missing", deps)).status).toBe(404);
  });
});

describe("events", () => {
  it("adds events and rejects unknown sources", async () => {
    expect((await handleEvent(req("POST", { sourceId, level: "warn", message: "youtube: failed" }), deps)).status).toBe(200);
    expect((await handleEvent(req("POST", { sourceId: "missing", level: "info", message: "x" }), deps)).status).toBe(400);
    expect((await handleEvent(req("POST", { level: "loud", message: "x" }), deps)).status).toBe(400);
  });
});

describe("deepgram usage", () => {
  it("reserves against the server-side cap and releases", async () => {
    const call = async (action: string, seconds: number) => (await handleDeepgramUsage(req("POST", { action, seconds }), deps)).json();
    expect(await call("reserve", 500)).toEqual({ ok: true, usedSec: 500, capSec: 600 });
    expect((await call("reserve", 200)).ok).toBe(false);
    expect((await call("release", 500)).usedSec).toBe(0);
  });
});

describe("selection endpoints", () => {
  const clip = (rank: number, start: number) => ({
    rank,
    score: 70,
    scores: { hook: 7, standalone: 7, payoff: 7, emotion: 7, novelty: 7, quotability: 7 },
    startSec: start,
    endSec: start + 30,
    hookA: "Hook A",
    hookB: "Hook B",
    title: "T",
    captionTiktok: "a",
    captionInstagram: "b",
    captionYoutube: "c",
    hashtags: ["#x"],
    emphasisWords: ["money"],
    reason: "r",
    coldOpen: { start: start + 10, end: start + 13 },
    candidateId: "c1",
    source: "edit",
  });

  it("returns the campaign context with defaults", async () => {
    const r = await (await handleSourceContext(req("GET"), sourceId, deps)).json();
    expect(r.campaign.config.minLengthSec).toBe(20);
    expect(r.scoreWeights.hook).toBe(0.3);
    expect(r.fewShot).toEqual([]);
    expect((await handleSourceContext(req("GET"), "missing", deps)).status).toBe(404);
  });

  it("replaces candidate clips on retry and sets the initial edit", async () => {
    await handleCreateClips(req("POST", { clips: [clip(1, 0), clip(2, 100)] }), sourceId, deps);
    const r = await (await handleCreateClips(req("POST", { clips: [clip(1, 200)] }), sourceId, deps)).json();
    expect(r.clips).toHaveLength(1);
    const rows = sourceClips(db, sourceId);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.edit).toMatchObject({ trim: { start: 200, end: 230 }, coldOpen: { enabled: true, start: 210, end: 213 }, hookChoice: "A" });
    expect((await handleCreateClips(req("POST", { clips: [{ rank: 0 }] }), sourceId, deps)).status).toBe(400);
  });

  it("accumulates LLM usage", async () => {
    await handleLlmUsage(req("POST", { calls: 1, tokensIn: 1000, tokensOut: 200 }), deps);
    const r = await (await handleLlmUsage(req("POST", { calls: 2, tokensIn: 10, tokensOut: 5 }), deps)).json();
    expect(r.usage).toMatchObject({ llmCalls: 3, llmTokensIn: 1010, llmTokensOut: 205 });
  });
});

describe("final failure marks the source failed", () => {
  it("sets source status + error when attempts run out", async () => {
    const t = enqueueTask(db, { type: "SCOUT", sourceId, maxAttempts: 1 });
    claimTask(db, { workerId: "w", types: ["SCOUT"] });
    const r = await handleWorkerRequest("fail", req("POST", { workerId: "w", taskId: t.id, error: "boom" }), { db, token: TOKEN });
    expect((await r.json()).task.status).toBe("failed");
    const src = (await (await handleSource(req("GET"), sourceId, deps)).json()).source;
    expect(src).toMatchObject({ status: "failed", error: "boom" });
  });
});
