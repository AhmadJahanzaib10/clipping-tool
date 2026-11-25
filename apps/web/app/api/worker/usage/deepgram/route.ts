import { dataDeps } from "@/lib/worker-route";
import { handleDeepgramUsage } from "@/lib/worker-data-api";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const POST = (req: Request) => handleDeepgramUsage(req, dataDeps());
