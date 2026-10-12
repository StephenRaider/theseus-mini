import { readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { BrowserPool, type BrowserPoolOptions } from "@theseus/browser";
import { AnthropicAdapter, EventLog, GeminiAdapter, Kernel, RateLimiter, ScriptedModel, SpendMeter, withCache, withRateLimit, withTrace, type ModelAdapter } from "@theseus/core";
import { loadPack, packId } from "./packs.ts";
import type { World } from "./world.ts";

/**
 * Wires one harness: kernel (keel) + a role pack (the employee type, chosen by
 * id from the registry in packs.ts) + a model + a world. The same function serves the CLI, the tests and (M5) the
 * desktop app.
 */
export interface HarnessOptions {
  world: World;
  model: ModelAdapter;
  log?: EventLog;
  approver?: string;
  sleep?: (ms: number) => Promise<void>;
  employeeName?: string;
  stepDelayMs?: number;
  /** Which employee type to run (a role pack id; default: THESEUS_PACK or "vendor-integrity"). */
  pack?: string;
  /**
   * Computer use: give the employees a real browser (Chromium via Playwright)
   * limited to the world's sites. Needs a world whose sites listen on ports.
   */
  browser?: boolean | Omit<BrowserPoolOptions, "allowOrigins">;
}

export async function createHarness(opts: HarnessOptions) {
  const employeeId = "emp_1";
  let pool: BrowserPool | undefined;
  if (opts.browser) {
    if (!opts.world.browsable) throw new Error("Computer use needs a world a browser can reach: inProcessWorld({ listen: true }) or the live world");
    pool = new BrowserPool({ ...(typeof opts.browser === "object" ? opts.browser : {}), allowOrigins: Object.values(opts.world.urls) });
  }
  const runtime = await loadPack(packId(opts.pack), {
    world: opts.world,
    employeeId,
    ...(pool ? { browser: { pool, urls: opts.world.urls } } : {}),
  });
  const kernel = new Kernel({
    pack: runtime,
    model: opts.model,
    ...(opts.log ? { log: opts.log } : {}),
    approver: opts.approver ?? "you",
    ...(opts.sleep ? { sleep: opts.sleep } : {}),
    ...(opts.stepDelayMs ? { stepDelayMs: opts.stepDelayMs } : {}),
  });
  const employee = kernel.createEmployee({ id: employeeId, name: opts.employeeName ?? "Employee 1" });
  /** Close the browser and the world's servers. */
  const close = async () => {
    await pool?.close();
    await opts.world.close();
  };
  return { kernel, runtime, employee, browser: pool, close };
}

export const REPO_ROOT = join(import.meta.dirname, "../../..");

export type Provider = "gemini" | "anthropic";

/**
 * Which live model to use. MODEL_PROVIDER wins when set; otherwise whichever key exists
 * (Gemini first, because it is free). Returns undefined when no key is configured.
 */
export function providerFromEnv(): Provider | undefined {
  const explicit = process.env.MODEL_PROVIDER?.toLowerCase().trim();
  if (explicit === "gemini" || explicit === "anthropic") return process.env[explicit === "gemini" ? "GEMINI_API_KEY" : "ANTHROPIC_API_KEY"]?.trim() ? explicit : undefined;
  if (explicit) throw new Error(`MODEL_PROVIDER=${explicit} isn't supported. Use gemini or anthropic.`);
  if (process.env.GEMINI_API_KEY?.trim()) return "gemini";
  if (process.env.ANTHROPIC_API_KEY?.trim()) return "anthropic";
  return undefined;
}

/** Why no live model is available, in a sentence for the user. */
export function noLiveModelReason(): string {
  const explicit = process.env.MODEL_PROVIDER?.toLowerCase().trim();
  if (explicit === "anthropic") return "MODEL_PROVIDER=anthropic but no ANTHROPIC_API_KEY in .env";
  if (explicit === "gemini") return "MODEL_PROVIDER=gemini but no GEMINI_API_KEY in .env";
  return "no GEMINI_API_KEY or ANTHROPIC_API_KEY in .env";
}

let meter: SpendMeter | undefined;
/** The Claude spend so far (undefined unless the Anthropic provider is in use). */
export const claudeSpend = () => meter;

/**
 * The live model from .env.
 *  - Gemini behind the free-tier limiter (15 requests a minute, 500 a day by default;
 *    GEMINI_RPM / GEMINI_RPD override). Usage is remembered in .theseus/usage.json.
 *  - Claude (MODEL_PROVIDER=anthropic): Sonnet 5.5 for judgement calls, Haiku 5.5 for
 *    triage and summaries, low effort, prompt caching, and a hard spend cap
 *    (ANTHROPIC_BUDGET_USD, default 12) remembered in .theseus/anthropic-spend.json.
 *    ANTHROPIC_MODEL / ANTHROPIC_MODEL_SMALL override the models; ANTHROPIC_FALLBACK=off
 *    turns off the server-side refusal fallback.
 */
export function modelFromEnv(opts: { cache?: boolean } = {}): ModelAdapter {
  const provider = providerFromEnv();
  if (!provider) throw new Error(`No live model: ${noLiveModelReason()}.`);
  let m: ModelAdapter;
  if (provider === "anthropic") {
    meter = new SpendMeter(Number(process.env.ANTHROPIC_BUDGET_USD ?? 12), join(REPO_ROOT, ".theseus/anthropic-spend.json"));
    m = new AnthropicAdapter({
      meter,
      ...(process.env.ANTHROPIC_MODEL ? { model: process.env.ANTHROPIC_MODEL } : {}),
      ...(process.env.ANTHROPIC_MODEL_SMALL ? { smallModel: process.env.ANTHROPIC_MODEL_SMALL } : {}),
      fallback: process.env.ANTHROPIC_FALLBACK?.toLowerCase() !== "off",
    });
  } else {
    const model = process.env.GEMINI_MODEL ?? "gemini-3.5-flash-lite";
    m = new GeminiAdapter({ apiKey: process.env.GEMINI_API_KEY ?? "", model });
    m = withRateLimit(m, new RateLimiter({ rpm: Number(process.env.GEMINI_RPM ?? 15), rpd: Number(process.env.GEMINI_RPD ?? 500), usageFile: join(REPO_ROOT, ".theseus/usage.json") }));
  }
  if (opts.cache) m = withCache(m, join(REPO_ROOT, ".theseus/model-cache"));
  return m;
}

export { ScriptedModel };

/**
 * Flight recorder for one session: every event and every model call go to
 * .theseus/runs/<time>.events.jsonl and <time>.model.jsonl (git-ignored).
 * Keeps the newest 40 files so the folder doesn't grow forever.
 */
export function recorder(label: string): { log: EventLog; trace: (m: ModelAdapter) => ModelAdapter; dir: string; stamp: string } {
  const dir = join(REPO_ROOT, ".theseus/runs");
  const stamp = `${new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19)}-${label}`;
  try {
    const old = readdirSync(dir).filter((f) => f.endsWith(".jsonl")).sort();
    for (const f of old.slice(0, Math.max(0, old.length - 38))) rmSync(join(dir, f), { force: true });
  } catch {
    /* first run: no folder yet */
  }
  return {
    log: new EventLog({ file: join(dir, `${stamp}.events.jsonl`) }),
    trace: (m) => (m.name === "scripted" ? m : withTrace(m, join(dir, `${stamp}.model.jsonl`))),
    dir,
    stamp,
  };
}
