import Link from "next/link";
import { notFound } from "next/navigation";
import { eq } from "drizzle-orm";
import { availableSfx } from "@clip/shared";
import { schema } from "@clip/shared/db";
import { CampaignForm } from "@/components/CampaignForm";
import { getDb } from "@/lib/db";

export const dynamic = "force-dynamic";

/** Campaign brief (SPEC §6.1) — `/campaigns/new` creates one. */
export default async function CampaignPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const db = getDb();
  const campaign = id === "new" ? null : db.select().from(schema.campaigns).where(eq(schema.campaigns.id, id)).get();
  if (id !== "new" && !campaign) notFound();
  const sfxCategories = [...new Set(availableSfx(db).map((s) => s.category))].sort();
  return (
    <div className="space-y-6">
      <div>
        <Link href="/campaigns" className="text-sm text-zinc-500 underline">
          ← Campaigns
        </Link>
        <h1 className="text-xl font-semibold">{campaign ? campaign.name : "New campaign"}</h1>
      </div>
      <CampaignForm campaign={campaign ? { id: campaign.id, name: campaign.name, niche: campaign.niche, active: campaign.active, config: campaign.config } : null} sfxCategories={sfxCategories} />
    </div>
  );
}
