import { and, asc, eq, inArray, sql } from "drizzle-orm";
import { nanoid } from "nanoid";
import { z } from "zod";
import type { Db } from "./db/client";
import { campaigns, clips, settings, sources, usage, type Clip } from "./db/schema";
import { campaignConfigSchema, type CampaignConfig } from "./schemas/campaign";
import { clipInputSchema, initialClipEdit, type ClipInput } from "./selection/finalize";
import { DEFAULT_SCORE_WEIGHTS, scoreWeightsSchema, type ScoreWeights } from "./selection/score";
import { usageDate } from "./jobs";

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
  /** Few-shot examples from past clips (SPEC §9); filled from Milestone 7. */
  fewShot: { hook: string; firstLine: string; lengthSec: number; views: number }[];
}

export function getSourceContext(db: Db, sourceId: string): SourceContext | null {
  const src = db.select().from(sources).where(eq(sources.id, sourceId)).get();
  if (!src?.campaignId) return null;
  const camp = db.select().from(campaigns).where(eq(campaigns.id, src.campaignId)).get();
  if (!camp) return null;
  return {
    sourceId,
    campaign: { id: camp.id, name: camp.name, niche: camp.niche, config: campaignConfigSchema.parse(camp.config) },
    scoreWeights: getScoreWeights(db),
    fewShot: [],
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
