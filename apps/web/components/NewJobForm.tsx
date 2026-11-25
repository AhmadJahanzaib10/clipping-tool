"use client";

import { useRouter } from "next/navigation";
import { useRef, useState } from "react";

type Option = { id: string; name: string };
type UploadItem = { file: File; progress: number; uploadId?: string; error?: string };

const ACCEPT = [".mp4", ".mov", ".m4v", ".mkv", ".webm"];

function uploadFile(file: File, onProgress: (p: number) => void): Promise<string> {
  // XHR (not fetch) for upload progress; the body is streamed to disk server-side.
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("POST", "/api/uploads");
    xhr.setRequestHeader("x-filename", encodeURIComponent(file.name));
    xhr.upload.onprogress = (e) => e.lengthComputable && onProgress(e.loaded / e.total);
    xhr.onload = () => {
      try {
        const body = JSON.parse(xhr.responseText);
        if (xhr.status === 200) resolve(body.uploadId);
        else reject(new Error(body.error ?? `HTTP ${xhr.status}`));
      } catch {
        reject(new Error(`HTTP ${xhr.status}`));
      }
    };
    xhr.onerror = () => reject(new Error("network error"));
    xhr.send(file);
  });
}

export function NewJobForm({ campaigns, operators }: { campaigns: Option[]; operators: Option[] }) {
  const router = useRouter();
  const [urls, setUrls] = useState("");
  const [items, setItems] = useState<UploadItem[]>([]);
  const [campaignId, setCampaignId] = useState(campaigns[0]?.id ?? "");
  const [operatorId, setOperatorId] = useState(operators[0]?.id ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [drag, setDrag] = useState(false);
  const input = useRef<HTMLInputElement>(null);

  function addFiles(files: FileList | null) {
    if (!files) return;
    const ok = [...files].filter((f) => ACCEPT.some((e) => f.name.toLowerCase().endsWith(e)));
    setItems((cur) => [...cur, ...ok.map((file) => ({ file, progress: 0 }))]);
    if (ok.length < files.length) setError(`Skipped unsupported files. Allowed: ${ACCEPT.join(", ")}`);
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    const urlList = urls.split(/\s+/).map((u) => u.trim()).filter(Boolean);
    if (!urlList.length && !items.length) return setError("Paste at least one URL or add a video file.");
    setBusy(true);
    try {
      const uploadIds: string[] = [];
      for (let i = 0; i < items.length; i++) {
        const it = items[i]!;
        if (it.uploadId) {
          uploadIds.push(it.uploadId);
          continue;
        }
        const id = await uploadFile(it.file, (p) => setItems((cur) => cur.map((c, j) => (j === i ? { ...c, progress: p } : c))));
        setItems((cur) => cur.map((c, j) => (j === i ? { ...c, uploadId: id, progress: 1 } : c)));
        uploadIds.push(id);
      }
      const res = await fetch("/api/jobs", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ urls: urlList, uploadIds, campaignId, operatorId }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error === "invalid body" ? "Check the URLs (one per line, starting with https://)." : body.error);
      router.push(body.sources.length === 1 ? `/jobs/${body.sources[0].id}` : "/");
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setBusy(false);
    }
  }

  const field = "w-full rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm dark:border-zinc-700 dark:bg-zinc-900";
  return (
    <form onSubmit={submit} className="max-w-2xl space-y-5">
      <label className="block space-y-1">
        <span className="text-sm font-medium">YouTube URLs (one per line)</span>
        <textarea className={`${field} h-28 font-mono`} value={urls} onChange={(e) => setUrls(e.target.value)} placeholder="https://www.youtube.com/watch?v=…" />
      </label>

      <div
        onDragOver={(e) => {
          e.preventDefault();
          setDrag(true);
        }}
        onDragLeave={() => setDrag(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDrag(false);
          addFiles(e.dataTransfer.files);
        }}
        onClick={() => input.current?.click()}
        className={`cursor-pointer rounded-lg border-2 border-dashed p-6 text-center text-sm ${drag ? "border-blue-500 bg-blue-50 dark:bg-blue-950" : "border-zinc-300 dark:border-zinc-700"}`}
      >
        Drop MP4 files here or click to choose
        <input ref={input} type="file" multiple accept={ACCEPT.join(",")} className="hidden" onChange={(e) => addFiles(e.target.files)} />
      </div>
      {items.length > 0 && (
        <ul className="space-y-1 text-sm">
          {items.map((it, i) => (
            <li key={i} className="flex items-center gap-3">
              <span className="flex-1 truncate">{it.file.name}</span>
              <span className="tabular-nums text-zinc-500">{(it.file.size / 1024 / 1024).toFixed(0)} MB</span>
              <span className="w-12 text-right tabular-nums">{Math.round(it.progress * 100)}%</span>
              {!busy && (
                <button type="button" className="text-zinc-500 hover:text-red-600" onClick={() => setItems((c) => c.filter((_, j) => j !== i))}>
                  remove
                </button>
              )}
            </li>
          ))}
        </ul>
      )}

      <div className="grid grid-cols-2 gap-4">
        <label className="block space-y-1">
          <span className="text-sm font-medium">Campaign</span>
          <select className={field} value={campaignId} onChange={(e) => setCampaignId(e.target.value)}>
            {campaigns.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
        </label>
        <label className="block space-y-1">
          <span className="text-sm font-medium">Operator</span>
          <select className={field} value={operatorId} onChange={(e) => setOperatorId(e.target.value)}>
            {operators.map((o) => (
              <option key={o.id} value={o.id}>
                {o.name}
              </option>
            ))}
          </select>
        </label>
      </div>

      {error && <p className="text-sm text-red-600">{error}</p>}
      <button disabled={busy} className="rounded-md bg-zinc-900 px-4 py-2 text-sm font-medium text-white disabled:opacity-50 dark:bg-zinc-100 dark:text-zinc-900">
        {busy ? "Starting…" : "Start job"}
      </button>
    </form>
  );
}
