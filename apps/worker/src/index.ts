import os from "node:os";
import { HEARTBEAT_MS, loadEnv, taskClass, type Task, type TaskClass, type TaskType } from "@clip/shared";
import { WorkerApi, WorkerApiError } from "./api";
import { PermanentError, type StageHandler } from "./context";
import { MediaService } from "./mediaService";
import { ingest } from "./stages/ingest";
import { transcribe } from "./stages/transcribe";
import { scout } from "./stages/scout";
import { edit } from "./stages/edit";
import { fetchSections } from "./stages/fetchSections";
import { analyze } from "./stages/analyze";
import { prepClip } from "./stages/prepClip";

const MAX_TOTAL = 2; // SPEC §12: max 2 concurrent tasks, at most MAX_HEAVY_TASKS heavy
const IDLE_POLL_MS = 3000;

const env = loadEnv();
const llmReady = Boolean(env.OPENROUTER_API_KEY && env.LLM_SCOUT_MODEL && env.LLM_EDITOR_MODEL);

/**
 * Stage registry: the worker only claims task types it has a handler for. LLM stages are only
 * registered when OpenRouter is configured, so their tasks wait (pending) instead of burning retries.
 */
const stages: Partial<Record<TaskType, StageHandler>> = {
  INGEST: ingest,
  TRANSCRIBE: transcribe,
  FETCH_SECTIONS: fetchSections,
  ANALYZE: analyze,
  PREP_CLIP: prepClip,
  ...(llmReady ? { SCOUT: scout, EDIT: edit } : {}),
};
const log = (...args: unknown[]) => console.log(new Date().toISOString(), "[worker]", ...args);
const api = new WorkerApi(env.API_BASE_URL, env.WORKER_TOKEN, `${os.hostname()}-${process.pid}`);
const media = new MediaService({
  pythonPath: env.PYTHON_PATH,
  lowPriority: env.LOW_PRIORITY,
  onLog: (l) => console.log(new Date().toISOString(), "[media]", l),
});
const running = new Map<string, { task: Task; abort: AbortController }>();
let stopping = false;

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
  const t0 = Date.now();
  try {
    log(`start ${task.type} ${task.id} (attempt ${task.attempts})`);
    const next = (await handler(task, { env, api, media, signal: abort.signal, log })) ?? [];
    await api.complete(task.id, next);
    log(`done ${task.type} ${task.id} in ${((Date.now() - t0) / 1000).toFixed(1)} s`);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    log(`failed ${task.type} ${task.id}: ${e instanceof Error ? (e.stack ?? msg) : msg}`);
    await api
      .fail(task.id, msg, { release: stopping, retryable: !(e instanceof PermanentError) })
      .catch((err) => log("could not report failure", err instanceof Error ? err.message : err));
  } finally {
    clearInterval(hb);
    running.delete(task.id);
  }
}

async function main() {
  const types = Object.keys(stages) as TaskType[];
  log(`worker ${api.workerId} polling ${env.API_BASE_URL} for: ${types.join(", ")}`);
  if (!llmReady) log("SCOUT/EDIT disabled: set OPENROUTER_API_KEY, LLM_SCOUT_MODEL and LLM_EDITOR_MODEL in .env, then restart the worker");

  process.on("SIGINT", () => {
    if (stopping) process.exit(1);
    stopping = true;
    log("stopping: releasing leases of running tasks (Ctrl+C again to force)");
    for (const r of running.values()) r.abort.abort();
  });

  let apiDown = false;
  while (!stopping) {
    const classes = freeClasses();
    let claimed: Task | null = null;
    if (classes.length > 0) {
      try {
        claimed = await api.claim(classes, types);
        if (apiDown) log("API reachable again");
        apiDown = false;
      } catch (e) {
        if (!apiDown) log("claim failed (is the web app running?):", e instanceof WorkerApiError ? e.message : e instanceof Error ? e.message : e);
        apiDown = true;
      }
    }
    if (claimed) {
      void runTask(claimed, stages[claimed.type]!);
      continue;
    }
    await new Promise((r) => setTimeout(r, IDLE_POLL_MS));
  }
  while (running.size > 0) await new Promise((r) => setTimeout(r, 200));
  media.stop();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
