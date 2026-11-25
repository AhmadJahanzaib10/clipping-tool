import path from "node:path";
import dotenv from "dotenv";
import { z } from "zod";
import { findRepoRoot, resolveFromRoot } from "./paths";

const blankToUndefined = (v: unknown) => (typeof v === "string" && v.trim() === "" ? undefined : v);
const boolEnv = (d: boolean) =>
  z.preprocess(
    blankToUndefined,
    z
      .enum(["true", "false", "1", "0"])
      .optional()
      .transform((v) => (v === undefined ? d : v === "true" || v === "1")),
  );
const int = (d: number) => z.preprocess(blankToUndefined, z.coerce.number().int().default(d));
const num = (d: number) => z.preprocess(blankToUndefined, z.coerce.number().default(d));
const optStr = z
  .string()
  .optional()
  .transform((v) => (v && v.trim() !== "" ? v.trim() : undefined));

/** SPEC §5. Empty strings in .env mean "not set". */
export const envSchema = z.object({
  PORT: int(3000),
  HOST: z.string().default("0.0.0.0"),
  STORAGE_DIR: z.string().default("./storage"),
  DATABASE_PATH: z.string().default("./data/app.db"),
  WORKER_TOKEN: z.string().min(1).default("change-me"),
  API_BASE_URL: z.string().url().default("http://localhost:3000"),

  DEEPGRAM_API_KEY: optStr,
  DEEPGRAM_MODEL: z.string().default("nova-3"),
  DEEPGRAM_DAILY_CAP_MIN: int(300),
  DEEPGRAM_DIARIZE: boolEnv(true),
  WHISPER_MODEL: z.string().default("small.en"),
  WHISPER_THREADS: int(4),
  TRANSCRIBE_ORDER: z.string().default("youtube,deepgram,whisper"),

  OPENROUTER_API_KEY: optStr,
  LLM_SCOUT_MODEL: optStr,
  LLM_EDITOR_MODEL: optStr,
  LLM_MAX_CANDIDATES: int(10),

  LOW_PRIORITY: boolEnv(true),
  FFMPEG_THREADS: int(4),
  MAX_HEAVY_TASKS: int(1),
  SECTION_DOWNLOAD: boolEnv(true),

  FFMPEG_PATH: z.string().default("ffmpeg"),
  FFPROBE_PATH: z.string().default("ffprobe"),
  VIDEO_ENCODER: z.enum(["h264_qsv", "libx264"]).default("h264_qsv"),
  OUTPUT_FPS: int(30),
  TARGET_LUFS: num(-14),
  PYTHON_PATH: z.string().default("python"),

  DRIVE_ROOT: optStr,

  KEEP_SOURCES_DAYS: int(3),
  KEEP_REJECTED_DAYS: int(2),
});
export type Env = z.infer<typeof envSchema>;

let cached: Env | undefined;

/** Load `<repo root>/.env` (existing process env wins), validate, and resolve relative paths against the repo root. */
export function loadEnv(): Env {
  if (cached) return cached;
  dotenv.config({ path: path.join(findRepoRoot(), ".env"), quiet: true });
  // Inline comments ("VAR=x   # note") are stripped by dotenv; empty values become "".
  const parsed = envSchema.parse(process.env);
  parsed.STORAGE_DIR = resolveFromRoot(parsed.STORAGE_DIR);
  parsed.DATABASE_PATH = resolveFromRoot(parsed.DATABASE_PATH);
  cached = parsed;
  return parsed;
}
