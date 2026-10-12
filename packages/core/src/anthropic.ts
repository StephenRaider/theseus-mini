import Anthropic from "@anthropic-ai/sdk";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { ModelError, type ModelAdapter, type ModelRequest, type ModelResponse, type ThinkingLevel } from "./model.ts";

/**
 * Claude behind the same one-method ModelAdapter the kernel already uses.
 *
 * Built for a small, fixed budget (the credits are a one-time $20):
 *  - TWO TIERS. Judgement calls (route, plan, operate steps, verify) go to the main
 *    model (Sonnet 5.5); cheap mechanical ones (triage, summaries) to the small one
 *    (Haiku 5.5). Both are overridable.
 *  - LOW EFFORT. The kernel's `thinking` level maps to `output_config.effort`
 *    (default low): Claude 5.x thinks adaptively and bills it as output.
 *  - CACHING. The kernel orders prompts stable-first and tells us where the stable part
 *    ends (`cacheSplit`); we put a cache breakpoint there, so a 15-step job reads its
 *    tools and rules from cache after the first step (cache reads cost 0.1x).
 *  - A SPEND METER with a HARD CAP, remembered across runs in a file: once the cap
 *    is reached, calls stop with a clear message instead of quietly spending the rest.
 *  - JSON in the prompt, not strict structured outputs: our schemas include free-form
 *    maps (tool arguments), which strict mode rejects. The kernel already validates and
 *    asks once for a repair, so the schema is simply appended to the system prompt.
 *  - REFUSAL FALLBACK (server-side, Sonnet only): a safety-classifier decline is retried
 *    by the API itself on a fallback model. If the API ever rejects the parameter we
 *    drop it once and carry on (never a failed run because of an optional extra).
 */

export interface ModelPrice {
  /** USD per million tokens. */
  input: number;
  output: number;
}

/** First-party API prices. Unknown models are billed at the highest rate we know (never under-count). */
export const PRICES: Record<string, ModelPrice> = {
  "claude-sonnet-5-5": { input: 2, output: 10 },
  "claude-sonnet-5": { input: 2, output: 10 },
  "claude-haiku-5-5": { input: 0.1, output: 0.5 },
  "claude-opus-5-5": { input: 4, output: 20 },
  "claude-opus-5": { input: 5, output: 25 },
  "claude-fable-5-1": { input: 10, output: 50 },
};
const UNKNOWN_PRICE: ModelPrice = { input: 10, output: 50 };

export interface Usage {
  input_tokens: number;
  output_tokens: number;
  cache_creation_input_tokens?: number | null;
  cache_read_input_tokens?: number | null;
}

/** Dollar cost of one call: cache writes cost 1.25x input, cache reads 0.1x. */
export function costOf(model: string, u: Usage): number {
  const p = PRICES[model] ?? UNKNOWN_PRICE;
  const write = u.cache_creation_input_tokens ?? 0;
  const read = u.cache_read_input_tokens ?? 0;
  return (u.input_tokens * p.input + write * p.input * 1.25 + read * p.input * 0.1 + u.output_tokens * p.output) / 1e6;
}

/* ------------------------------------------------------------------ the spend meter */

export interface SpendFile {
  usd: number;
  calls: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  byModel: Record<string, { usd: number; calls: number }>;
}

/** Running total of what the Claude API has cost, kept in a small JSON file so the cap spans runs. */
export class SpendMeter {
  private state: SpendFile = { usd: 0, calls: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, byModel: {} };

  constructor(
    readonly capUsd: number,
    private readonly file?: string,
  ) {
    if (file && existsSync(file)) {
      try {
        this.state = { ...this.state, ...(JSON.parse(readFileSync(file, "utf8")) as Partial<SpendFile>) };
      } catch {
        /* a corrupt file just restarts the count */
      }
    }
  }

  get spent() {
    return this.state.usd;
  }
  get remaining() {
    return Math.max(0, this.capUsd - this.state.usd);
  }
  get totals(): Readonly<SpendFile> {
    return this.state;
  }

  /** Throws a `quota` error once the cap is reached. */
  check() {
    if (this.state.usd >= this.capUsd)
      throw new ModelError(
        "quota",
        `Claude budget reached: $${this.state.usd.toFixed(2)} spent of the $${this.capUsd.toFixed(2)} cap (ANTHROPIC_BUDGET_USD). Raise the cap in .env or delete .theseus/anthropic-spend.json to start over.`,
      );
  }

  add(model: string, u: Usage): number {
    const usd = costOf(model, u);
    const s = this.state;
    s.usd += usd;
    s.calls += 1;
    s.inputTokens += u.input_tokens + (u.cache_creation_input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0);
    s.outputTokens += u.output_tokens;
    s.cacheReadTokens += u.cache_read_input_tokens ?? 0;
    const m = (s.byModel[model] ??= { usd: 0, calls: 0 });
    m.usd += usd;
    m.calls += 1;
    if (this.file) {
      try {
        mkdirSync(dirname(this.file), { recursive: true });
        writeFileSync(this.file, JSON.stringify(s, null, 1));
      } catch {
        /* the meter must never break a run */
      }
    }
    return usd;
  }
}

/* ------------------------------------------------------------------ the adapter */

/** Purposes cheap enough for the small model: short, mechanical, no tool judgement. */
const SMALL_PURPOSES = new Set(["triage", "summary"]);

const EFFORT: Record<ThinkingLevel, "low" | "medium" | "high"> = { minimal: "low", low: "low", medium: "medium", high: "high" };

/** Output ceilings per purpose. Thinking counts against max_tokens, so these leave headroom (cost is only what is used). */
const MAX_TOKENS: Record<string, number> = { triage: 3000, summary: 3000, route: 6000, "operate.step": 6000, "operate.verify": 5000, "operate.plan": 6000, compose: 10000, draft: 10000 };

/** The slice of the SDK we use, so tests can pass a fake. */
export interface AnthropicLike {
  beta: { messages: { create(body: Record<string, unknown>): Promise<AnthropicReply> } };
}
export interface AnthropicReply {
  content: { type: string; text?: string }[];
  stop_reason: string | null;
  usage: Usage;
  stop_details?: { category?: string | null; explanation?: string | null } | null;
}

export interface AnthropicOptions {
  apiKey?: string;
  /** Main model (default claude-sonnet-5-5). */
  model?: string;
  /** Small model for triage and summaries (default claude-haiku-5-5). */
  smallModel?: string;
  meter: SpendMeter;
  /** Server-side refusal fallback on the main model (default on). */
  fallback?: boolean;
  client?: AnthropicLike;
}

export class AnthropicAdapter implements ModelAdapter {
  readonly name: string;
  private readonly client: AnthropicLike;
  private readonly model: string;
  private readonly small: string;
  private fallback: boolean;
  /** Cost of the last call (read by the kernel for the activity trace). */
  lastCostUsd = 0;

  constructor(private readonly opts: AnthropicOptions) {
    const key = opts.apiKey ?? process.env.ANTHROPIC_API_KEY;
    if (!opts.client && !key?.trim()) throw new ModelError("auth", "ANTHROPIC_API_KEY is missing. Put it in the .env file at the project root.");
    this.client = opts.client ?? (new Anthropic({ apiKey: key!, maxRetries: 3, timeout: 120_000 }) as unknown as AnthropicLike);
    this.model = opts.model ?? "claude-sonnet-5-5";
    this.small = opts.smallModel ?? "claude-haiku-5-5";
    this.fallback = opts.fallback ?? true;
    this.name = `anthropic:${this.model}`;
  }

  get meter() {
    return this.opts.meter;
  }

  /** Which model serves a request. */
  modelFor(req: ModelRequest): string {
    return SMALL_PURPOSES.has(req.purpose) ? this.small : this.model;
  }

  /** The exact request body (exported for tests). */
  body(req: ModelRequest): Record<string, unknown> {
    const model = this.modelFor(req);
    const split = req.cacheSplit && req.cacheSplit > 0 && req.cacheSplit < req.prompt.length ? req.cacheSplit : 0;
    const system = req.jsonSchema
      ? `${req.system}\n\nReply with ONE JSON object only (no prose, no code fences) that matches this JSON Schema:\n${JSON.stringify(req.jsonSchema)}`
      : req.system;
    const content = split
      ? [
          { type: "text", text: req.prompt.slice(0, split), cache_control: { type: "ephemeral" } },
          { type: "text", text: req.prompt.slice(split) },
        ]
      : [{ type: "text", text: req.prompt }];
    return {
      model,
      max_tokens: MAX_TOKENS[req.purpose] ?? 6000,
      // The system prompt is stable per employee, so it is cached along with the prefix when there is one.
      system: [{ type: "text", text: system }],
      messages: [{ role: "user", content }],
      output_config: { effort: EFFORT[req.thinking ?? "low"] },
      ...(this.fallback && model === this.model && model.startsWith("claude-sonnet") ? { betas: ["server-side-fallback-2026-07-01"], fallbacks: "default" } : {}),
    };
  }

  async generate(req: ModelRequest): Promise<ModelResponse> {
    this.opts.meter.check();
    const body = this.body(req);
    let reply: AnthropicReply;
    try {
      reply = await this.client.beta.messages.create(body);
    } catch (e) {
      // An optional extra the API doesn't accept must not fail the run: drop it once and retry.
      if (body.fallbacks && /fallback|beta/i.test((e as Error).message) && (e as { status?: number }).status === 400) {
        this.fallback = false;
        const { betas: _b, fallbacks: _f, ...plain } = body;
        reply = await this.client.beta.messages.create(plain).catch((e2) => {
          throw toModelError(e2);
        });
      } else throw toModelError(e);
    }
    const model = (body.model as string) ?? this.model;
    this.lastCostUsd = this.opts.meter.add(model, reply.usage);
    if (reply.stop_reason === "refusal")
      throw new ModelError("blocked", `Claude declined this request (${reply.stop_details?.category ?? "safety classifier"}${reply.stop_details?.explanation ? `: ${reply.stop_details.explanation}` : ""})`);
    const text = reply.content
      .filter((b) => b.type === "text" && typeof b.text === "string")
      .map((b) => b.text)
      .join("");
    if (!text) throw new ModelError("parse", `Claude returned no text (stop_reason: ${reply.stop_reason ?? "unknown"}${reply.stop_reason === "max_tokens" ? "; the answer was cut off" : ""})`);
    return {
      text,
      usage: {
        inputTokens: reply.usage.input_tokens + (reply.usage.cache_creation_input_tokens ?? 0) + (reply.usage.cache_read_input_tokens ?? 0),
        outputTokens: reply.usage.output_tokens,
        cacheReadTokens: reply.usage.cache_read_input_tokens ?? 0,
        costUsd: this.lastCostUsd,
      },
    };
  }
}

/** SDK errors → the kernel's error kinds (typed classes, never message matching on the happy path). */
function toModelError(e: unknown): ModelError {
  if (e instanceof ModelError) return e;
  if (e instanceof Anthropic.AuthenticationError || e instanceof Anthropic.PermissionDeniedError) return new ModelError("auth", "Anthropic rejected the API key. Check ANTHROPIC_API_KEY in .env.");
  if (e instanceof Anthropic.RateLimitError) {
    const ra = Number((e.headers as { get?: (k: string) => string | null } | undefined)?.get?.("retry-after"));
    return new ModelError("rate_limited", `Claude is rate-limited: ${e.message}`, Number.isFinite(ra) && ra > 0 ? ra * 1000 : undefined);
  }
  if (e instanceof Anthropic.BadRequestError) {
    const credit = /credit balance|billing/i.test(e.message);
    return new ModelError(credit ? "quota" : "bad_request", credit ? "The Anthropic account is out of credit (check console.anthropic.com → Billing)." : `Claude rejected the request: ${e.message}`);
  }
  if (e instanceof Anthropic.APIConnectionError) return new ModelError("network", `Could not reach Claude: ${e.message}`);
  if (e instanceof Anthropic.APIError) return new ModelError((e.status ?? 500) >= 500 ? "server" : "bad_request", `Claude API error ${e.status}: ${e.message}`);
  return new ModelError("network", `Claude call failed: ${(e as Error).message}`);
}
