import { cleanupState } from "@clip/shared";
import { authorized, json } from "@/lib/worker-api";
import { dataDeps } from "@/lib/worker-route";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** GET /api/worker/cleanup — source ages and clip statuses for the CLEANUP stage (SPEC §7.12). */
export function GET(req: Request) {
  const deps = dataDeps();
  if (!authorized(req, deps.token)) return json({ error: "unauthorized" }, 401);
  return json(cleanupState(deps.db));
}
