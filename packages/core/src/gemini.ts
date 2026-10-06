import { ModelError, type ModelAdapter, type ModelRequest, type ModelResponse } from "./model.ts";

/**
 * Google Gemini over plain REST (`generateContent`), no SDK: one fetch call,
 * easy to read and to test with a fake fetch.
 *
 * Notes for Gemini 3.x models:
 *  - sampling knobs (temperature, top_p, top_k) are deprecated and are NOT sent;
 *  - effort is set with thinkingConfig.thinkingLevel (Flash-Lite defaults to "minimal");
 *  - structured output: responseMimeType "application/json" + responseJsonSchema.
 * The API key travels only in the x-goog-api-key header, never in a URL or log.
 */
export interface GeminiOptions {
  apiKey: string;
  /** e.g. "gemini-3.5-flash-lite" */
  model: string;
  baseUrl?: string;
  fetch?: typeof fetch;
  /** Retries for 429/5xx/network errors (each waits, honouring the server's retry hint). */
  maxRetries?: number;
  sleep?: (ms: number) => Promise<void>;
  timeoutMs?: number;
}

export const GEMINI_BASE_URL = "https://generativelanguage.googleapis.com/v1beta";

interface GeminiReply {
  candidates?: { content?: { parts?: { text?: string; thought?: boolean }[] }; finishReason?: string }[];
  usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number };
  promptFeedback?: { blockReason?: string };
  error?: { code?: number; message?: string; status?: string; details?: { "@type"?: string; retryDelay?: string }[] };
}

export class GeminiAdapter implements ModelAdapter {
  readonly name: string;

  constructor(private readonly opts: GeminiOptions) {
    if (!opts.apiKey) throw new ModelError("auth", "GEMINI_API_KEY is missing. Put it in the .env file at the project root.");
    this.name = `gemini:${opts.model}`;
  }

  /** The exact request body sent (exported for tests and for the curious). */
  body(req: ModelRequest): Record<string, unknown> {
    return {
      systemInstruction: { parts: [{ text: req.system }] },
      contents: [{ role: "user", parts: [{ text: req.prompt }] }],
      generationConfig: {
        ...(req.jsonSchema ? { responseMimeType: "application/json", responseJsonSchema: req.jsonSchema } : {}),
        ...(req.thinking ? { thinkingConfig: { thinkingLevel: req.thinking } } : {}),
      },
    };
  }

  async generate(req: ModelRequest): Promise<ModelResponse> {
    const f = this.opts.fetch ?? fetch;
    const sleep = this.opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
    const url = `${this.opts.baseUrl ?? GEMINI_BASE_URL}/models/${encodeURIComponent(this.opts.model)}:generateContent`;
    const maxRetries = this.opts.maxRetries ?? 3;

    for (let attempt = 0; ; attempt++) {
      let err: ModelError;
      try {
        const res = await f(url, {
          method: "POST",
          headers: { "content-type": "application/json", "x-goog-api-key": this.opts.apiKey },
          body: JSON.stringify(this.body(req)),
          signal: AbortSignal.timeout(this.opts.timeoutMs ?? 60_000),
        });
        const json = (await res.json().catch(() => ({}))) as GeminiReply;
        if (res.ok) return parseReply(json);
        err = classify(res.status, json);
      } catch (e) {
        err = e instanceof ModelError ? e : new ModelError("network", `Could not reach Gemini: ${(e as Error).message}`);
      }
      const retryable = err.kind === "rate_limited" || err.kind === "server" || err.kind === "network";
      if (!retryable || attempt >= maxRetries) throw err;
      await sleep(err.retryAfterMs ?? 2_000 * 2 ** attempt);
    }
  }
}

function parseReply(json: GeminiReply): ModelResponse {
  if (json.promptFeedback?.blockReason) throw new ModelError("blocked", `Gemini blocked the prompt (${json.promptFeedback.blockReason})`);
  const cand = json.candidates?.[0];
  const text = (cand?.content?.parts ?? [])
    .filter((p) => !p.thought && typeof p.text === "string")
    .map((p) => p.text)
    .join("");
  if (!text) throw new ModelError("blocked", `Gemini returned no text (finishReason: ${cand?.finishReason ?? "unknown"})`);
  return {
    text,
    usage: { inputTokens: json.usageMetadata?.promptTokenCount, outputTokens: json.usageMetadata?.candidatesTokenCount },
  };
}

function classify(status: number, json: GeminiReply): ModelError {
  const msg = json.error?.message ?? `HTTP ${status}`;
  const delay = json.error?.details?.find((d) => d.retryDelay)?.retryDelay;
  const retryAfterMs = delay ? Math.ceil(parseFloat(delay) * 1000) : undefined;
  if (status === 429) {
    // Google uses 429 both for "slow down" and "daily quota exhausted".
    const daily = /per day|PerDay|daily/i.test(msg);
    return new ModelError(daily ? "quota" : "rate_limited", `Gemini: ${msg}`, retryAfterMs);
  }
  if (status === 401 || status === 403) return new ModelError("auth", `Gemini rejected the API key (${status}). Check GEMINI_API_KEY in .env.`);
  if (status >= 500) return new ModelError("server", `Gemini server error ${status}: ${msg}`, retryAfterMs);
  return new ModelError("bad_request", `Gemini: ${msg}`);
}
