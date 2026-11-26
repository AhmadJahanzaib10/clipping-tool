import type { Env } from "@clip/shared";
import { runProcess } from "../proc";
import type { VideoEncoder } from "./ffmpegBase";

/**
 * QSV with fallback (SPEC §3, §7.8): try the configured encoder (h264_qsv by default); if FFmpeg fails with
 * it, run the same job again with libx264 and remember that for the rest of this worker's life.
 */
let qsvBroken = false;

export function preferredEncoder(env: Env): VideoEncoder {
  return env.VIDEO_ENCODER === "h264_qsv" && !qsvBroken ? "h264_qsv" : "libx264";
}

export interface EncodeResult {
  encoder: VideoEncoder;
  ms: number;
  fellBack: boolean;
  qsvError?: string;
}

export async function runEncode(env: Env, build: (encoder: VideoEncoder) => string[], signal?: AbortSignal): Promise<EncodeResult> {
  const first = preferredEncoder(env);
  const t0 = Date.now();
  try {
    await runProcess(env.FFMPEG_PATH, build(first), { lowPriority: env.LOW_PRIORITY, signal });
    return { encoder: first, ms: Date.now() - t0, fellBack: false };
  } catch (e) {
    if (first !== "h264_qsv" || signal?.aborted) throw e;
    qsvBroken = true;
    const t1 = Date.now();
    await runProcess(env.FFMPEG_PATH, build("libx264"), { lowPriority: env.LOW_PRIORITY, signal });
    return { encoder: "libx264", ms: Date.now() - t1, fellBack: true, qsvError: e instanceof Error ? e.message.split("\n").slice(-2).join(" ") : String(e) };
  }
}

/** For tests. */
export function resetEncoderState() {
  qsvBroken = false;
}
