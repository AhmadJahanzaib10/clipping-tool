import { eq } from "drizzle-orm";
import { nanoid } from "nanoid";
import type { Db } from "./db/client";
import { campaigns, operators } from "./db/schema";
import { campaignConfigSchema, type CampaignConfigInput } from "./schemas/campaign";

const SEED_OPERATORS = [
  { name: "Operator One", slug: "operator-one", driveFolder: "operator-one" },
  { name: "Operator Two", slug: "operator-two", driveFolder: "operator-two" },
];

const SEED_CAMPAIGN: { name: string; slug: string; niche: string; ratePer1k: number; allowedPlatforms: string[]; config: CampaignConfigInput } = {
  name: "Example Podcast Campaign",
  slug: "example-podcast",
  niche: "business & entrepreneurship podcast",
  ratePer1k: 1.0,
  allowedPlatforms: ["tiktok", "instagram", "youtube"],
  config: {
    requiredHashtags: ["#examplepodcast"],
    requiredMentions: ["@examplepodcast"],
    briefNotes: "Clips must be self-contained. Credit the show in every caption.",
  },
};

/** Idempotent seed: 2 operators, 1 campaign (matched by slug). Returns how many rows were inserted. */
export function seedDb(db: Db, now: Date = new Date()): { operators: number; campaigns: number } {
  const ts = now.toISOString();
  let ops = 0;
  let camps = 0;
  db.transaction((tx) => {
    for (const op of SEED_OPERATORS) {
      if (tx.select().from(operators).where(eq(operators.slug, op.slug)).get()) continue;
      tx.insert(operators).values({ id: nanoid(), ...op, active: true, createdAt: ts }).run();
      ops++;
    }
    if (!tx.select().from(campaigns).where(eq(campaigns.slug, SEED_CAMPAIGN.slug)).get()) {
      tx.insert(campaigns)
        .values({
          id: nanoid(),
          ...SEED_CAMPAIGN,
          config: campaignConfigSchema.parse(SEED_CAMPAIGN.config),
          active: true,
          createdAt: ts,
          updatedAt: ts,
        })
        .run();
      camps++;
    }
  });
  return { operators: ops, campaigns: camps };
}
