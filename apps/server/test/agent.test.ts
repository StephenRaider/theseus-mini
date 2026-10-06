import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { inflateRawSync } from "node:zlib";
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

/** One file out of a .docx (a zip), with no extra dependency. */
function zipEntry(zip: Buffer, name: string): string {
  for (let i = 0; i < zip.length - 30; ) {
    if (zip.readUInt32LE(i) !== 0x04034b50) break;
    const method = zip.readUInt16LE(i + 8);
    const size = zip.readUInt32LE(i + 18);
    const nameLen = zip.readUInt16LE(i + 26);
    const extra = zip.readUInt16LE(i + 28);
    const entry = zip.toString("utf8", i + 30, i + 30 + nameLen);
    const start = i + 30 + nameLen + extra;
    const body = zip.subarray(start, start + size);
    if (entry === name) return (method === 8 ? inflateRawSync(body) : body).toString("utf8");
    i = start + size;
  }
  throw new Error(`${name} not found in zip`);
}

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
/** Wait for real progress (not wall-clock guesses): timers are coarser on Windows. */
async function until(k: Kernel, itemId: string, ms = 20000) {
  const t0 = Date.now();
  while (!k.log.ofType("tool.called").some((c) => c.payload.itemId === itemId)) {
    if (Date.now() - t0 > ms) throw new Error(`never reached ${itemId}`);
    await new Promise((r) => setTimeout(r, 5));
  }
}
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
    expect(ack).toMatch(/\d+\/65 payment lines checked \(\d+ done/);
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

describe("composed plans that read the wrong data (what a weak model does)", () => {
  // "Which vendors haven't been paid in 3 months": the truth, computed straight from the world.
  const truth = (w: World) => {
    const s = w.kaveri!.state;
    const last = new Map<string, string>();
    for (const b of s.paidBills) if ((last.get(b.vendorId) ?? "") < b.paidOn) last.set(b.vendorId, b.paidOn);
    const cutoff = Date.parse("2026-10-07T00:00:00Z") - 90 * 86_400_000;
    return s.vendors.filter((v) => !last.has(v.id) || Date.parse(`${last.get(v.id)}T00:00:00Z`) < cutoff).length;
  };
  const program = (flagIf: unknown[]) => ({
    title: "Vendors not paid in 3 months",
    itemKind: "vendor",
    items: { tool: "vendor.search", args: { q: "" }, listPath: "vendors", idPath: "id", labelTemplate: "{{item.legalName}}" },
    steps: [{ id: "bills", title: "Paid bills", tool: "payments.paid_bills", args: { vendorId: "{{item.id}}" }, flagIf, flagNote: "Not paid in 3 months" }],
    columns: [{ title: "Vendor", path: "item.legalName" }],
  });
  const good = program([{ path: "steps.bills.bills[].paidOn", agg: "max", op: "days_ago_gt", value: "3 months" }]);

  it("a trial run catches a field that doesn't exist; the fixed plan gives the right answer", async () => {
    const broken = program([{ path: "steps.bills.payments[].date", agg: "max", op: "days_ago_lt", value: "90" }]);
    const model = scriptedModel([
      { purpose: "compose", times: 1, reply: broken },
      { purpose: "compose", match: /doesn't exist in the data[\s\S]*REALLY RETURNED[\s\S]*paidOn/, reply: good },
    ]);
    const { kernel, employee, world } = await setup(model);
    await run(kernel, employee.id, "Which vendors haven't been paid in 3 months?");
    const msgs = kernel.log.ofType("message.posted").map((m) => m.payload.text);
    expect(msgs.some((t) => t.includes("trial run"))).toBe(true);
    expect(model.calls.filter((c) => c.purpose === "compose")).toHaveLength(2);
    const flagged = [...kernel.runs.values()].at(-1)!.itemData;
    const n = [...flagged.values()].filter((d) => d.flags?.length).length;
    expect(n).toBe(truth(world));
    expect(n).toBeGreaterThan(40);
    expect(taskOf(kernel).assumptions?.some((a) => a.includes('"3 months" as 90 days'))).toBe(true);
    const verify = kernel.log.ofType("verification.completed").at(-1)!.payload.results;
    expect(verify.every((r) => r.verdict === "pass")).toBe(true);
    expect(verify.some((r) => r.detail.startsWith("A fresh re-read agrees"))).toBe(true);
  });

  it("a list without agg is sent back to be fixed", async () => {
    const model = scriptedModel([
      { purpose: "compose", times: 1, reply: program([{ path: "steps.bills.bills[].paidOn", op: "days_ago_gt", value: "90" }]) },
      { purpose: "compose", match: /is a list; add agg/, reply: good },
    ]);
    const { kernel, employee, world } = await setup(model);
    await run(kernel, employee.id, "Which vendors haven't been paid in 3 months?");
    expect(taskOf(kernel).status).toBe("done");
    expect([...[...kernel.runs.values()].at(-1)!.itemData.values()].filter((d) => d.flags?.length).length).toBe(truth(world));
  });

  it("if the model can't produce a working plan, it stops instead of answering wrongly", async () => {
    const broken = program([{ path: "steps.bills.nothing", op: "eq", value: "x" }]);
    const model = scriptedModel([{ purpose: "compose", reply: broken }]);
    const { kernel, employee } = await setup(model);
    await run(kernel, employee.id, "Which vendors haven't been paid in 3 months?");
    expect(taskOf(kernel).status).toBe("failed");
    expect(lastMessage(kernel)).toMatch(/rather than give you a wrong answer/);
    expect(model.calls.filter((c) => c.purpose === "compose")).toHaveLength(3);
  });

  it("'a while' where a number of days belongs, or a step that doesn't exist, is rejected before anything runs", async () => {
    const { validateProgram, normalizeProgram, toDays } = await import("@theseus/core");
    const tools = { has: () => true, get: () => ({ risk: "read" }) };
    expect(validateProgram(program([{ path: "steps.bills.bills[].paidOn", agg: "max", op: "days_ago_gt", value: "a while" }]) as never, tools)[0]).toMatch(/number of days/);
    expect(validateProgram(program([{ path: "steps.later.x", op: "eq", value: "1" }]) as never, tools)[0]).toMatch(/doesn't exist/);
    expect([toDays("3 months"), toDays("six weeks"), toDays("1 year"), toDays("90")]).toEqual([90, 42, 365, 90]);
    const p = program([{ path: "steps.bills.bills[].paidOn", agg: "max", op: "days_ago_gt", value: "three months" }]);
    expect(normalizeProgram(p as never).notes).toEqual(['read "three months" as 90 days']);
  });

  it("every new request gets an instant reply before any model call", async () => {
    const { kernel, employee, model } = await setup();
    const sent = kernel.send(employee.id, "Run the integrity check on this week's payment batch");
    const first = kernel.log.ofType("message.posted").filter((m) => m.payload.from.startsWith("employee:"))[0];
    expect(first?.payload.text).toMatch(/On it|Got it|Sure/);
    await sent;
    await kernel.settled();
    expect(model.calls.filter((c) => c.purpose === "route")).toHaveLength(1);
  });
});

describe("Jyotiraditya's first live chats (what went wrong, now pinned down)", () => {
  it('"what all work can you do, your skill sets?" is answered from the role pack: no model call, nothing run', async () => {
    const { kernel, employee, model } = await setup();
    await run(kernel, employee.id, "what all work can you do, give me your skill sets, whats the general workflow for your specialisation?");
    expect(model.calls).toHaveLength(0);
    expect(kernel.log.ofType("tool.called")).toHaveLength(0);
    expect(taskOf(kernel).status).toBe("done");
    expect(lastMessage(kernel)).toMatch(/Pre-payment|payment batch/i);
    expect(lastMessage(kernel)).toMatch(/waits for your OK/);
  });

  it('"Prepare a doc for Bhadra Concrete Works…" drafts a Word letter from the records; runs no playbook, sends nothing', async () => {
    const { kernel, employee, world } = await setup();
    await run(kernel, employee.id, "Prepare a doc to be sent to Bhadra Concrete Works and informing them about successful empanelment, make it a formal document");
    const t = taskOf(kernel);
    expect(t.status).toBe("done");
    expect(t.playbookId).toBeUndefined();
    const tools = kernel.log.ofType("tool.called").map((e) => e.payload.tool);
    expect(tools).toContain("files.save_docx");
    expect(tools).not.toContain("mail.send");
    expect(tools).not.toContain("vendor.activate");
    expect(kernel.pendingApprovals()).toHaveLength(0);
    const msg = kernel.log.ofType("message.posted").at(-1)!.payload;
    expect(msg.text).toMatch(/Nothing has been sent/);
    expect(msg.text).toMatch(/\[Ref\. No\.\]/);
    expect(msg.attachments[0]?.ref).toMatch(/^workspace:Drafts\/Empanelment letter - Bhadra Concrete Works\.docx$/);
    const path = join(world.workspaceDir, msg.attachments[0]!.ref.slice("workspace:".length));
    expect(existsSync(path)).toBe(true);
    const xml = zipEntry(readFileSync(path), "word/document.xml");
    expect(xml).toContain("Bhadra Concrete Works");
    expect(xml).not.toMatch(/\d{9,}/); // no bank account numbers in a letter
  });

  it("a letter to someone not in our records is not written (no made-up recipient)", async () => {
    const { kernel, employee, model } = await setup();
    await run(kernel, employee.id, "Prepare a letter to Zenith Polymers informing them about successful empanelment");
    expect(taskOf(kernel).status).toBe("failed");
    expect(lastMessage(kernel)).toMatch(/couldn't find "Zenith Polymers"/);
    expect(model.calls.filter((c) => c.purpose === "draft")).toHaveLength(0);
  });

  it("a named item that isn't in the job stops the run instead of doing every item", async () => {
    const model = scriptedModel([
      { purpose: "route", reply: { inScope: true, tier: 1, goal: "Empanel", playbookId: "onboard-contractor", params: { tenderId: "T-2026-14" }, itemFilter: ["Bhadra Concrete Works"], successCriteria: [], assumptions: [], questions: [], relevant: [] } },
    ]);
    const { kernel, employee } = await setup(model);
    await run(kernel, employee.id, "Empanel Bhadra Concrete Works");
    expect(taskOf(kernel).status).toBe("failed");
    expect(lastMessage(kernel)).toMatch(/isn't one of the items/);
    expect(kernel.pendingApprovals()).toHaveLength(0);
    expect(kernel.log.ofType("tool.called").map((e) => e.payload.tool)).not.toContain("vendor.create_pending");
  });

  const review = (dupArgs: Record<string, string>) => ({
    title: "Vendor review",
    itemKind: "vendor",
    items: { tool: "vendor.search", args: { q: "" }, listPath: "vendors", idPath: "id", labelTemplate: "{{item.legalName}}" },
    steps: [
      { id: "gst", title: "GST Status", tool: "gov.gstin_status", args: { gstin: "{{item.gstin}}" }, flagIf: [{ path: "steps.gst.status", op: "ne", value: "Active" }], flagNote: "GST not active" },
      { id: "dup", title: "Duplicates", tool: "match.find_duplicates", args: dupArgs, flagIf: [{ path: "steps.dup.candidates", agg: "count", op: "gt", value: "0" }], flagNote: "Possible duplicate" },
    ],
    columns: [{ title: "Vendor", path: "item.legalName" }],
  });
  const reviewRoute = { purpose: "route", reply: { inScope: true, tier: 3, goal: "Review vendors", successCriteria: [], assumptions: [], questions: [], relevant: [] } };

  it("vendors without a GSTIN are reported as 'couldn't check', and the verifier counts them as handled", async () => {
    const model = scriptedModel([reviewRoute, { purpose: "compose", reply: review({ name: "{{item.legalName}}", pan: "{{item.pan}}", excludeId: "{{item.id}}" }) }]);
    const { kernel, employee } = await setup(model);
    await run(kernel, employee.id, "Review the vendor master for GST and duplicates");
    const report = lastMessage(kernel);
    expect(report).toMatch(/Couldn't check 7:/);
    expect(report).toMatch(/no gstin on record/);
    const v = kernel.log.ofType("verification.completed").at(-1)!.payload.results;
    expect(v.find((r) => r.detail.startsWith("Every item was handled"))?.verdict).toBe("pass");
    // With excludeId nobody is their own duplicate: only real look-alikes remain.
    const flagged = [...[...kernel.runs.values()].at(-1)!.itemData.values()].filter((d) => d.flags?.length).length;
    expect(flagged).toBeLessThan(10);
  });

  it("a duplicate check that matches every vendor to itself is called out as implausible", async () => {
    const model = scriptedModel([reviewRoute, { purpose: "compose", reply: review({ name: "{{item.legalName}}", pan: "{{item.pan}}" }) }]);
    const { kernel, employee } = await setup(model);
    await run(kernel, employee.id, "Review the vendor master for GST and duplicates");
    const v = kernel.log.ofType("verification.completed").at(-1)!.payload.results;
    expect(v.find((r) => r.detail.startsWith("The result is plausible"))?.verdict).toBe("uncertain");
    expect(lastMessage(kernel)).toMatch(/Spot-check/);
  });

  it('"give me all info on Chitra Geotech Labs LLP" lists the details instead of "0 of 1 flagged"', async () => {
    const info = {
      title: "Vendor information",
      itemKind: "vendor",
      items: { tool: "vendor.search", args: { q: "Chitra Geotech" }, listPath: "vendors", idPath: "id", labelTemplate: "{{item.legalName}} ({{item.id}})" },
      steps: [{ id: "gst", title: "GST Check", tool: "gov.gstin_status", args: { gstin: "{{item.gstin}}" } }],
      columns: [{ title: "GSTIN", path: "item.gstin" }, { title: "GST status", path: "steps.gst.status" }, { title: "PAN", path: "item.pan" }],
    };
    const model = scriptedModel([reviewRoute, { purpose: "compose", reply: info }]);
    const { kernel, employee } = await setup(model);
    await run(kernel, employee.id, "check GST number account details etc for only Chitra Geotech Labs LLP, give me all info");
    const report = lastMessage(kernel);
    expect(report).toMatch(/Chitra Geotech Labs LLP \(V-\d+\): GSTIN: \w+ · GST status: Active · PAN: \w+/);
    expect(report).not.toMatch(/0 of 1 flagged/);
  });

  it("everything on Malnad: one route call, a full profile read live from every system", async () => {
    const { kernel, employee, model } = await setup();
    await run(kernel, employee.id, "Give me everything we have on Malnad Transport Co.");
    const report = lastMessage(kernel);
    expect(model.calls.map((c) => c.purpose)).toEqual(["route"]);
    expect(report).toMatch(/^Malnad Transport Co \(V-105\) · active/);
    for (const part of ["Address:", "Contact:", "PAN:", "GST portal: Active", "Bank:", "MSME:", "Debarment register: not listed", "Payments made:", "PB-2026-W41 PL-06"]) expect(report).toContain(part);
    expect(report).not.toMatch(/\bdone\b/);
  });

  it("asking about a line mid-run gets a plain sentence, not the grid's internals", async () => {
    const { kernel, employee } = await setup();
    const k = kernel as unknown as { opts: { stepDelayMs?: number } };
    k.opts.stepDelayMs = 2;
    const sent = kernel.send(employee.id, "Run the integrity check on this week's payment batch");
    await until(kernel, "PL-14");
    await kernel.send(employee.id, "why is deccan quarry works held?");
    const answer = kernel.log.ofType("message.posted").filter((m) => m.payload.from.startsWith("employee:")).at(-1)!.payload.text;
    expect(answer).toMatch(/^PL-11 · Deccan Quarry Works · ₹3,75,000 is held\. Deccan Quarry Works is on the debarment register/);
    expect(answer).not.toMatch(/pending/);
    await sent;
    await kernel.settled();
  }, 30000);

  it("a line skipped mid-run is reported as skipped and the verifier agrees", async () => {
    const { kernel, employee, world } = await setup();
    (kernel as unknown as { opts: { stepDelayMs?: number } }).opts.stepDelayMs = 2;
    const sent = kernel.send(employee.id, "Run the integrity check on this week's payment batch");
    await until(kernel, "PL-10");
    await kernel.send(employee.id, "skip garuda constructions");
    await sent;
    await kernel.settled();
    expect(line(world, "PL-56").status).toBe("pending");
    const report = lastMessage(kernel);
    expect(report).toMatch(/60 cleared \(1 after a TDS correction\) · 4 held · 1 skipped by you/);
    expect(report).toMatch(/Skipped, as you asked[\s\S]*PL-56 · Garuda Constructions/);
    expect(report).toMatch(/Verifier: all 3 checks passed/);
  }, 30000);

  it("no 'on it' before answering 'what can you do'", async () => {
    const { kernel, employee } = await setup();
    await run(kernel, employee.id, "Hey, what's your job here and what can you help me with?");
    const said = kernel.log.ofType("message.posted").filter((m) => m.payload.from.startsWith("employee:"));
    expect(said).toHaveLength(1);
    expect(said[0]!.payload.text).toMatch(/^I'm a Vendor & Contractor Integrity Specialist/);
  });

  it("a letter that states today's date as a fact gets a warning", async () => {
    const model = scriptedModel([
      {
        purpose: "draft",
        reply: { fileName: "Letter.docx", title: "Confirmation", blocks: [{ kind: "paragraph", text: "Bhadra Concrete Works was empanelled effective from 7 October 2026." }] },
      },
    ]);
    const { kernel, employee } = await setup(model);
    await run(kernel, employee.id, "Prepare a letter to Bhadra Concrete Works confirming their empanelment");
    expect(lastMessage(kernel)).toMatch(/today's date used in the text/);
  });
});
