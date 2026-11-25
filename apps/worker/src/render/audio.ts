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
}

export function parseProbe(json: unknown): ProbeResult {
  const p = probeSchema.parse(json);
  const video = p.streams.find((s) => s.codec_type === "video");
  const audio = p.streams.find((s) => s.codec_type === "audio");
  const duration = p.format?.duration ?? audio?.duration ?? video?.duration;
  return {
    durationSec: duration !== undefined && Number.isFinite(duration) ? duration : null,
    width: video?.width ?? null,
    height: video?.height ?? null,
    hasAudio: Boolean(audio),
  };
}
