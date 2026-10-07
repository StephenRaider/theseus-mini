import { readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { BrowserPool, type BrowserPoolOptions } from "@theseus/browser";
import { EventLog, GeminiAdapter, Kernel, RateLimiter, ScriptedModel, withCache, withRateLimit, withTrace, type ModelAdapter } from "@theseus/core";
import { createVendorIntegrityRuntime } from "@theseus/pack-vendor-integrity/runtime";
import type { World } from "./world.ts";

/**
 * Wires one harness: kernel (keel) + vendor-integrity runtime (planks) + a
 * model + a world. The same function serves the CLI, the tests and (M5) the
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
  const runtime = await createVendorIntegrityRuntime({
    client: { urls: opts.world.urls, actor: `agent:${employeeId}`, fetch: opts.world.fetch },
    workspaceDir: opts.world.workspaceDir,
    today: opts.world.today,
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

/**
 * The live model from .env: Gemini behind the free-tier limiter (15 requests
 * a minute, 500 a day by default; override with GEMINI_RPM / GEMINI_RPD).
 * Usage is remembered in .theseus/usage.json so the daily budget survives restarts.
 */
export function modelFromEnv(opts: { cache?: boolean } = {}): ModelAdapter {
  const provider = (process.env.MODEL_PROVIDER ?? "gemini").toLowerCase();
  if (provider !== "gemini") throw new Error(`MODEL_PROVIDER=${provider} isn't wired yet (Claude arrives at M7). Use gemini.`);
  const model = process.env.GEMINI_MODEL ?? "gemini-3.5-flash-lite";
  let m: ModelAdapter = new GeminiAdapter({ apiKey: process.env.GEMINI_API_KEY ?? "", model });
  m = withRateLimit(m, new RateLimiter({ rpm: Number(process.env.GEMINI_RPM ?? 15), rpd: Number(process.env.GEMINI_RPD ?? 500), usageFile: join(REPO_ROOT, ".theseus/usage.json") }));
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
