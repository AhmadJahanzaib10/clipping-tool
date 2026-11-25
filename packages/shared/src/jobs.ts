import fs from "node:fs";
import path from "node:path";
import { and, desc, eq, sql } from "drizzle-orm";
import { nanoid } from "nanoid";
import { z } from "zod";
import type { EventLevel, SourceStatus } from "./constants";
import type { Db } from "./db/client";
import { campaigns, events, operators, sources, tasks, usage, type Source } from "./db/schema";
import { enqueueTask } from "./queue/queue";

// ---------- storage layout ----------

export const UPLOAD_EXTS = [".mp4", ".mov", ".m4v", ".mkv", ".webm"] as const;
export const UPLOAD_ID_RE = /^[A-Za-z0-9_-]{10,40}$/;

export function sourceDir(storageDir: string, sourceId: string) {
  return path.join(storageDir, "sources", sourceId);
}
/** Well-known files of a source (SPEC §7.1). */
export function sourceFiles(storageDir: string, sourceId: string) {
  const dir = sourceDir(storageDir, sourceId);
  return {
    dir,
    info: path.join(dir, "info.json"),
    wav: path.join(dir, "audio.wav"),
    opus: path.join(dir, "audio.opus"),
    captions: path.join(dir, "captions.json3"),
    transcript: path.join(dir, "transcript.json"),
  };
}
export const uploadsDir = (storageDir: string) => path.join(storageDir, "uploads");
/** Upload sources keep their file as `upload<ext>` in the source dir. */
export function findUploadFile(storageDir: string, sourceId: string): string | null {
  const dir = sourceDir(storageDir, sourceId);
  for (const ext of UPLOAD_EXTS) {
    const p = path.join(dir, `upload${ext}`);
    if (fs.existsSync(p)) return p;
  }
  return null;
}

// ---------- events ----------

export function addEvent(
  db: Db,
  e: { sourceId?: string | null; clipId?: string | null; level: EventLevel; message: string; data?: unknown },
  now: Date = new Date(),
) {
  return db
    .insert(events)
    .values({ id: nanoid(), sourceId: e.sourceId ?? null, clipId: e.clipId ?? null, level: e.level, message: e.message, data: e.data ?? null, createdAt: now.toISOString() })
    .returning()
    .get();
}

// ---------- usage (Deepgram daily cap) ----------

export const usageDate = (now: Date = new Date()) => now.toISOString().slice(0, 10);

function ensureUsageRow(db: Db, date: string) {
  db.insert(usage).values({ date }).onConflictDoNothing().run();
}

export function getUsage(db: Db, now: Date = new Date()) {
  const date = usageDate(now);
  return db.select().from(usage).where(eq(usage.date, date)).get() ?? { date, deepgramSeconds: 0, llmCalls: 0, llmTokensIn: 0, llmTokensOut: 0 };
}

/**
 * Atomically reserve `seconds` of today's Deepgram budget. Returns false (and reserves nothing)
 * if today's usage + seconds would exceed the cap. Release on failure with releaseDeepgram.
 */
export function reserveDeepgram(db: Db, seconds: number, capSec: number, now: Date = new Date()): boolean {
  const date = usageDate(now);
  return db.transaction(
    (tx) => {
      tx.insert(usage).values({ date }).onConflictDoNothing().run();
      const r = tx
        .update(usage)
        .set({ deepgramSeconds: sql`${usage.deepgramSeconds} + ${seconds}` })
        .where(and(eq(usage.date, date), sql`${usage.deepgramSeconds} + ${seconds} <= ${capSec}`))
        .run();
      return r.changes === 1;
    },
    { behavior: "immediate" },
  );
}

export function releaseDeepgram(db: Db, seconds: number, now: Date = new Date()) {
  const date = usageDate(now);
  ensureUsageRow(db, date);
  db.update(usage)
    .set({ deepgramSeconds: sql`max(0, ${usage.deepgramSeconds} - ${seconds})` })
    .where(eq(usage.date, date))
    .run();
}

// ---------- jobs ----------

export const createJobSchema = z
  .object({
    urls: z.array(z.string().url()).max(50).default([]),
    uploadIds: z.array(z.string().regex(UPLOAD_ID_RE)).max(50).default([]),
    campaignId: z.string().min(1),
    operatorId: z.string().min(1),
    options: z
      .object({
        clipCount: z.number().int().min(1).max(20).optional(),
        minLengthSec: z.number().positive().optional(),
        maxLengthSec: z.number().positive().optional(),
      })
      .default({}),
  })
  .refine((j) => j.urls.length + j.uploadIds.length > 0, { message: "Add at least one URL or upload", path: ["urls"] });
export type CreateJobInput = z.input<typeof createJobSchema>;

export class JobError extends Error {}

/**
 * Create one source per URL / upload and enqueue its INGEST task.
 * Uploads are moved from storage/uploads/{uploadId}{ext} into storage/sources/{sourceId}/upload{ext}.
 */
export function createJob(db: Db, storageDir: string, input: CreateJobInput, now: Date = new Date()): Source[] {
  const job = createJobSchema.parse(input);
  if (!db.select().from(campaigns).where(eq(campaigns.id, job.campaignId)).get()) throw new JobError("Unknown campaign");
  if (!db.select().from(operators).where(eq(operators.id, job.operatorId)).get()) throw new JobError("Unknown operator");

  const uploads = job.uploadIds.map((id) => {
    const name = fs.existsSync(uploadsDir(storageDir)) ? fs.readdirSync(uploadsDir(storageDir)).find((f) => path.parse(f).name === id) : undefined;
    if (!name) throw new JobError(`Upload ${id} not found`);
    return { id, file: path.join(uploadsDir(storageDir), name), ext: path.extname(name).toLowerCase() };
  });

  const ts = now.toISOString();
  const created: Source[] = [];
  const items = [...job.urls.map((url) => ({ kind: "url" as const, url })), ...uploads.map((u) => ({ kind: "upload" as const, upload: u }))];
  // Stagger createdAt by 1 ms so claim order (oldest source first) follows the order given.
  items.forEach((item, i) => {
    const id = nanoid();
    const created_at = new Date(now.getTime() + i).toISOString();
    if (item.kind === "upload") {
      const dir = sourceDir(storageDir, id);
      fs.mkdirSync(dir, { recursive: true });
      fs.renameSync(item.upload.file, path.join(dir, `upload${item.upload.ext}`));
    }
    const src = db
      .insert(sources)
      .values({
        id,
        operatorId: job.operatorId,
        campaignId: job.campaignId,
        kind: item.kind,
        url: item.kind === "url" ? item.url : null,
        title: item.kind === "upload" ? path.basename(item.upload.file) : null,
        status: "queued",
        createdAt: created_at,
        updatedAt: ts,
      })
      .returning()
      .get();
    enqueueTask(db, { type: "INGEST", sourceId: id, payload: { options: job.options } }, now);
    addEvent(db, { sourceId: id, level: "info", message: `Job created (${item.kind})` }, now);
    created.push(src);
  });
  return created;
}

export const sourcePatchSchema = z
  .object({
    status: z.enum(["queued", "ingesting", "transcribing", "selecting", "fetching", "clipping", "done", "failed"]),
    title: z.string().max(500).nullable(),
    durationSec: z.number().nonnegative().nullable(),
    width: z.number().int().nonnegative().nullable(),
    height: z.number().int().nonnegative().nullable(),
    transcriptProvider: z.enum(["youtube", "deepgram", "whisper"]).nullable(),
    transcriptQuality: z.enum(["rough", "precise"]).nullable(),
    error: z.string().max(10_000).nullable(),
  })
  .partial();
export type SourcePatch = z.infer<typeof sourcePatchSchema>;

export function updateSource(db: Db, id: string, patch: SourcePatch, now: Date = new Date()): Source | undefined {
  const p = sourcePatchSchema.parse(patch);
  return db.update(sources).set({ ...p, updatedAt: now.toISOString() }).where(eq(sources.id, id)).returning().get();
}

/** Called when a task ends in `failed`: mark its source failed and log it. */
export function markSourceFailed(db: Db, sourceId: string, error: string, now: Date = new Date()) {
  updateSource(db, sourceId, { status: "failed" satisfies SourceStatus, error }, now);
  addEvent(db, { sourceId, level: "error", message: `Failed: ${error.split("\n")[0]}` }, now);
}

export function jobDetail(db: Db, id: string) {
  const source = db.select().from(sources).where(eq(sources.id, id)).get();
  if (!source) return null;
  return {
    source,
    events: db.select().from(events).where(eq(events.sourceId, id)).orderBy(desc(events.createdAt)).limit(200).all(),
    tasks: db.select().from(tasks).where(eq(tasks.sourceId, id)).orderBy(desc(tasks.createdAt)).all(),
  };
}
