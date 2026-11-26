import path from "node:path";
import { and, asc, eq, inArray, sql } from "drizzle-orm";
import { nanoid } from "nanoid";
import { z } from "zod";
import type { Db } from "./db/client";
import { campaigns, clips, operators, settings, sources, usage, type Clip } from "./db/schema";
import { campaignConfigSchema, type CampaignConfig } from "./schemas/campaign";
import { clipEditSchema } from "./schemas/clip";
import { CLIP_STATUSES } from "./constants";
import { clipInputSchema, initialClipEdit, type ClipInput } from "./selection/finalize";
import { DEFAULT_SCORE_WEIGHTS, scoreWeightsSchema, type ScoreWeights } from "./selection/score";
import { usageDate } from "./jobs";
import { fewShotExamples } from "./reviewDb";

// ---------- settings ----------

export function getSetting<T>(db: Db, key: string, schema: z.ZodType<T>, fallback: T): T {
  const row = db.select().from(settings).where(eq(settings.key, key)).get();
  const parsed = row ? schema.safeParse(row.value) : null;
  return parsed?.success ? parsed.data : fallback;
}

export const getScoreWeights = (db: Db): ScoreWeights => getSetting(db, "scoreWeights", scoreWeightsSchema, { ...DEFAULT_SCORE_WEIGHTS });

// ---------- LLM usage ----------

export const llmUsageSchema = z.object({
  calls: z.number().int().min(0).max(1000),
  tokensIn: z.number().int().min(0),
  tokensOut: z.number().int().min(0),
});

export function addLlmUsage(db: Db, u: z.infer<typeof llmUsageSchema>, now: Date = new Date()) {
  const date = usageDate(now);
  db.insert(usage).values({ date }).onConflictDoNothing().run();
  db.update(usage)
    .set({
      llmCalls: sql`${usage.llmCalls} + ${u.calls}`,
      llmTokensIn: sql`${usage.llmTokensIn} + ${u.tokensIn}`,
      llmTokensOut: sql`${usage.llmTokensOut} + ${u.tokensOut}`,
    })
    .where(eq(usage.date, date))
    .run();
}

// ---------- source context for SCOUT / EDIT ----------

export interface SourceContext {
  sourceId: string;
  campaign: { id: string; name: string; niche: string; config: CampaignConfig };
  scoreWeights: ScoreWeights;
  /** Few-shot examples: the niche's best clips of the last 30 days by views at 72 h (SPEC §9). */
  fewShot: { hook: string; firstLine: string; lengthSec: number; views: number }[];
}

export function getSourceContext(db: Db, sourceId: string, storageDir: string | null = null): SourceContext | null {
  const src = db.select().from(sources).where(eq(sources.id, sourceId)).get();
  if (!src?.campaignId) return null;
  const camp = db.select().from(campaigns).where(eq(campaigns.id, src.campaignId)).get();
  if (!camp) return null;
  return {
    sourceId,
    campaign: { id: camp.id, name: camp.name, niche: camp.niche, config: campaignConfigSchema.parse(camp.config) },
    scoreWeights: getScoreWeights(db),
    fewShot: fewShotExamples(db, storageDir, camp.niche),
  };
}

// ---------- clips ----------

export const createClipsSchema = z.object({ clips: z.array(clipInputSchema).max(30) });

/**
 * Replace a source's candidate clips (EDIT may be retried) and insert the new ones with their
 * initial ClipEdit. Clips already rendered/approved/rejected are never touched.
 */
export function replaceSourceClips(db: Db, sourceId: string, inputs: ClipInput[], now: Date = new Date()): Clip[] {
  const src = db.select().from(sources).where(eq(sources.id, sourceId)).get();
  if (!src) throw new Error(`source ${sourceId} not found`);
  const ctx = getSourceContext(db, sourceId);
  if (!ctx) throw new Error(`source ${sourceId} has no campaign`);
  const parsed = inputs.map((c) => clipInputSchema.parse(c));
  const ts = now.toISOString();
  return db.transaction((tx) => {
    const old = tx
      .select({ id: clips.id })
      .from(clips)
      .where(and(eq(clips.sourceId, sourceId), eq(clips.status, "candidate")))
      .all()
      .map((r) => r.id);
    if (old.length) tx.delete(clips).where(inArray(clips.id, old)).run();
    for (const c of parsed) {
      tx.insert(clips)
        .values({
          id: nanoid(),
          sourceId,
          campaignId: src.campaignId,
          operatorId: src.operatorId,
          rank: c.rank,
          score: c.score,
          scores: c.scores,
          startSec: c.startSec,
          endSec: c.endSec,
          hookA: c.hookA,
          hookB: c.hookB,
          hookChoice: "A",
          title: c.title,
          captionTiktok: c.captionTiktok,
          captionInstagram: c.captionInstagram,
          captionYoutube: c.captionYoutube,
          hashtags: c.hashtags,
          emphasisWords: c.emphasisWords,
          reason: c.reason,
          edit: initialClipEdit(c, ctx.campaign.config),
          status: "candidate",
          createdAt: ts,
          updatedAt: ts,
        })
        .run();
    }
    return tx.select().from(clips).where(eq(clips.sourceId, sourceId)).orderBy(asc(clips.rank)).all();
  });
}

export function sourceClips(db: Db, sourceId: string): Clip[] {
  return db.select().from(clips).where(eq(clips.sourceId, sourceId)).orderBy(asc(clips.rank)).all();
}

// ---------- per-clip storage (SPEC §7.5–7.8) ----------

export function clipFiles(storageDir: string, clipId: string) {
  const dir = path.join(storageDir, "clips", clipId);
  return {
    dir,
    section: path.join(dir, "section.mp4"),
    sectionInfo: path.join(dir, "section.json"),
    analysis: path.join(dir, "analysis.json"),
    plan: path.join(dir, "plan.json"),
    words: path.join(dir, "words.json"),
    base: path.join(dir, "base.mp4"),
    baseLoudness: path.join(dir, "base.loudness.json"),
    ass: path.join(dir, "captions.ass"),
    srt: path.join(dir, "captions.srt"),
    thumb: path.join(dir, "thumb.jpg"),
    output: (version: number) => path.join(dir, `clip.v${version}.mp4`),
  };
}

/** Everything a worker stage needs about one clip. */
export function getClipContext(db: Db, clipId: string) {
  const clip = db.select().from(clips).where(eq(clips.id, clipId)).get();
  if (!clip) return null;
  const src = db.select().from(sources).where(eq(sources.id, clip.sourceId)).get();
  const ctx = getSourceContext(db, clip.sourceId);
  if (!src || !ctx) return null;
  const op = clip.operatorId ? db.select().from(operators).where(eq(operators.id, clip.operatorId)).get() : undefined;
  return {
    clip,
    source: { id: src.id, kind: src.kind, url: src.url, durationSec: src.durationSec, transcriptQuality: src.transcriptQuality },
    campaign: { ...ctx.campaign, slug: db.select({ slug: campaigns.slug }).from(campaigns).where(eq(campaigns.id, ctx.campaign.id)).get()?.slug ?? ctx.campaign.id },
    operator: op ? { id: op.id, name: op.name, slug: op.slug, driveFolder: op.driveFolder } : null,
  };
}

export const clipPatchSchema = z
  .object({
    edit: clipEditSchema,
    status: z.enum(CLIP_STATUSES),
    baseVersion: z.number().int().min(0),
    basePath: z.string().nullable(),
    composeVersion: z.number().int().min(0),
    outputPath: z.string().nullable(),
    thumbPath: z.string().nullable(),
    deliveredAt: z.string().nullable(),
    deliveryPath: z.string().nullable(),
  })
  .partial();
export type ClipPatch = z.infer<typeof clipPatchSchema>;

export function updateClip(db: Db, clipId: string, patch: ClipPatch, now: Date = new Date()): Clip | undefined {
  const p = clipPatchSchema.parse(patch);
  return db.update(clips).set({ ...p, updatedAt: now.toISOString() }).where(eq(clips.id, clipId)).returning().get();
}
