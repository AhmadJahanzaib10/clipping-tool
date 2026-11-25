import { beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { openDb, type Db } from "../db/client";
import { sources, tasks } from "../db/schema";
import { LEASE_MS, PRIORITY_USER, type TaskType } from "../constants";
import {
  allowedTypes,
  backoffMs,
  claimTask,
  completeTask,
  enqueueTask,
  failTask,
  heartbeatTask,
  QueueError,
  retryTask,
  taskCounts,
} from "./queue";

const T0 = new Date("2026-01-01T10:00:00.000Z");
const at = (ms: number) => new Date(T0.getTime() + ms);

let db: Db;

function addSource(id: string, createdAt: Date) {
  db.insert(sources)
    .values({ id, kind: "url", status: "queued", createdAt: createdAt.toISOString(), updatedAt: createdAt.toISOString() })
    .run();
}
function add(type: TaskType, opts: { sourceId?: string; priority?: number; at?: Date; maxAttempts?: number } = {}) {
  return enqueueTask(db, { type, sourceId: opts.sourceId, priority: opts.priority, maxAttempts: opts.maxAttempts }, opts.at ?? T0);
}
const claim = (workerId = "w1", now = T0, extra: { classes?: ("heavy" | "light")[]; types?: TaskType[] } = {}) =>
  claimTask(db, { workerId, ...extra }, now);

beforeEach(() => {
  db = openDb(":memory:").db;
});

describe("enqueue + claim basics", () => {
  it("returns null on an empty queue", () => {
    expect(claim()).toBeNull();
  });

  it("claims a task, sets lease, worker and attempt", () => {
    const t = add("SCOUT");
    const c = claim("w1", T0)!;
    expect(c.id).toBe(t.id);
    expect(c.status).toBe("running");
    expect(c.workerId).toBe("w1");
    expect(c.attempts).toBe(1);
    expect(c.leaseUntil).toBe(at(LEASE_MS).toISOString());
  });

  it("never hands the same task to two workers while the lease is valid", () => {
    add("SCOUT");
    expect(claim("w1")).not.toBeNull();
    expect(claim("w2", at(LEASE_MS - 1))).toBeNull();
  });

  it("does not queue a duplicate of a waiting task (same type, source, clip)", () => {
    addSource("s1", T0);
    const a = add("FETCH_SECTIONS", { sourceId: "s1" });
    const b = add("FETCH_SECTIONS", { sourceId: "s1" });
    expect(b.id).toBe(a.id);
    // A higher priority upgrades the waiting task instead.
    expect(add("FETCH_SECTIONS", { sourceId: "s1", priority: PRIORITY_USER }).priority).toBe(PRIORITY_USER);
    // Different clip, or once the first is running, a new task is fine.
    expect(enqueueTask(db, { type: "FETCH_SECTIONS", sourceId: "s1", clipId: null }).id).toBe(a.id);
    claim("w1");
    expect(add("FETCH_SECTIONS", { sourceId: "s1" }).id).not.toBe(a.id);
  });

  it("never runs two copies of the same stage for the same source/clip at once", () => {
    addSource("s1", T0);
    const first = add("FETCH_SECTIONS", { sourceId: "s1" });
    expect(claim("w1")!.id).toBe(first.id);
    const copy = add("FETCH_SECTIONS", { sourceId: "s1" }); // queued while the first runs
    expect(copy.id).not.toBe(first.id);
    expect(claim("w2")).toBeNull(); // the copy waits
    completeTask(db, { taskId: first.id, workerId: "w1" });
    expect(claim("w2")!.id).toBe(copy.id);
  });

  it("a crashed copy (expired lease) does not block the other", () => {
    addSource("s1", T0);
    const first = add("ANALYZE", { sourceId: "s1" });
    claim("w1", T0);
    add("ANALYZE", { sourceId: "s1" });
    // After the lease expires, the claim can take either task; nothing stays blocked.
    expect(claim("w2", at(LEASE_MS + 1))).not.toBeNull();
    expect(first.id).toBeTruthy();
  });

  it("validates input", () => {
    expect(() => enqueueTask(db, { type: "NOPE" as TaskType })).toThrow();
    expect(() => claimTask(db, { workerId: "" })).toThrow();
  });
});

describe("claim order", () => {
  it("priority beats everything (user-triggered COMPOSE jumps the queue)", () => {
    addSource("s1", T0);
    add("DELIVER", { sourceId: "s1" });
    const user = add("COMPOSE", { sourceId: "s1", priority: PRIORITY_USER, at: at(5000) });
    expect(claim()!.id).toBe(user.id);
  });

  it("oldest source first, then latest stage within the source", () => {
    addSource("old", T0);
    addSource("new", at(60_000));
    const newIngest = add("INGEST", { sourceId: "new", at: at(60_000) });
    const oldScout = add("SCOUT", { sourceId: "old", at: at(70_000) });
    const oldRender = add("RENDER_BASE", { sourceId: "old", at: at(80_000) });
    const oldPrep = add("PREP_CLIP", { sourceId: "old", at: at(90_000) });

    const order = [claim("a")!, claim("b")!, claim("c")!, claim("d")!].map((t) => t.id);
    expect(order).toEqual([oldRender.id, oldPrep.id, oldScout.id, newIngest.id]);
  });

  it("same source and stage → oldest task first", () => {
    addSource("s1", T0);
    const first = add("RENDER_BASE", { sourceId: "s1", at: at(1) });
    add("RENDER_BASE", { sourceId: "s1", at: at(2) });
    expect(claim()!.id).toBe(first.id);
  });

  it("a light-only worker can take INGEST of the next source while heavy work is running", () => {
    addSource("s1", T0);
    addSource("s2", at(1000));
    const render = add("RENDER_BASE", { sourceId: "s1" });
    const ingest = add("INGEST", { sourceId: "s2", at: at(1000) });
    expect(claim("w", T0, { classes: ["heavy"] })!.id).toBe(render.id);
    expect(claim("w", T0, { classes: ["light"] })!.id).toBe(ingest.id);
  });

  it("respects the types filter", () => {
    add("ANALYZE");
    const scout = add("SCOUT");
    expect(claim("w", T0, { types: ["SCOUT", "EDIT"] })!.id).toBe(scout.id);
    expect(claim("w", T0, { types: ["SCOUT", "EDIT"] })).toBeNull();
  });

  it("allowedTypes splits heavy and light", () => {
    expect(allowedTypes({ classes: ["heavy"] }).sort()).toEqual(["ANALYZE", "PREP_CLIP", "RENDER_BASE", "TRANSCRIBE"]);
    expect(allowedTypes({ classes: ["light"] })).not.toContain("RENDER_BASE");
    expect(allowedTypes({ classes: ["light"], types: ["ANALYZE"] })).toEqual([]);
  });
});

describe("leases and heartbeat", () => {
  it("heartbeat extends the lease", () => {
    const t = add("ANALYZE");
    claim("w1", T0);
    const hb = heartbeatTask(db, { taskId: t.id, workerId: "w1" }, at(5 * 60_000));
    expect(hb.leaseUntil).toBe(at(5 * 60_000 + LEASE_MS).toISOString());
    expect(claim("w2", at(LEASE_MS + 1000))).toBeNull();
  });

  it("an expired lease can be reclaimed by another worker, counting an attempt", () => {
    const t = add("ANALYZE");
    claim("w1", T0);
    const re = claim("w2", at(LEASE_MS + 1))!;
    expect(re.id).toBe(t.id);
    expect(re.workerId).toBe("w2");
    expect(re.attempts).toBe(2);
  });

  it("the old worker loses the task after it was reclaimed", () => {
    const t = add("ANALYZE");
    claim("w1", T0);
    claim("w2", at(LEASE_MS + 1));
    expect(() => heartbeatTask(db, { taskId: t.id, workerId: "w1" }, at(LEASE_MS + 2))).toThrowError(QueueError);
    expect(() => completeTask(db, { taskId: t.id, workerId: "w1" }, at(LEASE_MS + 2))).toThrow(/not running under/);
  });

  it("unknown task → not_found", () => {
    try {
      heartbeatTask(db, { taskId: "missing", workerId: "w1" });
      expect.unreachable();
    } catch (e) {
      expect((e as QueueError).code).toBe("not_found");
    }
  });

  it("an expired lease on the final attempt is marked failed, not reclaimed", () => {
    const t = add("ANALYZE", { maxAttempts: 1 });
    claim("w1", T0);
    expect(claim("w2", at(LEASE_MS + 1))).toBeNull();
    const row = db.select().from(tasks).where(eq(tasks.id, t.id)).get()!;
    expect(row.status).toBe("failed");
    expect(row.error).toMatch(/lease expired/);
  });
});

describe("complete", () => {
  it("marks done and enqueues follow-ups atomically", () => {
    addSource("s1", T0);
    const t = add("INGEST", { sourceId: "s1" });
    claim("w1");
    const { task, next } = completeTask(db, {
      taskId: t.id,
      workerId: "w1",
      next: [{ type: "TRANSCRIBE", sourceId: "s1", payload: { from: "ingest" } }],
    });
    expect(task.status).toBe("done");
    expect(task.leaseUntil).toBeNull();
    expect(next).toHaveLength(1);
    expect(next[0]!.payload).toEqual({ from: "ingest" });
    expect(claim("w1")!.type).toBe("TRANSCRIBE");
  });

  it("rolls back the completion if a follow-up is invalid", () => {
    const t = add("INGEST");
    claim("w1");
    expect(() =>
      completeTask(db, { taskId: t.id, workerId: "w1", next: [{ type: "BOGUS" as TaskType }] }),
    ).toThrow();
    expect(db.select().from(tasks).where(eq(tasks.id, t.id)).get()!.status).toBe("running");
  });
});

describe("fail, retry and backoff", () => {
  it("backoff is 30 s then 2 min", () => {
    expect(backoffMs(1)).toBe(30_000);
    expect(backoffMs(2)).toBe(120_000);
    expect(backoffMs(5)).toBe(120_000);
  });

  it("retryable failures go back to pending with backoff, then fail after 3 attempts", () => {
    const t = add("SCOUT");

    claim("w1", T0);
    let f = failTask(db, { taskId: t.id, workerId: "w1", error: "boom 1" }, T0);
    expect(f.status).toBe("pending");
    expect(f.runAfter).toBe(at(30_000).toISOString());
    expect(claim("w1", at(29_999))).toBeNull();

    expect(claim("w1", at(30_000))!.attempts).toBe(2);
    f = failTask(db, { taskId: t.id, workerId: "w1", error: "boom 2" }, at(30_000));
    expect(f.runAfter).toBe(at(30_000 + 120_000).toISOString());

    expect(claim("w1", at(150_000))!.attempts).toBe(3);
    f = failTask(db, { taskId: t.id, workerId: "w1", error: "boom 3" }, at(150_000));
    expect(f.status).toBe("failed");
    expect(f.error).toBe("boom 3");
    expect(claim("w1", at(10 * 60_000 * 60))).toBeNull();
  });

  it("non-retryable failure fails immediately", () => {
    const t = add("EDIT");
    claim("w1");
    expect(failTask(db, { taskId: t.id, workerId: "w1", error: "bad input", retryable: false }).status).toBe("failed");
  });

  it("release hands the task back without counting the attempt", () => {
    const t = add("RENDER_BASE");
    claim("w1");
    const r = failTask(db, { taskId: t.id, workerId: "w1", release: true });
    expect(r.status).toBe("pending");
    expect(r.attempts).toBe(0);
    expect(r.workerId).toBeNull();
    expect(claim("w2")!.id).toBe(t.id);
  });

  it("a worker cannot fail a task it does not own", () => {
    const t = add("SCOUT");
    claim("w1");
    expect(() => failTask(db, { taskId: t.id, workerId: "w2", error: "x" })).toThrow(/not running under/);
  });

  it("manual retry resets a failed task", () => {
    const t = add("EDIT");
    claim("w1");
    failTask(db, { taskId: t.id, workerId: "w1", error: "x", retryable: false });
    const r = retryTask(db, t.id);
    expect(r.status).toBe("pending");
    expect(r.attempts).toBe(0);
    expect(r.error).toBeNull();
    expect(() => retryTask(db, t.id)).toThrow(QueueError);
  });

  it("taskCounts reports per status", () => {
    add("SCOUT");
    const t = add("EDIT");
    claim("w1", T0, { types: ["EDIT"] });
    completeTask(db, { taskId: t.id, workerId: "w1" });
    expect(taskCounts(db)).toEqual({ pending: 1, running: 0, done: 1, failed: 0 });
  });
});
