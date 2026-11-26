/**
 * `pnpm check:render <sourceId> [--sync]`: M6 acceptance on the real output files of a source's clips.
 *  - 1080×1920, OUTPUT_FPS, duration = plan
 *  - loudness ≈ TARGET_LUFS (ebur128 on the final file)
 *  - whoosh at 0 s (the cued whoosh located inside the final audio by cross-correlation)
 *  - nothing in the bottom 20 % / right 12 % (captions.ass rendered alone over black, pixels checked)
 *  - --sync: captions in sync, ±100 ms on 3 spot-checked words (Whisper on the final clip vs words.json)
 *  - base / compose times from the job log
 */
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { clipFiles, findRepoRoot, jobDetail, loadEnv, measureArgs, parseEbur128, planSchema, planWordSchema, sfxCacheDir, sourceClips } from "@clip/shared";
import { openDb, schema } from "@clip/shared/db";
import { z } from "zod";
import { escapeFilterPath } from "../apps/worker/src/render/ffmpegCompose";

const sourceId = process.argv[2];
const doSync = process.argv.includes("--sync");
if (!sourceId) {
  console.error("usage: pnpm check:render <sourceId> [--sync]");
  process.exit(2);
}
const env = loadEnv();
const { db, sqlite } = openDb(env.DATABASE_PATH);
const d = jobDetail(db, sourceId);
if (!d) process.exit(2);
const pyDir = path.join(findRepoRoot(), "py");
const media = (cmd: string, args: object) => {
  const r = spawnSync(env.PYTHON_PATH, ["-m", "media", cmd, "--json", JSON.stringify(args)], { cwd: pyDir, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  const line = (r.stdout ?? "").split("\n").find((l) => l.trim().startsWith("{"));
  const j = line ? (JSON.parse(line) as { ok: boolean; result?: unknown; error?: string }) : { ok: false, error: r.stderr?.slice(-300) };
  if (!j.ok) throw new Error(`${cmd}: ${j.error}`);
  return j.result;
};

/** Max luma in the forbidden zones of a captions-only render (2 fps). */
function forbiddenZonePixels(assFile: string, duration: number): Promise<{ bottom: number; right: number; frames: number }> {
  const W = 1080;
  const H = 1920;
  const fonts = path.join(findRepoRoot(), "assets", "fonts");
  const args = ["-hide_banner", "-nostdin", "-loglevel", "error", "-f", "lavfi", "-i", `color=c=black:s=${W}x${H}:r=2:d=${duration.toFixed(2)}`, "-vf", `subtitles=filename=${escapeFilterPath(assFile)}:fontsdir=${escapeFilterPath(fonts)},format=gray`, "-f", "rawvideo", "-"];
  return new Promise((resolve, reject) => {
    const p = spawn(env.FFMPEG_PATH, args);
    let buf = Buffer.alloc(0);
    let bottom = 0;
    let right = 0;
    let frames = 0;
    const size = W * H;
    p.stdout.on("data", (c: Buffer) => {
      buf = Buffer.concat([buf, c]);
      while (buf.length >= size) {
        const f = buf.subarray(0, size);
        buf = buf.subarray(size);
        frames++;
        for (let y = Math.round(H * 0.8); y < H; y++) for (let x = 0; x < W; x++) bottom = Math.max(bottom, f[y * W + x]!);
        for (let y = 0; y < Math.round(H * 0.8); y++) for (let x = Math.round(W * 0.88); x < W; x++) right = Math.max(right, f[y * W + x]!);
      }
    });
    p.on("close", (code) => (code === 0 ? resolve({ bottom, right, frames }) : reject(new Error(`ffmpeg exited ${code}`))));
  });
}

const norm = (w: string) => w.toLowerCase().replace(/[^\p{L}\p{N}']/gu, "");
let problems = 0;
const fail = (m: string) => {
  problems++;
  console.log(`    !! ${m}`);
};

console.log(`\n${d.source.title ?? sourceId}\n`);
for (const c of sourceClips(db, sourceId)) {
  const f = clipFiles(env.STORAGE_DIR, c.id);
  console.log(`#${c.rank} ${c.status} v${c.composeVersion}`);
  if (!c.outputPath) {
    console.log("    (not rendered)");
    continue;
  }
  const out = path.join(env.STORAGE_DIR, c.outputPath);
  const plan = planSchema.parse(JSON.parse(fs.readFileSync(f.plan, "utf8")));
  const pr = JSON.parse(spawnSync(env.FFPROBE_PATH, ["-v", "error", "-show_entries", "stream=codec_type,width,height,r_frame_rate:format=duration", "-of", "json", out], { encoding: "utf8" }).stdout);
  const v = pr.streams.find((s: { codec_type: string }) => s.codec_type === "video");
  const dur = Number(pr.format.duration);
  console.log(`    file: ${v.width}×${v.height} @ ${v.r_frame_rate}, ${dur.toFixed(2)} s (plan ${plan.duration.toFixed(2)} s), layout ${plan.layout}`);
  if (v.width !== 1080 || v.height !== 1920) fail("not 1080×1920");
  if (Math.abs(dur - plan.duration) > 0.15) fail("duration differs from the plan");

  const loud = parseEbur128(spawnSync(env.FFMPEG_PATH, measureArgs(out), { encoding: "utf8" }).stderr);
  console.log(`    loudness: ${loud.lufs?.toFixed(1)} LUFS, true peak ${loud.peakDb?.toFixed(1)} dBFS (target ${env.TARGET_LUFS})`);
  if (loud.lufs === null || Math.abs(loud.lufs - env.TARGET_LUFS) > 1) fail("loudness not within ±1 LU of the target");

  const cueAt0 = c.edit?.sfxCues.find((q) => q.at === 0);
  const whoosh = cueAt0 && db.select().from(schema.sfx).all().find((s) => s.id === cueAt0.sfxId);
  if (whoosh?.cachedPath && fs.existsSync(path.join(sfxCacheDir(), whoosh.cachedPath))) {
    // The whoosh sits under speech, so its absolute match score varies; compare against a control (the same
    // search in base.mp4, which has no SFX): present = found at ≤ 50 ms with ≥ 2× the control's score.
    const needle = path.join(sfxCacheDir(), whoosh.cachedPath);
    const r = media("locate_audio", { needle, hay: out, duration: 2.0, ffmpegPath: env.FFMPEG_PATH }) as { offset: number; score: number };
    const ctl = c.basePath ? (media("locate_audio", { needle, hay: path.join(env.STORAGE_DIR, c.basePath), duration: 2.0, ffmpegPath: env.FFMPEG_PATH }) as { offset: number; score: number }) : { offset: -1, score: 0 };
    console.log(`    whoosh (${whoosh.category}/${whoosh.name}) at ${r.offset.toFixed(3)} s, match ${r.score.toFixed(2)} vs ${ctl.score.toFixed(2)} without SFX`);
    if (r.offset > 0.05 || r.score < Math.max(0.1, 2 * ctl.score)) fail("whoosh not found at 0 s");
  } else {
    console.log("    whoosh: no cue at 0 s (library empty?)");
    fail("no whoosh cue at 0 s");
  }

  const zone = await forbiddenZonePixels(f.ass, plan.duration);
  console.log(`    safe zones (${zone.frames} caption frames): max brightness bottom 20 % = ${zone.bottom}, right 12 % = ${zone.right}`);
  if (zone.bottom > 0 || zone.right > 0) fail("captions/hook drawn in a forbidden zone");

  if (doSync) {
    const words = z.array(planWordSchema).parse(JSON.parse(fs.readFileSync(f.words, "utf8"))).filter((w) => !w.teaser);
    const heard = (media("transcribe", { audio: out, model: env.WHISPER_MODEL, threads: env.WHISPER_THREADS }) as { words: { w: string; s: number }[] }).words;
    const counts = (list: { w: string }[]) => list.reduce((m, w) => m.set(norm(w.w), (m.get(norm(w.w)) ?? 0) + 1), new Map<string, number>());
    const cw = counts(words);
    const hw = counts(heard);
    const picks = words.filter((w) => norm(w.w).length >= 5 && cw.get(norm(w.w)) === 1 && hw.get(norm(w.w)) === 1);
    const spread = [picks[Math.floor(picks.length * 0.15)], picks[Math.floor(picks.length * 0.5)], picks[Math.floor(picks.length * 0.85)]].filter(Boolean) as typeof picks;
    for (const w of spread) {
      const h = heard.find((x) => norm(x.w) === norm(w.w))!;
      const diff = (h.s - w.s) * 1000;
      console.log(`    sync "${w.w}": caption ${w.s.toFixed(3)} s, heard ${h.s.toFixed(3)} s → ${diff >= 0 ? "+" : ""}${diff.toFixed(0)} ms`);
      if (Math.abs(diff) > 100) fail(`"${w.w}" out of sync by ${diff.toFixed(0)} ms`);
    }
    if (spread.length < 3) fail("could not find 3 distinctive words to spot-check");
  }
}
const timing = d.events.filter((e) => /^(Base render|Composed)/.test(e.message)).reverse();
console.log("\nTimings");
for (const e of timing) console.log(`  ${e.message.split(":")[0]}`);
sqlite.close();
console.log(problems ? `\n${problems} problem(s)` : "\nno problems");
process.exit(problems ? 1 : 0);
