import fs from "node:fs";
import { makeTranscript, parseYoutubeJson3, sourceFiles, type Transcript } from "@clip/shared";
import { z } from "zod";
import { requireSourceId, type StageContext, type StageHandler } from "../context";
import { runProcess } from "../proc";
import { deepgramTranscribe } from "../providers/deepgram";
import { parseProbe, probeArgs } from "../render/audio";

/** Fewer caption words than this means the captions are unusable (e.g. only "[Music]"). */
const MIN_CAPTION_WORDS = 20;

const whisperResultSchema = z.object({
  words: z.array(z.object({ w: z.string(), s: z.number(), e: z.number(), conf: z.number().optional() })),
  durationSec: z.number(),
  model: z.string(),
});

class Skip extends Error {}

type Provider = "youtube" | "deepgram" | "whisper";
export const PROVIDERS: readonly Provider[] = ["youtube", "deepgram", "whisper"];

export function parseOrder(order: string): Provider[] {
  const list = order
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter((s): s is Provider => (PROVIDERS as readonly string[]).includes(s));
  return [...new Set(list)];
}

async function audioSeconds(ctx: StageContext, sourceId: string, opus: string): Promise<number> {
  const src = await ctx.api.getSource(sourceId);
  if (src.durationSec) return src.durationSec;
  const p = parseProbe(JSON.parse((await runProcess(ctx.env.FFPROBE_PATH, probeArgs(opus), { signal: ctx.signal })).stdout));
  if (!p.durationSec) throw new Error("could not determine audio duration");
  return p.durationSec;
}

async function runProvider(p: Provider, sourceId: string, ctx: StageContext): Promise<Transcript> {
  const { env, api, media, signal } = ctx;
  const files = sourceFiles(env.STORAGE_DIR, sourceId);

  if (p === "youtube") {
    if (!fs.existsSync(files.captions)) throw new Skip("no YouTube captions");
    const words = parseYoutubeJson3(JSON.parse(fs.readFileSync(files.captions, "utf8")));
    if (words.length < MIN_CAPTION_WORDS) throw new Skip(`captions have only ${words.length} words`);
    return makeTranscript("youtube", "rough", words);
  }

  if (p === "deepgram") {
    if (!env.DEEPGRAM_API_KEY) throw new Skip("DEEPGRAM_API_KEY not set");
    const seconds = Math.ceil(await audioSeconds(ctx, sourceId, files.opus));
    const r = await api.deepgram("reserve", seconds);
    if (!r.ok) throw new Skip(`daily cap reached (${(r.usedSec / 60).toFixed(0)} of ${(r.capSec / 60).toFixed(0)} min used, needs ${(seconds / 60).toFixed(1)})`);
    try {
      const { words } = await deepgramTranscribe(files.opus, { apiKey: env.DEEPGRAM_API_KEY, model: env.DEEPGRAM_MODEL, diarize: env.DEEPGRAM_DIARIZE, signal });
      if (words.length === 0) throw new Error("Deepgram returned no words");
      return makeTranscript("deepgram", "precise", words);
    } catch (e) {
      await api.deepgram("release", seconds).catch(() => undefined);
      throw e;
    }
  }

  const r = await media.call("transcribe", { audio: files.wav, model: env.WHISPER_MODEL, threads: env.WHISPER_THREADS, language: "en" }, whisperResultSchema, {
    signal,
  });
  if (r.words.length === 0) throw new Error("Whisper returned no words");
  return makeTranscript("whisper", "precise", r.words);
}

/** TRANSCRIBE (SPEC §7.3): provider chain from TRANSCRIBE_ORDER; each failure logs a warn event and falls through. */
export const transcribe: StageHandler = async (task, ctx) => {
  const sourceId = requireSourceId(task);
  const { api, env } = ctx;
  await api.patchSource(sourceId, { status: "transcribing", error: null });
  const order = parseOrder(env.TRANSCRIBE_ORDER);
  if (!order.length) throw new Error(`TRANSCRIBE_ORDER has no known providers: ${env.TRANSCRIBE_ORDER}`);

  for (const p of order) {
    const t0 = Date.now();
    try {
      const t = await runProvider(p, sourceId, ctx);
      fs.writeFileSync(sourceFiles(env.STORAGE_DIR, sourceId).transcript, JSON.stringify(t));
      const fillers = t.words.filter((w) => w.filler).length;
      await api.patchSource(sourceId, { transcriptProvider: t.provider, transcriptQuality: t.quality, status: "selecting" });
      await api.event({
        sourceId,
        level: "info",
        message: `Transcript from ${p} (${t.quality}) in ${((Date.now() - t0) / 1000).toFixed(1)} s: ${t.words.length} words, ${t.sentences.length} sentences, ${fillers} fillers`,
      });
      return [{ type: "SCOUT", sourceId, payload: task.payload }];
    } catch (e) {
      if (ctx.signal.aborted) throw e;
      const msg = e instanceof Error ? e.message : String(e);
      await api.event({ sourceId, level: e instanceof Skip ? "info" : "warn", message: `${p}: ${e instanceof Skip ? "skipped" : "failed"}: ${msg}` });
    }
  }
  throw new Error(`no transcription provider succeeded (${order.join(" → ")})`);
};
