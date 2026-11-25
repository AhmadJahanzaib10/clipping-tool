import { dataDeps } from "@/lib/worker-route";
import { handleEvent } from "@/lib/worker-data-api";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const POST = (req: Request) => handleEvent(req, dataDeps());
