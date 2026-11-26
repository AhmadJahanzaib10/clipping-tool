"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

const input = "w-full rounded-md border border-zinc-300 bg-white px-2 py-1 text-sm dark:border-zinc-700 dark:bg-zinc-950";
const btn = "rounded-md border border-zinc-300 px-2 py-1 text-xs hover:bg-zinc-100 disabled:opacity-40 dark:border-zinc-700 dark:hover:bg-zinc-800";

type Operator = { id: string; name: string; slug: string; driveFolder: string | null; active: boolean };

async function send(url: string, method: string, body: unknown) {
  const res = await fetch(url, { method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const j = await res.json();
  if (!res.ok) throw new Error(j.error ?? `HTTP ${res.status}`);
  return j;
}

function OperatorRow({ o }: { o: Operator }) {
  const router = useRouter();
  const [name, setName] = useState(o.name);
  const [folder, setFolder] = useState(o.driveFolder ?? "");
  const [err, setErr] = useState<string | null>(null);
  const dirty = name !== o.name || folder !== (o.driveFolder ?? "");
  const save = async (patch: Partial<Operator>) => {
    setErr(null);
    try {
      await send(`/api/operators/${o.id}`, "PATCH", patch);
      router.refresh();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    }
  };
  return (
    <tr className="border-t border-zinc-100 dark:border-zinc-800">
      <td className="py-1 pr-2">
        <input className={input} value={name} onChange={(e) => setName(e.target.value)} />
      </td>
      <td className="pr-2 font-mono text-xs text-zinc-500">{o.slug}</td>
      <td className="pr-2">
        <input className={input} value={folder} placeholder={o.slug} onChange={(e) => setFolder(e.target.value)} />
      </td>
      <td className="pr-2 text-xs">
        <label className="flex items-center gap-1">
          <input type="checkbox" checked={o.active} onChange={(e) => save({ active: e.target.checked })} /> active
        </label>
      </td>
      <td>
        <button className={btn} disabled={!dirty} onClick={() => save({ name, driveFolder: folder.trim() || null })}>
          Save
        </button>
        {err && <span className="ml-2 text-xs text-red-600">{err}</span>}
      </td>
    </tr>
  );
}

export function OperatorsForm({ operators }: { operators: Operator[] }) {
  const router = useRouter();
  const [name, setName] = useState("");
  const [folder, setFolder] = useState("");
  const [err, setErr] = useState<string | null>(null);
  return (
    <div className="space-y-3">
      <table className="w-full text-left text-sm">
        <thead className="text-xs text-zinc-500">
          <tr>
            <th className="pr-2">Name</th>
            <th className="pr-2">Folder name</th>
            <th className="pr-2">Drive folder</th>
            <th />
            <th />
          </tr>
        </thead>
        <tbody>
          {operators.map((o) => (
            <OperatorRow key={o.id} o={o} />
          ))}
        </tbody>
      </table>
      <div className="flex gap-2">
        <input className={input} placeholder="New operator name" value={name} onChange={(e) => setName(e.target.value)} />
        <input className={input} placeholder="Drive folder (optional)" value={folder} onChange={(e) => setFolder(e.target.value)} />
        <button
          className={btn}
          disabled={!name.trim()}
          onClick={async () => {
            setErr(null);
            try {
              await send("/api/operators", "POST", { name, driveFolder: folder.trim() || null });
              setName("");
              setFolder("");
              router.refresh();
            } catch (e) {
              setErr(e instanceof Error ? e.message : String(e));
            }
          }}
        >
          Add
        </button>
      </div>
      {err && <p className="text-xs text-red-600">{err}</p>}
    </div>
  );
}

const KEYS = ["hook", "standalone", "payoff", "emotion", "novelty", "quotability"] as const;
export function WeightsForm({ weights }: { weights: Record<(typeof KEYS)[number], number> }) {
  const [w, setW] = useState(weights);
  const [msg, setMsg] = useState<string | null>(null);
  const total = KEYS.reduce((n, k) => n + w[k], 0);
  return (
    <div className="space-y-2">
      <div className="grid grid-cols-3 gap-2 sm:grid-cols-6">
        {KEYS.map((k) => (
          <label key={k} className="space-y-1 text-xs">
            {k}
            <input className={input} type="number" step="0.05" min="0" value={w[k]} onChange={(e) => setW({ ...w, [k]: Number(e.target.value) })} />
          </label>
        ))}
      </div>
      <div className="flex items-center gap-3 text-xs">
        <button
          className={btn}
          onClick={async () => {
            try {
              await send("/api/settings", "PUT", { scoreWeights: w });
              setMsg("Saved — used for clips selected from now on.");
            } catch (e) {
              setMsg(e instanceof Error ? e.message : String(e));
            }
          }}
        >
          Save weights
        </button>
        <span className="text-zinc-500">sum {total.toFixed(2)} (normalized automatically)</span>
        {msg && <span>{msg}</span>}
      </div>
    </div>
  );
}
