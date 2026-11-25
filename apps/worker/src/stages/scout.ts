import fs from "node:fs";
import { buildWindows, mergeCandidates, SCOUT_SYSTEM, scoutResponseSchema, scoutUser, type Candidate, type ScoutMoment } from "@clip/shared";
import { requireSourceId, type StageHandler } from "../context";
import { chatJson } from "../providers/openrouter";
import { candidatesFile, jobOptions, lengths, llmConfig, mapLimit, readTranscript, usageReporter } from "./selection";

const PARALLEL_WINDOWS = 3;
const KEEP_CANDIDATES = 15;

/**
 * SCOUT (SPEC §7.4, §8.1): cheap model over ~8-min windows (1-min overlap), up to 4 moments each,
 * 3 windows in parallel. Merge, drop > 50% overlaps, keep the top ~15 → candidates.json.
 */
export const scout: StageHandler = async (task, ctx) => {
  const sourceId = requireSourceId(task);
  const { api, env, signal } = ctx;
  const llm = llmConfig(env);
  await api.patchSource(sourceId, { status: "selecting", error: null });

  const t = readTranscript(env, sourceId);
  const { campaign } = await api.context(sourceId);
  const len = lengths(campaign.config, jobOptions(task));
  const total = t.words.at(-1)?.e ?? 0;
  const windows = buildWindows(t);
  if (!windows.length) throw new Error("transcript has no sentences");

  const usage = usageReporter(ctx);
  const t0 = Date.now();
  let failed = 0;
  const perWindow = await mapLimit(windows, PARALLEL_WINDOWS, async (w) => {
    try {
      const r = await chatJson(
        llm.or,
        {
          model: llm.scoutModel,
          system: SCOUT_SYSTEM,
          user: scoutUser({ niche: campaign.niche, idealLengthSec: len.ideal, min: len.min, max: len.max, lines: w.lines }),
          schema: scoutResponseSchema,
          maxTokens: 4000, // includes the thinking budget
          reasoning: env.LLM_SCOUT_REASONING,
          signal,
        },
        usage.onUsage,
      );
      // Keep moments inside the transcript and roughly the right size (snapping fixes the rest).
      return r.data.filter((m: ScoutMoment) => m.end > m.start && m.start < total && m.end - m.start >= len.min * 0.5 && m.end - m.start <= len.max * 2.5);
    } catch (e) {
      if (signal.aborted) throw e;
      failed++;
      await api.event({ sourceId, level: "warn", message: `SCOUT window ${w.index + 1} (${Math.round(w.start / 60)}–${Math.round(w.end / 60)} min) skipped: ${e instanceof Error ? e.message : e}` });
      return [];
    }
  });
  await usage.flush();

  const raw = perWindow.flat().map((m) => ({ ...m, end: Math.min(m.end, total) }));
  const merged = mergeCandidates(raw, KEEP_CANDIDATES);
  if (!merged.length) throw new Error(`SCOUT found no candidates (${failed}/${windows.length} windows failed)`);
  const candidates: Candidate[] = merged.map((m, i) => ({ id: `c${i + 1}`, start: m.start, end: m.end, summary: m.summary, roughScore: m.roughScore }));
  fs.writeFileSync(candidatesFile(env, sourceId), JSON.stringify(candidates, null, 2));

  await api.event({
    sourceId,
    level: failed ? "warn" : "info",
    message: `SCOUT (${llm.scoutModel}) in ${((Date.now() - t0) / 1000).toFixed(0)} s: ${windows.length} windows${failed ? ` (${failed} failed)` : ""}, ${raw.length} raw moments → ${candidates.length} candidates`,
  });
  return [{ type: "EDIT", sourceId, payload: task.payload }];
};
