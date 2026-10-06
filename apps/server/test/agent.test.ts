import { existsSync } from "node:fs";
import { join } from "node:path";
import { ModelError, ScriptedModel, type Kernel } from "@theseus/core";
import type { TheseusEvent } from "@theseus/protocol";
import { describe, expect, it } from "vitest";
import { createHarness } from "../src/harness.ts";
import { scriptedModel } from "../src/scripted.ts";
import { inProcessWorld, type World } from "../src/world.ts";

/**
 * End-to-end: the real kernel + the real role pack + a fresh in-process
 * Kaveri world. Only the model is scripted (same JSON a live model must give).
 */
const noSleep = async () => {};

async function setup(model = scriptedModel()) {
  const world = await inProcessWorld({ workspaceDir: "temp" });
  const h = await createHarness({ world, model, sleep: noSleep });
  return { ...h, world, model };
}

async function run(k: Kernel, employeeId: string, text: string) {
  await k.send(employeeId, text);
  await k.settled();
}

const batch = (w: World) => w.kaveri!.state.batches[0]!;
const line = (w: World, id: string) => batch(w).lines.find((l) => l.id === id)!;
const lastMessage = (k: Kernel) => k.log.ofType("message.posted").at(-1)!.payload.text;
const taskOf = (k: Kernel) => [...k.runs.values()].at(-1)!.task;

describe("tier 1: a whole playbook (pre-payment integrity check, 65 lines)", () => {
  it("catches every planted trap, clears the rest, and the verifier agrees", async () => {
    const { kernel, employee, world, model } = await setup();
    await run(kernel, employee.id, "Run the integrity check on this week's payment batch");

    expect(taskOf(kernel).status).toBe("done");
    expect(taskOf(kernel).tier).toBe(1);
    const held = batch(world).lines.filter((l) => l.status === "held").map((l) => l.id);
    expect(held.sort()).toEqual(["PL-03", "PL-08", "PL-10", "PL-11"]); // T-BANK-1, T-DUP, T-INACTIVE, T-DEBARRED, and no false alarms
    expect(line(world, "PL-05").tds).toBe(1560); // T-TDS: 2% → 1% for an individual
    expect(line(world, "PL-13")).toMatchObject({ tds: 0, status: "cleared" }); // T-NO-TDS
    expect(batch(world).lines.filter((l) => l.status === "pending")).toHaveLength(0);
    expect(batch(world).status).toBe("draft"); // never released
    expect(lastMessage(kernel)).toContain("MSME payments due now");
    expect(lastMessage(kernel)).toContain("Tunga Electricals"); // T-MSME

    const verification = kernel.log.ofType("verification.completed").at(-1)!.payload.results;
    expect(verification.every((r) => r.verdict === "pass")).toBe(true);
    expect(model.calls.map((c) => c.purpose)).toEqual(["route"]); // the 390 checks cost zero model calls
    expect(existsSync(join(world.workspaceDir, "Payments/W41/Integrity check PB-2026-W41.md"))).toBe(true);
    const orient = kernel.log.ofType("orient.completed")[0]!.payload;
    expect(orient.found.map((f) => f.ref)).toContain("email:msg_018");
  });

  it("degrades gracefully: with the model down it still routes a clear request by keywords", async () => {
    const down = new ScriptedModel([
      {
        purpose: "route",
        reply: () => {
          throw new ModelError("quota", "budget used up");
        },
      },
    ]);
    const { kernel, employee, world } = await setup(down);
    await run(kernel, employee.id, "Run the pre-payment integrity check on the payment batch");
    expect(taskOf(kernel).status).toBe("done");
    expect(batch(world).lines.filter((l) => l.status === "held")).toHaveLength(4);
    expect(kernel.log.ofType("message.posted").some((m) => m.payload.text.includes("matched your request"))).toBe(true);
  });
});

describe("tier 2: only part of a playbook", () => {
  it('"just the TDS" runs only the TDS step: corrects PL-05, clears nothing', async () => {
    const { kernel, employee, world } = await setup();
    await run(kernel, employee.id, "Recheck the TDS on the W41 batch");
    const plan = [...kernel.runs.values()][0]!.plan!;
    expect(plan.steps.map((s) => s.id)).toEqual(["tds"]);
    expect(taskOf(kernel).tier).toBe(2);
    expect(line(world, "PL-05")).toMatchObject({ tds: 1560, status: "corrected" });
    expect(batch(world).lines.filter((l) => l.status === "cleared")).toHaveLength(0);
  });

  it('"only the GSTINs" adds the steps GSTIN depends on (Docs, Extract) and stops there', async () => {
    const { kernel, employee, world } = await setup();
    await run(kernel, employee.id, "Only check the GSTINs of the T-14 bidders");
    const plan = [...kernel.runs.values()][0]!.plan!;
    expect(plan.steps.map((s) => s.id)).toEqual(["collect", "extract", "gstin"]);
    expect(plan.cells.A!.gstin!.state).toBe("done");
    expect(plan.cells.B!.gstin!.state).toBe("needs_you"); // T-PAN: PAN card ≠ PAN inside GSTIN
    expect(kernel.pendingApprovals()[0]!.toolCall?.tool).toBe("mail.send");
    expect(world.kaveri!.state.vendors.filter((v) => v.createdBy.startsWith("agent:"))).toHaveLength(0);
    // Documents were collected from two systems into the workspace.
    expect(existsSync(join(world.workspaceDir, "Vendor Desk/Bidders/Nandi Roadways LLP/Bid_Form_Nandi_Roadways.pdf"))).toBe(true);
    expect(existsSync(join(world.workspaceDir, "Vendor Desk/Bidders/Nandi Roadways LLP/Cancelled_Cheque_HDFC.pdf"))).toBe(true);
  });
});

describe("tier 1 with approvals: empanelment (maker-checker)", () => {
  it("activates only after your approval, parks the PAN mismatch, escalates the employee conflict", async () => {
    const { kernel, employee, world } = await setup();
    await run(kernel, employee.id, "Empanel the three bidders who qualified on T-2026-14");

    // A reaches activation; B is parked at GSTIN; C stops at the conflict-of-interest check.
    let titles = kernel.pendingApprovals().map((a) => a.title);
    expect(titles).toEqual([
      "Activate vendor Nandi Roadways LLP (V-161)",
      expect.stringContaining("Send Vrishabha Earthmovers an email"),
      "Possible conflict of interest: Sri Lakshmi Buildcon",
    ]);
    expect(world.kaveri!.state.vendors.find((v) => v.id === "V-161")!.status).toBe("pending");
    // The proprietor's personal account is accepted with a soft question, not rejected (T-PROPRIETOR).
    expect(kernel.log.ofType("question.asked").some((q) => q.payload.text.includes("proprietor") && !q.payload.blocking)).toBe(true);

    for (const a of kernel.pendingApprovals()) await kernel.command({ type: "resolve_approval", approvalId: a.id, decision: a.title.startsWith("Possible") ? "rejected" : "approved" });
    await kernel.settled();

    const a = world.kaveri!.state.vendors.find((v) => v.id === "V-161")!;
    expect(a).toMatchObject({ status: "active", createdBy: "agent:emp_1", approvedBy: "user:you" });
    expect(world.kaveri!.state.mail.find((m) => m.folder === "sent" && m.to === "office@vrishabhaearth.example")).toBeTruthy();
    expect(world.kaveri!.state.vendors.some((v) => /Lakshmi Buildcon/.test(v.legalName))).toBe(false); // rejected at the conflict: never created
    titles = kernel.pendingApprovals().map((x) => x.title);
    expect(titles).toEqual([]);
    expect(taskOf(kernel).status).toBe("done");
    expect(kernel.log.ofType("verification.completed").at(-1)!.payload.results.every((r) => r.verdict === "pass")).toBe(true);
  });
});

describe("tier 3: adjacent tasks with no playbook (composed plans)", () => {
  it("EMD guarantees: composes a plan from tools and flags the fake guarantee", async () => {
    const { kernel, employee, model } = await setup();
    await run(kernel, employee.id, "Confirm the EMD guarantees of the T-2026-14 bidders with the banks");
    const plan = [...kernel.runs.values()][0]!.plan!;
    expect(plan.items.map((i) => i.id)).toEqual(["PBG/HDFC/2026/88123", "PBG/ICICI/2026/55120", "PBG/SBI/2026/40917"]);
    const flagged = plan.items.filter((i) => plan.cells[i.id]!.verify!.note?.startsWith("⚑"));
    expect(flagged.map((i) => i.label)).toEqual(["Sri Lakshmi Buildcon"]); // T-FAKE-BG
    expect(model.calls.map((c) => c.purpose)).toEqual(["route", "compose", "summary"]);
    expect(taskOf(kernel)).toMatchObject({ status: "done", tier: 3 });
  });

  it("dormant vendor review: read-only, many items, no extra model calls per item", async () => {
    const { kernel, employee, model } = await setup();
    await run(kernel, employee.id, "Which vendors are dormant? List the ones we haven't paid in six months");
    const plan = [...kernel.runs.values()][0]!.plan!;
    expect(plan.items.length).toBeGreaterThan(30);
    expect(model.calls).toHaveLength(3);
    const writes = kernel.log.ofType("tool.called").filter((e) => /hold|clear|correct|create|activate|send|save/.test(e.payload.tool));
    expect(writes).toHaveLength(0);
    expect(lastMessage(kernel)).toMatch(/flagged/);
  });

  it("refuses work outside the role's scope without touching anything", async () => {
    const { kernel, employee } = await setup();
    await run(kernel, employee.id, "Write me a poem about roads");
    expect(taskOf(kernel).status).toBe("cancelled");
    expect(lastMessage(kernel)).toContain("outside my role");
    expect(kernel.log.ofType("tool.called").filter((e) => !/search|list|get/.test(e.payload.tool))).toHaveLength(0);
  });
});

describe("mid-work conversation (the two lanes)", () => {
  it("a steer sent while a line is mid-check is honoured at the gateway: no write to that vendor after it", async () => {
    const { kernel, employee, world } = await setup();
    let sent = false;
    kernel.log.subscribe((e: TheseusEvent) => {
      // Malnad Transport's line PL-06 would normally be cleared; nudge exactly as its last step starts.
      if (!sent && e.type === "plan.patched" && e.payload.patch.op === "set_cell" && e.payload.patch.itemId === "PL-06" && e.payload.patch.stepId === "decide" && e.payload.patch.state === "running") {
        sent = true;
        void kernel.send(employee.id, "Hold everything to Malnad Transport, it's under dispute");
      }
    });
    await run(kernel, employee.id, "Run the integrity check on this week's payment batch");
    await kernel.settled();

    expect(line(world, "PL-06").status).toBe("held");
    expect(line(world, "PL-06").note).toContain("Malnad");
    const c = kernel.log.ofType("constraint.added")[0]!;
    expect(c.payload.subjects).toContain("vendor:V-105");
    // Property: after the constraint, no non-protective write touched PL-06.
    const after = kernel.log.events.filter((e) => e.seq > c.seq && e.type === "tool.called") as Extract<TheseusEvent, { type: "tool.called" }>[];
    const okWrites = after.filter((e) => /clear_line|correct_line/.test(e.payload.tool) && (e.payload.input as { lineId?: string }).lineId === "PL-06");
    const completed = new Map(kernel.log.ofType("tool.completed").map((e) => [e.payload.callId, e.payload.ok]));
    expect(okWrites.filter((e) => completed.get(e.payload.callId))).toHaveLength(0);
    // The step was already running: its clear_line call was refused at the gateway, mid-step.
    expect(kernel.log.ofType("tool.completed").some((e) => e.payload.error?.message.startsWith("Blocked by your instruction"))).toBe(true);
    expect(kernel.log.ofType("nudge.triaged")[0]!.payload).toMatchObject({ kind: "steer", by: "rules" });
    // Everything else still finished: pausing is the worst case, not the default.
    expect(taskOf(kernel).status).toBe("done");
    expect(batch(world).lines.filter((l) => l.status === "pending")).toHaveLength(0);
  });

  it("answers a status question from the plan without a model call and without stopping", async () => {
    const { kernel, employee, model } = await setup();
    let asked = false;
    kernel.log.subscribe((e) => {
      if (!asked && e.type === "plan.patched" && e.payload.patch.op === "set_cell" && e.payload.patch.itemId === "PL-10" && e.payload.patch.state === "running") {
        asked = true;
        void kernel.send(employee.id, "How far are you?");
      }
    });
    await run(kernel, employee.id, "Run the integrity check on this week's payment batch");
    const ack = kernel.log.ofType("nudge.acknowledged")[0]!.payload.response;
    expect(ack).toMatch(/\d+\/65 payment lines finished/);
    expect(model.calls.map((c) => c.purpose)).toEqual(["route"]);
    expect(taskOf(kernel).status).toBe("done");
  });

  it("pause and resume", async () => {
    const { kernel, employee } = await setup();
    let paused = false;
    kernel.log.subscribe((e) => {
      if (!paused && e.type === "plan.patched" && e.payload.patch.op === "set_cell" && e.payload.patch.itemId === "PL-04" && e.payload.patch.state === "running") {
        paused = true;
        void kernel.send(employee.id, "pause");
      }
    });
    await kernel.send(employee.id, "Run the integrity check on this week's payment batch");
    await kernel.settled();
    const t = taskOf(kernel);
    expect(t.status).not.toBe("done");
    expect(kernel.employees.get(employee.id)!.employee.status).toBe("paused");
    await kernel.send(employee.id, "resume");
    await kernel.settled();
    expect(taskOf(kernel).status).toBe("done");
  });
});
