import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { THESEUS_ID, type TheseusEvent } from "@theseus/protocol";
import { describe, expect, it } from "vitest";
import { AgentHost, managerIntent, type BrowserFrame } from "../src/host.ts";

/** The desktop app's agent host, driven exactly as the app drives it (commands in, events out). */
describe("agent host (what the desktop app talks to)", () => {
  it("Theseus delegates to an idle employee, hires a second one when busy, and reports back", async () => {
    const events: TheseusEvent[] = [];
    const host = await AgentHost.create({ mode: "demo", workspaceDir: await mkdtemp(join(tmpdir(), "theseus-host-")), onEvent: (e) => events.push(e), stepDelayMs: 0 });
    expect(host.info).toMatchObject({ mode: "demo", model: "scripted" });
    expect(events.filter((e) => e.type === "employee.created").map((e) => e.type === "employee.created" && e.payload.name)).toEqual(["Employee 1", "Theseus"]);

    await host.command({ type: "send_message", threadId: THESEUS_ID, text: "Only check the GSTINs of the T-14 bidders", attachments: [] });
    // Employee 1 is now waiting on an approval (the Vrishabha email), so a second request goes to a new hire.
    await host.kernel.settled();
    await host.command({ type: "send_message", threadId: THESEUS_ID, text: "Confirm the EMD guarantees of the T-2026-14 bidders with the banks", attachments: [] });
    await host.kernel.settled();

    const theseusSays = events.filter((e) => e.type === "message.posted" && e.payload.threadId === THESEUS_ID && e.payload.from === "theseus").map((e) => (e.type === "message.posted" ? e.payload.text : ""));
    expect(theseusSays.some((t) => t.startsWith("Handing this to Employee 1"))).toBe(true);
    expect(theseusSays.some((t) => t.startsWith("Handing this to Employee 2"))).toBe(true);
    expect(theseusSays.some((t) => /Employee 2 finished/.test(t))).toBe(true);
    // The request lands in the employee's own chat as a message from Theseus.
    expect(events.some((e) => e.type === "message.posted" && e.payload.threadId === "emp_1" && e.payload.from === "theseus")).toBe(true);

    // Approving from the app finishes Employee 1's task.
    const apr = host.kernel.pendingApprovals()[0]!;
    await host.command({ type: "resolve_approval", approvalId: apr.id, decision: "approved" });
    await host.kernel.settled();
    expect(theseusSays.length).toBeLessThan(events.filter((e) => e.type === "message.posted" && e.payload.threadId === THESEUS_ID && e.payload.from === "theseus").length);
    // Events are a gapless sequence (the UI relies on seq to merge snapshot + stream).
    expect(events.map((e) => e.seq)).toEqual(events.map((_, i) => i));
  });

  it("computer use: the app sees the employee's browser after every action", async () => {
    const frames: BrowserFrame[] = [];
    const host = await AgentHost.create({ mode: "demo", workspaceDir: await mkdtemp(join(tmpdir(), "theseus-host-")), onEvent: () => {}, onFrame: (f) => frames.push(f), stepDelayMs: 0 });
    try {
      // The first suggestion in the app is the brief's example: find an invoice, enter it in FinDesk.
      expect(host.info.suggestions[0]).toMatch(/latest invoice .* FinDesk/);
      await host.command({ type: "send_message", threadId: THESEUS_ID, text: host.info.suggestions[0]!, attachments: [] });
      for (let i = 0; i < 1000 && !host.kernel.log.ofType("task.status_changed").some((e) => e.payload.status === "done"); i++) await new Promise((r) => setTimeout(r, 10));
      expect(frames.length).toBeGreaterThan(3);
      expect(frames[0]).toMatchObject({ employeeId: "emp_1", title: "Sign in · Kaveri FinDesk 4.2" });
      expect(frames.at(-1)!.title).toMatch(/^AP-2026-0100/);
      expect(Buffer.from(frames.at(-1)!.jpeg, "base64").subarray(0, 2)).toEqual(Buffer.from([0xff, 0xd8])); // a real JPEG
    } finally {
      await host.close();
    }
  }, 60_000);

  it("Theseus handles team requests itself: hire, who's doing what, assign to a named employee", async () => {
    const events: TheseusEvent[] = [];
    const host = await AgentHost.create({ mode: "demo", workspaceDir: await mkdtemp(join(tmpdir(), "theseus-host-")), onEvent: (e) => events.push(e), stepDelayMs: 0 });
    const said = () => events.filter((e) => e.type === "message.posted" && e.payload.threadId === THESEUS_ID && e.payload.from === "theseus").map((e) => (e.type === "message.posted" ? e.payload.text : ""));
    await host.command({ type: "send_message", threadId: THESEUS_ID, text: "can you create 3 more employees for me please", attachments: [] });
    expect([...host.kernel.employees.values()].map((s) => s.employee.name)).toEqual(["Employee 1", "Employee 2", "Employee 3", "Employee 4"]);
    expect(said().at(-1)).toMatch(/Employee 2, Employee 3, Employee 4 have joined. You now have 4 employees/);
    expect(host.kernel.runs.size).toBe(0); // nobody was given "create employees" as a task

    await host.command({ type: "send_message", threadId: THESEUS_ID, text: "Ask Employee 3 to only check the GSTINs of the T-14 bidders", attachments: [] });
    await host.kernel.settled();
    const run = [...host.kernel.runs.values()].at(-1)!;
    expect(run.employeeId).toBe([...host.kernel.employees.values()].find((s) => s.employee.name === "Employee 3")!.employee.id);
    expect(run.task.request).toBe("only check the GSTINs of the T-14 bidders");

    await host.command({ type: "send_message", threadId: THESEUS_ID, text: "who's working on what?", attachments: [] });
    expect(said().at(-1)).toMatch(/Employee 1: free[\s\S]*Employee 3: waiting for you/);
    expect(said().at(-1)).toMatch(/approval/);
  });

  it("recognises team requests by rules, and leaves real work alone", () => {
    const names = ["Employee 1", "Employee 2"];
    expect(managerIntent("hire two more people", names)).toEqual({ kind: "hire", count: 2, capped: false });
    expect(managerIntent("add another employee", names)).toEqual({ kind: "hire", count: 1, capped: false });
    expect(managerIntent("create 20 employees", names)).toEqual({ kind: "hire", count: 5, capped: true });
    expect(managerIntent("what is everyone working on?", names).kind).toBe("team");
    expect(managerIntent("give this to Employee 2: recheck TDS on W41", names)).toEqual({ kind: "assign", employee: "Employee 2", text: "recheck TDS on W41" });
    expect(managerIntent("Run the integrity check on this week's payment batch", names).kind).toBe("work");
    expect(managerIntent("Add the new bank details for Malnad", names).kind).toBe("work");
    expect(managerIntent("Which vendors are MSMEs?", names).kind).toBe("work");
  });
});
