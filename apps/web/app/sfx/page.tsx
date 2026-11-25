import { asc } from "drizzle-orm";
import { schema } from "@clip/shared/db";
import { SfxLibrary } from "@/components/SfxLibrary";
import { getDb } from "@/lib/db";

export const dynamic = "force-dynamic";

/** SFX library browser (SPEC §10.4): preview, enable/disable, default gain, tags, rescan. */
export default function SfxPage() {
  const sounds = getDb()
    .select({
      id: schema.sfx.id,
      category: schema.sfx.category,
      file: schema.sfx.file,
      name: schema.sfx.name,
      durationSec: schema.sfx.durationSec,
      peakDb: schema.sfx.peakDb,
      lufs: schema.sfx.lufs,
      tags: schema.sfx.tags,
      defaultGainDb: schema.sfx.defaultGainDb,
      enabled: schema.sfx.enabled,
      missing: schema.sfx.missing,
      cachedPath: schema.sfx.cachedPath,
    })
    .from(schema.sfx)
    .orderBy(asc(schema.sfx.category), asc(schema.sfx.file))
    .all();
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-semibold">Sound effects</h1>
        <p className="text-sm text-zinc-500">
          Files in <code>assets/sfx/&lt;category&gt;/</code>. Rendering uses normalized copies (short sounds peak −6 dBFS, longer ones −20 LUFS). Only add sounds the team has the rights to use.
        </p>
      </div>
      <SfxLibrary sounds={sounds} />
    </div>
  );
}
