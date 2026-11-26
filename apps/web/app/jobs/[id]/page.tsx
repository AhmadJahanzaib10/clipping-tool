import fs from "node:fs";
import { notFound } from "next/navigation";
import { clipFiles, jobDetail, loadEnv, planSchema, sectionInfoSchema, sourceClips, sourceFiles, transcriptSchema, type Plan, type SectionInfo, type Transcript } from "@clip/shared";
import { AutoRefresh } from "@/components/AutoRefresh";
import { getDb } from "@/lib/db";

export const dynamic = "force-dynamic";

const ACTIVE = new Set(["queued", "ingesting", "transcribing", "selecting", "fetching", "clipping"]);
const STAGE_ORDER = ["INGEST", "TRANSCRIBE", "SCOUT", "EDIT", "FETCH_SECTIONS", "ANALYZE", "PREP_CLIP", "RENDER_BASE", "COMPOSE", "DELIVER", "CLEANUP"];
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

function readJson<T>(file: string, parse: (v: unknown) => T): T | null {
  try {
    return parse(JSON.parse(fs.readFileSync(file, "utf8")));
  } catch {
    return null;
  }
}
function clipArtifacts(clipId: string): { plan: Plan | null; section: SectionInfo | null } {
  const f = clipFiles(loadEnv().STORAGE_DIR, clipId);
  return { plan: readJson(f.plan, (v) => planSchema.parse(v)), section: readJson(f.sectionInfo, (v) => sectionInfoSchema.parse(v)) };
}
const LAYOUT_STYLE: Record<string, string> = {
  single: "bg-blue-100 text-blue-800 dark:bg-blue-950 dark:text-blue-300",
  split: "bg-purple-100 text-purple-800 dark:bg-purple-950 dark:text-purple-300",
  fit: "bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-300",
};

const fmt = (sec: number) => `${Math.floor(sec / 60)}:${String(Math.floor(sec % 60)).padStart(2, "0")}`;

export default async function JobPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const d = jobDetail(getDb(), id);
  if (!d) notFound();
  const { source, events, tasks } = d;
  const transcript = readTranscript(id);
  const clips = sourceClips(getDb(), id);
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
          {/* One row per stage (in pipeline order) with counts per status; stages repeat per clip and on re-runs. */}
          <ul className="space-y-1 text-sm">
            {[...new Set(tasks.map((t) => t.type))]
              .sort((a, b) => STAGE_ORDER.indexOf(a) - STAGE_ORDER.indexOf(b))
              .map((type) => {
                const ofType = tasks.filter((t) => t.type === type);
                const counts = (["running", "pending", "failed", "done"] as const).map((st) => [st, ofType.filter((t) => t.status === st).length] as const).filter(([, n]) => n > 0);
                return (
                  <li key={type} className="flex justify-between gap-2">
                    <span className="font-mono">{type}</span>
                    <span className="text-zinc-500">
                      {counts.map(([st, n]) => (
                        <span key={st} className={st === "failed" ? "text-red-600" : st === "running" ? "text-blue-600" : ""}>
                          {" "}
                          {n} {st}
                        </span>
                      ))}
                    </span>
                  </li>
                );
              })}
          </ul>
        </section>
      </div>

      {clips.length > 0 && (
        <section className="rounded-lg border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-900">
          <h2 className="mb-3 text-sm font-medium text-zinc-500">Clips ({clips.length})</h2>
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead className="text-xs text-zinc-500">
                <tr>
                  <th className="py-1 pr-3">#</th>
                  <th className="pr-3">Clip</th>
                  <th className="pr-3">Score</th>
                  <th className="pr-3">Time</th>
                  <th className="pr-3">Length</th>
                  <th className="pr-3">Hooks (A / B)</th>
                  <th className="pr-3">Plan</th>
                  <th>Title · why</th>
                </tr>
              </thead>
              <tbody>
                {clips.map((c) => (
                  <tr key={c.id} className="border-t border-zinc-100 align-top dark:border-zinc-800">
                    <td className="py-2 pr-3 tabular-nums">{c.rank}</td>
                    <td className="py-2 pr-3">
                      {c.outputPath ? (
                        <div className="w-24 space-y-1">
                          <video
                            className="aspect-[9/16] w-24 rounded bg-black"
                            src={`/api/files/${c.outputPath}`}
                            poster={c.thumbPath ? `/api/files/${c.thumbPath}?v=${c.composeVersion}` : undefined}
                            controls
                            preload="none"
                          />
                          <div className="flex flex-wrap gap-x-2 text-[11px] text-zinc-500">
                            <span>v{c.composeVersion}</span>
                            <a className="underline" href={`/api/files/${c.outputPath}?download=1`}>
                              mp4
                            </a>
                            {c.basePath && (
                              <a className="underline" href={`/api/files/${c.basePath}?download=1`} title="Clean version (no captions/SFX) for CapCut">
                                clean
                              </a>
                            )}
                            <a className="underline" href={`/api/files/clips/${c.id}/captions.srt?download=1`}>
                              srt
                            </a>
                          </div>
                        </div>
                      ) : (
                        <span className="text-xs text-zinc-400">{c.status === "rendering" ? "rendering…" : "—"}</span>
                      )}
                    </td>
                    <td className="pr-3 tabular-nums" title={c.scores ? Object.entries(c.scores).map(([k, v]) => `${k} ${v}`).join(", ") : ""}>
                      {c.score?.toFixed(0)}
                    </td>
                    <td className="whitespace-nowrap pr-3 tabular-nums">
                      {fmt(c.startSec)}–{fmt(c.endSec)}
                    </td>
                    <td className="pr-3 tabular-nums">{Math.round(c.endSec - c.startSec)} s</td>
                    <td className="pr-3">
                      <div className="font-medium">{c.hookA}</div>
                      <div className="text-zinc-500">{c.hookB}</div>
                    </td>
                    <td className="pr-3 text-xs">
                      {(() => {
                        const { plan, section } = clipArtifacts(c.id);
                        if (!plan) return <span className="text-zinc-400">{section ? "analyzing…" : "—"}</span>;
                        return (
                          <div className="space-y-0.5">
                            <span className={`rounded px-1.5 py-0.5 font-medium ${LAYOUT_STYLE[plan.layout]}`} title={plan.layoutReason}>
                              {plan.layout}
                            </span>
                            <div className="text-zinc-500">
                              {plan.duration.toFixed(1)} s{plan.stats.savedSec > 0 ? ` (−${plan.stats.savedSec} s)` : ""}
                              {plan.stats.coldOpen ? " · cold open" : ""}
                              {plan.zoom.length ? ` · ${plan.zoom.length} zoom` : ""}
                            </div>
                            {section && <div className="text-zinc-400">{(section.bytes / 1024 / 1024).toFixed(1)} MB {section.method}</div>}
                          </div>
                        );
                      })()}
                    </td>
                    <td>
                      <div>{c.title}</div>
                      <div className="text-xs text-zinc-500">{c.reason}</div>
                      {c.hashtags?.length ? <div className="text-xs text-blue-600">{c.hashtags.join(" ")}</div> : null}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}

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
