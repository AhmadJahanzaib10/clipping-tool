import { z } from "zod";
import { TASK_CLASSES, TASK_TYPES } from "../constants";

const workerId = z.string().min(1).max(100);
const taskId = z.string().min(1).max(100);

export const enqueueTaskSchema = z.object({
  type: z.enum(TASK_TYPES),
  sourceId: z.string().nullish(),
  clipId: z.string().nullish(),
  payload: z.record(z.string(), z.unknown()).default({}),
  priority: z.number().int().default(0),
  maxAttempts: z.number().int().min(1).max(10).optional(),
});
export type EnqueueTaskInput = z.input<typeof enqueueTaskSchema>;

export const claimBodySchema = z.object({
  workerId,
  /** Which task classes this worker has a free slot for. Default: both. */
  classes: z.array(z.enum(TASK_CLASSES)).min(1).optional(),
  /** Restrict to these task types (e.g. a worker without Python). Default: all. */
  types: z.array(z.enum(TASK_TYPES)).min(1).optional(),
});
export type ClaimBody = z.input<typeof claimBodySchema>;

export const heartbeatBodySchema = z.object({ workerId, taskId });
export type HeartbeatBody = z.input<typeof heartbeatBodySchema>;

export const completeBodySchema = z.object({
  workerId,
  taskId,
  /** Follow-up tasks to enqueue atomically with the completion. */
  next: z.array(enqueueTaskSchema).max(100).optional(),
});
export type CompleteBody = z.input<typeof completeBodySchema>;

export const failBodySchema = z.object({
  workerId,
  taskId,
  error: z.string().max(10_000).default("unknown error"),
  /** false = permanent failure, no retry. */
  retryable: z.boolean().default(true),
  /** true = worker is shutting down; hand the task back without counting the attempt. */
  release: z.boolean().default(false),
});
export type FailBody = z.input<typeof failBodySchema>;
