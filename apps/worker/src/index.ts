import os from "node:os";
import { HEARTBEAT_MS, loadEnv, taskClass, type EnqueueTaskInput, type Task, type TaskClass, type TaskType } from "@clip/shared";
import { WorkerApi, WorkerApiError } from "./api";

/** A stage handler does the work and returns follow-up tasks to enqueue. */
export type StageHandler = (task: Task, ctx: { signal: AbortSignal }) => Promise<EnqueueTaskInput[] | void>;

/** Stage registry. Filled in from Milestone 2 onward (ingest, transcribe, …). */
const stages: Partial<Record<TaskType, StageHandler>> = {};

const MAX_TOTAL = 2; // SPEC §12: max 2 concurrent tasks, at most MAX_HEAVY_TASKS heavy
const IDLE_POLL_MS = 3000;

const env = loadEnv();
const api = new WorkerApi(env.API_BASE_URL, env.WORKER_TOKEN, `${os.hostname()}-${process.pid}`);
const running = new Map<string, { task: Task; abort: AbortController }>();
let stopping = false;

const log = (...args: unknown[]) => console.log(new Date().toISOString(), "[worker]", ...args);

function freeClasses(): TaskClass[] {
  if (running.size >= MAX_TOTAL) return [];
  const heavy = [...running.values()].filter((r) => taskClass(r.task.type) === "heavy").length;
  return heavy < env.MAX_HEAVY_TASKS ? ["heavy", "light"] : ["light"];
}

async function runTask(task: Task, handler: StageHandler) {
  const abort = new AbortController();
  running.set(task.id, { task, abort });
  const hb = setInterval(() => {
    api.heartbeat(task.id).catch((e) => {
      log(`heartbeat lost for ${task.type} ${task.id}; aborting`, e instanceof Error ? e.message : e);
      abort.abort();
    });
  }, HEARTBEAT_MS);
  try {
    log(`start ${task.type} ${task.id} (attempt ${task.attempts})`);
    const next = (await handler(task, { signal: abort.signal })) ?? [];
    await api.complete(task.id, next);
    log(`done ${task.type} ${task.id}`);
  } catch (e) {
    const msg = e instanceof Error ? (e.stack ?? e.message) : String(e);
    log(`failed ${task.type} ${task.id}: ${msg}`);
    await api.fail(task.id, msg, { release: stopping }).catch((err) => log("could not report failure", err));
  } finally {
    clearInterval(hb);
    running.delete(task.id);
  }
}

async function main() {
  const types = Object.keys(stages) as TaskType[];
  if (types.length === 0) {
    log("No pipeline stages are implemented yet (Milestone 1). Nothing to do.");
    return;
  }
  log(`worker ${api.workerId} polling ${env.API_BASE_URL} for: ${types.join(", ")}`);

  process.on("SIGINT", () => {
    if (stopping) process.exit(1);
    stopping = true;
    log("stopping: releasing leases of running tasks (Ctrl+C again to force)");
    for (const r of running.values()) r.abort.abort();
  });

  while (!stopping) {
    const classes = freeClasses();
    let claimed: Task | null = null;
    if (classes.length > 0) {
      try {
        claimed = await api.claim(classes, types);
      } catch (e) {
        log("claim failed", e instanceof WorkerApiError ? e.message : e);
      }
    }
    if (claimed) {
      void runTask(claimed, stages[claimed.type]!);
      continue;
    }
    await new Promise((r) => setTimeout(r, IDLE_POLL_MS));
  }
  while (running.size > 0) await new Promise((r) => setTimeout(r, 200));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
