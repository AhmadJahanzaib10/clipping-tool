import { extractJson } from "@clip/shared";
import { z } from "zod";

/** OpenRouter chat completions (params checked against openrouter.ai docs, Nov 2026). */
export const OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions";
const TIMEOUT_MS = 5 * 60 * 1000;

export type ChatMessage = { role: "system" | "user" | "assistant"; content: string };

export interface ChatResult {
  content: string;
  tokensIn: number;
  tokensOut: number;
  finishReason: string | null;
}

const responseSchema = z.object({
  error: z.object({ code: z.union([z.number(), z.string()]).optional(), message: z.string() }).optional(),
  choices: z
    .array(
      z.object({
        message: z.object({ content: z.string().nullable().optional() }).optional(),
        finish_reason: z.string().nullable().optional(),
        error: z.object({ message: z.string() }).optional(),
      }),
    )
    .optional(),
  usage: z.object({ prompt_tokens: z.number().optional(), completion_tokens: z.number().optional() }).optional(),
});

export class LlmError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    readonly retryable = true,
    readonly retryAfterSec?: number,
  ) {
    super(message);
    this.name = "LlmError";
  }
}

export interface OpenRouterOptions {
  apiKey: string;
  fetchImpl?: typeof fetch;
}

export type ReasoningEffort = "none" | "minimal" | "low" | "medium" | "high";
type ChatRequest = {
  model: string;
  messages: ChatMessage[];
  temperature?: number;
  maxTokens?: number;
  json?: boolean;
  /** OpenRouter reasoning.effort. For Claude the thinking budget is a share of maxTokens. */
  reasoning?: ReasoningEffort;
  signal?: AbortSignal;
};

/** Backoff for 429 / 5xx (free models: 20 req/min). Honors Retry-After, capped at 60 s. */
export const RETRY_WAITS_MS = [5_000, 20_000];

export async function chat(o: OpenRouterOptions & { waitsMs?: number[] }, req: ChatRequest): Promise<ChatResult> {
  const waits = o.waitsMs ?? RETRY_WAITS_MS;
  for (let attempt = 0; ; attempt++) {
    try {
      return await chatOnce(o, req);
    } catch (e) {
      const status = e instanceof LlmError ? e.status : undefined;
      const transient = status === 429 || (status !== undefined && status >= 500);
      if (!transient || attempt >= waits.length || req.signal?.aborted) throw e;
      const hinted = e instanceof LlmError && e.retryAfterSec ? e.retryAfterSec * 1000 : 0;
      await new Promise((r) => setTimeout(r, Math.min(60_000, Math.max(hinted, waits[attempt]!))));
    }
  }
}

async function chatOnce(o: OpenRouterOptions, req: ChatRequest): Promise<ChatResult> {
  const signal = req.signal ? AbortSignal.any([req.signal, AbortSignal.timeout(TIMEOUT_MS)]) : AbortSignal.timeout(TIMEOUT_MS);
  const res = await (o.fetchImpl ?? fetch)(OPENROUTER_URL, {
    method: "POST",
    headers: { authorization: `Bearer ${o.apiKey}`, "content-type": "application/json", "x-title": "Clip Engine" },
    body: JSON.stringify({
      model: req.model,
      messages: req.messages,
      temperature: req.temperature ?? 0.4,
      max_tokens: req.maxTokens ?? 8000,
      ...(req.json ? { response_format: { type: "json_object" } } : {}),
      ...(req.reasoning ? { reasoning: { effort: req.reasoning } } : {}),
    }),
    signal,
  });
  const text = await res.text();
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new LlmError(`OpenRouter HTTP ${res.status}: non-JSON response ${text.slice(0, 200)}`, res.status);
  }
  const body = responseSchema.safeParse(raw);
  if (!res.ok || !body.success || body.data.error) {
    const msg = body.success ? (body.data.error?.message ?? text.slice(0, 300)) : text.slice(0, 300);
    // 400/401/402/403 won't fix themselves on retry.
    const retryAfter = Number(res.headers.get("retry-after")) || undefined;
    throw new LlmError(`OpenRouter HTTP ${res.status}: ${msg}`, res.status, ![400, 401, 402, 403].includes(res.status), retryAfter);
  }
  const choice = body.data.choices?.[0];
  // Errors can arrive inside a 200 response.
  if (choice?.error) throw new LlmError(`OpenRouter generation error: ${choice.error.message}`);
  const content = choice?.message?.content ?? "";
  if (!content.trim()) throw new LlmError(`OpenRouter returned an empty reply (finish_reason ${choice?.finish_reason ?? "?"})`);
  return {
    content,
    tokensIn: body.data.usage?.prompt_tokens ?? 0,
    tokensOut: body.data.usage?.completion_tokens ?? 0,
    finishReason: choice?.finish_reason ?? null,
  };
}

export interface JsonCallResult<T> {
  data: T;
  calls: number;
  tokensIn: number;
  tokensOut: number;
}

/**
 * Ask for JSON and validate it with zod (SPEC §8.4). On invalid output, retry once with the
 * validation error appended. Throws if the second reply is invalid too.
 */
export async function chatJson<T>(
  o: OpenRouterOptions,
  req: { model: string; system: string; user: string; schema: z.ZodType<T>; maxTokens?: number; reasoning?: ReasoningEffort; signal?: AbortSignal },
  onUsage?: (u: { calls: number; tokensIn: number; tokensOut: number }) => void,
): Promise<JsonCallResult<T>> {
  const messages: ChatMessage[] = [
    { role: "system", content: req.system },
    { role: "user", content: req.user },
  ];
  let total = { calls: 0, tokensIn: 0, tokensOut: 0 };
  let lastError = "";
  for (let attempt = 1; attempt <= 2; attempt++) {
    const r = await chat(o, { model: req.model, messages, json: true, maxTokens: req.maxTokens, reasoning: req.reasoning, signal: req.signal });
    const u = { calls: 1, tokensIn: r.tokensIn, tokensOut: r.tokensOut };
    total = { calls: total.calls + 1, tokensIn: total.tokensIn + u.tokensIn, tokensOut: total.tokensOut + u.tokensOut };
    onUsage?.(u);
    try {
      const data = req.schema.parse(extractJson(r.content));
      return { data, ...total };
    } catch (e) {
      lastError = e instanceof z.ZodError ? z.prettifyError(e) : e instanceof Error ? e.message : String(e);
      if (r.finishReason === "length") lastError += " (the reply was cut off: keep it shorter)";
      messages.push(
        { role: "assistant", content: r.content.slice(0, 20_000) },
        { role: "user", content: `Your reply was not valid: ${lastError.slice(0, 2000)}\nReturn ONLY the corrected JSON object.` },
      );
    }
  }
  throw new LlmError(`model output invalid after retry: ${lastError.slice(0, 500)}`, undefined, false);
}
