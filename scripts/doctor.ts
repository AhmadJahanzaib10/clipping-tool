/**
 * `pnpm doctor` (SPEC §13): checks the machine and config, prints pass / warn / fail.
 * FAIL = needed now (exit code 1). WARN = needed by a later milestone or recommended.
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { findRepoRoot, loadEnv } from "@clip/shared";
import { openDb } from "@clip/shared/db";

type Status = "pass" | "warn" | "fail";
interface Check {
  name: string;
  status: Status;
  detail: string;
}

const root = findRepoRoot();
const env = loadEnv();
const results: Check[] = [];
const add = (name: string, status: Status, detail: string) => results.push({ name, status, detail });
/** Missing → fail when needed now, warn when only needed by a later milestone. */
const later = (milestone: string): Status => (milestone === "now" ? "fail" : "warn");

function run(cmd: string, args: string[], timeoutMs = 20_000) {
  const r = spawnSync(cmd, args, { encoding: "utf8", timeout: timeoutMs, windowsHide: true });
  return { ok: !r.error && r.status === 0, out: `${r.stdout ?? ""}${r.stderr ?? ""}`, error: r.error };
}
const firstLine = (s: string) => s.split(/\r?\n/).find((l) => l.trim())?.trim() ?? "";

// Node
const nodeMajor = Number(process.versions.node.split(".")[0]);
add("Node.js >= 20", nodeMajor >= 20 ? "pass" : "fail", `v${process.versions.node}`);

// .env
const envFile = path.join(root, ".env");
add(".env file", fs.existsSync(envFile) ? "pass" : "warn", fs.existsSync(envFile) ? envFile : "missing: copy .env.example to .env");
add(
  "WORKER_TOKEN changed",
  env.WORKER_TOKEN === "change-me" ? "warn" : "pass",
  env.WORKER_TOKEN === "change-me" ? "still the default 'change-me'" : "set",
);

// Database
try {
  const { sqlite } = openDb(env.DATABASE_PATH);
  const n = (sqlite.prepare("select count(*) n from operators").get() as { n: number }).n;
  add("Database + migrations", "pass", `${env.DATABASE_PATH} (${n} operators)`);
  if (n === 0) add("Seed data", "warn", "no operators: run `pnpm db:seed`");
  const sfxRows = (sqlite.prepare("select count(*) n from sfx where enabled = 1").get() as { n: number }).n;
  add("SFX library scanned", sfxRows > 0 ? "pass" : later("M5"), sfxRows > 0 ? `${sfxRows} sounds` : "no sounds scanned yet (needed from M5: `pnpm sfx:scan`)");
  sqlite.close();
} catch (e) {
  add("Database + migrations", "fail", e instanceof Error ? e.message : String(e));
}

// Python
const py = run(env.PYTHON_PATH, ["--version"]);
const pyVer = firstLine(py.out);
add("Python 3.11", py.ok && /Python 3\.11\./.test(pyVer) ? "pass" : py.ok ? "warn" : "fail", py.ok ? pyVer : `'${env.PYTHON_PATH}' not found`);
if (py.ok) {
  const mods = ["yt_dlp", "faster_whisper", "mediapipe", "scenedetect", "cv2"];
  const probe = run(env.PYTHON_PATH, [
    "-c",
    `import importlib.util, json; print(json.dumps({m: importlib.util.find_spec(m) is not None for m in ${JSON.stringify(mods)}}))`,
  ]);
  try {
    const found = JSON.parse(firstLine(probe.out)) as Record<string, boolean>;
    const missing = mods.filter((m) => !found[m]);
    add("Python packages (py/requirements.txt)", missing.length ? later("now") : "pass", missing.length ? `missing: ${missing.join(", ")}` : "all present");
  } catch {
    add("Python packages (py/requirements.txt)", later("now"), "could not probe");
  }
}

// Python media service: one-shot check_deps imports the native libraries the way the service does.
if (py.ok) {
  const r = spawnSync(env.PYTHON_PATH, ["-m", "media", "check_deps"], { cwd: path.join(root, "py"), encoding: "utf8", timeout: 120_000, windowsHide: true });
  try {
    const resp = JSON.parse(firstLine(r.stdout ?? "")) as { ok: boolean; result?: Record<string, string>; error?: string };
    const broken = Object.entries(resp.result ?? {}).filter(([, v]) => String(v).startsWith("ERROR"));
    add(
      "Media service (python -m media)",
      resp.ok && broken.length === 0 ? "pass" : later("now"),
      resp.ok ? (broken.length ? broken.map(([k, v]) => `${k}: ${v}`).join("; ") : Object.entries(resp.result ?? {}).map(([k, v]) => `${k} ${v}`).join(", ")) : (resp.error ?? "failed"),
    );
  } catch {
    add("Media service (python -m media)", later("now"), firstLine(r.stderr ?? "") || "did not respond");
  }
}

// yt-dlp (CLI or Python module)
const ytCli = run("yt-dlp", ["--version"]);
const ytMod = py.ok ? run(env.PYTHON_PATH, ["-m", "yt_dlp", "--version"]) : { ok: false, out: "" };
add(
  "yt-dlp",
  ytCli.ok || ytMod.ok ? "pass" : later("now"),
  ytCli.ok ? `CLI ${firstLine(ytCli.out)}` : ytMod.ok ? `python -m yt_dlp ${firstLine(ytMod.out)}` : "not installed (python -m pip install -r py/requirements.txt)",
);

// FFmpeg
const ff = run(env.FFMPEG_PATH, ["-hide_banner", "-version"]);
add("FFmpeg", ff.ok ? "pass" : "fail", ff.ok ? firstLine(ff.out) : `'${env.FFMPEG_PATH}' not found`);
const ffp = run(env.FFPROBE_PATH, ["-hide_banner", "-version"]);
add("FFprobe", ffp.ok ? "pass" : "fail", ffp.ok ? firstLine(ffp.out) : `'${env.FFPROBE_PATH}' not found`);
if (ff.ok) {
  const encoders = run(env.FFMPEG_PATH, ["-hide_banner", "-encoders"]).out;
  add("libx264 encoder (fallback)", /\blibx264\b/.test(encoders) ? "pass" : "fail", /\blibx264\b/.test(encoders) ? "listed" : "missing");
  const filters = run(env.FFMPEG_PATH, ["-hide_banner", "-filters"]).out;
  const hasSubs = /\bsubtitles\b/.test(filters) && /\bass\b/.test(filters);
  add("libass (subtitles filter)", hasSubs ? "pass" : "fail", hasSubs ? "subtitles + ass filters available" : "FFmpeg built without libass");
  const hasLoudnorm = /\bloudnorm\b/.test(filters);
  add("loudnorm filter", hasLoudnorm ? "pass" : "fail", hasLoudnorm ? "available" : "missing");

  if (!/\bh264_qsv\b/.test(encoders)) {
    add("h264_qsv (Quick Sync)", "warn", "not listed: renders will use libx264 (slower)");
  } else {
    const t0 = Date.now();
    const enc = run(
      env.FFMPEG_PATH,
      ["-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", "testsrc2=size=1080x1920:rate=30", "-t", "1", "-c:v", "h264_qsv", "-global_quality", "23", "-f", "null", "-"],
      60_000,
    );
    add(
      "h264_qsv (Quick Sync) test encode",
      enc.ok ? "pass" : "warn",
      enc.ok ? `1 s of 1080x1920 encoded in ${Date.now() - t0} ms` : `listed but test encode failed; set VIDEO_ENCODER=libx264. ${firstLine(enc.out)}`,
    );
  }
}

// Fonts (M6)
const fontsDir = path.join(root, "assets", "fonts");
const fonts = fs.existsSync(fontsDir) ? fs.readdirSync(fontsDir).filter((f) => /\.(ttf|otf)$/i.test(f)) : [];
const wantFonts = [
  { label: "Montserrat ExtraBold", re: /montserrat.*extra.?bold/i },
  { label: "Inter Bold", re: /inter.*bold/i },
];
const missingFonts = wantFonts.filter((w) => !fonts.some((f) => w.re.test(f))).map((w) => w.label);
add("Caption fonts in assets/fonts", missingFonts.length ? later("M6") : "pass", missingFonts.length ? `missing: ${missingFonts.join(", ")} (needed from M6)` : fonts.join(", "));

// API keys and models
add("DEEPGRAM_API_KEY", env.DEEPGRAM_API_KEY ? "pass" : later("M2"), env.DEEPGRAM_API_KEY ? "set" : "not set: transcription falls back to Whisper (M2)");
add("OPENROUTER_API_KEY", env.OPENROUTER_API_KEY ? "pass" : later("M3"), env.OPENROUTER_API_KEY ? "set" : "not set (needed from M3)");
const models = env.LLM_SCOUT_MODEL && env.LLM_EDITOR_MODEL;
add("LLM_SCOUT_MODEL / LLM_EDITOR_MODEL", models ? "pass" : later("M3"), models ? `${env.LLM_SCOUT_MODEL} / ${env.LLM_EDITOR_MODEL}` : "not set (needed from M3)");

// Disk
try {
  fs.mkdirSync(env.STORAGE_DIR, { recursive: true });
  const s = fs.statfsSync(env.STORAGE_DIR);
  const freeGb = (s.bavail * s.bsize) / 1024 ** 3;
  add("Disk space >= 30 GB free", freeGb >= 30 ? "pass" : "fail", `${freeGb.toFixed(1)} GB free at ${env.STORAGE_DIR}`);
} catch (e) {
  add("Disk space >= 30 GB free", "fail", e instanceof Error ? e.message : String(e));
}

// Report
const icon: Record<Status, string> = { pass: "PASS", warn: "WARN", fail: "FAIL" };
const width = Math.max(...results.map((r) => r.name.length));
console.log("\nClip Engine doctor\n");
for (const r of results) console.log(`  [${icon[r.status]}] ${r.name.padEnd(width)}  ${r.detail}`);
const n = (s: Status) => results.filter((r) => r.status === s).length;
console.log(`\n${n("pass")} passed, ${n("warn")} warnings, ${n("fail")} failed\n`);
process.exit(n("fail") > 0 ? 1 : 0);
