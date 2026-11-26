import { z } from "zod";
import { getScoreWeights, scoreWeightsSchema, setScoreWeights } from "@clip/shared";
import { getDb } from "@/lib/db";
import { readJson } from "@/lib/clips-api";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export function GET() {
  return Response.json({ scoreWeights: getScoreWeights(getDb()) });
}

/** PUT { scoreWeights } — weights of the final clip score (SPEC §8.3); used by the next EDIT pass. */
export async function PUT(req: Request) {
  const b = await readJson(req, z.object({ scoreWeights: scoreWeightsSchema }));
  if ("res" in b) return b.res;
  return Response.json({ scoreWeights: setScoreWeights(getDb(), b.data.scoreWeights) });
}
