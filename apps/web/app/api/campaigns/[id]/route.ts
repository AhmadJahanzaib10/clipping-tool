import { eq } from "drizzle-orm";
import { campaignInputSchema, updateCampaign } from "@clip/shared";
import { schema } from "@clip/shared/db";
import { getDb } from "@/lib/db";
import { readJson, reviewErrorResponse, type IdParams } from "@/lib/clips-api";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(_req: Request, { params }: IdParams) {
  const c = getDb().select().from(schema.campaigns).where(eq(schema.campaigns.id, (await params).id)).get();
  return c ? Response.json({ campaign: c }) : Response.json({ error: "not_found" }, { status: 404 });
}

/** PATCH — any campaign field; `config` is the full CampaignConfig. */
export async function PATCH(req: Request, { params }: IdParams) {
  const b = await readJson(req, campaignInputSchema.partial());
  if ("res" in b) return b.res;
  try {
    return Response.json({ campaign: updateCampaign(getDb(), (await params).id, b.data) });
  } catch (e) {
    if (e instanceof Error && e.name === "ZodError") return Response.json({ error: e.message }, { status: 400 });
    return reviewErrorResponse(e);
  }
}
