import { z } from "zod";
import type { CompleteBody, EnqueueTaskInput, EventLevel, Source, SourcePatch, Task, TaskClass, TaskType } from "@clip/shared";

/** Thin client for /api/worker/*. Workers never touch SQLite directly (SPEC §2). */
export class WorkerApi {
  constructor(
    private readonly baseUrl: string,
    private readonly token: string,
    readonly workerId: string,
  ) {}

  private async request<T>(method: "GET" | "POST" | "PATCH", route: string, body: object | undefined, schema: z.ZodType<T>): Promise<T> {
    const res = await fetch(new URL(`/api/worker/${route}`, this.baseUrl), {
      method,
      headers: { "content-type": "application/json", authorization: `Bearer ${this.token}` },
      body: body ? JSON.stringify(body) : undefined,
    });
    const json: unknown = await res.json().catch(() => ({}));
    if (!res.ok) throw new WorkerApiError(res.status, route, json);
    return schema.parse(json);
  }
  private post<T>(action: string, body: object, schema: z.ZodType<T>) {
    return this.request("POST", action, { workerId: this.workerId, ...body }, schema);
  }

  // ----- queue -----
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

  // ----- data -----
  getSource(id: string) {
    return this.request("GET", `sources/${encodeURIComponent(id)}`, undefined, z.object({ source: sourceSchema })).then((r) => r.source);
  }
  patchSource(id: string, patch: SourcePatch) {
    return this.request("PATCH", `sources/${encodeURIComponent(id)}`, patch, z.object({ source: sourceSchema })).then((r) => r.source);
  }
  event(e: { sourceId?: string | null; clipId?: string | null; level: EventLevel; message: string; data?: unknown }) {
    return this.request("POST", "events", e, z.object({ event: z.object({ id: z.string() }).passthrough() }));
  }
  deepgram(action: "reserve" | "release", seconds: number) {
    return this.request("POST", "usage/deepgram", { action, seconds }, z.object({ ok: z.boolean(), usedSec: z.number(), capSec: z.number() }));
  }
}

export class WorkerApiError extends Error {
  constructor(
    readonly status: number,
    route: string,
    readonly body: unknown,
  ) {
    super(`worker API ${route} failed with HTTP ${status}: ${JSON.stringify(body)}`);
  }
}

// Validate the fields the worker relies on; passthrough keeps the rest.
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

const sourceSchema = z
  .object({
    id: z.string(),
    kind: z.enum(["url", "upload"]),
    url: z.string().nullable(),
    title: z.string().nullable(),
    durationSec: z.number().nullable(),
    status: z.string(),
  })
  .passthrough() as unknown as z.ZodType<Source>;
