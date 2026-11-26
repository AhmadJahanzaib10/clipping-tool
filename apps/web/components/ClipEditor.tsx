"use client";

import { BASE_EDIT_FIELDS } from "@clip/shared/edit";
import type { ClipEdit } from "@clip/shared/edit";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ClipDetail } from "@/lib/clip-detail";

/** SPEC §11 clip review / editor. */

type Text = { title: string; captionTiktok: string; captionInstagram: string; captionYoutube: string; hashtags: string; hookA: string; hookB: string };
type Cue = ClipEdit["sfxCues"][number];

const PRESETS = ["bold-yellow", "white-box", "clean-white"];
const box = "rounded-lg border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-900";
const input = "w-full rounded-md border border-zinc-300 bg-white px-2 py-1 text-sm dark:border-zinc-700 dark:bg-zinc-950";
const btn = "rounded-md border border-zinc-300 px-2 py-1 text-xs hover:bg-zinc-100 disabled:opacity-40 dark:border-zinc-700 dark:hover:bg-zinc-800";
const primary = "rounded-md bg-zinc-900 px-3 py-1.5 text-sm font-medium text-white disabled:opacity-40 dark:bg-zinc-100 dark:text-zinc-900";
const fmt = (s: number) => `${Math.floor(s / 60)}:${(s % 60).toFixed(1).padStart(4, "0")}`;
const same = (a: unknown, b: unknown) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

function textOf(c: ClipDetail["clip"]): Text {
  return {
    title: c.title ?? "",
    captionTiktok: c.captionTiktok ?? "",
    captionInstagram: c.captionInstagram ?? "",
    captionYoutube: c.captionYoutube ?? "",
    hashtags: (c.hashtags ?? []).join(" "),
    hookA: c.hookA ?? "",
    hookB: c.hookB ?? "",
  };
}
const tagsOf = (s: string) => s.split(/[\s,]+/).map((t) => t.trim()).filter(Boolean).map((t) => (t.startsWith("#") ? t : `#${t}`));

/** Client copy of the server rule (packages/shared/src/review.ts renderKindFor), for the button label only. */
function renderKind(prev: ClipEdit, next: ClipEdit, prevText: Text, nextText: Text): "base" | "compose" | "none" {
  if (BASE_EDIT_FIELDS.some((k) => !same(prev[k], next[k]))) return "base";
  if ((Object.keys(next) as (keyof ClipEdit)[]).some((k) => !(BASE_EDIT_FIELDS as readonly string[]).includes(k) && !same(prev[k], next[k]))) return "compose";
  const shown = next.hookChoice === "B" ? "hookB" : "hookA";
  if (!next.hookOverride?.trim() && prevText[shown] !== nextText[shown]) return "compose";
  return "none";
}

async function call(url: string, init?: RequestInit) {
  const res = await fetch(url, init);
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`);
  return body;
}

function CopyButton({ text }: { text: string }) {
  const [done, setDone] = useState(false);
  return (
    <button
      type="button"
      className={btn}
      onClick={async () => {
        await navigator.clipboard.writeText(text);
        setDone(true);
        setTimeout(() => setDone(false), 1200);
      }}
    >
      {done ? "Copied" : "Copy"}
    </button>
  );
}

export function ClipEditor({ d }: { d: ClipDetail }) {
  const router = useRouter();
  const savedEdit = d.clip.edit!;
  const savedText = useMemo(() => textOf(d.clip), [d.clip]);
  const [edit, setEdit] = useState<ClipEdit>(savedEdit);
  const [text, setText] = useState<Text>(savedText);
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<{ kind: "ok" | "err"; text: string } | null>(null);
  const [compare, setCompare] = useState(false);
  const [version, setVersion] = useState(d.versions[0]?.v ?? 0);
  const [editWords, setEditWords] = useState(false);
  const [picker, setPicker] = useState(false);
  const [pickCat, setPickCat] = useState("all");
  const [views, setViews] = useState(String(d.clip.views72h ?? ""));
  const [platform, setPlatform] = useState(d.clip.viewsPlatform ?? "tiktok");
  const video = useRef<HTMLVideoElement>(null);
  const audio = useRef<HTMLAudioElement | null>(null);
  const upload = useRef<HTMLInputElement>(null);

  const dirty = !same(edit, savedEdit) || !same(text, savedText);
  const kind = renderKind(savedEdit, edit, savedText, text);
  const rendering = d.clip.status === "rendering" || d.pending.length > 0;
  const locked = d.clip.status === "approved";
  const cfg = d.campaign.config;

  // Pick up server changes (render finished, etc.) unless there are unsaved edits.
  useEffect(() => {
    if (!dirty) {
      setEdit(savedEdit);
      setText(savedText);
    }
    setVersion((v) => (d.versions.some((x) => x.v === v) ? (d.versions[0] && d.versions[0].v > v && !dirty ? d.versions[0].v : v) : (d.versions[0]?.v ?? 0)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [d]);
  useEffect(() => {
    if (!rendering) return;
    const t = setInterval(() => router.refresh(), 3000);
    return () => clearInterval(t);
  }, [rendering, router]);

  const set = <K extends keyof ClipEdit>(k: K, v: ClipEdit[K]) => setEdit((e) => ({ ...e, [k]: v }));
  const run = useCallback(
    async (label: string, fn: () => Promise<string | void>) => {
      setBusy(label);
      setMsg(null);
      try {
        const m = await fn();
        if (m) setMsg({ kind: "ok", text: m });
        router.refresh();
      } catch (e) {
        setMsg({ kind: "err", text: e instanceof Error ? e.message : String(e) });
      } finally {
        setBusy(null);
      }
    },
    [router],
  );

  const save = () =>
    run("save", async () => {
      const patch: Record<string, unknown> = {};
      if (!same(edit, savedEdit)) patch.edit = edit;
      for (const k of Object.keys(text) as (keyof Text)[]) if (text[k] !== savedText[k]) patch[k] = k === "hashtags" ? tagsOf(text.hashtags) : text[k];
      const r = await call(`/api/clips/${d.clip.id}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify(patch) });
      return r.render === "base" ? "Saved — full re-render queued" : r.render === "compose" ? "Saved — fast re-render queued" : "Saved";
    });
  const action = (path: string, label: string, done: string) => run(label, async () => (await call(`/api/clips/${d.clip.id}/${path}`, { method: "POST" }), done));

  // Keyboard: A approve, R reject, J/K next/prev clip (not while typing).
  const idx = d.siblings.findIndex((s) => s.id === d.clip.id);
  const prevClip = d.siblings[idx - 1];
  const nextClip = d.siblings[idx + 1];
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      if (t.closest("input, textarea, select, [contenteditable]") || e.ctrlKey || e.metaKey || e.altKey) return;
      const k = e.key.toLowerCase();
      if (k === "a" && !locked && !dirty && !rendering && d.clip.outputPath) action("approve", "approve", "Approved — delivering");
      else if (k === "r" && !locked) action("reject", "reject", "Rejected");
      else if (k === "j" && nextClip) router.push(`/clips/${nextClip.id}`);
      else if (k === "k" && prevClip) router.push(`/clips/${prevClip.id}`);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  const seek = (t: number) => {
    if (video.current) {
      video.current.currentTime = t;
      void video.current.play();
    }
  };
  const playSfx = (id: string) => {
    audio.current?.pause();
    audio.current = new Audio(`/api/sfx/${id}?asset=audio`);
    void audio.current.play();
  };

  // Trim helpers (source time): nudges and whole-sentence extend / shorten.
  const sent = d.sentences;
  const trim = (start: number, end: number) => set("trim", { start: Math.max(0, Math.round(start * 100) / 100), end: Math.round(end * 100) / 100 });
  const sentenceStartBefore = (t: number) => [...sent].reverse().find((s) => s.s < t - 0.05)?.s;
  const sentenceStartAfter = (t: number) => sent.find((s) => s.s > t + 0.05)?.s;
  const sentenceEndAfter = (t: number) => sent.find((s) => s.e > t + 0.05)?.e;
  const sentenceEndBefore = (t: number) => [...sent].reverse().find((s) => s.e < t - 0.05)?.e;

  // Word edits keyed by the word's index in the clip.
  const wordEdit = (i: number) => edit.wordEdits.find((w) => w.index === i);
  const setWordEdit = (i: number, patch: { text?: string; hidden?: boolean }) => {
    const rest = edit.wordEdits.filter((w) => w.index !== i);
    const next = { ...wordEdit(i), index: i, ...patch };
    if (!next.text && !next.hidden) set("wordEdits", rest);
    else set("wordEdits", [...rest, next].sort((a, b) => a.index - b.index));
  };

  // SFX cues: editing an automatic cue makes it manual so re-planning keeps it.
  const cues = [...edit.sfxCues].sort((a, b) => a.at - b.at);
  const lib = new Map(d.library.map((s) => [s.id, s]));
  const setCue = (id: string, patch: Partial<Cue>) => set("sfxCues", edit.sfxCues.map((c) => (c.id === id ? { ...c, ...patch, source: "manual" } : c)));
  const duration = d.plan?.duration ?? d.clip.endSec - d.clip.startSec;
  const track = useRef<HTMLDivElement>(null);
  const drag = (id: string) => (e: React.PointerEvent) => {
    const el = track.current;
    if (!el || locked) return;
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
    const move = (ev: PointerEvent) => {
      const r = el.getBoundingClientRect();
      const t = Math.min(duration, Math.max(0, ((ev.clientX - r.left) / r.width) * duration));
      setCue(id, { at: Math.round(t * 100) / 100 });
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };
  const addCue = (sfxId: string) => {
    const at = Math.round((video.current?.currentTime ?? 0) * 100) / 100;
    set("sfxCues", [...edit.sfxCues, { id: `m-${Date.now().toString(36)}`, sfxId, at, gainDb: cfg.sfx.gainDb, source: "manual" }]);
    setPicker(false);
  };

  const copyText = (caption: string) => {
    const tags = [...new Set([...cfg.requiredMentions, ...cfg.requiredHashtags, ...tagsOf(text.hashtags)])].filter((t) => !caption.toLowerCase().includes(t.toLowerCase()));
    return [caption.trim(), tags.join(" ")].filter(Boolean).join("\n\n");
  };

  const current = d.versions.find((v) => v.v === version);
  const previous = d.versions.find((v) => v.v < version);
  const scores = d.clip.scores;
  const statusColor = { approved: "bg-emerald-600", rejected: "bg-red-600", rendering: "bg-blue-600", rendered: "bg-zinc-700", candidate: "bg-zinc-500", failed: "bg-red-600" }[d.clip.status];

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        <Link className="text-sm text-zinc-500 underline" href={`/jobs/${d.source.id}`}>
          ← {d.source.title ?? "job"}
        </Link>
        <h1 className="text-lg font-semibold">
          Clip #{d.clip.rank} <span className="text-zinc-500">· score {d.clip.score?.toFixed(0)}</span>
        </h1>
        <span className={`rounded px-2 py-0.5 text-xs text-white ${statusColor}`}>{d.clip.status}</span>
        {rendering && <span className="text-xs text-blue-600">rendering… ({d.pending.map((p) => p.type).join(", ") || "queued"})</span>}
        <span className="ml-auto flex gap-2 text-xs text-zinc-500">
          {prevClip && (
            <Link className="underline" href={`/clips/${prevClip.id}`}>
              ← prev (K)
            </Link>
          )}
          {nextClip && (
            <Link className="underline" href={`/clips/${nextClip.id}`}>
              next (J) →
            </Link>
          )}
        </span>
      </div>
      {msg && <p className={`text-sm ${msg.kind === "ok" ? "text-emerald-600" : "text-red-600"}`}>{msg.text}</p>}

      <div className="grid gap-4 lg:grid-cols-[minmax(0,360px)_1fr]">
        {/* ---------- left: player, actions ---------- */}
        <div className="space-y-4">
          <section className={box}>
            {current ? (
              <div className={compare && previous ? "grid grid-cols-2 gap-2" : ""}>
                {compare && previous && (
                  <div>
                    <div className="mb-1 text-xs text-zinc-500">v{previous.v} (previous)</div>
                    <video className="aspect-[9/16] w-full rounded bg-black" src={`/api/files/${previous.path}`} controls preload="metadata" />
                  </div>
                )}
                <div>
                  {compare && previous && <div className="mb-1 text-xs text-zinc-500">v{current.v}</div>}
                  <video ref={video} key={current.path} className="aspect-[9/16] w-full rounded bg-black" src={`/api/files/${current.path}`} controls preload="metadata" />
                </div>
              </div>
            ) : (
              <div className="flex aspect-[9/16] items-center justify-center rounded bg-zinc-100 text-sm text-zinc-500 dark:bg-zinc-800">not rendered yet</div>
            )}
            <div className="mt-2 flex flex-wrap items-center gap-2 text-xs">
              {d.versions.length > 0 && (
                <select className="rounded border border-zinc-300 px-1 py-0.5 dark:border-zinc-700 dark:bg-zinc-950" value={version} onChange={(e) => setVersion(Number(e.target.value))}>
                  {d.versions.map((v) => (
                    <option key={v.v} value={v.v}>
                      v{v.v}
                    </option>
                  ))}
                </select>
              )}
              {d.versions.length > 1 && (
                <label className="flex items-center gap-1">
                  <input type="checkbox" checked={compare} onChange={(e) => setCompare(e.target.checked)} /> compare with previous
                </label>
              )}
              {d.clip.finalUploaded && <span className="rounded bg-amber-100 px-1.5 text-amber-800">uploaded final</span>}
            </div>
          </section>

          <section className={`${box} space-y-3`}>
            <div className="flex flex-wrap gap-2">
              {!locked ? (
                <>
                  <button className="rounded-md bg-emerald-600 px-3 py-1.5 text-sm font-medium text-white disabled:opacity-40" disabled={!!busy || dirty || rendering || !d.clip.outputPath} onClick={() => action("approve", "approve", "Approved — delivering")} title="A">
                    Approve (A)
                  </button>
                  <button className="rounded-md bg-red-600 px-3 py-1.5 text-sm font-medium text-white disabled:opacity-40" disabled={!!busy || d.clip.status === "rejected"} onClick={() => action("reject", "reject", "Rejected")} title="R">
                    Reject (R)
                  </button>
                </>
              ) : (
                <button className={btn} disabled={!!busy} onClick={() => action("reopen", "reopen", "Re-opened for editing")}>
                  Re-open for editing
                </button>
              )}
              {d.clip.status === "rejected" && (
                <button className={btn} onClick={() => action("reopen", "reopen", "Re-opened")}>
                  Undo reject
                </button>
              )}
            </div>
            {d.clip.deliveryPath && (
              <p className="text-xs text-emerald-700 dark:text-emerald-400">
                Delivered: storage/{d.clip.deliveryPath}
                {d.clip.deliveredAt ? ` (${d.clip.deliveredAt.slice(0, 16).replace("T", " ")})` : ""}
              </p>
            )}
            {dirty && !locked && <p className="text-xs text-amber-600">Save your changes before approving.</p>}
            <div className="flex flex-wrap gap-2 text-xs">
              {current && (
                <a className={btn} href={`/api/files/${current.path}?download=1`}>
                  Download MP4
                </a>
              )}
              {d.downloads.clean && (
                <a className={btn} href={`/api/files/${d.downloads.clean}?download=1`} title="No captions, hook or SFX — for CapCut">
                  Clean version
                </a>
              )}
              {d.downloads.srt && (
                <a className={btn} href={`/api/files/${d.downloads.srt}?download=1`}>
                  Captions .srt
                </a>
              )}
              <button className={btn} disabled={locked || !!busy} onClick={() => upload.current?.click()} title="Replace with a CapCut-edited MP4">
                Upload final…
              </button>
              <input
                ref={upload}
                type="file"
                accept="video/mp4,.mp4,.mov"
                className="hidden"
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  e.target.value = "";
                  if (f) run("upload", async () => (await call(`/api/clips/${d.clip.id}/upload-final`, { method: "POST", body: f }), `Uploaded ${f.name} as the new version`));
                }}
              />
            </div>
          </section>

          <section className={`${box} space-y-2`}>
            <h2 className="text-sm font-medium text-zinc-500">Views at 72 h</h2>
            <div className="flex gap-2">
              <input className={input} inputMode="numeric" placeholder="e.g. 125000" value={views} onChange={(e) => setViews(e.target.value.replace(/[^\d]/g, ""))} />
              <select className={input} style={{ width: 130 }} value={platform} onChange={(e) => setPlatform(e.target.value)}>
                <option value="tiktok">TikTok</option>
                <option value="instagram">Instagram</option>
                <option value="youtube">YouTube</option>
              </select>
              <button
                className={btn}
                disabled={!views || !!busy}
                onClick={() =>
                  run("views", async () => {
                    await call(`/api/clips/${d.clip.id}/performance`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ views72h: Number(views), platform }) });
                    return "Views saved — used as an example for future hooks";
                  })
                }
              >
                Save
              </button>
            </div>
          </section>

          {scores && (
            <section className={box}>
              <h2 className="mb-2 text-sm font-medium text-zinc-500">Scores</h2>
              {Object.entries(scores).map(([k, v]) => (
                <div key={k} className="flex items-center gap-2 text-xs">
                  <span className="w-24 text-zinc-500">{k}</span>
                  <div className="h-2 flex-1 rounded bg-zinc-100 dark:bg-zinc-800">
                    <div className="h-2 rounded bg-blue-600" style={{ width: `${(v as number) * 10}%` }} />
                  </div>
                  <span className="w-6 text-right tabular-nums">{v as number}</span>
                </div>
              ))}
              {d.clip.reason && <p className="mt-2 text-xs text-zinc-500">{d.clip.reason}</p>}
            </section>
          )}
        </div>

        {/* ---------- right: edits ---------- */}
        <div className="space-y-4">
          <section className={`${box} sticky top-0 z-10 flex flex-wrap items-center gap-2`}>
            <button className={primary} disabled={!dirty || !!busy || locked} onClick={save}>
              {busy === "save" ? "Saving…" : !dirty ? "No changes" : kind === "base" ? "Save & full re-render" : kind === "compose" ? "Save & fast re-render" : "Save"}
            </button>
            <span className="text-xs text-zinc-500">
              {dirty ? (kind === "base" ? "Picture/timeline changed: re-plan + base render + compose (~30–60 s)" : kind === "compose" ? "Text/SFX changed: compose only (~10–20 s)" : "Only captions/title changed: no render") : "Edits are saved to this clip"}
            </span>
            <span className="ml-auto flex gap-2">
              <button className={btn} disabled={dirty || !!busy || locked} onClick={() => action("compose", "compose", "Fast re-render queued")}>
                Fast re-render
              </button>
              <button className={btn} disabled={dirty || !!busy || locked} onClick={() => action("rebase", "rebase", "Full re-render queued")}>
                Full re-render
              </button>
              {dirty && (
                <button
                  className={btn}
                  onClick={() => {
                    setEdit(savedEdit);
                    setText(savedText);
                  }}
                >
                  Discard
                </button>
              )}
            </span>
          </section>

          <fieldset disabled={locked} className="space-y-4">
            <section className={`${box} space-y-2`}>
              <h2 className="text-sm font-medium text-zinc-500">Hook (on screen 0–2.8 s)</h2>
              {(["A", "B"] as const).map((h) => (
                <label key={h} className="flex items-center gap-2">
                  <input type="radio" name="hook" checked={edit.hookChoice === h && !edit.hookOverride} onChange={() => setEdit((e) => ({ ...e, hookChoice: h, hookOverride: undefined }))} />
                  <input className={input} value={h === "A" ? text.hookA : text.hookB} onChange={(e) => setText((t) => ({ ...t, [h === "A" ? "hookA" : "hookB"]: e.target.value }))} />
                </label>
              ))}
              <label className="flex items-center gap-2">
                <input type="radio" name="hook" checked={!!edit.hookOverride} onChange={() => set("hookOverride", edit.hookOverride || " ")} />
                <input className={input} placeholder="Custom hook (max 7 words)" value={edit.hookOverride ?? ""} onChange={(e) => set("hookOverride", e.target.value || undefined)} />
              </label>
              {(edit.hookOverride?.trim().split(/\s+/).length ?? 0) > 7 && <p className="text-xs text-amber-600">Longer than 7 words — it may wrap to two lines.</p>}
            </section>

            <section className={`${box} space-y-2`}>
              <h2 className="text-sm font-medium text-zinc-500">Title and platform captions</h2>
              <label className="block text-xs">
                YouTube title
                <input className={input} maxLength={100} value={text.title} onChange={(e) => setText((t) => ({ ...t, title: e.target.value }))} />
              </label>
              {(
                [
                  ["captionTiktok", "TikTok"],
                  ["captionInstagram", "Instagram"],
                  ["captionYoutube", "YouTube"],
                ] as const
              ).map(([k, label]) => (
                <div key={k} className="text-xs">
                  <div className="flex items-center justify-between">
                    <span>{label}</span>
                    <CopyButton text={copyText(text[k])} />
                  </div>
                  <textarea className={`${input} h-16`} value={text[k]} onChange={(e) => setText((t) => ({ ...t, [k]: e.target.value }))} />
                </div>
              ))}
              <label className="block text-xs">
                Hashtags (required ones are always added: {[...cfg.requiredHashtags, ...cfg.requiredMentions].join(" ") || "none"})
                <input className={input} value={text.hashtags} onChange={(e) => setText((t) => ({ ...t, hashtags: e.target.value }))} />
              </label>
            </section>

            <section className={`${box} space-y-3`}>
              <h2 className="text-sm font-medium text-zinc-500">Trim, pacing and picture</h2>
              <div className="grid grid-cols-2 gap-3 text-xs">
                {(["start", "end"] as const).map((side) => (
                  <div key={side}>
                    <div className="mb-1">
                      {side} <span className="tabular-nums text-zinc-500">{fmt(edit.trim[side])}</span>
                    </div>
                    <div className="flex flex-wrap gap-1">
                      {[-1, -0.5, 0.5, 1].map((dlt) => (
                        <button key={dlt} type="button" className={btn} onClick={() => trim(side === "start" ? edit.trim.start + dlt : edit.trim.start, side === "end" ? edit.trim.end + dlt : edit.trim.end)}>
                          {dlt > 0 ? `+${dlt}` : dlt}
                        </button>
                      ))}
                    </div>
                  </div>
                ))}
              </div>
              <div className="flex flex-wrap gap-1 text-xs">
                <button type="button" className={btn} disabled={sentenceStartBefore(edit.trim.start) === undefined} onClick={() => trim(sentenceStartBefore(edit.trim.start)!, edit.trim.end)}>
                  + sentence before
                </button>
                <button type="button" className={btn} disabled={sentenceStartAfter(edit.trim.start) === undefined} onClick={() => trim(sentenceStartAfter(edit.trim.start)!, edit.trim.end)}>
                  − first sentence
                </button>
                <button type="button" className={btn} disabled={sentenceEndBefore(edit.trim.end) === undefined} onClick={() => trim(edit.trim.start, sentenceEndBefore(edit.trim.end)!)}>
                  − last sentence
                </button>
                <button type="button" className={btn} disabled={sentenceEndAfter(edit.trim.end) === undefined} onClick={() => trim(edit.trim.start, sentenceEndAfter(edit.trim.end)!)}>
                  + sentence after
                </button>
                <span className="self-center text-zinc-500">length {(edit.trim.end - edit.trim.start).toFixed(1)} s (allowed {cfg.minLengthSec}–{cfg.maxLengthSec})</span>
              </div>
              <div className="grid gap-3 text-xs sm:grid-cols-2">
                <label className="flex items-center gap-2">
                  <input type="checkbox" checked={edit.pacing.tightenPauses} onChange={(e) => set("pacing", { ...edit.pacing, tightenPauses: e.target.checked })} /> Tighten pauses over
                  <input className={`${input} w-16`} type="number" step="0.05" min="0.2" max="3" value={edit.pacing.maxPauseSec} onChange={(e) => set("pacing", { ...edit.pacing, maxPauseSec: Number(e.target.value) })} /> s
                </label>
                <label className="flex items-center gap-2">
                  <input type="checkbox" checked={edit.pacing.trimFillers} onChange={(e) => set("pacing", { ...edit.pacing, trimFillers: e.target.checked })} /> Cut filler words
                </label>
                <label className="flex items-center gap-2">
                  <input
                    type="checkbox"
                    checked={!!edit.coldOpen?.enabled}
                    onChange={(e) => set("coldOpen", e.target.checked ? { enabled: true, start: edit.coldOpen?.start ?? edit.trim.start + 5, end: edit.coldOpen?.end ?? edit.trim.start + 8 } : edit.coldOpen ? { ...edit.coldOpen, enabled: false } : null)}
                  />
                  Cold-open teaser
                </label>
                {edit.coldOpen?.enabled && (
                  <span className="flex items-center gap-1">
                    <input className={`${input} w-20`} type="number" step="0.1" value={edit.coldOpen.start} onChange={(e) => set("coldOpen", { ...edit.coldOpen!, start: Number(e.target.value) })} />–
                    <input className={`${input} w-20`} type="number" step="0.1" value={edit.coldOpen.end} onChange={(e) => set("coldOpen", { ...edit.coldOpen!, end: Number(e.target.value) })} /> s (2–4 s, source time)
                  </span>
                )}
                <label className="flex items-center gap-2">
                  Zoom
                  <select className={input} value={edit.zoom} onChange={(e) => set("zoom", e.target.value as ClipEdit["zoom"])}>
                    <option value="off">off</option>
                    <option value="subtle">subtle</option>
                    <option value="punchy">punchy</option>
                  </select>
                </label>
                <label className="flex items-center gap-2">
                  Layout
                  <select className={input} value={edit.layout} onChange={(e) => set("layout", e.target.value as ClipEdit["layout"])}>
                    <option value="single">single</option>
                    <option value="split">split</option>
                    <option value="fit">fit</option>
                  </select>
                </label>
                <label className="flex items-center gap-2">
                  Focus
                  <select className={input} value={edit.focus ?? "auto"} onChange={(e) => set("focus", e.target.value as ClipEdit["focus"])}>
                    <option value="auto">auto (follow face)</option>
                    <option value="left">left</option>
                    <option value="center">center</option>
                    <option value="right">right</option>
                  </select>
                </label>
                <label className="flex items-center gap-2">
                  Captions
                  <select className={input} value={edit.captionPreset} onChange={(e) => set("captionPreset", e.target.value)}>
                    {PRESETS.map((p) => (
                      <option key={p}>{p}</option>
                    ))}
                  </select>
                </label>
                {cfg.overlay && (
                  <label className="flex items-center gap-2">
                    <input type="checkbox" checked={edit.overlay} onChange={(e) => set("overlay", e.target.checked)} /> Campaign overlay ({cfg.overlay.file})
                  </label>
                )}
              </div>
              {d.plan && <p className="text-xs text-zinc-500">Current plan: {d.plan.layout} — {d.plan.layoutReason}</p>}
            </section>

            <section className={`${box} space-y-2`}>
              <div className="flex items-center justify-between">
                <h2 className="text-sm font-medium text-zinc-500">Sound effects</h2>
                <button type="button" className={btn} onClick={() => setPicker((p) => !p)}>
                  + Add SFX at playhead
                </button>
              </div>
              <div ref={track} className="relative h-8 rounded bg-zinc-100 dark:bg-zinc-800" title="Drag a marker to move it">
                {cues.map((c) => (
                  <div
                    key={c.id}
                    onPointerDown={drag(c.id)}
                    className={`absolute top-1 h-6 w-2 -translate-x-1/2 cursor-ew-resize rounded ${c.source === "manual" ? "bg-amber-500" : "bg-blue-600"}`}
                    style={{ left: `${(c.at / duration) * 100}%` }}
                    title={`${c.at.toFixed(2)} s ${lib.get(c.sfxId)?.name ?? "missing sound"}`}
                  />
                ))}
              </div>
              {picker && (
                <div className="space-y-2 rounded border border-zinc-200 p-2 dark:border-zinc-700">
                  <select className={input} value={pickCat} onChange={(e) => setPickCat(e.target.value)}>
                    <option value="all">all categories</option>
                    {[...new Set(d.library.map((s) => s.category))].sort().map((c) => (
                      <option key={c}>{c}</option>
                    ))}
                  </select>
                  <ul className="max-h-48 overflow-y-auto text-xs">
                    {d.library
                      .filter((s) => pickCat === "all" || s.category === pickCat)
                      .map((s) => (
                        <li key={s.id} className="flex items-center gap-2 py-0.5">
                          <button type="button" className={btn} onClick={() => playSfx(s.id)}>
                            ▶
                          </button>
                          <span className="flex-1">
                            {s.category}/{s.name} <span className="text-zinc-500">{s.durationSec?.toFixed(1)} s</span>
                          </span>
                          <button type="button" className={btn} onClick={() => addCue(s.id)}>
                            Add
                          </button>
                        </li>
                      ))}
                  </ul>
                </div>
              )}
              <ul className="space-y-1 text-xs">
                {cues.map((c) => {
                  const s = lib.get(c.sfxId);
                  return (
                    <li key={c.id} className="flex flex-wrap items-center gap-2">
                      <button type="button" className={btn} disabled={!s} onClick={() => s && playSfx(s.id)}>
                        ▶
                      </button>
                      <input className={`${input} w-20`} type="number" step="0.05" min="0" value={c.at} onChange={(e) => setCue(c.id, { at: Number(e.target.value) })} />s
                      <span className={`flex-1 ${s ? "" : "text-red-600"}`}>
                        {s ? `${s.category}/${s.name}` : "sound missing (skipped)"} <span className="text-zinc-500">{c.source}</span>
                      </span>
                      <input className={`${input} w-16`} type="number" step="1" value={c.gainDb} onChange={(e) => setCue(c.id, { gainDb: Number(e.target.value) })} />
                      dB
                      <button type="button" className={btn} onClick={() => set("sfxCues", edit.sfxCues.filter((x) => x.id !== c.id))}>
                        ✕
                      </button>
                    </li>
                  );
                })}
                {!cues.length && <li className="text-zinc-500">No sound effects.</li>}
              </ul>
            </section>

            <section className={`${box} space-y-2`}>
              <div className="flex items-center justify-between">
                <h2 className="text-sm font-medium text-zinc-500">Transcript (click a word to jump there)</h2>
                <label className="flex items-center gap-1 text-xs">
                  <input type="checkbox" checked={editWords} onChange={(e) => setEditWords(e.target.checked)} /> fix words
                </label>
              </div>
              {editWords && <p className="text-xs text-zinc-500">Click a word to correct it; Alt+click to hide or show it (e.g. a filler).</p>}
              <p className="max-h-72 overflow-y-auto text-sm leading-relaxed">
                {d.words
                  .filter((w) => !w.teaser)
                  .map((w) => {
                    const we = wordEdit(w.i);
                    return (
                      <span
                        key={`${w.i}-${w.s}`}
                        onClick={(e) => {
                          if (!editWords) return seek(w.s);
                          if (e.altKey) return setWordEdit(w.i, { hidden: !we?.hidden });
                          const t = window.prompt("Correct this word (empty = original):", we?.text ?? w.w);
                          if (t !== null) setWordEdit(w.i, { text: t.trim() && t.trim() !== w.w ? t.trim() : undefined });
                        }}
                        className={`cursor-pointer rounded px-0.5 hover:bg-blue-100 dark:hover:bg-blue-950 ${we?.hidden ? "text-zinc-400 line-through" : ""} ${we?.text ? "text-blue-600" : ""} ${w.emphasis ? "font-semibold" : ""}`}
                        title={`${w.s.toFixed(2)} s`}
                      >
                        {we?.text ?? w.w}{" "}
                      </span>
                    );
                  })}
              </p>
            </section>
          </fieldset>

          <section className={box}>
            <h2 className="mb-2 text-sm font-medium text-zinc-500">Clip log</h2>
            <ul className="max-h-48 space-y-0.5 overflow-y-auto font-mono text-xs">
              {d.events.map((e) => (
                <li key={e.id} className={e.level === "error" ? "text-red-600" : e.level === "warn" ? "text-amber-600" : ""}>
                  <span className="text-zinc-400">{e.createdAt.slice(5, 16).replace("T", " ")}</span> {e.message}
                </li>
              ))}
            </ul>
          </section>
        </div>
      </div>
    </div>
  );
}
