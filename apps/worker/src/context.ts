import type { EnqueueTaskInput, Env, Task } from "@clip/shared";
import type { WorkerApi } from "./api";
import type { MediaService } from "./mediaService";

export interface StageContext {
  env: Env;
  api: WorkerApi;
  media: MediaService;
  signal: AbortSignal;
  log: (...args: unknown[]) => void;
}

/** A stage does the work and returns follow-up tasks to enqueue. */
export type StageHandler = (task: Task, ctx: StageContext) => Promise<EnqueueTaskInput[] | void>;

/** Errors that retrying cannot fix (bad input): the task fails immediately. */
export class PermanentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PermanentError";
  }
}

export function requireSourceId(task: Task): string {
  if (!task.sourceId) throw new PermanentError(`${task.type} task ${task.id} has no sourceId`);
  return task.sourceId;
}
