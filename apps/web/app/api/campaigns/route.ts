import { asc } from "drizzle-orm";
import { campaignInputSchema, createCampaign } from "@clip/shared";
import { schema } from "@clip/shared/db";
import { getDb } from "@/lib/db";
import { readJson } from "@/lib/clips-api";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export function GET() {
  return Response.json({ campaigns: getDb().select().from(schema.campaigns).orderBy(asc(schema.campaigns.name)).all() });
}

/** POST — new campaign (CampaignConfig validated by zod, SPEC §6.1). */
export async function POST(req: Request) {
  const b = await readJson(req, campaignInputSchema);
  if ("res" in b) return b.res;
  return Response.json({ campaign: createCampaign(getDb(), b.data) }, { status: 201 });
}
