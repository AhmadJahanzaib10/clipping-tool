import { beforeEach, describe, expect, it } from "vitest";
import { enqueueTask, LEASE_MS, type Db } from "@clip/shared";
import { openDb } from "@clip/shared/db";
import { handleWorkerRequest, type WorkerAction } from "./worker-api";

const TOKEN = "test-token";
const T0 = new Date("2026-01-01T10:00:00.000Z");
let db: Db;
let now: Date;

const call = (action: WorkerAction, body: unknown, token: string | null = TOKEN) =>
  handleWorkerRequest(
    action,
    new Request(`http://localhost/api/worker/${action}`, {
      method: "POST",
      headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
      body: typeof body === "string" ? body : JSON.stringify(body),
    }),
    { db, token: TOKEN, now: () => now },
  );

beforeEach(() => {
  db = openDb(":memory:").db;
  now = T0;
});

describe("worker API", () => {
  it("rejects missing or wrong token with 401", async () => {
    expect((await call("claim", { workerId: "w1" }, null)).status).toBe(401);
    expect((await call("claim", { workerId: "w1" }, "nope")).status).toBe(401);
  });

  it("rejects malformed JSON and invalid bodies with 400", async () => {
    expect((await call("claim", "{not json")).status).toBe(400);
    const r = await call("claim", { workerId: "w1", classes: ["medium"] });
    expect(r.status).toBe(400);
    expect((await r.json()).error).toBe("invalid body");
  });

  it("claim returns null when the queue is empty", async () => {
    const r = await call("claim", { workerId: "w1" });
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ task: null });
  });

  it("claim → heartbeat → complete with follow-up", async () => {
    const t = enqueueTask(db, { type: "INGEST" }, T0);
    const { task } = await (await call("claim", { workerId: "w1" })).json();
    expect(task.id).toBe(t.id);
    expect(task.status).toBe("running");

    now = new Date(T0.getTime() + 60_000);
    const hb = await (await call("heartbeat", { workerId: "w1", taskId: t.id })).json();
    expect(hb).toEqual({ ok: true, leaseUntil: new Date(now.getTime() + LEASE_MS).toISOString() });

    const done = await (await call("complete", { workerId: "w1", taskId: t.id, next: [{ type: "TRANSCRIBE" }] })).json();
    expect(done.task.status).toBe("done");
    expect(done.next[0].type).toBe("TRANSCRIBE");
  });

  it("heartbeat on someone else's task → 409, unknown task → 404", async () => {
    const t = enqueueTask(db, { type: "INGEST" }, T0);
    await call("claim", { workerId: "w1" });
    expect((await call("heartbeat", { workerId: "w2", taskId: t.id })).status).toBe(409);
    expect((await call("heartbeat", { workerId: "w1", taskId: "missing" })).status).toBe(404);
  });

  it("fail schedules a retry", async () => {
    const t = enqueueTask(db, { type: "SCOUT" }, T0);
    await call("claim", { workerId: "w1" });
    const { task } = await (await call("fail", { workerId: "w1", taskId: t.id, error: "LLM timeout" })).json();
    expect(task.status).toBe("pending");
    expect(task.error).toBe("LLM timeout");
    expect(task.runAfter).toBe(new Date(T0.getTime() + 30_000).toISOString());
  });
});
