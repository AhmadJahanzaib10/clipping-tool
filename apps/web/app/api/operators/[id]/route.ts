import { operatorInputSchema, updateOperator } from "@clip/shared";
import { getDb } from "@/lib/db";
import { readJson, reviewErrorResponse, type IdParams } from "@/lib/clips-api";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function PATCH(req: Request, { params }: IdParams) {
  const b = await readJson(req, operatorInputSchema.partial());
  if ("res" in b) return b.res;
  try {
    return Response.json({ operator: updateOperator(getDb(), (await params).id, b.data) });
  } catch (e) {
    return reviewErrorResponse(e);
  }
}
