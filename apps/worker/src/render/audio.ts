import { z } from "zod";

/**
 * Pure FFmpeg/ffprobe argument builders for ingest (SPEC §7.1). They return argv arrays
 * (no shell, so paths with spaces need no quoting) and are unit-tested without running FFmpeg.
 */

/**
 * One pass, audio stream only (`-vn`, `-map 0:a:0`: video is never decoded):
 *  - 16 kHz mono PCM WAV for Whisper
 *  - 32 kbps mono Opus (Ogg) for Deepgram uploads
 */
export function extractAudioArgs(input: string, wavOut: string, opusOut: string, threads: number): string[] {
  return [
    "-hide_banner",
    "-nostdin",
    "-loglevel", "error",
    "-y",
    "-threads", String(threads),
    "-i", input,
    "-map", "0:a:0", "-vn", "-sn", "-dn",
    "-ac", "1", "-ar", "16000", "-c:a", "pcm_s16le",
    wavOut,
    "-map", "0:a:0", "-vn", "-sn", "-dn",
    "-ac", "1", "-c:a", "libopus", "-b:a", "32k", "-application", "voip",
    opusOut,
  ];
}

export function probeArgs(input: string): string[] {
  return ["-v", "error", "-print_format", "json", "-show_format", "-show_streams", input];
}

const probeSchema = z.object({
  format: z.object({ duration: z.coerce.number().optional() }).passthrough().optional(),
  streams: z
    .array(
      z
        .object({
          codec_type: z.string().optional(),
          width: z.number().optional(),
          height: z.number().optional(),
          duration: z.coerce.number().optional(),
          avg_frame_rate: z.string().optional(),
          disposition: z.object({ attached_pic: z.number().optional() }).passthrough().optional(),
        })
        .passthrough(),
    )
    .default([]),
});

export interface ProbeResult {
  durationSec: number | null;
  width: number | null;
  height: number | null;
  hasAudio: boolean;
  /** Real video streams (cover-art pictures attached to audio files don't count). */
  hasVideo: boolean;
  fps: number | null;
}

function parseRate(r: string | undefined): number | null {
  if (!r) return null;
  const [n, d] = r.split("/").map(Number);
  const v = d ? n! / d : n!;
  return Number.isFinite(v) && v > 0 ? Math.round(v * 1000) / 1000 : null;
}

export function parseProbe(json: unknown): ProbeResult {
  const p = probeSchema.parse(json);
  const video = p.streams.find((s) => s.codec_type === "video" && !s.disposition?.attached_pic);
  const audio = p.streams.find((s) => s.codec_type === "audio");
  const duration = p.format?.duration ?? audio?.duration ?? video?.duration;
  return {
    durationSec: duration !== undefined && Number.isFinite(duration) ? duration : null,
    width: video?.width ?? null,
    height: video?.height ?? null,
    hasAudio: Boolean(audio),
    hasVideo: Boolean(video),
    fps: parseRate(video?.avg_frame_rate),
  };
}

/**
 * Cut [start, start+duration] out of an upload or the cached full download without re-encoding
 * (SPEC §7.5). Input seeking + stream copy starts at the keyframe before `start`; the exact start is
 * measured afterwards by audio alignment.
 */
export function cutSectionArgs(input: string, start: number, duration: number, out: string): string[] {
  return [
    "-hide_banner",
    "-nostdin",
    "-loglevel", "error",
    "-y",
    "-ss", Math.max(0, start).toFixed(3),
    "-i", input,
    "-t", duration.toFixed(3),
    "-map", "0:v:0",
    "-map", "0:a:0?",
    "-c", "copy",
    "-avoid_negative_ts", "make_zero",
    "-movflags", "+faststart",
    out,
  ];
}
