"use client";

import { useRouter } from "next/navigation";
import { useMemo, useRef, useState } from "react";

export type SfxRow = {
  id: string;
  category: string;
  file: string;
  name: string;
  durationSec: number | null;
  peakDb: number | null;
  lufs: number | null;
  tags: string[];
  defaultGainDb: number;
  enabled: boolean;
  missing: boolean;
  cachedPath: string | null;
};

type ScanResult = {
  added: string[];
  updated: string[];
  unchanged: number;
  removed: string[];
  failed: { file: string; error: string }[];
  warnings: string[];
  ms: number;
};

async function patch(id: string, body: Partial<Pick<SfxRow, "enabled" | "defaultGainDb" | "tags">>) {
  const res = await fetch(`/api/sfx/${id}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  if (!res.ok) throw new Error((await res.json()).error ?? `HTTP ${res.status}`);
}

function Row({ s, onPlay }: { s: SfxRow; onPlay: (id: string) => void }) {
  const router = useRouter();
  const [gain, setGain] = useState(String(s.defaultGainDb));
  const [tags, setTags] = useState(s.tags.join(", "));
  const [err, setErr] = useState<string | null>(null);
  const save = async (body: Parameters<typeof patch>[1]) => {
    setErr(null);
    try {
      await patch(s.id, body);
      router.refresh();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    }
  };
  const usable = s.enabled && !s.missing && s.cachedPath;
  return (
    <li className={`flex flex-wrap items-center gap-3 border-t border-zinc-100 py-2 dark:border-zinc-800 ${usable ? "" : "opacity-50"}`}>
      <button
        type="button"
        disabled={!s.cachedPath}
        onClick={() => onPlay(s.id)}
        className="h-8 w-8 shrink-0 rounded-full bg-zinc-900 text-xs text-white disabled:opacity-30 dark:bg-zinc-100 dark:text-zinc-900"
        title="Preview (normalized)"
        aria-label={`Play ${s.name}`}
      >
        ▶
      </button>
      <div className="w-48 min-w-0">
        <div className="truncate text-sm font-medium" title={s.file}>
          {s.name}
        </div>
        <div className="text-xs text-zinc-500">
          {s.durationSec?.toFixed(2)} s · peak {s.peakDb?.toFixed(1) ?? "?"} dB{s.lufs !== null ? ` · ${s.lufs.toFixed(1)} LUFS` : ""}
          {s.missing ? " · file missing" : ""}
        </div>
      </div>
      {s.cachedPath ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={`/api/sfx/${s.id}?asset=waveform`} alt="" className="h-8 w-48 rounded bg-zinc-100 object-fill dark:bg-zinc-800" />
      ) : (
        <div className="h-8 w-48" />
      )}
      <label className="flex items-center gap-1 text-xs">
        <input type="checkbox" checked={s.enabled} onChange={(e) => save({ enabled: e.target.checked })} disabled={s.missing} />
        enabled
      </label>
      <label className="flex items-center gap-1 text-xs">
        gain
        <input
          className="w-14 rounded border border-zinc-300 bg-white px-1 py-0.5 text-right dark:border-zinc-700 dark:bg-zinc-900"
          value={gain}
          onChange={(e) => setGain(e.target.value)}
          onBlur={() => {
            const v = Number(gain);
            if (Number.isFinite(v) && v !== s.defaultGainDb) save({ defaultGainDb: v });
          }}
        />
        dB
      </label>
      <input
        className="min-w-0 flex-1 rounded border border-zinc-300 bg-white px-2 py-0.5 text-xs dark:border-zinc-700 dark:bg-zinc-900"
        placeholder="tags, comma separated"
        value={tags}
        onChange={(e) => setTags(e.target.value)}
        onBlur={() => {
          const next = tags.split(",").map((t) => t.trim()).filter(Boolean);
          if (next.join() !== s.tags.join()) save({ tags: next });
        }}
      />
      {err && <span className="w-full text-xs text-red-600">{err}</span>}
    </li>
  );
}

export function SfxLibrary({ sounds }: { sounds: SfxRow[] }) {
  const router = useRouter();
  const [cat, setCat] = useState<string>("all");
  const [scan, setScan] = useState<ScanResult | null>(null);
  const [scanning, setScanning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const audio = useRef<HTMLAudioElement | null>(null);

  const categories = useMemo(() => {
    const m = new Map<string, number>();
    for (const s of sounds) if (!s.missing) m.set(s.category, (m.get(s.category) ?? 0) + 1);
    return [...m.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  }, [sounds]);
  const shown = sounds.filter((s) => (cat === "all" || s.category === cat) && (!s.missing || cat === "all"));
  const grouped = useMemo(() => {
    const g = new Map<string, SfxRow[]>();
    for (const s of shown) g.set(s.category, [...(g.get(s.category) ?? []), s]);
    return [...g.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  }, [shown]);

  const rescan = async () => {
    setScanning(true);
    setError(null);
    try {
      const res = await fetch("/api/sfx/scan", { method: "POST" });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`);
      setScan(body);
      router.refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setScanning(false);
    }
  };
  const play = (id: string) => {
    audio.current?.pause();
    audio.current = new Audio(`/api/sfx/${id}?asset=audio`);
    void audio.current.play();
  };

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <button
          onClick={rescan}
          disabled={scanning}
          className="rounded-md bg-zinc-900 px-3 py-1.5 text-sm font-medium text-white disabled:opacity-50 dark:bg-zinc-100 dark:text-zinc-900"
        >
          {scanning ? "Scanning…" : "Rescan"}
        </button>
        <div className="flex flex-wrap gap-1 text-xs">
          {[["all", sounds.filter((s) => !s.missing).length] as const, ...categories].map(([c, n]) => (
            <button
              key={c}
              onClick={() => setCat(c)}
              className={`rounded-full px-3 py-1 ${cat === c ? "bg-blue-600 text-white" : "bg-zinc-100 dark:bg-zinc-800"}`}
            >
              {c} <span className="opacity-70">{n}</span>
            </button>
          ))}
        </div>
      </div>
      {scan && (
        <p className="text-sm text-zinc-600 dark:text-zinc-400">
          Scan in {scan.ms} ms: {scan.added.length} new, {scan.updated.length} updated, {scan.unchanged} unchanged, {scan.removed.length} removed
          {scan.failed.length ? `, ${scan.failed.length} failed (${scan.failed.map((f) => `${f.file}: ${f.error}`).join("; ")})` : ""}.
          {scan.warnings.map((w) => (
            <span key={w} className="block text-amber-600">
              {w}
            </span>
          ))}
        </p>
      )}
      {error && <p className="text-sm text-red-600">{error}</p>}
      {sounds.length === 0 ? (
        <div className="rounded-lg border border-dashed border-zinc-300 p-6 text-sm text-zinc-600 dark:border-zinc-700 dark:text-zinc-400">
          No sounds yet. Put files your team has the rights to use into <code>assets/sfx/&lt;category&gt;/</code> (whoosh, pop, impact, riser, ding, transition,
          glitch, click, misc; new folders become new categories) as mp3, wav, ogg or m4a, then press Rescan.
        </div>
      ) : (
        grouped.map(([c, rows]) => (
          <section key={c} className="rounded-lg border border-zinc-200 bg-white px-4 py-2 dark:border-zinc-800 dark:bg-zinc-900">
            <h2 className="py-1 text-sm font-medium">
              {c} <span className="text-zinc-500">({rows.length})</span>
            </h2>
            <ul>
              {rows.map((s) => (
                <Row key={s.id} s={s} onPlay={play} />
              ))}
            </ul>
          </section>
        ))
      )}
    </div>
  );
}
