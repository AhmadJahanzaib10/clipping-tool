/**
 * Pure FFmpeg argument builders and parsers for the SFX library (SPEC §10.2). Unit-tested without FFmpeg.
 */

/** Measure peak and integrated loudness: `ebur128` prints a summary on stderr. */
export function measureArgs(input: string): string[] {
  return ["-hide_banner", "-nostdin", "-nostats", "-i", input, "-map", "0:a:0", "-af", "ebur128=peak=true:framelog=quiet", "-f", "null", "-"];
}

export interface Loudness {
  /** Integrated loudness (LUFS); null when the sound is too short/quiet to gate (ebur128 reports -70). */
  lufs: number | null;
  /** True peak, dBFS. */
  peakDb: number | null;
}

/** Parse the ebur128 summary block ("I: -23.0 LUFS" … "Peak: -1.2 dBFS"). */
export function parseEbur128(stderr: string): Loudness {
  const summary = stderr.slice(stderr.lastIndexOf("Summary:"));
  const i = /I:\s+(-?[\d.]+|-inf)\s+LUFS/.exec(summary);
  const p = /Peak:\s+(-?[\d.]+|-inf)\s+dBFS/.exec(summary);
  const num = (m: RegExpExecArray | null) => (m && m[1] !== "-inf" ? Number(m[1]) : null);
  const lufs = num(i);
  return { lufs: lufs !== null && lufs > -69.9 ? lufs : null, peakDb: num(p) };
}

/** SPEC §10.2 normalization targets. */
export const SHORT_SFX_MAX_SEC = 1.5;
export const SHORT_PEAK_TARGET_DB = -6;
export const LONG_LUFS_TARGET = -20;
/** Never let normalization push a sound's peak above this. */
export const PEAK_CEILING_DB = -1;

/**
 * Gain (dB) to bring a sound to the common level: short sounds (≤ 1.5 s) by peak to −6 dBFS,
 * longer ones by loudness to −20 LUFS, always keeping the peak ≤ −1 dBFS.
 */
export function normalizeGainDb(durationSec: number, l: Loudness): number {
  let gain: number;
  if (durationSec <= SHORT_SFX_MAX_SEC || l.lufs === null) {
    gain = l.peakDb === null ? 0 : SHORT_PEAK_TARGET_DB - l.peakDb;
  } else {
    gain = LONG_LUFS_TARGET - l.lufs;
  }
  if (l.peakDb !== null && l.peakDb + gain > PEAK_CEILING_DB) gain = PEAK_CEILING_DB - l.peakDb;
  return Math.round(gain * 100) / 100;
}

/**
 * Cached render-ready copy: 48 kHz stereo 16-bit WAV with the normalization gain applied.
 * Mono is duplicated to both channels with `pan`: FFmpeg's default upmix treats mono as a centre
 * channel and lowers it by 3 dB, which would undo the normalization.
 */
export function normalizeArgs(input: string, output: string, gainDb: number, channels = 2): string[] {
  const toStereo = channels === 1 ? ",pan=stereo|c0=c0|c1=c0" : channels === 2 ? "" : ",aresample=ochl=stereo";
  return [
    "-hide_banner", "-nostdin", "-loglevel", "error", "-y",
    "-i", input,
    "-map", "0:a:0", "-vn",
    "-af", `volume=${gainDb.toFixed(2)}dB${toStereo}`,
    "-ar", "48000", "-ac", "2", "-c:a", "pcm_s16le",
    output,
  ];
}

/** Small waveform PNG for the library browser. */
export function waveformArgs(input: string, output: string, width = 400, height = 60): string[] {
  return [
    "-hide_banner", "-nostdin", "-loglevel", "error", "-y",
    "-i", input,
    "-filter_complex", `aformat=channel_layouts=mono,showwavespic=s=${width}x${height}:colors=#3b82f6`,
    "-frames:v", "1",
    output,
  ];
}
