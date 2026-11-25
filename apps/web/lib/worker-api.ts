import { timingSafeEqual } from "node:crypto";
import {
  claimBodySchema,
  claimTask,
  completeBodySchema,
  completeTask,
  failBodySchema,
  failTask,
  heartbeatBodySchema,
  heartbeatTask,
  QueueError,
  type Db,
} from "@clip/shared";
import { z } from "zod";

export const WORKER_ACTIONS = ["claim", "heartbeat", "complete", "fail"] as const;
export type WorkerAction = (typeof WORKER_ACTIONS)[number];

export interface WorkerApiDeps {
  db: Db;
  token: string;
  now?: () => Date;
}

const json = (body: unknown, status = 200) => Response.json(body, { status });

function authorized(req: Request, token: string): boolean {
  const header = req.headers.get("authorization") ?? "";
  const m = /^Bearer\s+(.+)$/i.exec(header);
  if (!m) return false;
  const a = Buffer.from(m[1]!.trim());
  const b = Buffer.from(token);
  return a.length === b.length && timingSafeEqual(a, b);
}

const handlers = {
  claim: { schema: claimBodySchema, run: (db: Db, body: z.infer<typeof claimBodySchema>, now: Date) => ({ task: claimTask(db, body, now) }) },
  heartbeat: {
    schema: heartbeatBodySchema,
    run: (db: Db, body: z.infer<typeof heartbeatBodySchema>, now: Date) => {
      const t = heartbeatTask(db, body, now);
      return { ok: true, leaseUntil: t.leaseUntil };
    },
  },
  complete: { schema: completeBodySchema, run: (db: Db, body: z.infer<typeof completeBodySchema>, now: Date) => completeTask(db, body, now) },
  fail: { schema: failBodySchema, run: (db: Db, body: z.infer<typeof failBodySchema>, now: Date) => ({ task: failTask(db, body, now) }) },
} as const;

/** Framework-agnostic handler for POST /api/worker/{action}. Bearer WORKER_TOKEN auth, zod-validated bodies. */
export async function handleWorkerRequest(action: WorkerAction, req: Request, deps: WorkerApiDeps): Promise<Response> {
  if (!authorized(req, deps.token)) return json({ error: "unauthorized" }, 401);

  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return json({ error: "invalid JSON body" }, 400);
  }

  const h = handlers[action];
  const parsed = h.schema.safeParse(raw);
  if (!parsed.success) return json({ error: "invalid body", issues: z.treeifyError(parsed.error) }, 400);

  try {
    // Each handler's schema matches its run() argument; TS can't correlate the union, hence the cast.
    const result = (h.run as (db: Db, body: unknown, now: Date) => unknown)(deps.db, parsed.data, deps.now?.() ?? new Date());
    return json(result);
  } catch (e) {
    if (e instanceof QueueError) return json({ error: e.code, message: e.message }, e.code === "not_found" ? 404 : 409);
    if (e instanceof z.ZodError) return json({ error: "invalid body", issues: z.treeifyError(e) }, 400);
    console.error(`[worker-api] ${action} failed`, e);
    return json({ error: "internal error" }, 500);
  }
}
