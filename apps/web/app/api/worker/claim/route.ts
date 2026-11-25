import { workerRoute } from "@/lib/worker-route";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const POST = workerRoute("claim");
