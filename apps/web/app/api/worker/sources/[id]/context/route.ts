import { dataDeps } from "@/lib/worker-route";
import { handleSourceContext } from "@/lib/worker-data-api";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = async (req: Request, { params }: { params: Promise<{ id: string }> }) => handleSourceContext(req, (await params).id, dataDeps());
