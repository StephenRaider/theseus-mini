/**
 * Live check suite: real scenarios against a real model, checked against the mock company's
 * ground truth, with a cost report.
 *
 *   pnpm live:check                          smoke set (the 3 cheapest, most telling cases)
 *   pnpm live:check --set standard           the whole demo
 *   pnpm live:check --set full               + approvals, faults and the hold gate in the browser
 *   pnpm live:check --cases batch,operate    pick cases by id
 *   pnpm live:check --headed --slowmo 300    watch the employee's browser work
 *   pnpm live:check --budget 2               stop starting new cases once this run has cost $2
 *   pnpm live:check --scripted               no key: the offline stand-in model (checks the suite itself)
 *   pnpm live:check --list                   show the cases and their cost estimates
 */
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { claudeSpend, modelFromEnv, REPO_ROOT, providerFromEnv, noLiveModelReason } from "@theseus/server";
import { scriptedModel } from "@theseus/server/scripted";
import { CASES, SETS, type LiveCase } from "./cases.ts";
import { formatReport, money, runCase, type CaseResult } from "./runner.ts";

const args = process.argv.slice(2);
const flag = (n: string) => args.includes(`--${n}`);
const opt = (n: string) => {
  const i = args.indexOf(`--${n}`);
  return i >= 0 ? args[i + 1] : undefined;
};

if (existsSync(join(REPO_ROOT, ".env"))) process.loadEnvFile(join(REPO_ROOT, ".env"));

if (flag("list")) {
  for (const c of CASES) console.log(`${c.id.padEnd(17)} ~${money(c.estimateUsd).padEnd(6)} [${c.sets[0]}+]${c.browser ? " browser" : ""}  ${c.title}`);
  console.log(`\nsmoke ≈ ${money(SETS.smoke.reduce((n, c) => n + c.estimateUsd, 0))} · standard ≈ ${money(SETS.standard.reduce((n, c) => n + c.estimateUsd, 0))} · full ≈ ${money(SETS.full.reduce((n, c) => n + c.estimateUsd, 0))} (Claude, rough estimates)`);
  process.exit(0);
}

const scripted = flag("scripted");
if (!scripted && !providerFromEnv()) {
  console.error(`No live model: ${noLiveModelReason()}. Add the key to the .env file at the project root (see evals/README.md), or use --scripted to check the suite itself.`);
  process.exit(2);
}

const ids = opt("cases")?.split(",").map((s) => s.trim());
const setName = (opt("set") ?? "smoke") as keyof typeof SETS;
if (!ids && !SETS[setName]) {
  console.error(`Unknown set "${setName}". Use smoke, standard or full.`);
  process.exit(2);
}
const picked: LiveCase[] = ids ? ids.map((id) => CASES.find((c) => c.id === id) ?? (() => { throw new Error(`Unknown case "${id}". Try --list.`); })()) : SETS[setName];
const repeat = Math.max(1, Number(opt("repeat") ?? 1));
const budget = opt("budget") ? Number(opt("budget")) : undefined;

// One model instance for the whole run, so the free-tier limiter and the spend meter are shared.
const model = scripted ? scriptedModel() : modelFromEnv({ cache: flag("cache") });
const est = picked.reduce((n, c) => n + c.estimateUsd, 0) * repeat;
console.log(`Model: ${model.name}${scripted ? " (offline stand-in)" : ""} · ${picked.length} case${picked.length === 1 ? "" : "s"}${repeat > 1 ? ` × ${repeat}` : ""} · browser ${flag("headed") ? "visible" : "hidden"}`);
if (!scripted && model.name.startsWith("anthropic")) {
  const s = claudeSpend()!;
  console.log(`Claude spend so far ${money(s.spent)} of the ${money(s.capUsd)} cap · this run is estimated at about ${money(est)}${est > s.remaining ? "  ⚠ more than what's left under the cap" : ""}\n`);
}

const results: CaseResult[] = [];
let runCost = 0;
outer: for (let k = 0; k < repeat; k++) {
  for (const c of picked) {
    if (budget !== undefined && runCost >= budget) {
      console.log(`Stopping: this run reached its --budget of ${money(budget)}.`);
      break outer;
    }
    process.stdout.write(`▶ ${c.id}${repeat > 1 ? ` (${k + 1}/${repeat})` : ""} … `);
    const r = await runCase(c, {
      model: () => model,
      ...(flag("headed") ? { headed: true } : {}),
      ...(opt("slowmo") ? { slowMo: Number(opt("slowmo")) } : {}),
      ...(opt("timeout") ? { timeoutSec: Number(opt("timeout")) } : {}),
    });
    runCost += r.costUsd;
    results.push(r);
    console.log(`${r.pass ? "pass" : "FAIL"} (${money(r.costUsd)}, ${r.seconds.toFixed(0)}s)`);
    if (claudeSpend() && claudeSpend()!.spent >= claudeSpend()!.capUsd) {
      console.log("Stopping: the Claude spend cap was reached.");
      break outer;
    }
  }
}

const spend = claudeSpend();
const report = formatReport(results, { model: model.name, ...(spend ? { spent: { total: spend.spent, cap: spend.capUsd } } : {}) });
console.log(`\n${report}`);

const dir = join(REPO_ROOT, ".theseus/live-check");
mkdirSync(dir, { recursive: true });
const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
writeFileSync(join(dir, `${stamp}.json`), JSON.stringify({ model: model.name, at: new Date().toISOString(), results }, null, 1));
writeFileSync(join(dir, `${stamp}.txt`), report);
console.log(`\nReport saved: .theseus/live-check/${stamp}.txt (and .json)`);
process.exit(results.length && results.every((r) => r.pass) ? 0 : 1);
