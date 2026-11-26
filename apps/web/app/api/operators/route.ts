import { asc } from "drizzle-orm";
import { createOperator, operatorInputSchema } from "@clip/shared";
import { schema } from "@clip/shared/db";
import { getDb } from "@/lib/db";
import { readJson } from "@/lib/clips-api";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export function GET() {
  return Response.json({ operators: getDb().select().from(schema.operators).orderBy(asc(schema.operators.name)).all() });
}

export async function POST(req: Request) {
  const b = await readJson(req, operatorInputSchema);
  if ("res" in b) return b.res;
  return Response.json({ operator: createOperator(getDb(), b.data) }, { status: 201 });
}
