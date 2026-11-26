import { asc } from "drizzle-orm";
import { getScoreWeights, loadEnv } from "@clip/shared";
import { schema } from "@clip/shared/db";
import { OperatorsForm, WeightsForm } from "@/components/SettingsForms";
import { getDb } from "@/lib/db";

export const dynamic = "force-dynamic";

const box = "rounded-lg border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-900";

/** SPEC §11 Settings: operators, score weights; machine settings come from .env (shown read-only). */
export default function SettingsPage() {
  const db = getDb();
  const env = loadEnv();
  const operators = db.select().from(schema.operators).orderBy(asc(schema.operators.name)).all();
  const rows: [string, string][] = [
    ["Transcription order", env.TRANSCRIBE_ORDER],
    ["Deepgram", env.DEEPGRAM_API_KEY ? `key set · ${env.DEEPGRAM_MODEL} · cap ${env.DEEPGRAM_DAILY_CAP_MIN} min/day` : "no key (captions / Whisper only)"],
    ["LLM scout / editor", `${env.LLM_SCOUT_MODEL ?? "—"} / ${env.LLM_EDITOR_MODEL ?? "—"} (thinking ${env.LLM_SCOUT_REASONING} / ${env.LLM_EDITOR_REASONING})`],
    ["Video encoder", `${env.VIDEO_ENCODER} (libx264 fallback) · ${env.OUTPUT_FPS} fps · ${env.TARGET_LUFS} LUFS`],
    ["Delivery", env.DRIVE_ROOT ? `storage/out + Drive: ${env.DRIVE_ROOT}` : "storage/out (set DRIVE_ROOT to also copy to Google Drive)"],
    ["Cleanup", `sources after ${env.KEEP_SOURCES_DAYS} days, rejected clips after ${env.KEEP_REJECTED_DAYS} days, delivered clips' work files after 2 days`],
  ];
  return (
    <div className="space-y-6">
      <h1 className="text-xl font-semibold">Settings</h1>
      <section className={box}>
        <h2 className="mb-1 text-sm font-medium text-zinc-500">Operators</h2>
        <p className="mb-3 text-xs text-zinc-500">Approved clips go to storage/out/&lt;operator&gt;/… and, when DRIVE_ROOT is set, to DRIVE_ROOT/&lt;Drive folder&gt;/….</p>
        <OperatorsForm operators={operators} />
      </section>
      <section className={box}>
        <h2 className="mb-1 text-sm font-medium text-zinc-500">Clip score weights</h2>
        <p className="mb-3 text-xs text-zinc-500">How the editor model&apos;s per-criterion scores combine into the clip score (SPEC §8.3).</p>
        <WeightsForm weights={getScoreWeights(db)} />
      </section>
      <section className={box}>
        <h2 className="mb-2 text-sm font-medium text-zinc-500">Machine settings (from .env, restart to change)</h2>
        <table className="text-sm">
          <tbody>
            {rows.map(([k, v]) => (
              <tr key={k}>
                <td className="py-0.5 pr-4 text-zinc-500">{k}</td>
                <td>{v}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <p className="mt-2 text-xs text-zinc-500">
          Health checks for FFmpeg / QSV, keys and models: run <code>pnpm run doctor</code>.
        </p>
      </section>
    </div>
  );
}
