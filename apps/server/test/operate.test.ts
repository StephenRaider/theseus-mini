import { existsSync } from "node:fs";
import { join } from "node:path";
import type { Kernel } from "@theseus/core";
import { afterEach, describe, expect, it } from "vitest";
import { createHarness } from "../src/harness.ts";
import { scriptedModel } from "../src/scripted.ts";
import { inProcessWorld } from "../src/world.ts";

/**
 * Computer use, end to end: the real kernel drives a REAL Chromium through
 * FinDesk, the legacy AP register that has no API. Mail, files, the browser,
 * the gateway's risk tiers and approvals, evidence-bound memory and the
 * verifier are all real; only the model's answers come from a small reactive
 * policy (scripted-operate.ts) that reads each page the kernel shows it.
 */
const ASK = "Find the latest invoice from Hoysala Steel, extract the amount and due date, enter it into FinDesk and tell me once it's done";
const noSleep = async () => {};
let cleanup: (() => Promise<void>) | undefined;
afterEach(async () => {
  await cleanup?.();
  cleanup = undefined;
});

async function setup(opts: { approve?: "approved" | "rejected"; stepDelayMs?: number } = {}) {
  const world = await inProcessWorld({ workspaceDir: "temp", listen: true });
  const h = await createHarness({ world, model: scriptedModel(), sleep: noSleep, browser: true, ...(opts.stepDelayMs ? { stepDelayMs: opts.stepDelayMs } : {}) });
  cleanup = h.close;
  if (opts.approve)
    h.kernel.log.subscribe((e) => {
      if (e.type === "approval.requested") setTimeout(() => void h.kernel.command({ type: "resolve_approval", approvalId: e.payload.id, decision: opts.approve! }), 0);
    });
  return { ...h, world };
}

/** Send the request and wait until the task is over (approvals decided along the way count as waiting). */
async function run(k: Kernel, employeeId: string, text: string) {
  await k.send(employeeId, text);
  for (let i = 0; i < 1000; i++) {
    await k.settled();
    if (["done", "failed", "cancelled"].includes(taskOf(k).status)) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error(`task still ${taskOf(k).status}`);
}
const taskOf = (k: Kernel) => [...k.runs.values()].at(-1)!.task;
const lastMessage = (k: Kernel) => k.log.ofType("message.posted").at(-1)!.payload.text;
const booked = (w: Awaited<ReturnType<typeof inProcessWorld>>) => w.kaveri!.state.apInvoices.find((i) => i.number === "HSF/2026/0447");

describe("operate mode: the brief's example, done in a real browser", () => {
  it("finds the latest invoice, reads the PDF, enters it in FinDesk, and the verifier re-reads it fresh", async () => {
    const { kernel, employee, world } = await setup();
    await run(kernel, employee.id, ASK);

    expect(taskOf(kernel).status).toBe("done");
    // The world changed for real, through the web form, as the agent.
    expect(booked(world)).toMatchObject({ vendorId: "V-103", invoiceDate: "2026-10-03", dueDate: "2026-11-02", taxable: 362000, gst: 65160, total: 427160, status: "draft", enteredBy: "agent:emp_1" });
    // It picked the LATEST invoice (msg_031), not the older one that was already booked.
    const facts = kernel.log.ofType("evidence.added").filter((e) => e.payload.kind === "text").map((e) => e.payload.summary);
    expect(facts).toEqual(expect.arrayContaining(["invoice_email: msg_031", "invoice_total: 4,27,160.00", "due_date: 02/11/2026", "findesk_doc: AP-2026-0100"]));
    // Browser actions went through the gateway; the save click was judged a write (screenshots before/after).
    const calls = kernel.log.ofType("tool.called").map((c) => c.payload.tool);
    expect(calls).toEqual(expect.arrayContaining(["mail.search", "mail.download_attachment", "files.read_text", "browser.open", "browser.fill_form", "browser.click"]));
    const shots = kernel.log.ofType("evidence.added").filter((e) => e.payload.kind === "screenshot");
    expect(shots.length).toBeGreaterThanOrEqual(2);
    expect(existsSync(join(world.workspaceDir, shots[0]!.payload.ref!))).toBe(true);
    // The verifier: facts re-read from their sources + the FinDesk record opened fresh.
    const v = kernel.log.ofType("verification.completed").at(-1)!.payload.results;
    expect(v.every((r) => r.verdict === "pass")).toBe(true);
    expect(v.map((r) => r.detail).join(" ")).toMatch(/fresh browser\.open .*AP-2026-0100.* shows HSF\/2026\/0447, 427160, 02\/11\/2026/);
    const msg = lastMessage(kernel);
    expect(msg).toContain("AP-2026-0100");
    expect(msg).toContain("Verifier: all");
    // The grid: one row per subgoal, each with its proof.
    const plan = kernel.log.ofType("plan.created").at(-1)!.payload;
    expect(plan.steps.map((s) => s.title)).toEqual(["Do", "Proof"]);
  }, 60_000);

  it("posting is irreversible: it waits for your approval, then the same click runs", async () => {
    const { kernel, employee, world } = await setup({ approve: "approved" });
    await run(kernel, employee.id, `${ASK.replace(" and tell me", ", post it to the ledger and tell me")}`);
    const apr = kernel.log.ofType("approval.requested").at(-1)!.payload;
    expect(apr.title).toMatch(/Click "Post to ledger" on .*posting makes the invoice a payable/);
    expect(apr.diff.map((d) => d.field)).toContain("Page");
    expect(booked(world)).toMatchObject({ status: "posted", postedBy: "agent:emp_1" });
    expect(taskOf(kernel).status).toBe("done");
  }, 60_000);

  it("if you reject the posting, it stays a draft and the report says so", async () => {
    const { kernel, employee, world } = await setup({ approve: "rejected" });
    await run(kernel, employee.id, `${ASK.replace(" and tell me", ", post it to the ledger and tell me")}`);
    expect(booked(world)?.status).toBe("draft");
    expect(lastMessage(kernel)).toMatch(/Still open:[\s\S]*Post it to the ledger/);
  }, 60_000);

  it("recovers from an expired session and a 503 on save by looking at the page again", async () => {
    const { kernel, employee, world } = await setup();
    world.kaveri!.setFaults({ failNext: { "ap.session_expired": 1, "findesk.save_invoice": 1 } });
    await run(kernel, employee.id, ASK);
    expect(booked(world)).toMatchObject({ total: 427160, status: "draft" });
    expect(world.kaveri!.state.apInvoices.filter((i) => i.number === "HSF/2026/0447")).toHaveLength(1); // no double booking
    const seen = kernel.log.ofType("tool.completed").map((c) => (c.payload.ok ? c.payload.preview : "")).join(" ");
    expect(seen).toMatch(/expired/i);
    expect(taskOf(kernel).status).toBe("done");
  }, 60_000);

  it("a standing instruction blocks a browser click that would touch that vendor", async () => {
    const { kernel, employee, world } = await setup();
    kernel.gateway.addConstraint({ id: "con_t", employeeId: employee.id, text: "hold everything to Hoysala", subjects: ["vendor:V-103"], itemIds: [], blocks: "writes" });
    await run(kernel, employee.id, ASK);
    expect(booked(world)).toBeUndefined();
    const plan = [...kernel.runs.values()].at(-1)!;
    expect(plan.plan!.items.find((i) => i.id === "s4")?.held).toBe(true);
    expect(lastMessage(kernel)).toMatch(/hold everything to Hoysala/);
  }, 60_000);

  it("a message sent while it works reaches its very next decision, without stopping it", async () => {
    const { kernel, employee, world } = await setup({ stepDelayMs: 30 });
    const model = (kernel as unknown as { opts: { model: { calls: { purpose: string; prompt: string }[] } } }).opts.model;
    await kernel.send(employee.id, ASK);
    const t0 = Date.now();
    while (!kernel.log.ofType("tool.called").some((c) => c.payload.tool === "browser.open")) {
      if (Date.now() - t0 > 20_000) throw new Error("never opened the browser");
      await new Promise((r) => setTimeout(r, 5));
    }
    await kernel.send(employee.id, "FYI the remarks should mention it came by email");
    await run(kernel, employee.id, "how far are you?");
    const after = model.calls.filter((c) => c.purpose === "operate.step" && c.prompt.includes("MESSAGES FROM YOUR MANAGER"));
    expect(after.length).toBeGreaterThan(0);
    expect(after[0]!.prompt).toContain("- FYI the remarks should mention it came by email");
    expect(booked(world)?.status).toBe("draft");
  }, 60_000);
});
