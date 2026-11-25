import fs from "node:fs/promises";
import { deepgramQuery, parseDeepgram, type Word } from "@clip/shared";

export const DEEPGRAM_URL = "https://api.deepgram.com/v1/listen";
const TIMEOUT_MS = 15 * 60 * 1000;

export interface DeepgramOptions {
  apiKey: string;
  model: string;
  diarize: boolean;
  signal?: AbortSignal;
  fetchImpl?: typeof fetch;
}

/** POST the Opus file to Deepgram pre-recorded STT (SPEC §7.3 step 2). */
export async function deepgramTranscribe(opusPath: string, o: DeepgramOptions): Promise<{ words: Word[]; durationSec?: number }> {
  const audio = await fs.readFile(opusPath);
  const signal = o.signal ? AbortSignal.any([o.signal, AbortSignal.timeout(TIMEOUT_MS)]) : AbortSignal.timeout(TIMEOUT_MS);
  const res = await (o.fetchImpl ?? fetch)(`${DEEPGRAM_URL}?${deepgramQuery({ model: o.model, diarize: o.diarize })}`, {
    method: "POST",
    headers: { authorization: `Token ${o.apiKey}`, "content-type": "audio/ogg" },
    body: audio,
    signal,
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`Deepgram HTTP ${res.status}: ${text.slice(0, 300)}`);
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error("Deepgram returned non-JSON");
  }
  return parseDeepgram(json);
}
