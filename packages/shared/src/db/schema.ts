import { index, integer, real, sqliteTable, text } from "drizzle-orm/sqlite-core";
import type { ClipStatus, EventLevel, SourceStatus, TaskStatus, TaskType } from "../constants";
import type { CampaignConfig } from "../schemas/campaign";
import type { ClipEdit, ClipScores } from "../schemas/clip";

/** SPEC §6. Ids are nanoid text, timestamps ISO strings, JSON columns validated by zod at the edges. */

export const operators = sqliteTable("operators", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  slug: text("slug").notNull().unique(),
  driveFolder: text("drive_folder"),
  active: integer("active", { mode: "boolean" }).notNull().default(true),
  createdAt: text("created_at").notNull(),
});

export const campaigns = sqliteTable("campaigns", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  slug: text("slug").notNull().unique(),
  niche: text("niche").notNull().default(""),
  ratePer1k: real("rate_per_1k"),
  allowedPlatforms: text("allowed_platforms", { mode: "json" }).$type<string[]>().notNull(),
  config: text("config", { mode: "json" }).$type<CampaignConfig>().notNull(),
  active: integer("active", { mode: "boolean" }).notNull().default(true),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
});

export const sources = sqliteTable(
  "sources",
  {
    id: text("id").primaryKey(),
    operatorId: text("operator_id").references(() => operators.id),
    campaignId: text("campaign_id").references(() => campaigns.id),
    kind: text("kind").$type<"url" | "upload">().notNull(),
    url: text("url"),
    title: text("title"),
    durationSec: real("duration_sec"),
    width: integer("width"),
    height: integer("height"),
    status: text("status").$type<SourceStatus>().notNull().default("queued"),
    transcriptProvider: text("transcript_provider").$type<"youtube" | "deepgram" | "whisper">(),
    transcriptQuality: text("transcript_quality").$type<"rough" | "precise">(),
    error: text("error"),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (t) => [index("sources_created_idx").on(t.createdAt)],
);

export const clips = sqliteTable(
  "clips",
  {
    id: text("id").primaryKey(),
    sourceId: text("source_id")
      .notNull()
      .references(() => sources.id),
    campaignId: text("campaign_id").references(() => campaigns.id),
    operatorId: text("operator_id").references(() => operators.id),
    rank: integer("rank"),
    score: real("score"),
    scores: text("scores", { mode: "json" }).$type<ClipScores>(),
    startSec: real("start_sec").notNull(),
    endSec: real("end_sec").notNull(),
    hookA: text("hook_a"),
    hookB: text("hook_b"),
    hookChoice: text("hook_choice").$type<"A" | "B">().notNull().default("A"),
    title: text("title"),
    captionTiktok: text("caption_tiktok"),
    captionInstagram: text("caption_instagram"),
    captionYoutube: text("caption_youtube"),
    hashtags: text("hashtags", { mode: "json" }).$type<string[]>(),
    emphasisWords: text("emphasis_words", { mode: "json" }).$type<string[]>(),
    reason: text("reason"),
    edit: text("edit", { mode: "json" }).$type<ClipEdit>(),
    status: text("status").$type<ClipStatus>().notNull().default("candidate"),
    baseVersion: integer("base_version").notNull().default(0),
    composeVersion: integer("compose_version").notNull().default(0),
    outputPath: text("output_path"),
    basePath: text("base_path"),
    thumbPath: text("thumb_path"),
    views72h: integer("views_72h"),
    viewsPlatform: text("views_platform"),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (t) => [index("clips_source_idx").on(t.sourceId), index("clips_status_idx").on(t.status)],
);

export const sfx = sqliteTable(
  "sfx",
  {
    id: text("id").primaryKey(),
    category: text("category").notNull(),
    file: text("file").notNull().unique(),
    name: text("name").notNull(),
    durationSec: real("duration_sec"),
    peakDb: real("peak_db"),
    lufs: real("lufs"),
    tags: text("tags", { mode: "json" }).$type<string[]>().notNull(),
    defaultGainDb: real("default_gain_db").notNull().default(0),
    enabled: integer("enabled", { mode: "boolean" }).notNull().default(true),
    cachedPath: text("cached_path"),
    waveformPath: text("waveform_path"),
    updatedAt: text("updated_at").notNull(),
  },
  (t) => [index("sfx_category_idx").on(t.category)],
);

export const tasks = sqliteTable(
  "tasks",
  {
    id: text("id").primaryKey(),
    type: text("type").$type<TaskType>().notNull(),
    sourceId: text("source_id").references(() => sources.id),
    clipId: text("clip_id").references(() => clips.id),
    payload: text("payload", { mode: "json" }).$type<Record<string, unknown>>().notNull(),
    priority: integer("priority").notNull().default(0),
    status: text("status").$type<TaskStatus>().notNull().default("pending"),
    attempts: integer("attempts").notNull().default(0),
    maxAttempts: integer("max_attempts").notNull().default(3),
    workerId: text("worker_id"),
    leaseUntil: text("lease_until"),
    /** Not before this time (retry backoff). Not in SPEC §6 but required for its 30 s / 2 min backoff. */
    runAfter: text("run_after"),
    error: text("error"),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (t) => [
    index("tasks_status_idx").on(t.status, t.priority),
    index("tasks_source_idx").on(t.sourceId),
    index("tasks_clip_idx").on(t.clipId),
  ],
);

export const usage = sqliteTable("usage", {
  date: text("date").primaryKey(),
  deepgramSeconds: real("deepgram_seconds").notNull().default(0),
  llmCalls: integer("llm_calls").notNull().default(0),
  llmTokensIn: integer("llm_tokens_in").notNull().default(0),
  llmTokensOut: integer("llm_tokens_out").notNull().default(0),
});

export const events = sqliteTable(
  "events",
  {
    id: text("id").primaryKey(),
    sourceId: text("source_id").references(() => sources.id),
    clipId: text("clip_id").references(() => clips.id),
    level: text("level").$type<EventLevel>().notNull(),
    message: text("message").notNull(),
    data: text("data", { mode: "json" }).$type<unknown>(),
    createdAt: text("created_at").notNull(),
  },
  (t) => [index("events_source_idx").on(t.sourceId, t.createdAt)],
);

export const settings = sqliteTable("settings", {
  key: text("key").primaryKey(),
  value: text("value", { mode: "json" }).$type<unknown>().notNull(),
});

export type Operator = typeof operators.$inferSelect;
export type Campaign = typeof campaigns.$inferSelect;
export type Source = typeof sources.$inferSelect;
export type Clip = typeof clips.$inferSelect;
export type Sfx = typeof sfx.$inferSelect;
export type Task = typeof tasks.$inferSelect;
export type Usage = typeof usage.$inferSelect;
export type EventRow = typeof events.$inferSelect;
