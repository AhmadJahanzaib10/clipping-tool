import fs from "node:fs";
import { notFound } from "next/navigation";
import { jobDetail, loadEnv, sourceFiles, transcriptSchema, type Transcript } from "@clip/shared";
import { AutoRefresh } from "@/components/AutoRefresh";
import { getDb } from "@/lib/db";

export const dynamic = "force-dynamic";

const ACTIVE = new Set(["queued", "ingesting", "transcribing"]);
const STAGES = ["queued", "ingesting", "transcribing", "selecting", "fetching", "clipping", "done"];
const levelColor: Record<string, string> = { error: "text-red-600", warn: "text-amber-600", info: "", debug: "text-zinc-400" };

function readTranscript(sourceId: string): Transcript | null {
  try {
    const raw = fs.readFileSync(sourceFiles(loadEnv().STORAGE_DIR, sourceId).transcript, "utf8");
    return transcriptSchema.parse(JSON.parse(raw));
  } catch {
    return null;
  }
}

const fmt = (sec: number) => `${Math.floor(sec / 60)}:${String(Math.floor(sec % 60)).padStart(2, "0")}`;

export default async function JobPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const d = jobDetail(getDb(), id);
  if (!d) notFound();
  const { source, events, tasks } = d;
  const transcript = readTranscript(id);
  const stageIdx = STAGES.indexOf(source.status);

  return (
    <div className="space-y-6">
      <AutoRefresh active={ACTIVE.has(source.status)} />
      <div>
        <h1 className="text-xl font-semibold">{source.title ?? source.url ?? "Upload"}</h1>
        <p className="text-sm text-zinc-500">
          {source.kind === "url" && source.url && (
            <a className="underline" href={source.url} target="_blank" rel="noreferrer">
              {source.url}
            </a>
          )}
          {source.durationSec ? ` · ${fmt(source.durationSec)}` : ""}
          {source.width ? ` · ${source.width}×${source.height}` : ""}
        </p>
      </div>

      <ol className="flex flex-wrap gap-2 text-xs">
        {STAGES.map((s, i) => (
          <li
            key={s}
            className={`rounded-full px-3 py-1 ${
              source.status === "failed"
                ? "bg-zinc-100 text-zinc-400 dark:bg-zinc-800"
                : i < stageIdx
                  ? "bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-300"
                  : i === stageIdx
                    ? "bg-blue-600 text-white"
                    : "bg-zinc-100 text-zinc-500 dark:bg-zinc-800"
            }`}
          >
            {s}
          </li>
        ))}
        {source.status === "failed" && <li className="rounded-full bg-red-600 px-3 py-1 text-white">failed</li>}
      </ol>
      {source.error && <pre className="whitespace-pre-wrap rounded-md bg-red-50 p-3 text-xs text-red-800 dark:bg-red-950 dark:text-red-200">{source.error}</pre>}

      <div className="grid gap-4 md:grid-cols-2">
        <section className="rounded-lg border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-900">
          <h2 className="mb-2 text-sm font-medium text-zinc-500">Transcript</h2>
          {transcript ? (
            <>
              <p className="mb-3 text-sm">
                <b>{transcript.provider}</b> ({transcript.quality}) · {transcript.words.length} words · {transcript.sentences.length} sentences ·{" "}
                {transcript.words.filter((w) => w.filler).length} fillers
              </p>
              <p className="max-h-72 overflow-y-auto text-sm leading-relaxed">
                {transcript.words.slice(0, 400).map((w, i) => (
                  <span key={i} title={`${w.s.toFixed(2)}–${w.e.toFixed(2)} s`} className={w.filler ? "text-zinc-400 line-through" : ""}>
                    {w.w}{" "}
                  </span>
                ))}
                {transcript.words.length > 400 && <span className="text-zinc-400">…</span>}
              </p>
            </>
          ) : (
            <p className="text-sm text-zinc-500">Not transcribed yet.</p>
          )}
        </section>

        <section className="rounded-lg border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-900">
          <h2 className="mb-2 text-sm font-medium text-zinc-500">Tasks</h2>
          <ul className="space-y-1 text-sm">
            {tasks.map((t) => (
              <li key={t.id} className="flex justify-between gap-2">
                <span className="font-mono">{t.type}</span>
                <span className="text-zinc-500">
                  {t.status}
                  {t.attempts > 1 ? ` (attempt ${t.attempts})` : ""}
                  {t.status === "pending" && t.type === "SCOUT" ? " · waits for Milestone 3" : ""}
                </span>
              </li>
            ))}
          </ul>
        </section>
      </div>

      <section className="rounded-lg border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-900">
        <h2 className="mb-2 text-sm font-medium text-zinc-500">Event log</h2>
        <ul className="space-y-1 font-mono text-xs">
          {events.map((e) => (
            <li key={e.id} className={levelColor[e.level]}>
              <span className="text-zinc-400">{e.createdAt.slice(11, 19)}</span> [{e.level}] {e.message}
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}
