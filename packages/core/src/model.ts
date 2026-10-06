import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { z } from "zod";

/**
 * The model adapter: the ONLY way the kernel talks to an LLM. One small
 * interface, so swapping Gemini for Claude (M7) is a new adapter, not a new
 * kernel. Every call asks for JSON that matches a schema, because a weak
 * model is far more reliable filling in a form than writing free text.
 */
export type ThinkingLevel = "minimal" | "low" | "medium" | "high";

export interface ModelRequest {
  /** What the call is for: "route", "compose", "triage", "extract", "summary"… (shown in the log and evals). */
  purpose: string;
  system: string;
  prompt: string;
  /** JSON Schema the reply must follow. */
  jsonSchema?: Record<string, unknown>;
  thinking?: ThinkingLevel;
}

export interface ModelResponse {
  text: string;
  usage?: { inputTokens?: number; outputTokens?: number };
  cached?: boolean;
}

export interface ModelAdapter {
  readonly name: string;
  generate(req: ModelRequest): Promise<ModelResponse>;
}

export type ModelErrorKind = "rate_limited" | "quota" | "auth" | "bad_request" | "server" | "blocked" | "network" | "parse";

export class ModelError extends Error {
  constructor(
    public readonly kind: ModelErrorKind,
    message: string,
    /** Server-suggested wait before retrying, if any. */
    public readonly retryAfterMs?: number,
  ) {
    super(message);
  }
}

/* ------------------------------------------------------------------ rate limiting */

export interface RateLimit {
  /** Requests per minute allowed by the plan (free Gemini Flash-Lite: 15). */
  rpm: number;
  /** Requests per day (free Gemini Flash-Lite: 500). */
  rpd: number;
  /** Where to remember today's count across runs (optional). */
  usageFile?: string;
}

/**
 * Keeps us inside a free tier: spaces calls evenly (60 s / rpm, plus a margin)
 * and refuses once today's budget is spent, with a clear message rather than
 * a wall of 429 errors.
 */
export class RateLimiter {
  private nextAt = 0;
  private day = "";
  private count = 0;

  constructor(
    private readonly limit: RateLimit,
    private readonly env: { now?: () => number; sleep?: (ms: number) => Promise<void> } = {},
  ) {
    this.load();
  }

  private now() {
    return (this.env.now ?? Date.now)();
  }
  private sleep(ms: number) {
    return (this.env.sleep ?? ((t: number) => new Promise<void>((r) => setTimeout(r, t))))(ms);
  }

  private load() {
    const f = this.limit.usageFile;
    if (!f || !existsSync(f)) return;
    try {
      const j = JSON.parse(readFileSync(f, "utf8")) as { day: string; count: number };
      this.day = j.day;
      this.count = j.count;
    } catch {
      /* a corrupt usage file just resets the count */
    }
  }

  private save() {
    const f = this.limit.usageFile;
    if (!f) return;
    mkdirSync(dirname(f), { recursive: true });
    writeFileSync(f, JSON.stringify({ day: this.day, count: this.count }));
  }

  /** Calls used today and the daily limit. */
  get usage() {
    return { day: this.day, used: this.count, limit: this.limit.rpd };
  }

  async acquire(): Promise<void> {
    const today = new Date(this.now()).toISOString().slice(0, 10);
    if (today !== this.day) {
      this.day = today;
      this.count = 0;
    }
    if (this.count >= this.limit.rpd)
      throw new ModelError("quota", `Daily model budget used up (${this.count}/${this.limit.rpd} calls today). It resets tomorrow (UTC).`);
    const wait = this.nextAt - this.now();
    if (wait > 0) await this.sleep(wait);
    this.nextAt = Math.max(this.now(), this.nextAt) + Math.ceil(60_000 / this.limit.rpm) + 250;
    this.count++;
    this.save();
  }
}

export function withRateLimit(model: ModelAdapter, limiter: RateLimiter): ModelAdapter {
  return {
    name: model.name,
    async generate(req) {
      await limiter.acquire();
      return model.generate(req);
    },
  };
}

/* ------------------------------------------------------------------ caching */

/**
 * Disk cache keyed by the exact request. Repeat runs of the same eval task
 * then cost no quota. Off by default for live work (answers should reflect
 * the current world); the CLI turns it on with --cache.
 */
export function withCache(model: ModelAdapter, dir: string): ModelAdapter {
  return {
    name: model.name,
    async generate(req) {
      const key = createHash("sha256")
        .update(JSON.stringify([model.name, req.system, req.prompt, req.jsonSchema ?? null]))
        .digest("hex")
        .slice(0, 32);
      const file = join(dir, `${key}.json`);
      if (existsSync(file)) return { ...(JSON.parse(readFileSync(file, "utf8")) as ModelResponse), cached: true };
      const res = await model.generate(req);
      mkdirSync(dir, { recursive: true });
      writeFileSync(file, JSON.stringify({ text: res.text, usage: res.usage }));
      return res;
    },
  };
}

/* ------------------------------------------------------------------ scripted model (tests, offline demo) */

export interface ScriptRule {
  /** Matches req.purpose exactly, if given. */
  purpose?: string;
  /** Extra matcher on the prompt. */
  match?: RegExp | ((req: ModelRequest) => boolean);
  /** The reply: an object (sent as JSON) or a string, or a function of the request. */
  reply: unknown | ((req: ModelRequest) => unknown);
  /** Use at most this many times (default: unlimited). */
  times?: number;
}

/** A stand-in model that answers from a script. Lets every test run with no key and no network. */
export class ScriptedModel implements ModelAdapter {
  readonly name = "scripted";
  readonly calls: ModelRequest[] = [];
  private used = new Map<ScriptRule, number>();

  constructor(private readonly rules: ScriptRule[]) {}

  async generate(req: ModelRequest): Promise<ModelResponse> {
    this.calls.push(req);
    for (const r of this.rules) {
      if (r.purpose && r.purpose !== req.purpose) continue;
      if (r.match instanceof RegExp && !r.match.test(req.prompt)) continue;
      if (typeof r.match === "function" && !r.match(req)) continue;
      const n = this.used.get(r) ?? 0;
      if (r.times !== undefined && n >= r.times) continue;
      this.used.set(r, n + 1);
      const out = typeof r.reply === "function" ? (r.reply as (q: ModelRequest) => unknown)(req) : r.reply;
      return { text: typeof out === "string" ? out : JSON.stringify(out) };
    }
    throw new ModelError("bad_request", `ScriptedModel has no reply for purpose "${req.purpose}"`);
  }
}

/* ------------------------------------------------------------------ JSON replies */

/**
 * JSON Schema for the model, from a Zod schema. Gemini accepts a subset of
 * JSON Schema, so keywords it may reject are stripped.
 */
export function toModelSchema(schema: z.ZodType): Record<string, unknown> {
  const raw = z.toJSONSchema(schema, { unrepresentable: "any" }) as Record<string, unknown>;
  const DROP = new Set(["$schema", "pattern", "default", "examples", "$id", "propertyNames"]);
  const clean = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(clean);
    if (v && typeof v === "object") {
      const out: Record<string, unknown> = {};
      for (const [k, x] of Object.entries(v)) if (!DROP.has(k)) out[k] = clean(x);
      return out;
    }
    return v;
  };
  return clean(raw) as Record<string, unknown>;
}

/** Pull the JSON out of a reply: tolerates ```json fences and text around it. */
export function extractJson(text: string): unknown {
  const t = text.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  try {
    return JSON.parse(t);
  } catch {
    const start = t.search(/[[{]/);
    const end = Math.max(t.lastIndexOf("}"), t.lastIndexOf("]"));
    if (start >= 0 && end > start) return JSON.parse(t.slice(start, end + 1));
    throw new ModelError("parse", "Reply was not JSON");
  }
}

/**
 * Ask for JSON matching `schema`. If the reply doesn't parse or validate, ask
 * once more with the exact problems listed (cheap self-repair), then give up
 * with a `parse` error the caller can handle.
 */
export async function generateJson<T>(
  call: (req: ModelRequest) => Promise<ModelResponse>,
  req: Omit<ModelRequest, "jsonSchema">,
  schema: z.ZodType<T>,
  repairs = 1,
): Promise<T> {
  const jsonSchema = toModelSchema(schema);
  let prompt = req.prompt;
  for (let attempt = 0; ; attempt++) {
    const res = await call({ ...req, prompt, jsonSchema });
    let problem: string;
    try {
      const parsed = schema.safeParse(extractJson(res.text));
      if (parsed.success) return parsed.data;
      problem = parsed.error.issues
        .slice(0, 8)
        .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
        .join("; ");
    } catch (e) {
      problem = (e as Error).message;
    }
    if (attempt >= repairs) throw new ModelError("parse", `Model reply did not match the expected format: ${problem}`);
    prompt = `${req.prompt}\n\nYOUR PREVIOUS REPLY WAS INVALID (${problem}). Reply again with JSON only, following the schema exactly.`;
  }
}
