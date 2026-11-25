import { getUsage, loadEnv } from "@clip/shared";
import { getDb } from "@/lib/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Today's usage (UTC day) and the Deepgram cap. */
export function GET() {
  const u = getUsage(getDb());
  return Response.json({ ...u, deepgramMinutes: u.deepgramSeconds / 60, deepgramCapMinutes: loadEnv().DEEPGRAM_DAILY_CAP_MIN });
}
