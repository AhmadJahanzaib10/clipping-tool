import { dataDeps } from "@/lib/worker-route";
import { handleClip } from "@/lib/worker-data-api";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };
export const GET = async (req: Request, { params }: Ctx) => handleClip(req, (await params).id, dataDeps());
export const PATCH = async (req: Request, { params }: Ctx) => handleClip(req, (await params).id, dataDeps());
