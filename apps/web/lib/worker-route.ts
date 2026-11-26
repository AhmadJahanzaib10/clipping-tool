import { loadEnv } from "@clip/shared";
import { getDb } from "./db";
import { handleWorkerRequest, type WorkerAction } from "./worker-api";
import type { DataApiDeps } from "./worker-data-api";

/** Builds the POST handler for an /api/worker/* queue route. */
export function workerRoute(action: WorkerAction) {
  return (req: Request) => handleWorkerRequest(action, req, { db: getDb(), token: loadEnv().WORKER_TOKEN });
}

export function dataDeps(): DataApiDeps {
  const env = loadEnv();
  return { db: getDb(), token: env.WORKER_TOKEN, deepgramCapSec: env.DEEPGRAM_DAILY_CAP_MIN * 60, storageDir: env.STORAGE_DIR };
}
