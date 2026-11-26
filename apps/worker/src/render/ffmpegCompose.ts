import { finalFormat, OUT_H, OUT_W, threadArgs, videoEncoderArgs, type EncodeOptions, type LoudnessMeasure } from "./ffmpegBase";

/**
 * COMPOSE (SPEC §7.10) as a pure FFmpeg argument builder — the fast pass after every text/SFX edit.
 * base.mp4 + captions.ass + overlay PNG + SFX WAVs → clip.vN.mp4:
 *  video: subtitles → overlay → thin progress bar at the very bottom (a full-width colour strip slid in by t)
 *  audio: base + SFX (adelay, per-cue gain), amix normalize=0, loudnorm to TARGET_LUFS (single pass with
 *         the values measured after RENDER_BASE)
 */

export const PROGRESS_H = 10;

/**
 * Path for an FFmpeg filter option on Windows (SPEC §15): forward slashes, `:` escaped, then quoted so
 * spaces and commas are safe. Single quotes are closed, escaped and reopened.
 */
export function escapeFilterPath(p: string): string {
  const v = p.replace(/\\/g, "/").replace(/:/g, "\\:");
  return `'${v.replace(/'/g, "'\\''")}'`;
}

export interface OverlaySpec {
  file: string;
  position: "top" | "bottom" | "top-left" | "top-right";
  widthPct: number;
  opacity: number;
}

/** Overlay placement inside the safe area (never in the bottom 20 % or the right 12 %). */
export function overlayXY(pos: OverlaySpec["position"]): { x: string; y: string } {
  const m = 40;
  const right = Math.round(OUT_W * 0.88);
  const bottom = Math.round(OUT_H * 0.8);
  switch (pos) {
    case "top":
      return { x: `(${right}-w)/2`, y: String(Math.round(OUT_H * 0.03)) };
    case "top-left":
      return { x: String(m), y: String(Math.round(OUT_H * 0.03)) };
    case "top-right":
      return { x: `${right}-w-${m}`, y: String(Math.round(OUT_H * 0.03)) };
    case "bottom":
      return { x: `(${right}-w)/2`, y: `${bottom}-h-${m}` };
  }
}

export interface SfxInput {
  file: string;
  /** Output time (s). */
  at: number;
  gainDb: number;
}

export interface ComposeInput extends EncodeOptions {
  base: string;
  ass: string;
  fontsDir: string;
  duration: number;
  overlay?: OverlaySpec | null;
  sfx: SfxInput[];
  targetLufs: number;
  measured?: LoudnessMeasure | null;
  progressColor?: string;
  out: string;
}

const n = (v: number, d = 3) => Number(v.toFixed(d)).toString();

/** −1.5 dBFS as a linear amplitude (limiter ceiling). */
export const TRUE_PEAK_LINEAR = Math.pow(10, -1.5 / 20);
/** Most we will ever boost a voice track (protects against near-silent measurements). */
export const MAX_VOICE_GAIN_DB = 30;

/** Gain that brings the measured voice to the target loudness. */
export function voiceGainDb(m: LoudnessMeasure, targetLufs: number): number {
  const gain = targetLufs - Number(m.input_i);
  return Math.max(-30, Math.min(MAX_VOICE_GAIN_DB, gain));
}

export function buildComposeArgs(i: ComposeInput): string[] {
  const inputs: string[] = ["-i", i.base];
  inputs.push("-f", "lavfi", "-i", `color=c=${i.progressColor ?? "white@0.85"}:s=${OUT_W}x${PROGRESS_H}:r=${i.fps},format=rgba`);
  let next = 2;
  const ovIdx = i.overlay ? next++ : -1;
  if (i.overlay) inputs.push("-loop", "1", "-i", i.overlay.file);
  const sfxIdx = i.sfx.map(() => next++);
  for (const s of i.sfx) inputs.push("-i", s.file);

  const v: string[] = [];
  v.push(`[0:v]subtitles=filename=${escapeFilterPath(i.ass)}:fontsdir=${escapeFilterPath(i.fontsDir)}[vs]`);
  let cur = "vs";
  if (i.overlay) {
    const w = Math.round((OUT_W * Math.min(100, Math.max(1, i.overlay.widthPct))) / 100);
    const { x, y } = overlayXY(i.overlay.position);
    v.push(`[${ovIdx}:v]format=rgba,scale=${w}:-2,colorchannelmixer=aa=${n(Math.min(1, Math.max(0, i.overlay.opacity)), 2)}[ovl]`);
    v.push(`[${cur}][ovl]overlay=x=${x}:y=${y}:shortest=1[vo]`);
    cur = "vo";
  }
  // Progress bar: a full-width strip slid in from the left, so its visible width grows with t.
  v.push(`[${cur}][1:v]overlay=x='-w+w*t/${n(i.duration)}':y=H-h:shortest=1:eval=frame,format=${finalFormat(i.encoder)}[vout]`);

  // Loudness: the measurement cached from RENDER_BASE describes the voice only. Applying it to the whole mix
  // (loudnorm linear mode) would push the SFX up by the same gain, so the voice is brought to the target
  // first and the SFX are mixed relative to it; a limiter keeps true peaks ≤ −1.5 dBFS. Without a cached
  // measurement, the whole mix goes through a normal (dynamic) loudnorm instead.
  const a: string[] = [];
  const m = i.measured;
  const voiceGain = m ? voiceGainDb(m, i.targetLufs) : null;
  a.push(`[0:a]aformat=sample_fmts=fltp:channel_layouts=stereo:sample_rates=48000${voiceGain !== null ? `,volume=${n(voiceGain, 2)}dB` : ""}[avox]`);
  let mix = "[avox]";
  if (i.sfx.length) {
    i.sfx.forEach((s, k) => {
      const ms = Math.max(0, Math.round(s.at * 1000));
      a.push(`[${sfxIdx[k]}:a]aformat=sample_fmts=fltp:channel_layouts=stereo:sample_rates=48000,adelay=${ms}:all=1,volume=${n(s.gainDb, 2)}dB[sx${k}]`);
    });
    a.push(`[avox]${i.sfx.map((_, k) => `[sx${k}]`).join("")}amix=inputs=${i.sfx.length + 1}:normalize=0:duration=first:dropout_transition=0[amx]`);
    mix = "[amx]";
  }
  const level = voiceGain !== null ? `alimiter=limit=${n(TRUE_PEAK_LINEAR, 4)}:attack=5:release=50:level=disabled` : `loudnorm=I=${i.targetLufs}:TP=-1.5:LRA=11`;
  a.push(`${mix}${level},aresample=48000[aout]`);

  return [
    "-hide_banner", "-nostdin", "-loglevel", "error", "-y",
    ...inputs,
    "-filter_complex", [...v, ...a].join(";"),
    "-map", "[vout]", "-map", "[aout]",
    "-r", String(i.fps),
    ...videoEncoderArgs(i, "compose"),
    "-c:a", "aac", "-b:a", "192k", "-ar", "48000",
    ...threadArgs(i.threads),
    "-t", n(i.duration),
    "-movflags", "+faststart",
    i.out,
  ];
}

/** Thumbnail: the frame at 1.0 s (SPEC §7.10). */
export function thumbnailArgs(input: string, out: string, at = 1.0): string[] {
  return ["-hide_banner", "-nostdin", "-loglevel", "error", "-y", "-ss", n(at), "-i", input, "-frames:v", "1", "-q:v", "3", out];
}
