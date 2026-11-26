import { availableSfx } from "@clip/shared";
import { authorized, json } from "@/lib/worker-api";
import { dataDeps } from "@/lib/worker-route";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** GET /api/worker/sfx — sounds the planner may use (enabled, present, cached). */
export function GET(req: Request) {
  const deps = dataDeps();
  if (!authorized(req, deps.token)) return json({ error: "unauthorized" }, 401);
  const sounds = availableSfx(deps.db).map((s) => ({ id: s.id, category: s.category, file: s.file, durationSec: s.durationSec, defaultGainDb: s.defaultGainDb, cachedPath: s.cachedPath }));
  return json({ sfx: sounds });
}
