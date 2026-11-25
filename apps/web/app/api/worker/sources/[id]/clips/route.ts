import { dataDeps } from "@/lib/worker-route";
import { handleCreateClips, handleSourceClips } from "@/lib/worker-data-api";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };
export const GET = async (req: Request, { params }: Ctx) => handleSourceClips(req, (await params).id, dataDeps());
export const POST = async (req: Request, { params }: Ctx) => handleCreateClips(req, (await params).id, dataDeps());
