import fs from "node:fs";
import Link from "next/link";
import { desc, eq } from "drizzle-orm";
import { folderBytes, getUsage, hookInUse, loadEnv, performanceTables, taskCounts } from "@clip/shared";
import { schema } from "@clip/shared/db";
import { getDb } from "@/lib/db";
import { RetryButton } from "@/components/RetryButton";

export const dynamic = "force-dynamic";

function freeDiskGb(dir: string): number | null {
  try {
    fs.mkdirSync(dir, { recursive: true });
    const s = fs.statfsSync(dir);
    return (s.bavail * s.bsize) / 1024 ** 3;
  } catch {
    return null;
  }
}

function Card({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="rounded-lg border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-900">
      <h2 className="mb-3 text-sm font-medium text-zinc-500 dark:text-zinc-400">{title}</h2>
      {children}
    </section>
  );
}

function Stat({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div>
      <div className="text-2xl font-semibold tabular-nums">{value}</div>
      <div className="text-xs text-zinc-500">{label}</div>
    </div>
  );
}

export default function OverviewPage() {
  const env = loadEnv();
  const db = getDb();
  const { operators, campaigns, sources, tasks } = schema;

  const counts = taskCounts(db);
  const ops = db.select().from(operators).where(eq(operators.active, true)).all();
  const camps = db.select().from(campaigns).where(eq(campaigns.active, true)).all();
  const recentSources = db.select().from(sources).orderBy(desc(sources.createdAt)).limit(10).all();
  const running = db.select().from(tasks).where(eq(tasks.status, "running")).all();
  const failed = db.select().from(tasks).where(eq(tasks.status, "failed")).orderBy(desc(tasks.updatedAt)).limit(10).all();
  const usageToday = getUsage(db);
  const deepgramMin = usageToday.deepgramSeconds / 60;
  const freeGb = freeDiskGb(env.STORAGE_DIR);
  const workers = [...new Set(running.map((t) => t.workerId).filter(Boolean))];
  const storageGb = folderBytes(env.STORAGE_DIR) / 1024 ** 3;
  // Clips waiting for review, grouped by operator (SPEC §11 Overview).
  const toReview = db.select().from(schema.clips).where(eq(schema.clips.status, "rendered")).orderBy(desc(schema.clips.score)).all();
  const opName = new Map(ops.map((o) => [o.id, o.name]));
  const reviewByOp = new Map<string, typeof toReview>();
  for (const c of toReview) {
    const k = opName.get(c.operatorId ?? "") ?? "Unassigned";
    reviewByOp.set(k, [...(reviewByOp.get(k) ?? []), c]);
  }
  const perf = performanceTables(db);

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-semibold">Overview</h1>
        <Link href="/jobs/new" className="rounded-md bg-zinc-900 px-3 py-1.5 text-sm font-medium text-white dark:bg-zinc-100 dark:text-zinc-900">
          New job
        </Link>
      </div>

      <div className="grid grid-cols-2 gap-4 md:grid-cols-4">
        <Card title="Tasks">
          <div className="grid grid-cols-2 gap-3">
            <Stat label="pending" value={counts.pending} />
            <Stat label="running" value={counts.running} />
            <Stat label="done" value={counts.done} />
            <Stat label="failed" value={counts.failed} />
          </div>
        </Card>
        <Card title="Workers">
          <Stat label="active (holding a lease)" value={workers.length} />
          <ul className="mt-2 text-xs text-zinc-500">
            {running.map((t) => (
              <li key={t.id}>
                {t.workerId}: {t.type}
              </li>
            ))}
          </ul>
        </Card>
        <Card title="Usage today">
          <Stat label={`minutes of ${env.DEEPGRAM_DAILY_CAP_MIN} cap (UTC day)`} value={deepgramMin.toFixed(1)} />
          <div className="mt-2 h-1.5 rounded bg-zinc-100 dark:bg-zinc-800">
            <div className="h-1.5 rounded bg-blue-600" style={{ width: `${Math.min(100, (deepgramMin / env.DEEPGRAM_DAILY_CAP_MIN) * 100)}%` }} />
          </div>
          {!env.DEEPGRAM_API_KEY && <p className="mt-2 text-xs text-zinc-500">No API key: transcription uses captions or Whisper.</p>}
          <p className="mt-2 text-xs text-zinc-500">
            LLM today: {usageToday.llmCalls} calls, {(usageToday.llmTokensIn / 1000).toFixed(0)}k in / {(usageToday.llmTokensOut / 1000).toFixed(0)}k out
          </p>
        </Card>
        <Card title="Disk">
          <Stat label="GB free on storage drive" value={freeGb === null ? "?" : freeGb.toFixed(0)} />
          <p className="mt-2 text-xs text-zinc-500">storage/ uses {storageGb.toFixed(1)} GB (cleanup runs daily)</p>
        </Card>
      </div>

      <Card title={`Clips awaiting review (${toReview.length})`}>
        {toReview.length === 0 ? (
          <p className="text-sm text-zinc-500">Nothing to review.</p>
        ) : (
          <div className="grid gap-4 md:grid-cols-2">
            {[...reviewByOp.entries()].map(([op, list]) => (
              <div key={op}>
                <h3 className="mb-1 text-sm font-medium">
                  {op} <span className="text-zinc-500">({list.length})</span>
                </h3>
                <ul className="space-y-0.5 text-sm">
                  {list.slice(0, 8).map((c) => (
                    <li key={c.id}>
                      <Link className="hover:underline" href={`/clips/${c.id}`}>
                        <span className="tabular-nums text-zinc-500">{c.score?.toFixed(0)}</span> {hookInUse(c)}
                      </Link>
                    </li>
                  ))}
                  {list.length > 8 && <li className="text-xs text-zinc-500">+{list.length - 8} more</li>}
                </ul>
              </div>
            ))}
          </div>
        )}
      </Card>

      <Card title="What performs (views at 72 h)">
        {perf.total === 0 ? (
          <p className="text-sm text-zinc-500">Enter views at 72 h on posted clips (clip page) to see which hook angles and caption styles work. The best ones also become examples for new hooks.</p>
        ) : (
          <div className="grid gap-6 md:grid-cols-2">
            {(
              [
                ["Hook angle", perf.byAngle],
                ["Caption style", perf.byPreset],
              ] as const
            ).map(([title, rows]) => (
              <table key={title} className="w-full text-left text-sm">
                <thead className="text-xs text-zinc-500">
                  <tr>
                    <th className="py-1">{title}</th>
                    <th>Clips</th>
                    <th>Avg views</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r) => (
                    <tr key={r.key} className="border-t border-zinc-100 dark:border-zinc-800">
                      <td className="py-1">{r.key}</td>
                      <td className="tabular-nums">{r.clips}</td>
                      <td className="tabular-nums">{r.avgViews.toLocaleString("en-US")}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            ))}
          </div>
        )}
      </Card>

      <div className="grid gap-4 md:grid-cols-2">
        <Card title="Operators">
          <ul className="space-y-1 text-sm">
            {ops.map((o) => (
              <li key={o.id}>{o.name}</li>
            ))}
            {ops.length === 0 && <li className="text-zinc-500">None yet. Run `pnpm db:seed`.</li>}
          </ul>
        </Card>
        <Card title="Campaigns">
          <ul className="space-y-1 text-sm">
            {camps.map((c) => (
              <li key={c.id}>
                {c.name} <span className="text-zinc-500">· {c.niche}</span>
              </li>
            ))}
            {camps.length === 0 && <li className="text-zinc-500">None yet. Run `pnpm db:seed`.</li>}
          </ul>
        </Card>
      </div>

      <Card title="Recent sources">
        {recentSources.length === 0 ? (
          <p className="text-sm text-zinc-500">No sources yet.</p>
        ) : (
          <table className="w-full text-left text-sm">
            <thead className="text-xs text-zinc-500">
              <tr>
                <th className="py-1">Title / URL</th>
                <th>Status</th>
                <th>Created</th>
              </tr>
            </thead>
            <tbody>
              {recentSources.map((s) => (
                <tr key={s.id} className="border-t border-zinc-100 dark:border-zinc-800">
                  <td className="py-1">
                    <Link className="hover:underline" href={`/jobs/${s.id}`}>
                      {s.title ?? s.url ?? s.id}
                    </Link>
                  </td>
                  <td>
                    {s.status}
                    {s.transcriptProvider ? <span className="text-zinc-500"> · {s.transcriptProvider}</span> : null}
                  </td>
                  <td className="text-zinc-500">{s.createdAt.slice(0, 16).replace("T", " ")}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>

      <Card title="Failed tasks">
        {failed.length === 0 ? (
          <p className="text-sm text-zinc-500">No failed tasks.</p>
        ) : (
          <ul className="space-y-1 text-sm">
            {failed.map((t) => (
              <li key={t.id} className="flex items-start gap-3">
                <RetryButton taskId={t.id} />
                <span>
                  <span className="font-mono">{t.type}</span> <span className="text-zinc-500">({t.attempts} attempts)</span>: {t.error?.split("\n")[0]}
                  {t.sourceId && (
                    <Link className="ml-2 text-zinc-500 underline" href={`/jobs/${t.sourceId}`}>
                      job
                    </Link>
                  )}
                </span>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}
