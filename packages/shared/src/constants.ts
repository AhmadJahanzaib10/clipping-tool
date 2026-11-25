export const TASK_TYPES = [
  "INGEST",
  "TRANSCRIBE",
  "SCOUT",
  "EDIT",
  "FETCH_SECTIONS",
  "ANALYZE",
  "PREP_CLIP",
  "RENDER_BASE",
  "COMPOSE",
  "DELIVER",
  "CLEANUP",
] as const;
export type TaskType = (typeof TASK_TYPES)[number];

/** Pipeline position of each stage. Higher = later; claim prefers later stages within a source. */
export const STAGE_RANK: Record<TaskType, number> = {
  CLEANUP: 0,
  INGEST: 1,
  TRANSCRIBE: 2,
  SCOUT: 3,
  EDIT: 4,
  FETCH_SECTIONS: 5,
  ANALYZE: 6,
  PREP_CLIP: 7,
  RENDER_BASE: 8,
  COMPOSE: 9,
  DELIVER: 10,
};

/**
 * CPU-heavy tasks (one at a time per worker, SPEC §12). PREP_CLIP may run local Whisper on
 * rough transcripts, TRANSCRIBE may fall back to Whisper, so both are treated as heavy.
 */
export const HEAVY_TASK_TYPES: readonly TaskType[] = ["TRANSCRIBE", "ANALYZE", "PREP_CLIP", "RENDER_BASE"];
export const TASK_CLASSES = ["heavy", "light"] as const;
export type TaskClass = (typeof TASK_CLASSES)[number];

export function taskClass(type: TaskType): TaskClass {
  return HEAVY_TASK_TYPES.includes(type) ? "heavy" : "light";
}

export const TASK_STATUSES = ["pending", "running", "done", "failed"] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];

export const PRIORITY_NORMAL = 0;
/** User-triggered COMPOSE / RENDER_BASE from the review page jump the queue. */
export const PRIORITY_USER = 100;

export const LEASE_MS = 10 * 60 * 1000;
export const HEARTBEAT_MS = 30 * 1000;
export const DEFAULT_MAX_ATTEMPTS = 3;
/** Backoff after attempt n fails (index n-1): 30 s, then 2 min. */
export const RETRY_BACKOFF_MS = [30 * 1000, 2 * 60 * 1000] as const;

export const SOURCE_STATUSES = [
  "queued",
  "ingesting",
  "transcribing",
  "selecting",
  "fetching",
  "clipping",
  "done",
  "failed",
] as const;
export type SourceStatus = (typeof SOURCE_STATUSES)[number];

export const CLIP_STATUSES = ["candidate", "rendering", "rendered", "approved", "rejected", "failed"] as const;
export type ClipStatus = (typeof CLIP_STATUSES)[number];

export const EVENT_LEVELS = ["debug", "info", "warn", "error"] as const;
export type EventLevel = (typeof EVENT_LEVELS)[number];
