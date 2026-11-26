import Link from "next/link";
import { asc } from "drizzle-orm";
import { schema } from "@clip/shared/db";
import { getDb } from "@/lib/db";

export const dynamic = "force-dynamic";

export default function CampaignsPage() {
  const rows = getDb().select().from(schema.campaigns).orderBy(asc(schema.campaigns.name)).all();
  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-semibold">Campaigns</h1>
        <Link href="/campaigns/new" className="rounded-md bg-zinc-900 px-3 py-1.5 text-sm font-medium text-white dark:bg-zinc-100 dark:text-zinc-900">
          New campaign
        </Link>
      </div>
      <ul className="space-y-2">
        {rows.map((c) => (
          <li key={c.id} className="rounded-lg border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-900">
            <Link href={`/campaigns/${c.id}`} className="font-medium hover:underline">
              {c.name}
            </Link>
            {!c.active && <span className="ml-2 text-xs text-zinc-500">(inactive)</span>}
            <div className="text-xs text-zinc-500">
              {c.niche || "no niche"} · {c.config.minLengthSec}–{c.config.maxLengthSec} s · {c.config.captionPreset} · SFX {c.config.sfx.intensity} ({c.config.sfx.categories.join(", ")})
              {c.config.requiredHashtags.length ? ` · ${c.config.requiredHashtags.join(" ")}` : ""}
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}
