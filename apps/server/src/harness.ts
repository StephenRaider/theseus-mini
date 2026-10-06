import { join } from "node:path";
import { GeminiAdapter, Kernel, RateLimiter, ScriptedModel, withCache, withRateLimit, type EventLog, type ModelAdapter } from "@theseus/core";
import { createVendorIntegrityRuntime } from "@theseus/pack-vendor-integrity/runtime";
import type { World } from "./world.ts";

/**
 * Wires one harness: kernel (keel) + vendor-integrity runtime (planks) + a
 * model + a world. The same function serves the CLI, the tests and (M5) the
 * desktop app.
 */
export async function createHarness(opts: { world: World; model: ModelAdapter; log?: EventLog; approver?: string; sleep?: (ms: number) => Promise<void>; employeeName?: string; stepDelayMs?: number }) {
  const employeeId = "emp_1";
  const runtime = await createVendorIntegrityRuntime({
    client: { urls: opts.world.urls, actor: `agent:${employeeId}`, fetch: opts.world.fetch },
    workspaceDir: opts.world.workspaceDir,
    today: opts.world.today,
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
  return { kernel, runtime, employee };
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
