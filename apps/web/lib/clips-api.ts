import { z } from "zod";
import { ReviewError } from "@clip/shared";

/** Shared helpers for the /api/clips/* routes. */
export async function readJson<T>(req: Request, schema: z.ZodType<T>): Promise<{ data: T } | { res: Response }> {
  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return { res: Response.json({ error: "invalid JSON body" }, { status: 400 }) };
  }
  const p = schema.safeParse(raw);
  return p.success ? { data: p.data } : { res: Response.json({ error: "invalid body", issues: z.treeifyError(p.error) }, { status: 400 }) };
}

/** ReviewError → its HTTP status; anything else is rethrown. */
export function reviewErrorResponse(e: unknown): Response {
  if (e instanceof ReviewError) return Response.json({ error: e.message }, { status: e.status });
  throw e;
}

export type IdParams = { params: Promise<{ id: string }> };
