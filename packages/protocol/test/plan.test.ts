import { describe, expect, it } from "vitest";
import {
  applyPatch,
  createPlan,
  itemStatus,
  nextRunnableCell,
  Plan,
  PlanPatchError,
  summarize,
  type PlanPatch,
} from "../src/index.ts";

const NOW = "2026-10-06T09:00:00.000Z";

function basePlan() {
  let p = createPlan({
    taskId: "task_1",
    playbookId: "onboard-contractor",
    playbookVersion: 1,
    steps: [
      { id: "collect", title: "Docs" },
      { id: "gstin", title: "GSTIN" },
      { id: "bank", title: "Bank" },
    ],
  });
  p = applyPatch(p, { op: "add_items", items: [
    { id: "a", label: "Contractor A", held: false },
    { id: "b", label: "Contractor B", held: false },
    { id: "c", label: "Contractor C", held: false },
  ] }, NOW);
  return p;
}
const run = (p: Plan, ...patches: PlanPatch[]) => patches.reduce((acc, x) => applyPatch(acc, x, NOW), p);

describe("plan patches", () => {
  it("creates a pending cell for every item × step and bumps the version", () => {
    const p = basePlan();
    expect(p.version).toBe(1);
    expect(Object.keys(p.cells)).toEqual(["a", "b", "c"]);
    expect(p.cells.a!.gstin!.state).toBe("pending");
    expect(Plan.parse(p)).toBeTruthy(); // still a valid plan
  });

  it("is pure: never mutates the input plan", () => {
    const p = basePlan();
    const snapshot = structuredClone(p);
    applyPatch(p, { op: "set_cell", itemId: "a", stepId: "collect", state: "running" }, NOW);
    expect(p).toEqual(snapshot);
  });

  it("counts attempts on running/retrying and merges evidence ids", () => {
    const p = run(
      basePlan(),
      { op: "set_cell", itemId: "a", stepId: "collect", state: "running", evidenceIds: ["ev_1"] },
      { op: "set_cell", itemId: "a", stepId: "collect", state: "retrying", evidenceIds: ["ev_1", "ev_2"] },
    );
    expect(p.cells.a!.collect!.attempts).toBe(2);
    expect(p.cells.a!.collect!.evidenceIds).toEqual(["ev_1", "ev_2"]);
  });

  it("skip_item skips only unfinished cells and records why", () => {
    const p = run(
      basePlan(),
      { op: "set_cell", itemId: "b", stepId: "collect", state: "done" },
      { op: "skip_item", itemId: "b", reason: "Duplicate of vendor V-102" },
    );
    expect(p.cells.b!.collect!.state).toBe("done");
    expect(p.cells.b!.gstin!.state).toBe("skipped");
    expect(p.items[1]!.skipReason).toBe("Duplicate of vendor V-102");
    expect(itemStatus(p, "b")).toBe("done"); // done + skipped counts as finished
  });

  it("reorder must list every item exactly once", () => {
    expect(() => applyPatch(basePlan(), { op: "reorder", itemIds: ["a", "b"] }, NOW)).toThrow(PlanPatchError);
    const p = applyPatch(basePlan(), { op: "reorder", itemIds: ["c", "a", "b"] }, NOW);
    expect(p.items.map((i) => i.id)).toEqual(["c", "a", "b"]);
  });

  it("retry_item resets from the first unfinished step", () => {
    const p = run(
      basePlan(),
      { op: "set_cell", itemId: "a", stepId: "collect", state: "done" },
      { op: "set_cell", itemId: "a", stepId: "gstin", state: "failed", note: "Checksum mismatch" },
      { op: "retry_item", itemId: "a" },
    );
    expect(p.cells.a!.collect!.state).toBe("done");
    expect(p.cells.a!.gstin!.state).toBe("pending");
    expect(p.cells.a!.gstin!.note).toBeUndefined();
  });

  it("rejects unknown items and steps", () => {
    expect(() => applyPatch(basePlan(), { op: "hold_item", itemId: "zz", reason: "x" }, NOW)).toThrow(PlanPatchError);
    expect(() =>
      applyPatch(basePlan(), { op: "set_cell", itemId: "a", stepId: "nope", state: "done" }, NOW),
    ).toThrow(PlanPatchError);
  });
});

describe("skip-and-continue scheduling", () => {
  it("runs steps of an item in order", () => {
    const p = run(basePlan(), { op: "set_cell", itemId: "a", stepId: "collect", state: "done" });
    expect(nextRunnableCell(p)).toEqual({ itemId: "a", stepId: "gstin" });
  });

  it("a parked item never blocks the next one", () => {
    const p = run(basePlan(), { op: "set_cell", itemId: "a", stepId: "collect", state: "needs_you", note: "Missing PAN card" });
    expect(itemStatus(p, "a")).toBe("needs_you");
    expect(nextRunnableCell(p)).toEqual({ itemId: "b", stepId: "collect" });
  });

  it("held items are skipped until released", () => {
    let p = run(basePlan(), { op: "hold_item", itemId: "a", reason: "Under dispute" });
    expect(itemStatus(p, "a")).toBe("held");
    expect(nextRunnableCell(p)?.itemId).toBe("b");
    p = applyPatch(p, { op: "release_item", itemId: "a" }, NOW);
    expect(nextRunnableCell(p)?.itemId).toBe("a");
  });

  it("returns null when everything is finished or waiting on a human", () => {
    const all = ["a", "b", "c"].flatMap((itemId) =>
      ["collect", "gstin", "bank"].map((stepId) => ({ op: "set_cell" as const, itemId, stepId, state: "done" as const })),
    );
    let p = run(basePlan(), ...all);
    p = applyPatch(p, { op: "set_cell", itemId: "c", stepId: "bank", state: "needs_you" }, NOW);
    expect(nextRunnableCell(p)).toBeNull();
    expect(summarize(p)).toMatchObject({ done: 2, needs_you: 1 });
  });
});
