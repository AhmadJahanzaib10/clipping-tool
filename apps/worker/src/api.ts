import { z } from "zod";
import { campaignConfigSchema, clipEditSchema, scoreWeightsSchema, type Clip, type ClipInput, type ClipPatch, type CompleteBody, type EnqueueTaskInput, type EventLevel, type Source, type SourcePatch, type Task, type TaskClass, type TaskType } from "@clip/shared";

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
  context(sourceId: string) {
    return this.request("GET", `sources/${encodeURIComponent(sourceId)}/context`, undefined, sourceContextSchema);
  }
  createClips(sourceId: string, clips: ClipInput[]) {
    return this.request("POST", `sources/${encodeURIComponent(sourceId)}/clips`, { clips }, z.object({ clips: z.array(z.object({ id: z.string(), rank: z.number().nullable() })) }));
  }
  sourceClips(sourceId: string) {
    return this.request("GET", `sources/${encodeURIComponent(sourceId)}/clips`, undefined, z.object({ clips: z.array(clipSchema) })).then((r) => r.clips);
  }
  clip(clipId: string) {
    return this.request("GET", `clips/${encodeURIComponent(clipId)}`, undefined, clipContextSchema);
  }
  patchClip(clipId: string, patch: ClipPatch) {
    return this.request("PATCH", `clips/${encodeURIComponent(clipId)}`, patch, z.object({ clip: clipSchema })).then((r) => r.clip);
  }
  llmUsage(u: { calls: number; tokensIn: number; tokensOut: number }) {
    return this.request("POST", "usage/llm", u, z.object({ ok: z.literal(true) }).passthrough());
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

const sourceContextSchema = z.object({
  sourceId: z.string(),
  campaign: z.object({ id: z.string(), name: z.string(), niche: z.string(), config: campaignConfigSchema }),
  scoreWeights: scoreWeightsSchema,
  fewShot: z.array(z.object({ hook: z.string(), firstLine: z.string(), lengthSec: z.number(), views: z.number() })),
});

const clipSchema = z
  .object({
    id: z.string(),
    sourceId: z.string(),
    rank: z.number().nullable(),
    startSec: z.number(),
    endSec: z.number(),
    status: z.string(),
    baseVersion: z.number(),
    edit: clipEditSchema.nullable(),
  })
  .passthrough() as unknown as z.ZodType<Clip>;

const clipContextSchema = z.object({
  clip: clipSchema,
  source: z.object({
    id: z.string(),
    kind: z.enum(["url", "upload"]),
    url: z.string().nullable(),
    durationSec: z.number().nullable(),
    transcriptQuality: z.enum(["rough", "precise"]).nullable(),
  }),
  campaign: z.object({ id: z.string(), name: z.string(), niche: z.string(), config: campaignConfigSchema }),
});
