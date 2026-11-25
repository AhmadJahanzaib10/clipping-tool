import { z } from "zod";
import type { CompleteBody, EnqueueTaskInput, Task, TaskClass, TaskType } from "@clip/shared";

/** Thin client for /api/worker/*. Workers never touch SQLite directly (SPEC §2). */
export class WorkerApi {
  constructor(
    private readonly baseUrl: string,
    private readonly token: string,
    readonly workerId: string,
  ) {}

  private async post<T>(action: string, body: object, schema: z.ZodType<T>): Promise<T> {
    const res = await fetch(new URL(`/api/worker/${action}`, this.baseUrl), {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${this.token}` },
      body: JSON.stringify({ workerId: this.workerId, ...body }),
    });
    const json: unknown = await res.json().catch(() => ({}));
    if (!res.ok) throw new WorkerApiError(res.status, action, json);
    return schema.parse(json);
  }

  claim(classes: TaskClass[], types: TaskType[]) {
    return this.post("claim", { classes, types }, z.object({ task: taskSchema.nullable() })).then((r) => r.task);
  }
  heartbeat(taskId: string) {
    return this.post("heartbeat", { taskId }, z.object({ ok: z.literal(true), leaseUntil: z.string().nullable() }));
  }
  complete(taskId: string, next?: EnqueueTaskInput[]) {
    const body: Omit<CompleteBody, "workerId"> = { taskId, next };
    return this.post("complete", body, z.object({ task: taskSchema }));
  }
  fail(taskId: string, error: string, opts: { retryable?: boolean; release?: boolean } = {}) {
    return this.post("fail", { taskId, error, ...opts }, z.object({ task: taskSchema }));
  }
}

export class WorkerApiError extends Error {
  constructor(
    readonly status: number,
    action: string,
    readonly body: unknown,
  ) {
    super(`worker API ${action} failed with HTTP ${status}: ${JSON.stringify(body)}`);
  }
}

// Validates the fields the worker relies on; passthrough keeps the rest.
const taskSchema = z
  .object({
    id: z.string(),
    type: z.string(),
    sourceId: z.string().nullable(),
    clipId: z.string().nullable(),
    payload: z.record(z.string(), z.unknown()),
    attempts: z.number(),
  })
  .passthrough() as unknown as z.ZodType<Task>;
