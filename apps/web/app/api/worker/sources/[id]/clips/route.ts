import { dataDeps } from "@/lib/worker-route";
import { handleCreateClips } from "@/lib/worker-data-api";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const POST = async (req: Request, { params }: { params: Promise<{ id: string }> }) => handleCreateClips(req, (await params).id, dataDeps());
