import fs from "node:fs";
import { desc, eq } from "drizzle-orm";
import { loadEnv, taskCounts } from "@clip/shared";
import { schema } from "@clip/shared/db";
import { getDb } from "@/lib/db";

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
  const { operators, campaigns, sources, tasks, usage } = schema;

  const counts = taskCounts(db);
  const ops = db.select().from(operators).where(eq(operators.active, true)).all();
  const camps = db.select().from(campaigns).where(eq(campaigns.active, true)).all();
  const recentSources = db.select().from(sources).orderBy(desc(sources.createdAt)).limit(10).all();
  const running = db.select().from(tasks).where(eq(tasks.status, "running")).all();
  const failed = db.select().from(tasks).where(eq(tasks.status, "failed")).orderBy(desc(tasks.updatedAt)).limit(10).all();
  const today = new Date().toISOString().slice(0, 10);
  const usageToday = db.select().from(usage).where(eq(usage.date, today)).get();
  const deepgramMin = (usageToday?.deepgramSeconds ?? 0) / 60;
  const freeGb = freeDiskGb(env.STORAGE_DIR);
  const workers = [...new Set(running.map((t) => t.workerId).filter(Boolean))];

  return (
    <div className="space-y-6">
      <h1 className="text-xl font-semibold">Overview</h1>

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
        <Card title="Deepgram today">
          <Stat label={`minutes of ${env.DEEPGRAM_DAILY_CAP_MIN} cap`} value={deepgramMin.toFixed(1)} />
        </Card>
        <Card title="Disk">
          <Stat label="GB free on storage drive" value={freeGb === null ? "?" : freeGb.toFixed(0)} />
        </Card>
      </div>

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
                  <td className="py-1">{s.title ?? s.url ?? s.id}</td>
                  <td>{s.status}</td>
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
              <li key={t.id}>
                <span className="font-mono">{t.type}</span> <span className="text-zinc-500">({t.attempts} attempts)</span>: {t.error}
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}
