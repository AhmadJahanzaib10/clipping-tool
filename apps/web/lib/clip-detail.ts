import fs from "node:fs";
import path from "node:path";
import { and, asc, desc, eq } from "drizzle-orm";
import { availableSfx, clipFiles, getClipContext, loadEnv, planSchema, planWordSchema, sourceFiles, transcriptSchema, type Plan, type PlanWord } from "@clip/shared";
import { schema } from "@clip/shared/db";
import { getDb } from "./db";

function readJson<T>(file: string, parse: (v: unknown) => T): T | null {
  try {
    return parse(JSON.parse(fs.readFileSync(file, "utf8")));
  } catch {
    return null;
  }
}

/** Everything the review/editor page needs for one clip (SPEC §11). */
export function clipDetail(clipId: string) {
  const db = getDb();
  const env = loadEnv();
  const ctx = getClipContext(db, clipId);
  if (!ctx) return null;
  const { clip } = ctx;
  const cf = clipFiles(env.STORAGE_DIR, clipId);
  const plan: Plan | null = readJson(cf.plan, (v) => planSchema.parse(v));
  const words: PlanWord[] = readJson(cf.words, (v) => planWordSchema.array().parse(v)) ?? [];
  const source = db.select().from(schema.sources).where(eq(schema.sources.id, clip.sourceId)).get()!;

  // Sentences around the clip (source time) for "extend / shorten by a sentence".
  const transcript = readJson(sourceFiles(env.STORAGE_DIR, clip.sourceId).transcript, (v) => transcriptSchema.parse(v));
  const sentences = (transcript?.sentences ?? []).filter((s) => s.e > clip.startSec - 60 && s.s < clip.endSec + 60).map((s) => ({ s: s.s, e: s.e, text: s.text }));

  // Rendered versions on disk (the previous one is kept for compare).
  const versions = fs.existsSync(cf.dir)
    ? fs
        .readdirSync(cf.dir)
        .map((f) => /^clip\.v(\d+)\.mp4$/.exec(f))
        .filter((m): m is RegExpExecArray => m !== null)
        .map((m) => ({ v: Number(m[1]), path: `clips/${clipId}/${m[0]}` }))
        .sort((a, b) => b.v - a.v)
    : [];

  const library = availableSfx(db).map((s) => ({ id: s.id, category: s.category, name: s.name, durationSec: s.durationSec }));
  const events = db.select().from(schema.events).where(eq(schema.events.clipId, clipId)).orderBy(desc(schema.events.createdAt)).limit(40).all();
  const siblings = db
    .select({ id: schema.clips.id, rank: schema.clips.rank })
    .from(schema.clips)
    .where(and(eq(schema.clips.sourceId, clip.sourceId)))
    .orderBy(asc(schema.clips.rank))
    .all();
  const pending = db
    .select({ type: schema.tasks.type, status: schema.tasks.status })
    .from(schema.tasks)
    .where(eq(schema.tasks.clipId, clipId))
    .all()
    .filter((t) => t.status === "pending" || t.status === "running");
  const hasBase = fs.existsSync(cf.base);
  const hasSrt = fs.existsSync(cf.srt);
  return {
    clip,
    source: { id: source.id, title: source.title, url: source.url, kind: source.kind },
    campaign: ctx.campaign,
    operator: ctx.operator,
    plan,
    words,
    sentences,
    versions,
    library,
    events: events.map((e) => ({ id: e.id, level: e.level, message: e.message, createdAt: e.createdAt })),
    siblings,
    pending,
    downloads: {
      clean: hasBase ? path.relative(env.STORAGE_DIR, cf.base).split(path.sep).join("/") : null,
      srt: hasSrt ? path.relative(env.STORAGE_DIR, cf.srt).split(path.sep).join("/") : null,
    },
  };
}
export type ClipDetail = NonNullable<ReturnType<typeof clipDetail>>;
