import { spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { eq } from "drizzle-orm";
import { nanoid } from "nanoid";
import { z } from "zod";
import type { Db } from "../db/client";
import { sfx, type Sfx } from "../db/schema";
import { findRepoRoot } from "../paths";
import { measureArgs, normalizeArgs, normalizeGainDb, parseEbur128, waveformArgs } from "./ffmpeg";

/** SPEC §10.1: accepted formats; sub-folder = category (new folders become new categories). */
export const SFX_EXTS = [".mp3", ".wav", ".ogg", ".m4a"] as const;
export const DEFAULT_CATEGORY = "misc";

export const sfxDir = () => path.join(findRepoRoot(), "assets", "sfx");
export const sfxCacheDir = () => path.join(findRepoRoot(), "assets", ".cache", "sfx");

/** Optional assets/sfx/sfx.json per-file overrides: { "pop/soft-pop-02.mp3": { gainDb, tags, enabled } }. */
export const sfxOverridesSchema = z.record(
  z.string(),
  z.object({ gainDb: z.number().min(-40).max(20).optional(), tags: z.array(z.string()).optional(), enabled: z.boolean().optional() }).strict(),
);
export type SfxOverrides = z.infer<typeof sfxOverridesSchema>;

/** Library-relative path with forward slashes ("pop/soft-pop-02.mp3"), the stable key of a sound. */
export const relKey = (root: string, file: string) => path.relative(root, file).split(path.sep).join("/");

/** Category = first folder under assets/sfx (lowercased); files at the root are "misc". */
export function categoryOf(key: string): string {
  const parts = key.split("/");
  return parts.length > 1 ? parts[0]!.toLowerCase() : DEFAULT_CATEGORY;
}

/** All sound files under the library, recursively (sorted keys). */
export function listSfxFiles(root: string): string[] {
  if (!fs.existsSync(root)) return [];
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (e.name.startsWith(".")) continue;
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if ((SFX_EXTS as readonly string[]).includes(path.extname(e.name).toLowerCase())) out.push(p);
    }
  };
  walk(root);
  return out.sort((a, b) => relKey(root, a).localeCompare(relKey(root, b)));
}

export function readOverrides(root: string): { overrides: SfxOverrides; error?: string } {
  const f = path.join(root, "sfx.json");
  if (!fs.existsSync(f)) return { overrides: {} };
  try {
    return { overrides: sfxOverridesSchema.parse(JSON.parse(fs.readFileSync(f, "utf8"))) };
  } catch (e) {
    return { overrides: {}, error: `sfx.json ignored: ${e instanceof Error ? e.message.split("\n")[0] : e}` };
  }
}

function run(bin: string, args: string[]): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const p = spawn(bin, args, { windowsHide: true });
    let stdout = "";
    let stderr = "";
    p.stdout.on("data", (d: Buffer) => (stdout += d.toString()));
    p.stderr.on("data", (d: Buffer) => (stderr += d.toString()));
    p.on("error", reject);
    p.on("close", (code) => (code === 0 ? resolve({ stdout, stderr }) : reject(new Error(`${path.basename(bin)} exited ${code}: ${stderr.trim().split("\n").slice(-2).join(" ")}`))));
  });
}

async function probeAudio(ffprobe: string, file: string): Promise<{ durationSec: number; channels: number }> {
  const { stdout } = await run(ffprobe, ["-v", "error", "-select_streams", "a:0", "-show_entries", "stream=channels:format=duration", "-of", "json", file]);
  const j = JSON.parse(stdout) as { streams?: { channels?: number }[]; format?: { duration?: string } };
  const d = Number(j.format?.duration);
  if (!Number.isFinite(d) || d <= 0) throw new Error("could not read duration");
  if (!j.streams?.length) throw new Error("no audio stream");
  return { durationSec: d, channels: j.streams[0]!.channels ?? 2 };
}

export interface ScanOptions {
  ffmpegPath: string;
  ffprobePath: string;
  /** Override the library / cache folders (tests). */
  root?: string;
  cacheDir?: string;
  /** Re-process every file even if unchanged. */
  force?: boolean;
  now?: Date;
}

export interface ScanResult {
  added: string[];
  updated: string[];
  unchanged: number;
  removed: string[];
  failed: { file: string; error: string }[];
  warnings: string[];
  categories: Record<string, number>;
  ms: number;
}

let scanning: Promise<ScanResult> | null = null;

/** SPEC §10.2 scan. Only one scan runs at a time; concurrent callers share its result. */
export function scanSfx(db: Db, o: ScanOptions): Promise<ScanResult> {
  scanning ??= doScan(db, o).finally(() => (scanning = null));
  return scanning;
}

async function doScan(db: Db, o: ScanOptions): Promise<ScanResult> {
  const t0 = Date.now();
  const root = o.root ?? sfxDir();
  const cache = o.cacheDir ?? sfxCacheDir();
  fs.mkdirSync(root, { recursive: true });
  fs.mkdirSync(cache, { recursive: true });
  const ts = (o.now ?? new Date()).toISOString();
  const { overrides, error } = readOverrides(root);
  const res: ScanResult = { added: [], updated: [], unchanged: 0, removed: [], failed: [], warnings: error ? [error] : [], categories: {}, ms: 0 };

  const files = listSfxFiles(root);
  const seen = new Set<string>();
  const existing = new Map(db.select().from(sfx).all().map((r) => [r.file, r]));

  for (const file of files) {
    const key = relKey(root, file);
    seen.add(key);
    const stat = fs.statSync(file);
    const prev = existing.get(key);
    const ov = overrides[key];
    const category = categoryOf(key);
    const cacheOk = prev?.cachedPath && fs.existsSync(path.join(cache, prev.cachedPath));
    try {
      let hash = prev?.hash ?? null;
      const sameStat = prev && prev.sizeBytes === stat.size && prev.mtimeMs === stat.mtimeMs;
      if (!sameStat || !hash) hash = crypto.createHash("sha1").update(fs.readFileSync(file)).digest("hex");
      const unchanged = !o.force && prev && prev.hash === hash && cacheOk;

      // Overrides from sfx.json win on every scan; otherwise keep what was set in the UI.
      const settings = {
        tags: ov?.tags ?? prev?.tags ?? [],
        defaultGainDb: ov?.gainDb ?? prev?.defaultGainDb ?? 0,
        enabled: ov?.enabled ?? prev?.enabled ?? true,
      };

      if (unchanged && prev) {
        db.update(sfx)
          .set({ ...settings, category, mtimeMs: stat.mtimeMs, sizeBytes: stat.size, missing: false, updatedAt: prev.missing ? ts : prev.updatedAt })
          .where(eq(sfx.id, prev.id))
          .run();
        res.unchanged++;
      } else {
        const { durationSec, channels } = await probeAudio(o.ffprobePath, file);
        const loud = parseEbur128((await run(o.ffmpegPath, measureArgs(file))).stderr);
        const gain = normalizeGainDb(durationSec, loud);
        const id = prev?.id ?? nanoid();
        const wav = `${id}.wav`;
        const png = `${id}.png`;
        await run(o.ffmpegPath, normalizeArgs(file, path.join(cache, wav), gain, channels));
        await run(o.ffmpegPath, waveformArgs(path.join(cache, wav), path.join(cache, png)));
        const row = {
          category,
          name: path.basename(key, path.extname(key)),
          durationSec: Math.round(durationSec * 1000) / 1000,
          peakDb: loud.peakDb,
          lufs: loud.lufs,
          ...settings,
          cachedPath: wav,
          waveformPath: png,
          hash,
          mtimeMs: stat.mtimeMs,
          sizeBytes: stat.size,
          missing: false,
          updatedAt: ts,
        };
        if (prev) {
          db.update(sfx).set(row).where(eq(sfx.id, prev.id)).run();
          res.updated.push(key);
        } else {
          db.insert(sfx).values({ id, file: key, ...row }).run();
          res.added.push(key);
        }
      }
      res.categories[category] = (res.categories[category] ?? 0) + 1;
    } catch (e) {
      res.failed.push({ file: key, error: e instanceof Error ? e.message : String(e) });
    }
  }

  // Files gone from the folder: mark missing (never planned), keep the row for history.
  for (const [key, row] of existing) {
    if (seen.has(key) || row.missing) continue;
    db.update(sfx).set({ missing: true, updatedAt: ts }).where(eq(sfx.id, row.id)).run();
    res.removed.push(key);
  }
  for (const key of Object.keys(overrides)) if (!seen.has(key)) res.warnings.push(`sfx.json mentions "${key}", which is not in the library`);
  res.ms = Date.now() - t0;
  return res;
}

/** Sounds the planner may use: enabled, present, cached. */
export function availableSfx(db: Db): Sfx[] {
  return db
    .select()
    .from(sfx)
    .all()
    .filter((s) => s.enabled && !s.missing && s.cachedPath)
    .sort((a, b) => a.file.localeCompare(b.file));
}

export const sfxPatchSchema = z
  .object({ enabled: z.boolean(), defaultGainDb: z.number().min(-40).max(20), tags: z.array(z.string().min(1).max(40)).max(20) })
  .partial();

export function updateSfx(db: Db, id: string, patch: z.infer<typeof sfxPatchSchema>, now: Date = new Date()): Sfx | undefined {
  const p = sfxPatchSchema.parse(patch);
  return db.update(sfx).set({ ...p, updatedAt: now.toISOString() }).where(eq(sfx.id, id)).returning().get();
}
