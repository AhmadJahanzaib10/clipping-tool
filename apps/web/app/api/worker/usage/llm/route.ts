import { dataDeps } from "@/lib/worker-route";
import { handleLlmUsage } from "@/lib/worker-data-api";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const POST = (req: Request) => handleLlmUsage(req, dataDeps());
