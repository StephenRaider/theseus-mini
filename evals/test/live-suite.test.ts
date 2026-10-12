import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { scriptedModel } from "@theseus/server/scripted";
import { CASES, SETS } from "../src/cases.ts";
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

  it("the sets are what the docs say", () => {
    expect(SETS.smoke.map((c) => c.id)).toEqual(["refuse", "batch", "operate"]);
    expect(SETS.standard.length).toBe(11);
    expect(SETS.full.length).toBe(14);
    const est = (cs: typeof CASES) => cs.reduce((n, c) => n + c.estimateUsd, 0);
    expect(est(SETS.smoke)).toBeLessThan(0.5);
    expect(est(SETS.full)).toBeLessThan(3);
  });
});
