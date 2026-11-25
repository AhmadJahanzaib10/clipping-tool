import { runSfxScan } from "@/lib/sfx";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** POST /api/sfx/scan[?force=1] — rescan assets/sfx (SPEC §10.2). */
export async function POST(req: Request) {
  const force = new URL(req.url).searchParams.get("force") === "1";
  try {
    return Response.json(await runSfxScan(force));
  } catch (e) {
    return Response.json({ error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}
