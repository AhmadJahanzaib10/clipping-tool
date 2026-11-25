import { and, asc, desc, eq, inArray, isNull, lt, lte, or, sql } from "drizzle-orm";
import { nanoid } from "nanoid";
import {
  DEFAULT_MAX_ATTEMPTS,
  LEASE_MS,
  RETRY_BACKOFF_MS,
  STAGE_RANK,
  TASK_TYPES,
  taskClass,
  type TaskStatus,
  type TaskType,
} from "../constants";
import type { Db } from "../db/client";
import { sources, tasks, type Task } from "../db/schema";
import {
  claimBodySchema,
  completeBodySchema,
  enqueueTaskSchema,
  failBodySchema,
  heartbeatBodySchema,
  type ClaimBody,
  type CompleteBody,
  type EnqueueTaskInput,
  type FailBody,
  type HeartbeatBody,
} from "../schemas/worker";

/**
 * SQLite-backed task queue with leases (SPEC §6 tasks, §12).
 * All functions are synchronous (better-sqlite3); mutations run in IMMEDIATE transactions so a claim is atomic
 * even if several processes share the database file.
 */

export type QueueErrorCode = "not_found" | "lease_lost";
export class QueueError extends Error {
  constructor(
    public readonly code: QueueErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "QueueError";
  }
}

type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

const iso = (d: Date) => d.toISOString();
const addMs = (d: Date, ms: number) => new Date(d.getTime() + ms);

/** SQL expression: pipeline position of tasks.type (higher = later stage). */
const stageRankSql = sql`case ${tasks.type} ${sql.join(
  TASK_TYPES.map((t) => sql`when ${t} then ${STAGE_RANK[t]}`),
  sql` `,
)} else 0 end`;

function insertTask(tx: Db | Tx, input: EnqueueTaskInput, now: Date): Task {
  const t = enqueueTaskSchema.parse(input);
  const ts = iso(now);
  // The same stage for the same source/clip already waiting (e.g. a stage re-run twice): don't queue
  // a duplicate run, just make sure the waiting one has at least this priority.
  const waiting = tx
    .select()
    .from(tasks)
    .where(
      and(
        eq(tasks.type, t.type),
        eq(tasks.status, "pending"),
        t.sourceId ? eq(tasks.sourceId, t.sourceId) : isNull(tasks.sourceId),
        t.clipId ? eq(tasks.clipId, t.clipId) : isNull(tasks.clipId),
      ),
    )
    .get();
  if (waiting) {
    if (t.priority > waiting.priority) {
      return tx.update(tasks).set({ priority: t.priority, updatedAt: ts }).where(eq(tasks.id, waiting.id)).returning().get()!;
    }
    return waiting;
  }
  return tx
    .insert(tasks)
    .values({
      id: nanoid(),
      type: t.type,
      sourceId: t.sourceId ?? null,
      clipId: t.clipId ?? null,
      payload: t.payload,
      priority: t.priority,
      status: "pending",
      attempts: 0,
      maxAttempts: t.maxAttempts ?? DEFAULT_MAX_ATTEMPTS,
      createdAt: ts,
      updatedAt: ts,
    })
    .returning()
    .get();
}

export function enqueueTask(db: Db, input: EnqueueTaskInput, now: Date = new Date()): Task {
  return insertTask(db, input, now);
}

/** Types a worker may receive, from its requested classes/types. */
export function allowedTypes(body: Pick<ClaimBody, "classes" | "types">): TaskType[] {
  const classes = body.classes ?? ["heavy", "light"];
  const base = body.types ?? [...TASK_TYPES];
  return base.filter((t) => classes.includes(taskClass(t)));
}

/**
 * Atomically claim the next task.
 * Claimable: pending (past its backoff) or running with an expired lease (crashed worker).
 * Order: priority desc → oldest source first → latest stage first → oldest task.
 * Expired leases that already used every attempt are marked failed instead.
 */
export function claimTask(db: Db, input: ClaimBody, now: Date = new Date()): Task | null {
  const body = claimBodySchema.parse(input);
  const types = allowedTypes(body);
  if (types.length === 0) return null;
  const nowIso = iso(now);

  return db.transaction(
    (tx) => {
      tx.update(tasks)
        .set({ status: "failed", error: "lease expired on final attempt", workerId: null, leaseUntil: null, updatedAt: nowIso })
        .where(
          and(eq(tasks.status, "running"), lt(tasks.leaseUntil, nowIso), sql`${tasks.attempts} >= ${tasks.maxAttempts}`),
        )
        .run();

      const claimable = or(
        and(eq(tasks.status, "pending"), or(isNull(tasks.runAfter), lte(tasks.runAfter, nowIso))),
        and(eq(tasks.status, "running"), lt(tasks.leaseUntil, nowIso)),
      );
      // Never run two copies of the same stage for the same source/clip at once (they would write the
      // same files: on Windows the second rename fails). The copy waits until the first one finishes.
      const busy = sql`exists (select 1 from ${tasks} as r where r.status = 'running' and r.lease_until >= ${nowIso}
        and r.type = ${tasks.type} and r.id <> ${tasks.id}
        and coalesce(r.source_id, '') = coalesce(${tasks.sourceId}, '') and coalesce(r.clip_id, '') = coalesce(${tasks.clipId}, ''))`;

      const next = tx
        .select({ id: tasks.id })
        .from(tasks)
        .leftJoin(sources, eq(tasks.sourceId, sources.id))
        .where(and(claimable, inArray(tasks.type, types), sql`not ${busy}`))
        .orderBy(
          desc(tasks.priority),
          asc(sql`coalesce(${sources.createdAt}, ${tasks.createdAt})`),
          desc(stageRankSql),
          asc(tasks.createdAt),
          asc(tasks.id),
        )
        .limit(1)
        .get();
      if (!next) return null;

      return (
        tx
          .update(tasks)
          .set({
            status: "running",
            workerId: body.workerId,
            leaseUntil: iso(addMs(now, LEASE_MS)),
            attempts: sql`${tasks.attempts} + 1`,
            runAfter: null,
            updatedAt: nowIso,
          })
          .where(eq(tasks.id, next.id))
          .returning()
          .get() ?? null
      );
    },
    { behavior: "immediate" },
  );
}

/** Update a running task owned by `workerId`; throws not_found / lease_lost when it isn't. */
function updateOwned(tx: Db | Tx, taskId: string, workerId: string, set: Partial<typeof tasks.$inferInsert>): Task {
  const row = tx
    .update(tasks)
    .set(set)
    .where(and(eq(tasks.id, taskId), eq(tasks.workerId, workerId), eq(tasks.status, "running")))
    .returning()
    .get();
  if (row) return row;
  const exists = tx.select({ id: tasks.id }).from(tasks).where(eq(tasks.id, taskId)).get();
  if (!exists) throw new QueueError("not_found", `task ${taskId} not found`);
  throw new QueueError("lease_lost", `task ${taskId} is not running under worker ${workerId}`);
}

/** Extend the lease. Succeeds even if the lease just lapsed, as long as nobody else reclaimed the task. */
export function heartbeatTask(db: Db, input: HeartbeatBody, now: Date = new Date()): Task {
  const body = heartbeatBodySchema.parse(input);
  return db.transaction(
    (tx) => updateOwned(tx, body.taskId, body.workerId, { leaseUntil: iso(addMs(now, LEASE_MS)), updatedAt: iso(now) }),
    { behavior: "immediate" },
  );
}

/** Mark done and enqueue follow-up tasks in the same transaction. */
export function completeTask(db: Db, input: CompleteBody, now: Date = new Date()): { task: Task; next: Task[] } {
  const body = completeBodySchema.parse(input);
  return db.transaction(
    (tx) => {
      const task = updateOwned(tx, body.taskId, body.workerId, {
        status: "done",
        leaseUntil: null,
        error: null,
        updatedAt: iso(now),
      });
      const next = (body.next ?? []).map((n) => insertTask(tx, n, now));
      return { task, next };
    },
    { behavior: "immediate" },
  );
}

export function backoffMs(attempts: number): number {
  const i = Math.min(Math.max(attempts, 1), RETRY_BACKOFF_MS.length) - 1;
  return RETRY_BACKOFF_MS[i]!;
}

/**
 * Report a failure. Retryable failures go back to pending with backoff (30 s, then 2 min) until maxAttempts;
 * `release` hands the task back immediately without counting the attempt (worker shutdown).
 */
export function failTask(db: Db, input: FailBody, now: Date = new Date()): Task {
  const body = failBodySchema.parse(input);
  return db.transaction(
    (tx) => {
      const current = tx.select().from(tasks).where(eq(tasks.id, body.taskId)).get();
      if (!current) throw new QueueError("not_found", `task ${body.taskId} not found`);
      const base = { workerId: null, leaseUntil: null, updatedAt: iso(now) };

      if (body.release) {
        return updateOwned(tx, body.taskId, body.workerId, {
          ...base,
          status: "pending",
          attempts: Math.max(0, current.attempts - 1),
          runAfter: null,
        });
      }
      const retry = body.retryable && current.attempts < current.maxAttempts;
      return updateOwned(tx, body.taskId, body.workerId, {
        ...base,
        status: retry ? "pending" : "failed",
        error: body.error,
        runAfter: retry ? iso(addMs(now, backoffMs(current.attempts))) : null,
      });
    },
    { behavior: "immediate" },
  );
}

/** Manual retry of a failed task (Overview "retry" button). */
export function retryTask(db: Db, taskId: string, now: Date = new Date()): Task {
  const row = db
    .update(tasks)
    .set({ status: "pending", attempts: 0, error: null, runAfter: null, workerId: null, leaseUntil: null, updatedAt: iso(now) })
    .where(and(eq(tasks.id, taskId), eq(tasks.status, "failed")))
    .returning()
    .get();
  if (!row) throw new QueueError("not_found", `failed task ${taskId} not found`);
  return row;
}

export function taskCounts(db: Db): Record<TaskStatus, number> {
  const rows = db
    .select({ status: tasks.status, n: sql<number>`count(*)` })
    .from(tasks)
    .groupBy(tasks.status)
    .all();
  const out: Record<TaskStatus, number> = { pending: 0, running: 0, done: 0, failed: 0 };
  for (const r of rows) out[r.status] = Number(r.n);
  return out;
}
