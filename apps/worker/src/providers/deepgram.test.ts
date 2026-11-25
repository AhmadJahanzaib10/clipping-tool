import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { parseOrder } from "../stages/transcribe";
import { deepgramTranscribe } from "./deepgram";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "dg-"));
const opus = path.join(tmp, "audio.opus");
fs.writeFileSync(opus, Buffer.from("OggS fake"));

describe("deepgramTranscribe", () => {
  it("POSTs the Opus bytes with Token auth and SPEC query, parses words", async () => {
    let seen: { url: string; init: RequestInit } | undefined;
    const fetchImpl = (async (url: string, init: RequestInit) => {
      seen = { url, init };
      return new Response(
        JSON.stringify({
          metadata: { duration: 3 },
          results: { channels: [{ alternatives: [{ words: [{ word: "hi", punctuated_word: "Hi.", start: 0, end: 0.4, speaker: 0 }] }] }] },
        }),
      );
    }) as unknown as typeof fetch;

    const r = await deepgramTranscribe(opus, { apiKey: "KEY", model: "nova-3", diarize: true, fetchImpl });
    expect(r.words).toEqual([{ w: "Hi.", s: 0, e: 0.4, speaker: 0 }]);
    const u = new URL(seen!.url);
    expect(u.origin + u.pathname).toBe("https://api.deepgram.com/v1/listen");
    expect(u.searchParams.get("model")).toBe("nova-3");
    expect(u.searchParams.get("filler_words")).toBe("true");
    const h = seen!.init.headers as Record<string, string>;
    expect(h.authorization).toBe("Token KEY");
    expect(h["content-type"]).toBe("audio/ogg");
    expect(Buffer.from(seen!.init.body as Uint8Array).toString()).toBe("OggS fake");
  });

  it("throws with the HTTP status on errors", async () => {
    const fetchImpl = (async () => new Response('{"err_msg":"Invalid credentials"}', { status: 401 })) as unknown as typeof fetch;
    await expect(deepgramTranscribe(opus, { apiKey: "bad", model: "nova-3", diarize: false, fetchImpl })).rejects.toThrow(/HTTP 401/);
  });
});

describe("parseOrder", () => {
  it("keeps known providers in order, deduped", () => {
    expect(parseOrder("youtube,deepgram,whisper")).toEqual(["youtube", "deepgram", "whisper"]);
    expect(parseOrder(" Whisper , youtube,foo,whisper")).toEqual(["whisper", "youtube"]);
    expect(parseOrder("")).toEqual([]);
  });
});
