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
 *   pnpm live:check --retry-failed           run failed cases once more (tells flaky from consistent)
 *   pnpm live:check --scripted               no key: the offline stand-in model (checks the suite itself)
 *   pnpm live:check --list                   show the cases and their cost estimates
 */
import { appendFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { withTrace, type ModelAdapter } from "@theseus/core";
import { claudeSpend, modelFromEnv, REPO_ROOT, providerFromEnv, noLiveModelReason } from "@theseus/server";
import { scriptedModel } from "@theseus/server/scripted";
import { listOption } from "./args.ts";
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

const ids = listOption(args, "cases");
const setName = (opt("set") ?? "smoke") as keyof typeof SETS;
if (!ids && !SETS[setName]) {
  console.error(`Unknown set "${setName}". Use smoke, standard or full.`);
  process.exit(2);
}
const picked: LiveCase[] = ids ? ids.map((id) => CASES.find((c) => c.id === id) ?? (() => { throw new Error(`Unknown case "${id}". Try --list.`); })()) : SETS[setName];
const repeat = Math.max(1, Number(opt("repeat") ?? 1));
const budget = opt("budget") ? Number(opt("budget")) : undefined;

// One model instance for the whole run, so the free-tier limiter and the spend meter are shared.
// Every model call (full prompt and reply) is recorded, case by case, for analysing failures afterwards.
const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
const dir = join(REPO_ROOT, ".theseus/live-check");
mkdirSync(dir, { recursive: true });
const traceFile = join(dir, `${stamp}.model.jsonl`);
const base: ModelAdapter = scripted ? scriptedModel() : modelFromEnv({ cache: flag("cache") });
const model = withTrace(base, traceFile);
const mark = (id: string, attempt: number) => appendFileSync(traceFile, `${JSON.stringify({ marker: "case", id, attempt, at: new Date().toISOString() })}\n`);
const est = picked.reduce((n, c) => n + c.estimateUsd, 0) * repeat;
console.log(`Model: ${model.name}${scripted ? " (offline stand-in)" : ""} · ${picked.length} case${picked.length === 1 ? "" : "s"}${repeat > 1 ? ` × ${repeat}` : ""} · browser ${flag("headed") ? "visible" : "hidden"}`);
if (!scripted && model.name.startsWith("anthropic")) {
  const s = claudeSpend()!;
  console.log(`Claude spend so far ${money(s.spent)} of the ${money(s.capUsd)} cap · this run is estimated at about ${money(est)}${est > s.remaining ? "  ⚠ more than what's left under the cap" : ""}\n`);
}

const results: CaseResult[] = [];
let runCost = 0;
let stopped = false;
const eventsDir = join(dir, stamp);
const attempt = async (c: LiveCase, label: string, attemptNo: number): Promise<CaseResult | undefined> => {
  if (budget !== undefined && runCost >= budget) {
    console.log(`Stopping: this run reached its --budget of ${money(budget)}.`);
    stopped = true;
    return undefined;
  }
  process.stdout.write(`▶ ${c.id}${label} … `);
  mark(c.id, attemptNo);
  const r = await runCase(c, {
    model: () => model,
    eventsDir,
    ...(flag("headed") ? { headed: true } : {}),
    ...(opt("slowmo") ? { slowMo: Number(opt("slowmo")) } : {}),
    ...(opt("timeout") ? { timeoutSec: Number(opt("timeout")) } : {}),
  });
  runCost += r.costUsd;
  console.log(`${r.pass ? "pass" : "FAIL"} (${money(r.costUsd)}, ${r.seconds.toFixed(0)}s)`);
  const sp = claudeSpend();
  if (sp && sp.spent >= sp.capUsd) {
    console.log("Stopping: the Claude spend cap was reached.");
    stopped = true;
  }
  return r;
};
// A failure never stops the run: every case is attempted so the report shows all successes and all failures.
outer: for (let k = 0; k < repeat; k++) {
  for (const c of picked) {
    const r = await attempt(c, repeat > 1 ? ` (${k + 1}/${repeat})` : "", 1);
    if (r) results.push(r);
    if (stopped) break outer;
  }
}

// Optionally run each failed case once more: a case that passes the second time is flaky, one that fails again is consistent.
const retried: { id: string; second: "pass" | "FAIL" }[] = [];
if (flag("retry-failed") && !stopped) {
  for (const f of results.filter((r) => !r.pass)) {
    const c = picked.find((x) => x.id === f.id)!;
    const r = await attempt(c, " (retry)", 2);
    if (!r) break;
    retried.push({ id: f.id, second: r.pass ? "pass" : "FAIL" });
    results.push({ ...r, id: `${r.id} (retry)` });
    if (stopped) break;
  }
}

const spend = claudeSpend();
let report = formatReport(results, { model: model.name, ...(spend ? { spent: { total: spend.spent, cap: spend.capUsd } } : {}) });
if (retried.length) report += `\nRetried once: ${retried.map((r) => `${r.id} → ${r.second === "pass" ? "passed (flaky)" : "failed again (consistent)"}`).join(" · ")}`;
console.log(`\n${report}`);

writeFileSync(join(dir, `${stamp}.json`), JSON.stringify({ model: model.name, at: new Date().toISOString(), results }, null, 1));
writeFileSync(join(dir, `${stamp}.txt`), report);
console.log(`\nSaved in .theseus/live-check/: ${stamp}.txt (report), ${stamp}.json, ${stamp}.model.jsonl (every prompt and reply, by case)${results.some((r) => !r.pass) ? `, and ${stamp}/ (event log of each failed case)` : ""}`);
// Failed cases that passed on retry don't make the run fail on their own, consistent failures do.
const finalFail = results.filter((r) => !r.pass && !retried.some((t) => t.second === "pass" && r.id === t.id));
process.exit(results.length && finalFail.length === 0 ? 0 : 1);
