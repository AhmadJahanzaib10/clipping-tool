import { eq } from "drizzle-orm";
import { nanoid } from "nanoid";
import { z } from "zod";
import type { Db } from "./db/client";
import { campaigns, operators, settings, type Campaign, type Operator } from "./db/schema";
import { slugify } from "./review";
import { campaignConfigSchema, PLATFORMS } from "./schemas/campaign";
import { scoreWeightsSchema } from "./selection/score";
import { ReviewError } from "./reviewDb";

/** Campaigns, operators and settings management (SPEC §11 Campaigns / Settings pages). */

export const campaignInputSchema = z.object({
  name: z.string().trim().min(1).max(100),
  niche: z.string().trim().max(200).default(""),
  ratePer1k: z.number().min(0).max(1000).nullable().default(null),
  allowedPlatforms: z.array(z.enum(PLATFORMS)).min(1).default([...PLATFORMS]),
  config: campaignConfigSchema,
  active: z.boolean().default(true),
});
export type CampaignInput = z.input<typeof campaignInputSchema>;

function uniqueSlug(db: Db, base: string, table: typeof campaigns | typeof operators, selfId?: string): string {
  let slug = slugify(base, 50);
  for (let n = 2; ; n++) {
    const hit = db.select({ id: table.id }).from(table).where(eq(table.slug, slug)).get();
    if (!hit || hit.id === selfId) return slug;
    slug = `${slugify(base, 46)}-${n}`;
  }
}

export function createCampaign(db: Db, input: CampaignInput, now: Date = new Date()): Campaign {
  const c = campaignInputSchema.parse(input);
  const ts = now.toISOString();
  return db
    .insert(campaigns)
    .values({ id: nanoid(), ...c, slug: uniqueSlug(db, c.name, campaigns), createdAt: ts, updatedAt: ts })
    .returning()
    .get();
}

export function updateCampaign(db: Db, id: string, input: Partial<CampaignInput>, now: Date = new Date()): Campaign {
  const cur = db.select().from(campaigns).where(eq(campaigns.id, id)).get();
  if (!cur) throw new ReviewError("campaign not found", 404);
  const merged = campaignInputSchema.parse({ ...cur, ...input, config: input.config ?? cur.config });
  return db.update(campaigns).set({ ...merged, updatedAt: now.toISOString() }).where(eq(campaigns.id, id)).returning().get()!;
}

export const operatorInputSchema = z.object({
  name: z.string().trim().min(1).max(80),
  driveFolder: z.string().trim().max(120).nullable().default(null),
  active: z.boolean().default(true),
});

export function createOperator(db: Db, input: z.input<typeof operatorInputSchema>, now: Date = new Date()): Operator {
  const o = operatorInputSchema.parse(input);
  return db
    .insert(operators)
    .values({ id: nanoid(), ...o, slug: uniqueSlug(db, o.name, operators), createdAt: now.toISOString() })
    .returning()
    .get();
}

export function updateOperator(db: Db, id: string, input: Partial<z.input<typeof operatorInputSchema>>): Operator {
  const cur = db.select().from(operators).where(eq(operators.id, id)).get();
  if (!cur) throw new ReviewError("operator not found", 404);
  const o = operatorInputSchema.parse({ ...cur, ...input });
  return db.update(operators).set(o).where(eq(operators.id, id)).returning().get()!;
}

export function setScoreWeights(db: Db, w: z.input<typeof scoreWeightsSchema>) {
  const value = scoreWeightsSchema.parse(w);
  db.insert(settings).values({ key: "scoreWeights", value }).onConflictDoUpdate({ target: settings.key, set: { value } }).run();
  return value;
}

/** Overlay PNGs are stored in assets/overlays/ under a safe name. */
export function overlayFileName(original: string): string {
  const base = original.replace(/\.[^.]+$/, "");
  return `${slugify(base, 50)}.png`;
}
