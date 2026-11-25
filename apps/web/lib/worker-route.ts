import { loadEnv } from "@clip/shared";
import { getDb } from "./db";
import { handleWorkerRequest, type WorkerAction } from "./worker-api";

/** Builds the POST handler for an /api/worker/* route. */
export function workerRoute(action: WorkerAction) {
  return (req: Request) => handleWorkerRequest(action, req, { db: getDb(), token: loadEnv().WORKER_TOKEN });
}
