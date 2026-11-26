"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

type Config = {
  minLengthSec: number;
  maxLengthSec: number;
  idealLengthSec: number;
  requiredHashtags: string[];
  requiredMentions: string[];
  overlay?: { file: string; position: "top" | "bottom" | "top-left" | "top-right"; widthPct: number; opacity: number };
  showNameOnScreen?: string;
  captionPreset: "bold-yellow" | "white-box" | "clean-white";
  hookStyle: "top-banner" | "center-pop";
  pacing: { tightenPauses: boolean; maxPauseSec: number; trimFillers: boolean };
  coldOpen: "off" | "auto" | "always";
  zoom: "off" | "subtle" | "punchy";
  sfx: { intensity: "off" | "subtle" | "normal" | "heavy"; categories: string[]; gainDb: number };
  bannedWords: string[];
  briefNotes: string;
};
export type CampaignRow = { id: string; name: string; niche: string; active: boolean; config: Config } | null;

const input = "w-full rounded-md border border-zinc-300 bg-white px-2 py-1 text-sm dark:border-zinc-700 dark:bg-zinc-950";
const list = (s: string) => s.split(/[\s,]+/).map((x) => x.trim()).filter(Boolean);
const DEFAULTS: Config = {
  minLengthSec: 20,
  maxLengthSec: 60,
  idealLengthSec: 35,
  requiredHashtags: [],
  requiredMentions: [],
  captionPreset: "bold-yellow",
  hookStyle: "top-banner",
  pacing: { tightenPauses: true, maxPauseSec: 0.45, trimFillers: true },
  coldOpen: "auto",
  zoom: "subtle",
  sfx: { intensity: "normal", categories: ["whoosh", "pop", "impact", "transition"], gainDb: -14 },
  bannedWords: [],
  briefNotes: "",
};

export function CampaignForm({ campaign, sfxCategories }: { campaign: CampaignRow; sfxCategories: string[] }) {
  const router = useRouter();
  const [name, setName] = useState(campaign?.name ?? "");
  const [niche, setNiche] = useState(campaign?.niche ?? "");
  const [active, setActive] = useState(campaign?.active ?? true);
  const [c, setC] = useState<Config>(campaign?.config ?? DEFAULTS);
  const [tags, setTags] = useState((campaign?.config.requiredHashtags ?? []).join(" "));
  const [mentions, setMentions] = useState((campaign?.config.requiredMentions ?? []).join(" "));
  const [banned, setBanned] = useState((campaign?.config.bannedWords ?? []).join(", "));
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const set = <K extends keyof Config>(k: K, v: Config[K]) => setC((x) => ({ ...x, [k]: v }));
  const categories = [...new Set([...sfxCategories, ...c.sfx.categories])].sort();

  const save = async () => {
    setBusy(true);
    setMsg(null);
    const config: Config = {
      ...c,
      requiredHashtags: list(tags).map((t) => (t.startsWith("#") ? t : `#${t}`)),
      requiredMentions: list(mentions).map((t) => (t.startsWith("@") ? t : `@${t}`)),
      bannedWords: banned.split(",").map((x) => x.trim()).filter(Boolean),
      showNameOnScreen: c.showNameOnScreen?.trim() || undefined,
    };
    try {
      const res = await fetch(campaign ? `/api/campaigns/${campaign.id}` : "/api/campaigns", {
        method: campaign ? "PATCH" : "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name, niche, active, config }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error === "invalid body" ? "Check the values (lengths must be min ≤ ideal ≤ max)." : body.error);
      setMsg({ ok: true, text: "Saved. New jobs and re-renders use these settings." });
      if (!campaign) router.push(`/campaigns/${body.campaign.id}`);
      router.refresh();
    } catch (e) {
      setMsg({ ok: false, text: e instanceof Error ? e.message : String(e) });
    } finally {
      setBusy(false);
    }
  };

  const uploadOverlay = async (f: File) => {
    if (!campaign) return setMsg({ ok: false, text: "Save the campaign first, then upload the overlay." });
    const res = await fetch(`/api/campaigns/${campaign.id}/overlay`, { method: "POST", headers: { "x-filename": encodeURIComponent(f.name) }, body: f });
    const body = await res.json();
    if (!res.ok) return setMsg({ ok: false, text: body.error });
    set("overlay", { file: body.file, position: c.overlay?.position ?? "top-right", widthPct: c.overlay?.widthPct ?? 22, opacity: c.overlay?.opacity ?? 0.9 });
    setMsg({ ok: true, text: `Overlay uploaded (${body.file}). Save to apply.` });
  };

  const field = "block space-y-1 text-xs";
  return (
    <div className="max-w-3xl space-y-5">
      <div className="grid gap-3 sm:grid-cols-2">
        <label className={field}>
          Name
          <input className={input} value={name} onChange={(e) => setName(e.target.value)} />
        </label>
        <label className={field}>
          Niche (also groups the best past clips used as hook examples)
          <input className={input} value={niche} onChange={(e) => setNiche(e.target.value)} placeholder="e.g. business & entrepreneurship podcast" />
        </label>
        <label className={field}>
          Required hashtags (always appended)
          <input className={input} value={tags} onChange={(e) => setTags(e.target.value)} placeholder="#brand #show" />
        </label>
        <label className={field}>
          Required mentions
          <input className={input} value={mentions} onChange={(e) => setMentions(e.target.value)} placeholder="@brand" />
        </label>
        <label className={`${field} sm:col-span-2`}>
          Banned words (comma separated; never in hooks, titles or captions)
          <input className={input} value={banned} onChange={(e) => setBanned(e.target.value)} />
        </label>
        <label className={`${field} sm:col-span-2`}>
          Brief notes for the editor model
          <textarea className={`${input} h-20`} value={c.briefNotes} onChange={(e) => set("briefNotes", e.target.value)} />
        </label>
      </div>

      <fieldset className="grid gap-3 rounded-lg border border-zinc-200 p-3 sm:grid-cols-3 dark:border-zinc-800">
        <legend className="px-1 text-xs text-zinc-500">Length (seconds)</legend>
        {(["minLengthSec", "idealLengthSec", "maxLengthSec"] as const).map((k) => (
          <label key={k} className={field}>
            {k.replace("LengthSec", "")}
            <input className={input} type="number" min="5" max="180" value={c[k]} onChange={(e) => set(k, Number(e.target.value))} />
          </label>
        ))}
      </fieldset>

      <fieldset className="grid gap-3 rounded-lg border border-zinc-200 p-3 sm:grid-cols-3 dark:border-zinc-800">
        <legend className="px-1 text-xs text-zinc-500">Look and edit</legend>
        <label className={field}>
          Caption style
          <select className={input} value={c.captionPreset} onChange={(e) => set("captionPreset", e.target.value as Config["captionPreset"])}>
            <option value="bold-yellow">bold-yellow (Montserrat, yellow active word)</option>
            <option value="white-box">white-box (Inter on a dark box)</option>
            <option value="clean-white">clean-white (Inter, soft shadow)</option>
          </select>
        </label>
        <label className={field}>
          Hook style
          <select className={input} value={c.hookStyle} onChange={(e) => set("hookStyle", e.target.value as Config["hookStyle"])}>
            <option value="top-banner">top banner</option>
            <option value="center-pop">centre pop</option>
          </select>
        </label>
        <label className={field}>
          Zoom punch-ins
          <select className={input} value={c.zoom} onChange={(e) => set("zoom", e.target.value as Config["zoom"])}>
            <option value="off">off</option>
            <option value="subtle">subtle</option>
            <option value="punchy">punchy</option>
          </select>
        </label>
        <label className={field}>
          Cold-open teaser
          <select className={input} value={c.coldOpen} onChange={(e) => set("coldOpen", e.target.value as Config["coldOpen"])}>
            <option value="off">off</option>
            <option value="auto">auto (when the editor model suggests one)</option>
            <option value="always">always</option>
          </select>
        </label>
        <label className="flex items-center gap-2 text-xs">
          <input type="checkbox" checked={c.pacing.tightenPauses} onChange={(e) => set("pacing", { ...c.pacing, tightenPauses: e.target.checked })} /> Tighten pauses over
          <input className={`${input} w-16`} type="number" step="0.05" value={c.pacing.maxPauseSec} onChange={(e) => set("pacing", { ...c.pacing, maxPauseSec: Number(e.target.value) })} /> s
        </label>
        <label className="flex items-center gap-2 text-xs">
          <input type="checkbox" checked={c.pacing.trimFillers} onChange={(e) => set("pacing", { ...c.pacing, trimFillers: e.target.checked })} /> Cut filler words
        </label>
        <label className={`${field} sm:col-span-3`}>
          Name label on screen (optional, e.g. the guest)
          <input className={input} value={c.showNameOnScreen ?? ""} onChange={(e) => set("showNameOnScreen", e.target.value)} />
        </label>
      </fieldset>

      <fieldset className="space-y-3 rounded-lg border border-zinc-200 p-3 dark:border-zinc-800">
        <legend className="px-1 text-xs text-zinc-500">Sound effects (placed automatically)</legend>
        <div className="grid gap-3 sm:grid-cols-2">
          <label className={field}>
            Intensity
            <select className={input} value={c.sfx.intensity} onChange={(e) => set("sfx", { ...c.sfx, intensity: e.target.value as Config["sfx"]["intensity"] })}>
              <option value="off">off</option>
              <option value="subtle">subtle (hook + transitions)</option>
              <option value="normal">normal (+ emphasis, payoff, numbers, zooms)</option>
              <option value="heavy">heavy (+ every emphasis word, cuts)</option>
            </select>
          </label>
          <label className={field}>
            Volume (dB relative to the voice)
            <input className={input} type="number" step="1" min="-40" max="0" value={c.sfx.gainDb} onChange={(e) => set("sfx", { ...c.sfx, gainDb: Number(e.target.value) })} />
          </label>
        </div>
        <div className="flex flex-wrap gap-3 text-xs">
          {categories.map((cat) => (
            <label key={cat} className="flex items-center gap-1">
              <input
                type="checkbox"
                checked={c.sfx.categories.includes(cat)}
                onChange={(e) => set("sfx", { ...c.sfx, categories: e.target.checked ? [...c.sfx.categories, cat] : c.sfx.categories.filter((x) => x !== cat) })}
              />
              {cat}
              {!sfxCategories.includes(cat) && <span className="text-amber-600">(no sounds)</span>}
            </label>
          ))}
        </div>
        <p className="text-xs text-zinc-500">The planner uses ding for numbers, click for zooms, transition for cuts (heavy); risers, glitch and other folders are for manual use in the editor.</p>
      </fieldset>

      <fieldset className="space-y-3 rounded-lg border border-zinc-200 p-3 dark:border-zinc-800">
        <legend className="px-1 text-xs text-zinc-500">Overlay (campaign logo / required graphic)</legend>
        <input type="file" accept="image/png" className="text-xs" onChange={(e) => e.target.files?.[0] && uploadOverlay(e.target.files[0])} />
        {c.overlay && (
          <div className="grid items-end gap-3 sm:grid-cols-4">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img alt="overlay" src={`/api/campaigns/${campaign?.id}/overlay?file=${encodeURIComponent(c.overlay.file)}`} className="max-h-16 rounded bg-zinc-200 dark:bg-zinc-700" />
            <label className={field}>
              Position
              <select className={input} value={c.overlay.position} onChange={(e) => set("overlay", { ...c.overlay!, position: e.target.value as NonNullable<Config["overlay"]>["position"] })}>
                <option value="top">top</option>
                <option value="top-left">top-left</option>
                <option value="top-right">top-right</option>
                <option value="bottom">bottom (above platform captions)</option>
              </select>
            </label>
            <label className={field}>
              Width %
              <input className={input} type="number" min="5" max="60" value={c.overlay.widthPct} onChange={(e) => set("overlay", { ...c.overlay!, widthPct: Number(e.target.value) })} />
            </label>
            <label className={field}>
              Opacity
              <input className={input} type="number" step="0.05" min="0.1" max="1" value={c.overlay.opacity} onChange={(e) => set("overlay", { ...c.overlay!, opacity: Number(e.target.value) })} />
            </label>
            <button type="button" className="text-left text-xs text-red-600 underline" onClick={() => set("overlay", undefined)}>
              remove overlay
            </button>
          </div>
        )}
      </fieldset>

      <div className="flex items-center gap-3">
        <button disabled={busy || !name.trim()} onClick={save} className="rounded-md bg-zinc-900 px-4 py-2 text-sm font-medium text-white disabled:opacity-50 dark:bg-zinc-100 dark:text-zinc-900">
          {busy ? "Saving…" : campaign ? "Save campaign" : "Create campaign"}
        </button>
        <label className="flex items-center gap-1 text-xs">
          <input type="checkbox" checked={active} onChange={(e) => setActive(e.target.checked)} /> active
        </label>
        {msg && <span className={`text-sm ${msg.ok ? "text-emerald-600" : "text-red-600"}`}>{msg.text}</span>}
      </div>
    </div>
  );
}
