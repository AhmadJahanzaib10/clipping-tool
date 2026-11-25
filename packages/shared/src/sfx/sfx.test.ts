import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { openDb, type Db } from "../db/client";
import { measureArgs, normalizeArgs, normalizeGainDb, parseEbur128, waveformArgs } from "./ffmpeg";
import { availableSfx, categoryOf, scanSfx, updateSfx } from "./scan";

describe("ffmpeg builders", () => {
  it("measure / normalize / waveform keep paths as single argv entries", () => {
    expect(measureArgs("C:\\My SFX\\pop 1.mp3")).toContain("C:\\My SFX\\pop 1.mp3");
    const n = normalizeArgs("in.mp3", "C:\\c\\x.wav", -3.456);
    expect(n).toContain("volume=-3.46dB");
    expect(normalizeArgs("m.mp3", "o.wav", 0, 1)).toContain("volume=0.00dB,pan=stereo|c0=c0|c1=c0"); // mono: no −3 dB upmix
    expect(n.slice(n.indexOf("-ar"), n.indexOf("-ar") + 6)).toEqual(["-ar", "48000", "-ac", "2", "-c:a", "pcm_s16le"]);
    expect(waveformArgs("x.wav", "x.png").join(" ")).toMatch(/showwavespic=s=400x60/);
  });

  it("parses the ebur128 summary", () => {
    const stderr = `[Parsed_ebur128_0 @ 0x1] Summary:\n\n  Integrated loudness:\n    I:         -18.4 LUFS\n    Threshold: -28.6 LUFS\n\n  True peak:\n    Peak:       -2.3 dBFS\n`;
    expect(parseEbur128(stderr)).toEqual({ lufs: -18.4, peakDb: -2.3 });
    expect(parseEbur128("Summary:\n I: -70.0 LUFS\n Peak: -12.0 dBFS")).toEqual({ lufs: null, peakDb: -12 });
    expect(parseEbur128("Summary:\n I: -inf LUFS\n Peak: -inf dBFS")).toEqual({ lufs: null, peakDb: null });
  });

  it("normalizes short sounds by peak (−6 dBFS), long ones by loudness (−20 LUFS), peak ≤ −1", () => {
    expect(normalizeGainDb(0.4, { lufs: -30, peakDb: -12 })).toBe(6);
    expect(normalizeGainDb(3, { lufs: -26, peakDb: -14 })).toBe(6);
    expect(normalizeGainDb(3, { lufs: -10, peakDb: -0.5 })).toBe(-10);
    expect(normalizeGainDb(3, { lufs: -30, peakDb: -4 })).toBe(3); // capped: −4 + 10 would clip past −1
    expect(normalizeGainDb(2, { lufs: null, peakDb: -9 })).toBe(3); // no loudness → peak rule
  });

  it("category is the first folder, root files are misc", () => {
    expect(categoryOf("pop/soft-01.mp3")).toBe("pop");
    expect(categoryOf("Whoosh/deep/a.wav")).toBe("whoosh");
    expect(categoryOf("loose.ogg")).toBe("misc");
  });
});

// ---------- scan against real FFmpeg (SPEC §14 M5 acceptance) ----------

const ffmpeg = process.env.FFMPEG_PATH ?? "ffmpeg";
const ffprobe = process.env.FFPROBE_PATH ?? "ffprobe";
let tmp: string;
let root: string;
let cache: string;
let db: Db;

/** A short tone as MP3 (sound effect stand-in). */
function tone(file: string, freq: number, seconds: number, volume = 0.3) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  execFileSync(ffmpeg, ["-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i", `sine=frequency=${freq}:duration=${seconds}`, "-af", `volume=${volume}`, "-c:a", "libmp3lame", "-b:a", "128k", file]);
}
const opts = () => ({ ffmpegPath: ffmpeg, ffprobePath: ffprobe, root, cacheDir: cache });

beforeAll(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "sfx-"));
  root = path.join(tmp, "sfx");
  cache = path.join(tmp, "cache");
  db = openDb(":memory:").db;
  tone(path.join(root, "whoosh", "swoosh one.mp3"), 300, 0.6);
  tone(path.join(root, "pop", "pop-a.mp3"), 900, 0.15, 0.05);
});
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

describe("scanSfx", () => {
  it("adds files, measures and caches normalized 48 kHz stereo WAVs + waveforms", async () => {
    const r = await scanSfx(db, opts());
    expect(r.failed).toEqual([]);
    expect(r.added.sort()).toEqual(["pop/pop-a.mp3", "whoosh/swoosh one.mp3"]);
    const lib = availableSfx(db);
    expect(lib).toHaveLength(2);
    const pop = lib.find((s) => s.category === "pop")!;
    expect(pop.durationSec).toBeGreaterThan(0.1);
    expect(pop.peakDb).toBeLessThan(-20); // quiet source
    const wav = path.join(cache, pop.cachedPath!);
    const probe = execFileSync(ffprobe, ["-v", "error", "-show_entries", "stream=sample_rate,channels", "-of", "csv=p=0", wav]).toString().trim();
    expect(probe).toBe("48000,2");
    expect(fs.existsSync(path.join(cache, pop.waveformPath!))).toBe(true);
  });

  it("normalized cache is at the common level", async () => {
    const pop = availableSfx(db).find((s) => s.category === "pop")!;
    const wav = path.join(cache, pop.cachedPath!);
    const res = await new Promise<string>((resolve) => {
      const p = spawn(ffmpeg, measureArgs(wav));
      let err = "";
      p.stderr.on("data", (d: Buffer) => (err += d.toString()));
      p.on("close", () => resolve(err));
    });
    expect(parseEbur128(res).peakDb!).toBeCloseTo(-6, 0);
  });

  it("skips unchanged files on rescan", async () => {
    const r = await scanSfx(db, opts());
    expect(r).toMatchObject({ added: [], updated: [], unchanged: 2, removed: [] });
  });

  it("dropping a new MP3 into a (new) category folder makes it available after Rescan", async () => {
    tone(path.join(root, "ding", "bell.mp3"), 1500, 0.3);
    const r = await scanSfx(db, opts());
    expect(r.added).toEqual(["ding/bell.mp3"]);
    expect(r.categories).toMatchObject({ ding: 1, pop: 1, whoosh: 1 });
    expect(availableSfx(db).map((s) => s.category).sort()).toEqual(["ding", "pop", "whoosh"]);
  });

  it("a changed file is re-processed; a removed one is marked missing (not available)", async () => {
    tone(path.join(root, "pop", "pop-a.mp3"), 700, 0.25);
    fs.rmSync(path.join(root, "ding", "bell.mp3"));
    const r = await scanSfx(db, opts());
    expect(r.updated).toEqual(["pop/pop-a.mp3"]);
    expect(r.removed).toEqual(["ding/bell.mp3"]);
    expect(availableSfx(db).some((s) => s.category === "ding")).toBe(false);
    tone(path.join(root, "ding", "bell.mp3"), 1500, 0.3);
    await scanSfx(db, opts());
    expect(availableSfx(db).some((s) => s.category === "ding")).toBe(true);
  });

  it("applies sfx.json overrides and keeps UI edits otherwise", async () => {
    const whoosh = availableSfx(db).find((s) => s.category === "whoosh")!;
    updateSfx(db, whoosh.id, { defaultGainDb: -3 });
    fs.writeFileSync(path.join(root, "sfx.json"), JSON.stringify({ "pop/pop-a.mp3": { gainDb: -4, tags: ["soft"], enabled: false }, "nope/x.mp3": {} }));
    const r = await scanSfx(db, opts());
    expect(r.warnings.some((w) => w.includes("nope/x.mp3"))).toBe(true);
    const lib = availableSfx(db);
    expect(lib.find((s) => s.category === "pop")).toBeUndefined(); // disabled by sfx.json
    expect(lib.find((s) => s.category === "whoosh")!.defaultGainDb).toBe(-3); // UI edit kept
    fs.writeFileSync(path.join(root, "sfx.json"), "{ broken");
    expect((await scanSfx(db, opts())).warnings[0]).toMatch(/sfx.json ignored/);
  });
});
