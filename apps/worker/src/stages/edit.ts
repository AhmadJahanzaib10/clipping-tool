import {
  checkSelection,
  EDIT_SYSTEM,
  editResponseSchema,
  editUser,
  finalizeClips,
  formatLine,
  type Candidate,
  type EditClip,
  type Transcript,
} from "@clip/shared";
import fs from "node:fs";
import path from "node:path";
import { sourceFiles } from "@clip/shared";
import { requireSourceId, type StageHandler } from "../context";
import { chatJson } from "../providers/openrouter";
import { jobOptions, lengths, llmConfig, readCandidates, readTranscript, usageReporter } from "./selection";

const CONTEXT_SEC = 20;

/** "id c3 | 612.4–655.0 s (43 s) | summary" + timestamped clip lines and ±20 s context. */
export function candidateBlock(t: Transcript, c: Candidate): string {
  const lines = (from: number, to: number) =>
    t.sentences
      .filter((s) => s.s >= from && s.s < to)
      .map(formatLine)
      .join("\n");
  const before = lines(c.start - CONTEXT_SEC, c.start - 0.01);
  const after = lines(c.end + 0.01, c.end + CONTEXT_SEC);
  return [
    `### id ${c.id} | ${c.start.toFixed(1)}–${c.end.toFixed(1)} s (${Math.round(c.end - c.start)} s) | scout: ${c.summary}`,
    before ? `context before:\n${before}` : "",
    `clip text:\n${lines(c.start - 0.5, c.end)}`,
    after ? `context after:\n${after}` : "",
  ]
    .filter(Boolean)
    .join("\n");
}

/**
 * EDIT (SPEC §7.4, §8.2): strong model picks the final 8–10 with scores, two hooks, captions, etc.
 * Then code snaps, trims, enforces length, filters banned words, scores and creates clip rows.
 * If the model output is invalid after one retry, falls back to SCOUT results with template hooks.
 */
export const edit: StageHandler = async (task, ctx) => {
  const sourceId = requireSourceId(task);
  const { api, env, signal } = ctx;
  const llm = llmConfig(env);
  const t = readTranscript(env, sourceId);
  const candidates = readCandidates(env, sourceId);
  const { campaign, scoreWeights, fewShot } = await api.context(sourceId);
  const opts = jobOptions(task);
  const len = lengths(campaign.config, opts);
  const n = Math.min(opts.clipCount ?? env.LLM_MAX_CANDIDATES, candidates.length);
  const cfg = campaign.config;

  const usage = usageReporter(ctx);
  const t0 = Date.now();
  let edits: EditClip[] = [];
  let fellBack = false;
  try {
    const r = await chatJson(
      llm.or,
      {
        model: llm.editorModel,
        system: EDIT_SYSTEM,
        user: editUser({
          niche: campaign.niche,
          briefNotes: cfg.briefNotes,
          bannedWords: cfg.bannedWords,
          idealLengthSec: len.ideal,
          min: len.min,
          max: len.max,
          fewShot: fewShot.map((f) => `"${f.hook}" → ${f.views.toLocaleString("en-US")} views (${Math.round(f.lengthSec)} s, opens: "${f.firstLine}")`).join("\n"),
          candidates: candidates.map((c) => candidateBlock(t, c)).join("\n\n"),
          n,
        }),
        schema: editResponseSchema,
        maxTokens: 20000, // includes the thinking budget (medium ≈ half)
        reasoning: env.LLM_EDITOR_REASONING,
        signal,
      },
      usage.onUsage,
    );
    edits = r.data;
    // Keep the raw picks: snapping/length rules can be re-applied later without another LLM call.
    fs.writeFileSync(path.join(sourceFiles(env.STORAGE_DIR, sourceId).dir, "edit.json"), JSON.stringify({ model: llm.editorModel, clips: edits }, null, 2));
  } catch (e) {
    if (signal.aborted) throw e;
    fellBack = true;
    await api.event({ sourceId, level: "warn", message: `EDIT failed, using SCOUT results with template hooks: ${e instanceof Error ? e.message : e}` });
  } finally {
    await usage.flush();
  }

  const clips = finalizeClips(edits, {
    transcript: t,
    candidates,
    config: { minLengthSec: len.min, maxLengthSec: len.max, bannedWords: cfg.bannedWords },
    weights: scoreWeights,
    n,
    minClips: fellBack ? n : Math.min(8, n),
  });
  if (!clips.length) throw new Error("no clip survived snapping and length rules");
  await api.createClips(sourceId, clips);

  const checks = checkSelection(clips, t, { minLengthSec: len.min, maxLengthSec: len.max, bannedWords: cfg.bannedWords }, { min: Math.min(8, n), max: n });
  const failedChecks = checks.filter((c) => !c.pass);
  const fromScout = clips.filter((c) => c.source === "scout-fallback").length;
  await api.event({
    sourceId,
    level: failedChecks.length ? "warn" : "info",
    message: `EDIT (${llm.editorModel}) in ${((Date.now() - t0) / 1000).toFixed(0)} s: ${edits.length} picked → ${clips.length} clips${fromScout ? ` (${fromScout} from SCOUT)` : ""}. Checks: ${failedChecks.length ? failedChecks.map((c) => `${c.name}: ${c.detail}`).join(" | ") : "all pass"}`,
    data: { checks },
  });
  await api.patchSource(sourceId, { status: "fetching" });
  return [{ type: "FETCH_SECTIONS", sourceId, payload: task.payload }];
};
