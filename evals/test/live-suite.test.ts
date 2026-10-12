import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { scriptedModel } from "@theseus/server/scripted";
import { listOption } from "../src/args.ts";
import { CASES, SETS } from "../src/cases.ts";
import { summarizeEvents } from "../src/why.ts";
import { formatReport, runCase } from "../src/runner.ts";

/**
 * The live check suite, run offline against the scripted stand-in model. This does not test
 * Claude: it tests the SUITE: the answer keys match the real mock company, the runner drives
 * real browsers and approvals, and a wrong outcome is reported as a failure. Keeping it green
 * means a failure in a live run points at the model, not at the checks.
 */
describe("live check suite (offline, scripted model)", () => {
  it("every case passes when the employee does the job right", async () => {
    const model = scriptedModel();
    const results = [];
    for (const c of CASES) results.push(await runCase(c, { model: () => model, timeoutSec: 60 }));
    const failed = results.filter((r) => !r.pass);
    expect(failed.map((r) => `${r.id}: ${r.error ?? r.checks.filter((c) => !c.ok).map((c) => c.name).join("; ")}`)).toEqual([]);
    expect(results).toHaveLength(14);
  }, 180_000);

  it("a wrong outcome is reported as a failure (the checks have teeth)", async () => {
    // A model that routes the batch request to the wrong job: the answer key must notice.
    const wrong = scriptedModel([{ purpose: "route", match: /integrity check/i, reply: { inScope: false, tier: 1, goal: "x", refusal: "Not my job.", successCriteria: [], assumptions: [], questions: [], relevant: [] } }]);
    const eventsDir = mkdtempSync(join(tmpdir(), "live-events-"));
    const r = await runCase(CASES.find((c) => c.id === "batch")!, { model: () => wrong, timeoutSec: 30, eventsDir });
    expect(r.pass).toBe(false);
    // A failed case leaves its full event log behind, for analysis afterwards.
    expect(existsSync(join(eventsDir, "batch.events.jsonl"))).toBe(true);
    expect(readFileSync(join(eventsDir, "batch.events.jsonl"), "utf8")).toContain('"type":"task.created"');
    expect(formatReport([r], { model: "scripted" })).toMatch(/FAIL\s+batch[\s\S]*✗ Held exactly the four bad lines/);
  }, 60_000);

  it("a case that hangs is cut off at the time limit (even mid-run) and its task is cancelled", async () => {
    // A model call that never returns: the case must still end, and not keep working in the background.
    const hung = { name: "hung", generate: () => new Promise<never>(() => {}) };
    const t0 = Date.now();
    const r = await runCase(CASES.find((c) => c.id === "batch")!, { model: () => hung, timeoutSec: 2 });
    expect(r.pass).toBe(false);
    expect(r.error).toMatch(/timed out after 2s/);
    expect(Date.now() - t0).toBeLessThan(8000);
  }, 30_000);

  it("an employee that stops to ask a question nobody answers fails fast, with the question", async () => {
    const asks = scriptedModel([{ purpose: "route", match: /integrity check/i, reply: { inScope: true, tier: 1, goal: "x", playbookId: "payment-batch-check", successCriteria: [], assumptions: [], relevant: [], questions: [{ text: "Which batch do you mean?", blocking: true }] } }]);
    const t0 = Date.now();
    const r = await runCase(CASES.find((c) => c.id === "batch")!, { model: () => asks, timeoutSec: 60, idleGraceSec: 1 });
    expect(r.pass).toBe(false);
    expect(r.error).toMatch(/waited for a person[\s\S]*Which batch do you mean\?/);
    expect(Date.now() - t0).toBeLessThan(15_000);
  }, 30_000);

  it("live:why turns a failed case's saved log into a readable story", async () => {
    const eventsDir = mkdtempSync(join(tmpdir(), "live-why-"));
    const asks = scriptedModel([{ purpose: "route", match: /integrity check/i, reply: { inScope: true, tier: 1, goal: "x", playbookId: "payment-batch-check", successCriteria: [], assumptions: [], relevant: [], questions: [{ text: "Which batch do you mean?", blocking: true }] } }]);
    await runCase(CASES.find((c) => c.id === "batch")!, { model: () => asks, timeoutSec: 60, idleGraceSec: 1, eventsDir });
    const story = summarizeEvents(readFileSync(join(eventsDir, "batch.events.jsonl"), "utf8")).join("\n");
    expect(story).toMatch(/YOU\s+Run the integrity check/);
    expect(story).toMatch(/QUESTION\s+Which batch do you mean\? \(blocking\)/);
    expect(story).toMatch(/TASK\s+(waiting_on_user|cancelled)/);
  }, 30_000);

  it("a list of cases is read however PowerShell passes it", () => {
    expect(listOption(["--cases", "a,b,c", "--budget", "2"], "cases")).toEqual(["a", "b", "c"]);
    expect(listOption(["--cases", "a b c"], "cases")).toEqual(["a", "b", "c"]); // what pnpm received from `--cases a,b,c`
    expect(listOption(["--cases", "a", "b", "--retry-failed"], "cases")).toEqual(["a", "b"]);
    expect(listOption(["--set", "full"], "cases")).toBeUndefined();
  });

  it("the sets are what the docs say", () => {
    expect(SETS.smoke.map((c) => c.id)).toEqual(["refuse", "batch", "operate"]);
    expect(SETS.standard.length).toBe(11);
    expect(SETS.full.length).toBe(14);
    const est = (cs: typeof CASES) => cs.reduce((n, c) => n + c.estimateUsd, 0);
    expect(est(SETS.smoke)).toBeLessThan(0.5);
    expect(est(SETS.full)).toBeLessThan(3);
  });
});
