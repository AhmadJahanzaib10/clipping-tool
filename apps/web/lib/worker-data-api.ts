import { eq } from "drizzle-orm";
import { z } from "zod";
import {
  addEvent,
  addLlmUsage,
  clipPatchSchema,
  getClipContext,
  sourceClips,
  updateClip,
  createClipsSchema,
  EVENT_LEVELS,
  getSourceContext,
  getUsage,
  llmUsageSchema,
  releaseDeepgram,
  replaceSourceClips,
  reserveDeepgram,
  sourcePatchSchema,
  updateSource,
  type Db,
} from "@clip/shared";
import { schema } from "@clip/shared/db";
import { authorized, json } from "./worker-api";

/**
 * Worker-facing data endpoints (SPEC §2: workers talk to the API, never to SQLite).
 *   GET   /api/worker/sources/:id
 *   PATCH /api/worker/sources/:id          body: SourcePatch
 *   POST  /api/worker/events                body: { sourceId?, clipId?, level, message, data? }
 *   POST  /api/worker/usage/deepgram        body: { action: "reserve" | "release", seconds }
 *   GET   /api/worker/sources/:id/context  campaign config, score weights, few-shot examples
 *   POST  /api/worker/sources/:id/clips    body: { clips: ClipInput[] } (replaces candidate clips)
 *   POST  /api/worker/usage/llm            body: { calls, tokensIn, tokensOut }
 *   GET   /api/worker/sources/:id/clips    the source's clips (ranked)
 *   GET   /api/worker/clips/:id            clip + source + campaign
 *   PATCH /api/worker/clips/:id            body: { edit?, status?, baseVersion?, basePath? }
 */

export interface DataApiDeps {
  db: Db;
  token: string;
  deepgramCapSec: number;
  now?: () => Date;
}

async function body<T>(req: Request, s: z.ZodType<T>): Promise<{ data: T } | { res: Response }> {
  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return { res: json({ error: "invalid JSON body" }, 400) };
  }
  const p = s.safeParse(raw);
  return p.success ? { data: p.data } : { res: json({ error: "invalid body", issues: z.treeifyError(p.error) }, 400) };
}

export async function handleSource(req: Request, id: string, deps: DataApiDeps): Promise<Response> {
  if (!authorized(req, deps.token)) return json({ error: "unauthorized" }, 401);
  if (req.method === "GET") {
    const src = deps.db.select().from(schema.sources).where(eq(schema.sources.id, id)).get();
    return src ? json({ source: src }) : json({ error: "not_found" }, 404);
  }
  const b = await body(req, sourcePatchSchema);
  if ("res" in b) return b.res;
  const src = updateSource(deps.db, id, b.data, deps.now?.());
  return src ? json({ source: src }) : json({ error: "not_found" }, 404);
}

export const eventBodySchema = z.object({
  sourceId: z.string().nullish(),
  clipId: z.string().nullish(),
  level: z.enum(EVENT_LEVELS),
  message: z.string().min(1).max(2000),
  data: z.unknown().optional(),
});

export async function handleEvent(req: Request, deps: DataApiDeps): Promise<Response> {
  if (!authorized(req, deps.token)) return json({ error: "unauthorized" }, 401);
  const b = await body(req, eventBodySchema);
  if ("res" in b) return b.res;
  try {
    return json({ event: addEvent(deps.db, b.data, deps.now?.()) });
  } catch {
    return json({ error: "unknown source or clip" }, 400);
  }
}

export const deepgramBodySchema = z.object({ action: z.enum(["reserve", "release"]), seconds: z.number().positive().max(24 * 3600) });

export async function handleDeepgramUsage(req: Request, deps: DataApiDeps): Promise<Response> {
  if (!authorized(req, deps.token)) return json({ error: "unauthorized" }, 401);
  const b = await body(req, deepgramBodySchema);
  if ("res" in b) return b.res;
  const now = deps.now?.() ?? new Date();
  if (b.data.action === "reserve") {
    const ok = reserveDeepgram(deps.db, b.data.seconds, deps.deepgramCapSec, now);
    return json({ ok, usedSec: getUsage(deps.db, now).deepgramSeconds, capSec: deps.deepgramCapSec });
  }
  releaseDeepgram(deps.db, b.data.seconds, now);
  return json({ ok: true, usedSec: getUsage(deps.db, now).deepgramSeconds, capSec: deps.deepgramCapSec });
}

export async function handleSourceContext(req: Request, id: string, deps: DataApiDeps): Promise<Response> {
  if (!authorized(req, deps.token)) return json({ error: "unauthorized" }, 401);
  const ctx = getSourceContext(deps.db, id);
  return ctx ? json(ctx) : json({ error: "not_found" }, 404);
}

export async function handleCreateClips(req: Request, id: string, deps: DataApiDeps): Promise<Response> {
  if (!authorized(req, deps.token)) return json({ error: "unauthorized" }, 401);
  const b = await body(req, createClipsSchema);
  if ("res" in b) return b.res;
  try {
    const clips = replaceSourceClips(deps.db, id, b.data.clips, deps.now?.());
    return json({ clips: clips.map((c) => ({ id: c.id, rank: c.rank })) });
  } catch (e) {
    return json({ error: e instanceof Error ? e.message : String(e) }, 404);
  }
}

export async function handleLlmUsage(req: Request, deps: DataApiDeps): Promise<Response> {
  if (!authorized(req, deps.token)) return json({ error: "unauthorized" }, 401);
  const b = await body(req, llmUsageSchema);
  if ("res" in b) return b.res;
  addLlmUsage(deps.db, b.data, deps.now?.());
  return json({ ok: true, usage: getUsage(deps.db, deps.now?.()) });
}

export async function handleSourceClips(req: Request, id: string, deps: DataApiDeps): Promise<Response> {
  if (!authorized(req, deps.token)) return json({ error: "unauthorized" }, 401);
  return json({ clips: sourceClips(deps.db, id) });
}

export async function handleClip(req: Request, id: string, deps: DataApiDeps): Promise<Response> {
  if (!authorized(req, deps.token)) return json({ error: "unauthorized" }, 401);
  if (req.method === "GET") {
    const ctx = getClipContext(deps.db, id);
    return ctx ? json(ctx) : json({ error: "not_found" }, 404);
  }
  const b = await body(req, clipPatchSchema);
  if ("res" in b) return b.res;
  const clip = updateClip(deps.db, id, b.data, deps.now?.());
  return clip ? json({ clip }) : json({ error: "not_found" }, 404);
}
