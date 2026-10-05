import { describe, expect, it } from "vitest";
import { Command, nextEmployeeName, Playbook, TheseusEvent, ToolDescriptor, ToolResult } from "../src/index.ts";

describe("employee naming", () => {
  it("numbered mode fills the smallest free number", () => {
    expect(nextEmployeeName("numbered", [])).toBe("Employee 1");
    expect(nextEmployeeName("numbered", ["Employee 1", "Employee 3"])).toBe("Employee 2");
  });

  it("greek mode never repeats a name in use", () => {
    const name = nextEmployeeName("greek", ["Ariadne"], () => 0);
    expect(name).not.toBe("Ariadne");
    expect(name).toBe("Phaedra");
  });
});

describe("events", () => {
  it("parses a valid plan.patched event", () => {
    const e = TheseusEvent.parse({
      id: "evt_1",
      seq: 7,
      ts: "2026-10-06T09:00:00.000Z",
      actor: "employee:emp_1",
      taskId: "task_1",
      type: "plan.patched",
      payload: { taskId: "task_1", version: 3, patch: { op: "hold_item", itemId: "a", reason: "Dispute" } },
    });
    expect(e.type).toBe("plan.patched");
  });

  it("rejects an unknown actor", () => {
    expect(() =>
      TheseusEvent.parse({
        id: "evt_2", seq: 1, ts: "2026-10-06T09:00:00.000Z", actor: "robot",
        type: "nudge.acknowledged", payload: { nudgeId: "ndg_1", response: "ok" },
      }),
    ).toThrow();
  });
});

describe("commands", () => {
  it("accepts a nudge and rejects an empty one", () => {
    expect(Command.parse({ type: "nudge", employeeId: "emp_2", text: "Hold Shree Ganesh" }).type).toBe("nudge");
    expect(() => Command.parse({ type: "nudge", employeeId: "emp_2", text: "" })).toThrow();
  });
});

describe("tools", () => {
  it("enforces namespaced tool names", () => {
    const base = { description: "x", risk: "read", idempotent: true, inputSchema: {} };
    expect(ToolDescriptor.parse({ ...base, name: "check.gstin" }).name).toBe("check.gstin");
    expect(() => ToolDescriptor.parse({ ...base, name: "gstin" })).toThrow();
  });

  it("models failures as classified errors", () => {
    const r = ToolResult.parse({ ok: false, error: { class: "transient", message: "ERP timed out" } });
    expect(r.ok).toBe(false);
  });
});

describe("playbooks", () => {
  it("applies defaults (on_fail, risk, widget)", () => {
    const pb = Playbook.parse({
      id: "demo", version: 1, title: "Demo", when_to_use: "tests",
      item: { kind: "thing", plural: "things", discover: "n/a" },
      success_criteria: ["works"],
      steps: [{ id: "one", title: "One", goal: "do it" }],
    });
    expect(pb.steps[0]!.on_fail).toBe("needs_you");
    expect(pb.steps[0]!.risk).toBe("read");
    expect(pb.widget).toEqual({ type: "item_grid" });
  });
});
