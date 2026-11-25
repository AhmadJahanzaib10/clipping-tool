import { jobDetail } from "@clip/shared";
import { getDb } from "@/lib/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const d = jobDetail(getDb(), (await params).id);
  return d ? Response.json(d) : Response.json({ error: "not_found" }, { status: 404 });
}
