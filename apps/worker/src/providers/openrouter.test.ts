import { describe, expect, it } from "vitest";
import { z } from "zod";
import { chat, chatJson, LlmError } from "./openrouter";

type Call = { url: string; body: Record<string, unknown>; headers: Record<string, string> };

function fakeFetch(replies: { status?: number; body: unknown }[]) {
  const calls: Call[] = [];
  const impl = (async (url: string, init: RequestInit) => {
    calls.push({ url, body: JSON.parse(init.body as string), headers: init.headers as Record<string, string> });
    const r = replies[Math.min(calls.length - 1, replies.length - 1)]!;
    return new Response(JSON.stringify(r.body), { status: r.status ?? 200 });
  }) as unknown as typeof fetch;
  return { impl, calls };
}
const reply = (content: string, usage = { prompt_tokens: 100, completion_tokens: 20 }, finish = "stop") => ({
  body: { choices: [{ message: { content }, finish_reason: finish }], usage },
});

const schema = z.object({ moments: z.array(z.object({ start: z.number() })) });

describe("chat", () => {
  it("sends model, messages, json mode and Bearer auth", async () => {
    const f = fakeFetch([reply('{"moments":[]}')]);
    const r = await chat({ apiKey: "K", fetchImpl: f.impl }, { model: "m/x", messages: [{ role: "user", content: "hi" }], json: true });
    expect(r).toMatchObject({ content: '{"moments":[]}', tokensIn: 100, tokensOut: 20 });
    expect(f.calls[0]!.url).toBe("https://openrouter.ai/api/v1/chat/completions");
    expect(f.calls[0]!.headers.authorization).toBe("Bearer K");
    expect(f.calls[0]!.body).toMatchObject({ model: "m/x", response_format: { type: "json_object" } });
    expect(f.calls[0]!.body).not.toHaveProperty("reasoning");
    const g = fakeFetch([reply("{}")]);
    await chat({ apiKey: "K", fetchImpl: g.impl }, { model: "m", messages: [], reasoning: "low" });
    expect(g.calls[0]!.body.reasoning).toEqual({ effort: "low" });
  });

  it("surfaces HTTP errors (non-retryable for 401/402) and errors inside a 200", async () => {
    const e401 = fakeFetch([{ status: 401, body: { error: { code: 401, message: "No auth" } } }]);
    await expect(chat({ apiKey: "K", fetchImpl: e401.impl }, { model: "m", messages: [] })).rejects.toMatchObject({ retryable: false, status: 401 });
    const e200 = fakeFetch([{ body: { choices: [{ message: { content: "" }, error: { message: "provider died" } }] } }]);
    await expect(chat({ apiKey: "K", fetchImpl: e200.impl }, { model: "m", messages: [] })).rejects.toThrow(/provider died/);
    const e429 = fakeFetch([{ status: 429, body: { error: { code: 429, message: "slow down" } } }]);
    await expect(chat({ apiKey: "K", fetchImpl: e429.impl, waitsMs: [0, 0] }, { model: "m", messages: [] })).rejects.toMatchObject({ retryable: true });
    expect(e429.calls).toHaveLength(3); // 1 try + 2 backoff retries
  });

  it("retries 429 / 5xx with backoff, then succeeds; does not retry 400", async () => {
    const f = fakeFetch([{ status: 429, body: { error: { code: 429, message: "Rate limit exceeded" } } }, { status: 502, body: { error: { code: 502, message: "down" } } }, reply("ok")]);
    const r = await chat({ apiKey: "K", fetchImpl: f.impl, waitsMs: [0, 0] }, { model: "m", messages: [] });
    expect(r.content).toBe("ok");
    expect(f.calls).toHaveLength(3);
    const bad = fakeFetch([{ status: 400, body: { error: { code: 400, message: "bad" } } }]);
    await expect(chat({ apiKey: "K", fetchImpl: bad.impl, waitsMs: [0, 0] }, { model: "m", messages: [] })).rejects.toThrow(/400/);
    expect(bad.calls).toHaveLength(1);
  });
});

describe("chatJson", () => {
  it("returns validated data and reports usage", async () => {
    const f = fakeFetch([reply('```json\n{"moments":[{"start":1}]}\n```')]);
    const usage: number[] = [];
    const r = await chatJson({ apiKey: "K", fetchImpl: f.impl }, { model: "m", system: "s", user: "u", schema }, (u) => usage.push(u.tokensIn));
    expect(r.data.moments[0]!.start).toBe(1);
    expect(r.calls).toBe(1);
    expect(usage).toEqual([100]);
  });

  it("retries once with the validation error appended", async () => {
    const f = fakeFetch([reply('{"moments":[{"start":"soon"}]}'), reply('{"moments":[{"start":5}]}')]);
    const r = await chatJson({ apiKey: "K", fetchImpl: f.impl }, { model: "m", system: "s", user: "u", schema });
    expect(r.data.moments[0]!.start).toBe(5);
    expect(r.calls).toBe(2);
    expect(r.tokensIn).toBe(200);
    const retryMsgs = f.calls[1]!.body.messages as { role: string; content: string }[];
    expect(retryMsgs).toHaveLength(4);
    expect(retryMsgs[2]!.role).toBe("assistant");
    expect(retryMsgs[3]!.content).toMatch(/not valid/);
  });

  it("gives up after the retry with a non-retryable error", async () => {
    const f = fakeFetch([reply("not json at all")]);
    const err = await chatJson({ apiKey: "K", fetchImpl: f.impl }, { model: "m", system: "s", user: "u", schema }).catch((e) => e);
    expect(err).toBeInstanceOf(LlmError);
    expect(err.retryable).toBe(false);
    expect(f.calls).toHaveLength(2);
  });
});
