import { join } from "node:path";
import { Playbook, RolePackManifest, type PlanItem } from "@theseus/protocol";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { Kernel, ScriptedModel, loadRolePack, type PackRuntime, type Tool } from "../src/index.ts";

/**
 * The platform claim, tested: Theseus is not a vendor-checking program, it is
 * a platform that employee types plug into. Here a completely different
 * employee (a library desk clerk, nothing to do with vendors, money or ERPs)
 * runs on the unchanged keel, using only the PackRuntime contract.
 */

const manifest = RolePackManifest.parse({
  id: "library-desk",
  name: "Library Desk Clerk",
  version: 1,
  company: "Riverside Library",
  persona: { desk: "circulation desk", systems: "the loans register and member records", signoff: "Circulation Desk", steerExample: "hold Mrs Rao's loans", examples: ["Which loans are overdue?"] },
  tools: [
    { name: "loans.list", risk: "read", description: "List open loans" },
    { name: "members.send_notice", risk: "irreversible", description: "Send an overdue notice to a member" },
  ],
  scope: { does: ["overdue-loan checks"], does_not: ["fines or payments"] },
  checks: [{ id: "overdue", kind: "deterministic", description: "Loan is more than 14 days past due" }],
});

const playbook = Playbook.parse({
  id: "overdue-loans",
  version: 1,
  title: "Check overdue loans",
  when_to_use: "The user asks which library loans are overdue.",
  item: { kind: "loan", plural: "loans", discover: "One item per open loan." },
  success_criteria: ["Every open loan was checked against the 14-day rule."],
  steps: [{ id: "check", title: "Overdue?", goal: "Compare the due date with today.", tools: ["loans.list"], checks: ["overdue"] }],
});

const LOANS = [
  { id: "L-1", member: "Mrs Rao", title: "Middlemarch", dueOn: "2026-09-01" },
  { id: "L-2", member: "Dev Patel", title: "Dune", dueOn: "2026-10-05" },
  { id: "L-3", member: "Asha Nair", title: "Emma", dueOn: "2026-09-28" },
];

const tools: Tool[] = [
  { name: "loans.list", description: "List open loans", risk: "read", idempotent: true, input: z.object({}), run: async () => ({ loans: LOANS }) },
  {
    name: "members.send_notice",
    description: "Send an overdue notice",
    risk: "irreversible",
    idempotent: false,
    input: z.object({ member: z.string() }),
    run: async () => {
      throw new Error("must never run without approval");
    },
  },
];

const pack: PackRuntime = {
  manifest,
  playbooks: new Map([[playbook.id, playbook]]),
  tools,
  today: () => "2026-10-12",
  params: { "overdue-loans": {} },
  async orient() {
    return { today: "2026-10-12", sources: LOANS.map((l) => ({ kind: "loan", ref: `loan:${l.id}`, label: `${l.title} (${l.member})`, date: l.dueOn })) };
  },
  discover: {
    "overdue-loans": async (ctx): Promise<PlanItem[]> => {
      const { loans } = await ctx.call<{ loans: typeof LOANS }>("loans.list", {});
      return loans.map((l) => ({ id: l.id, label: `${l.title} (${l.member})`, ref: l.id, held: false }));
    },
  },
  handlers: {
    "overdue-loans": {
      async check(ctx) {
        const { loans } = await ctx.call<{ loans: typeof LOANS }>("loans.list", {});
        const loan = loans.find((l) => l.id === ctx.item.id)!;
        const days = Math.round((Date.parse(ctx.today) - Date.parse(loan.dueOn)) / 86_400_000);
        ctx.check("overdue", days > 14 ? "fail" : "pass", `${days} days past due`);
        return days > 14 ? { status: "done", note: `⚑ ${days} days overdue` } : { status: "done", note: "On time or recently due" };
      },
    },
  },
};

describe("platform: any employee type runs on the same keel", () => {
  it("a library clerk plans, runs and reports with no vendor code anywhere", async () => {
    const model = new ScriptedModel([
      { purpose: "route", reply: { inScope: true, tier: 1, goal: "List overdue loans", playbookId: "overdue-loans", successCriteria: [], assumptions: [], questions: [], relevant: [] } },
    ]);
    const kernel = new Kernel({ pack, model, sleep: async () => {} });
    const emp = kernel.createEmployee({ name: "Employee 1" });
    await kernel.send(emp.id, "Which loans are overdue?");
    await kernel.settled();

    const task = [...kernel.runs.values()][0]!;
    expect(task.task.status).toBe("done");
    const plan = task.plan!;
    expect(plan.items.map((i) => i.label)).toEqual(["Middlemarch (Mrs Rao)", "Dune (Dev Patel)", "Emma (Asha Nair)"]);
    expect(plan.cells["L-1"]!.check!.note).toBe("⚑ 41 days overdue");
    expect(plan.cells["L-2"]!.check!.note).toBe("On time or recently due");
    // The verifier ran, and the report speaks about loans, not vendors.
    expect(kernel.log.ofType("verification.completed")).toHaveLength(1);
    const said = kernel.log.ofType("message.posted").map((m) => m.payload.text).join("\n");
    expect(said).toMatch(/Running "Check overdue loans": 3 loans/);
    expect(said).not.toMatch(/vendor|ERP|GST/i);
  });

  it("the safety gateway protects this role too: an irreversible tool can't run without approval", async () => {
    const kernel = new Kernel({ pack, model: new ScriptedModel([]), sleep: async () => {} });
    const r = await kernel.gateway.call("members.send_notice", { member: "Mrs Rao" }, { employeeId: "emp_1" });
    expect(r.ok).toBe(false);
    expect(!r.ok && r.error.class).toBe("policy_violation");
  });

  it("'what can you do?' is answered from the pack's own persona and scope, not from the keel", async () => {
    const kernel = new Kernel({ pack, model: new ScriptedModel([]), sleep: async () => {} });
    const text = kernel.aboutMe();
    expect(text).toContain("Library Desk Clerk at Riverside Library");
    expect(text).toContain("the loans register and member records");
    expect(text).toContain("hold Mrs Rao's loans");
    expect(text).toContain("fines or payments");
    expect(text).not.toMatch(/vendor|ERP|GST|eProcure/i);
  });

  it("the scaffold in packs/_template stays a valid pack", async () => {
    const t = await loadRolePack(join(import.meta.dirname, "../../../packs/_template"));
    expect(t.manifest.id).toBe("your-role");
    expect([...t.playbooks.keys()]).toEqual(["example-procedure"]);
  });
});
