import fs from "node:fs";
import path from "node:path";
import { sourceFiles, transcriptSchema, type Candidate, type CampaignConfig, type Env, type Task, type Transcript } from "@clip/shared";
import { z } from "zod";
import { PermanentError, type StageContext } from "../context";
import type { OpenRouterOptions } from "../providers/openrouter";

/** Shared helpers for SCOUT and EDIT. */

export const jobOptionsSchema = z
  .object({
    clipCount: z.number().int().min(1).max(20).optional(),
    minLengthSec: z.number().positive().optional(),
    maxLengthSec: z.number().positive().optional(),
  })
  .default({});
export type JobOptions = z.infer<typeof jobOptionsSchema>;

export function jobOptions(task: Task): JobOptions {
  const r = jobOptionsSchema.safeParse((task.payload as { options?: unknown }).options);
  return r.success ? r.data : {};
}

/** Campaign lengths with per-job overrides applied (ideal clamped into the range). */
export function lengths(cfg: CampaignConfig, o: JobOptions) {
  const min = o.minLengthSec ?? cfg.minLengthSec;
  const max = Math.max(min + 5, o.maxLengthSec ?? cfg.maxLengthSec);
  const ideal = Math.min(max, Math.max(min, cfg.idealLengthSec));
  return { min, max, ideal };
}

export function readTranscript(env: Env, sourceId: string): Transcript {
  const file = sourceFiles(env.STORAGE_DIR, sourceId).transcript;
  if (!fs.existsSync(file)) throw new PermanentError("transcript.json is missing: run TRANSCRIBE first");
  return transcriptSchema.parse(JSON.parse(fs.readFileSync(file, "utf8")));
}

export const candidatesFile = (env: Env, sourceId: string) => path.join(sourceFiles(env.STORAGE_DIR, sourceId).dir, "candidates.json");

export const candidatesSchema = z.array(z.object({ id: z.string(), start: z.number(), end: z.number(), summary: z.string(), roughScore: z.number() }));

export function readCandidates(env: Env, sourceId: string): Candidate[] {
  const file = candidatesFile(env, sourceId);
  if (!fs.existsSync(file)) throw new PermanentError("candidates.json is missing: run SCOUT first");
  return candidatesSchema.parse(JSON.parse(fs.readFileSync(file, "utf8")));
}

export function llmConfig(env: Env): { or: OpenRouterOptions; scoutModel: string; editorModel: string } {
  if (!env.OPENROUTER_API_KEY) throw new Error("OPENROUTER_API_KEY is not set in .env");
  if (!env.LLM_SCOUT_MODEL || !env.LLM_EDITOR_MODEL) throw new Error("LLM_SCOUT_MODEL and LLM_EDITOR_MODEL must be set in .env");
  return { or: { apiKey: env.OPENROUTER_API_KEY }, scoutModel: env.LLM_SCOUT_MODEL, editorModel: env.LLM_EDITOR_MODEL };
}

/** Collects per-call LLM usage and posts it to the API (counted even when the stage later fails). */
export function usageReporter(ctx: StageContext) {
  const pending: Promise<unknown>[] = [];
  return {
    onUsage: (u: { calls: number; tokensIn: number; tokensOut: number }) => {
      pending.push(ctx.api.llmUsage(u).catch((e) => ctx.log("could not record LLM usage", e instanceof Error ? e.message : e)));
    },
    flush: () => Promise.all(pending),
  };
}

/** Run `fn` over items with at most `limit` in flight. */
export async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) {
        const i = next++;
        out[i] = await fn(items[i]!);
      }
    }),
  );
  return out;
}
