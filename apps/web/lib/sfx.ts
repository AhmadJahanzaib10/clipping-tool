import { loadEnv, scanSfx } from "@clip/shared";
import { getDb } from "./db";

/** Run a library scan with the configured FFmpeg (shared by the API, the startup hook and the button). */
export function runSfxScan(force = false) {
  const env = loadEnv();
  return scanSfx(getDb(), { ffmpegPath: env.FFMPEG_PATH, ffprobePath: env.FFPROBE_PATH, force });
}
