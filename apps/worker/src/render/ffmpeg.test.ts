import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { findRepoRoot, parseEbur128, measureArgs, type Plan } from "@clip/shared";
import { buildBaseArgs, cropXExpr, layoutChain, measureLoudnessArgs, parseLoudnorm, zoomExpr } from "./ffmpegBase";
import { buildComposeArgs, escapeFilterPath, overlayXY, thumbnailArgs } from "./ffmpegCompose";
import { buildAss } from "./ass";

/** Evaluate an FFmpeg-style expression in JS (if/lt/between/t) to test the generated strings. */
function evalExpr(expr: string, t: number): number {
  const js = expr.replace(/\bif\(/g, "IF(").replace(/\blt\(/g, "LT(").replace(/\bbetween\(/g, "BETWEEN(");
  // eslint-disable-next-line @typescript-eslint/no-implied-eval
  return new Function("t", "IF", "LT", "BETWEEN", `return ${js};`)(t, (c: number, a: number, b: number) => (c ? a : b), (a: number, b: number) => (a < b ? 1 : 0), (x: number, a: number, b: number) => (x >= a && x <= b ? 1 : 0));
}

const plan = (o: Partial<Plan> = {}): Plan => ({
  version: 1,
  clipId: "c",
  layout: "single",
  layoutReason: "",
  focus: "auto",
  section: { sourceStart: 100, width: 1920, height: 1080, fps: 30 },
  segments: [{ kind: "main", srcStart: 102, srcEnd: 112, outStart: 0, outEnd: 10 }],
  duration: 10,
  crop: { mode: "single", w: 608, h: 1080, y: 0, keyframes: [{ t: 0, x: 600, jump: true }] },
  zoom: [],
  cuts: [],
  sfx: [],
  stats: { removedPauses: 0, removedFillers: 0, savedSec: 0, coldOpen: false },
  ...o,
});

describe("expressions", () => {
  it("crop x interpolates linearly and steps at jump keyframes", () => {
    const e = cropXExpr([
      { t: 0, x: 100, jump: true },
      { t: 2, x: 300 },
      { t: 5, x: 900, jump: true },
    ]);
    expect(evalExpr(e, 0)).toBe(100);
    expect(evalExpr(e, 1)).toBe(200);
    expect(evalExpr(e, 3)).toBe(300); // held until the jump
    expect(evalExpr(e, 5)).toBe(900);
    expect(evalExpr(e, 9)).toBe(900);
    expect(cropXExpr([{ t: 0, x: 42 }])).toBe("42");
  });

  it("zoom eases 1 → scale → 1", () => {
    const e = zoomExpr([{ start: 2, peak: 2.15, holdEnd: 3.2, end: 3.35, scale: 1.06 }]);
    expect(evalExpr(e, 1)).toBe(1);
    expect(evalExpr(e, 2.075)).toBeCloseTo(1.03, 3);
    expect(evalExpr(e, 2.5)).toBeCloseTo(1.06, 6);
    expect(evalExpr(e, 3.275)).toBeCloseTo(1.03, 3);
    expect(evalExpr(e, 4)).toBe(1);
    expect(zoomExpr([])).toBe("1");
  });
});

describe("arg builders", () => {
  it("base: trims each segment in section time, concatenates, crops 9:16, encodes per encoder", () => {
    const a = buildBaseArgs({ section: "C:\\a b\\section.mp4", plan: plan(), out: "base.mp4", encoder: "h264_qsv", threads: 4, fps: 30 });
    const fc = a[a.indexOf("-filter_complex") + 1]!;
    expect(fc).toContain("trim=start=2:end=12"); // 102–112 source → 2–12 in the section
    expect(fc).toContain("concat=n=1:v=1:a=1");
    expect(fc).toContain("crop=w=608:h=1080:x='600':y=0,scale=1080:1920");
    expect(fc).toContain("format=nv12[vout]");
    expect(fc).toContain("highpass=f=80,acompressor");
    expect(a).toContain("h264_qsv");
    expect(a[a.indexOf("-global_quality") + 1]).toBe("18");
    const x = buildBaseArgs({ section: "s.mp4", plan: plan(), out: "b.mp4", encoder: "libx264", threads: 4, fps: 30 });
    expect(x.slice(x.indexOf("-c:v"), x.indexOf("-c:v") + 6)).toEqual(["-c:v", "libx264", "-preset", "veryfast", "-crf", "17"]);
    expect(x[x.indexOf("-threads") + 1]).toBe("4");
  });

  it("layout chains: split stacks two 1080×960 regions; fit blurs a quarter-size copy", () => {
    expect(layoutChain(plan({ layout: "split", crop: { mode: "split", top: { x: 0, y: 100, w: 900, h: 800 }, bottom: { x: 960, y: 100, w: 900, h: 800 } } }))).toContain(
      "crop=900:800:0:100,scale=1080:960:flags=bicubic[vt1];[vb0]crop=900:800:960:100,scale=1080:960:flags=bicubic[vb1];[vt1][vb1]vstack=inputs=2",
    );
    const fit = layoutChain(plan({ layout: "fit", crop: { mode: "fit" } }));
    expect(fit).toContain("scale=270:480:force_original_aspect_ratio=increase");
    expect(fit).toContain("gblur");
    expect(layoutChain(plan({ zoom: [{ start: 1, peak: 1.15, holdEnd: 2.2, end: 2.35, scale: 1.06 }] }))).toContain("eval=frame");
  });

  it("compose: subtitles with escaped Windows paths, progress bar, SFX delays and gains, loudnorm", () => {
    const a = buildComposeArgs({
      base: "base.mp4",
      ass: "C:\\Users\\Pc\\My Clips\\captions.ass",
      fontsDir: "C:\\repo\\assets\\fonts",
      duration: 30,
      sfx: [{ file: "whoosh.wav", at: 0, gainDb: -14 }, { file: "pop.wav", at: 4.25, gainDb: -16.5 }],
      targetLufs: -14,
      measured: { input_i: "-20.1", input_tp: "-3.0", input_lra: "4.0", input_thresh: "-30.5", target_offset: "0.2" },
      encoder: "libx264",
      threads: 4,
      fps: 30,
      out: "clip.v1.mp4",
    });
    const fc = a[a.indexOf("-filter_complex") + 1]!;
    expect(fc).toContain("subtitles=filename='C\\:/Users/Pc/My Clips/captions.ass':fontsdir='C\\:/repo/assets/fonts'");
    expect(fc).toContain("overlay=x='-w+w*t/30':y=H-h");
    expect(fc).toContain("adelay=0:all=1,volume=-14dB");
    expect(fc).toContain("adelay=4250:all=1,volume=-16.5dB");
    expect(fc).toContain("amix=inputs=3:normalize=0");
    // Voice brought to −14 with the cached measurement (−20.1 → +6.1 dB) before the SFX are mixed in.
    expect(fc).toContain("[0:a]aformat=sample_fmts=fltp:channel_layouts=stereo:sample_rates=48000,volume=6.1dB[avox]");
    expect(fc).toContain("alimiter=limit=0.8414");
    expect(fc).not.toContain("loudnorm");
    const noMeasure = buildComposeArgs({ base: "b", ass: "a", fontsDir: "f", duration: 5, sfx: [], targetLufs: -14, encoder: "libx264", threads: 2, fps: 30, out: "o" });
    expect(noMeasure[noMeasure.indexOf("-filter_complex") + 1]).toContain("[avox]loudnorm=I=-14:TP=-1.5:LRA=11");
    expect(a.filter((x) => x === "-i")).toHaveLength(4);
    expect(a[a.indexOf("-crf") + 1]).toBe("21");
  });

  it("escapes quotes in paths and keeps overlays inside the safe area", () => {
    expect(escapeFilterPath("D:\\it's\\x.ass")).toBe("'D\\:/it'\\''s/x.ass'");
    expect(overlayXY("top-right").x).toBe("950-w-40");
    expect(overlayXY("bottom").y).toBe("1536-h-40");
  });

  it("parses loudnorm's JSON block", () => {
    const err = `[Parsed_loudnorm_0 @ 0x]\n{\n\t"input_i" : "-19.62",\n\t"input_tp" : "-2.10",\n\t"input_lra" : "5.30",\n\t"input_thresh" : "-29.90",\n\t"output_i" : "-14.0",\n\t"target_offset" : "0.11"\n}\n`;
    expect(parseLoudnorm(err)).toEqual({ input_i: "-19.62", input_tp: "-2.10", input_lra: "5.30", input_thresh: "-29.90", target_offset: "0.11" });
    expect(parseLoudnorm("no json")).toBeNull();
    expect(measureLoudnessArgs("x.mp4", -14)).toContain("loudnorm=I=-14:TP=-1.5:LRA=11:print_format=json");
    expect(thumbnailArgs("c.mp4", "t.jpg")).toEqual(["-hide_banner", "-nostdin", "-loglevel", "error", "-y", "-ss", "1", "-i", "c.mp4", "-frames:v", "1", "-q:v", "3", "t.jpg"]);
  });
});

// ---------- real FFmpeg, end to end (synthetic section) ----------

const ffmpeg = process.env.FFMPEG_PATH ?? "ffmpeg";
let dir: string;
beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "render test "));
  // 20 s section: test pattern + speech-band tone at a quiet level.
  execFileSync(ffmpeg, ["-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i", "testsrc2=s=1920x1080:r=30:d=20", "-f", "lavfi", "-i", "sine=f=220:d=20", "-af", "volume=0.05", "-c:v", "libx264", "-preset", "ultrafast", "-c:a", "aac", "-shortest", path.join(dir, "section.mp4")]);
  execFileSync(ffmpeg, ["-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i", "anoisesrc=d=0.5:a=0.5", "-ac", "2", "-ar", "48000", path.join(dir, "whoosh.wav")]);
});
afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

const probe = (f: string) => JSON.parse(execFileSync("ffprobe", ["-v", "error", "-show_entries", "stream=codec_type,width,height,r_frame_rate:format=duration", "-of", "json", f]).toString());
const lufs = (f: string) => parseEbur128(spawnSync(ffmpeg, measureArgs(f), { encoding: "utf8" }).stderr).lufs!;

describe("render end to end (libx264, synthetic section)", () => {
  it("base + compose: 1080×1920, right duration, ≈ −14 LUFS, paths with spaces", () => {
    const p = plan({
      segments: [
        { kind: "teaser", srcStart: 110, srcEnd: 112, outStart: 0, outEnd: 2 },
        { kind: "transition", srcStart: 112, srcEnd: 112, outStart: 2, outEnd: 2.2 },
        { kind: "main", srcStart: 102, srcEnd: 106, outStart: 2.2, outEnd: 6.2 },
        { kind: "main", srcStart: 107, srcEnd: 112, outStart: 6.2, outEnd: 11.2 },
      ],
      duration: 11.2,
      crop: { mode: "single", w: 608, h: 1080, y: 0, keyframes: [{ t: 0, x: 200, jump: true }, { t: 2.2, x: 600, jump: true }, { t: 8, x: 900 }] },
      zoom: [{ start: 3, peak: 3.15, holdEnd: 4.2, end: 4.35, scale: 1.06 }],
    });
    const base = path.join(dir, "base.mp4");
    execFileSync(ffmpeg, buildBaseArgs({ section: path.join(dir, "section.mp4"), plan: p, out: base, encoder: "libx264", threads: 4, fps: 30 }));
    const b = probe(base);
    expect(b.streams.find((s: { codec_type: string }) => s.codec_type === "video")).toMatchObject({ width: 1080, height: 1920, r_frame_rate: "30/1" });
    expect(Number(b.format.duration)).toBeCloseTo(11.2, 1);

    const measured = parseLoudnorm(spawnSync(ffmpeg, measureLoudnessArgs(base, -14), { encoding: "utf8" }).stderr);
    expect(measured).not.toBeNull();
    const words = [0.3, 0.6, 2.4, 2.7, 3.0, 6.5, 6.8].map((s, k) => ({ i: k, w: ["Big", "news.", "This", "changes", "everything", "trust", "me."][k]!, s, e: s + 0.25 }));
    const { ass } = buildAss({ words, edit: { captionPreset: "bold-yellow", wordEdits: [], emphasisWords: ["changes"] }, hook: "A test hook", hookStyle: "top-banner", layout: "single", duration: 11.2 });
    const assFile = path.join(dir, "captions.ass");
    fs.writeFileSync(assFile, ass);
    const out = path.join(dir, "clip.v1.mp4");
    const r = spawnSync(ffmpeg, buildComposeArgs({ base, ass: assFile, fontsDir: path.join(findRepoRoot(), "assets", "fonts"), duration: 11.2, sfx: [{ file: path.join(dir, "whoosh.wav"), at: 0, gainDb: -14 }], targetLufs: -14, measured, encoder: "libx264", threads: 4, fps: 30, out }), { encoding: "utf8" });
    expect(r.status, r.stderr).toBe(0);
    const o = probe(out);
    expect(o.streams.find((s: { codec_type: string }) => s.codec_type === "video")).toMatchObject({ width: 1080, height: 1920 });
    expect(Number(o.format.duration)).toBeCloseTo(11.2, 1);
    expect(lufs(out)).toBeGreaterThan(-15.5);
    expect(lufs(out)).toBeLessThan(-12.5);
  }, 120_000);
});
