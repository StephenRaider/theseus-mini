import { THESEUS_ID, itemStatus, summarize } from "@theseus/protocol";
import { describe, expect, it } from "vitest";
import { DEMO_DATA } from "../src/replay/demo-data.ts";
import { ReplayEngine, type FilesAdapter } from "../src/replay/engine.ts";
import { E1, E2, TASK_BATCH, TASK_EMP, kaveriDemo } from "../src/replay/kaveri-demo.ts";
import { badges, sidebarPreview } from "../src/state/selectors.ts";
import { demoDataFromSeed } from "./demo-source.ts";

const pendingFor = (eng: ReplayEngine, taskId: string) =>
  Object.values(eng.state.approvals).filter((a) => a.status === "pending" && a.taskId === taskId);

function approveAll(eng: ReplayEngine, decide: (title: string) => "approved" | "rejected" = () => "approved") {
  for (let guard = 0; guard < 20; guard++) {
    eng.runToIdle();
    const pending = Object.values(eng.state.approvals).filter((a) => a.status === "pending");
    if (!pending.length) return;
    for (const a of pending) eng.send({ type: "resolve_approval", approvalId: a.id, decision: decide(a.title) });
  }
}

describe("demo data", () => {
  it("matches the Kaveri seed (regenerate with pnpm --filter @theseus/web gen:demo)", () => {
    expect(DEMO_DATA).toEqual(demoDataFromSeed());
  });
});

describe("replay engine", () => {
  it("starts with history: Theseus and Employee 1, older chats, nothing running", () => {
    const eng = new ReplayEngine(kaveriDemo());
    expect(eng.state.employeeOrder).toEqual([THESEUS_ID, E1]);
    expect(eng.state.messages[THESEUS_ID]!.length).toBe(4);
    expect(sidebarPreview(eng.state, E1, eng.now)).toMatchObject({ kind: "message", hasAttachment: true });
  });

  it("delegates, runs both tasks to completion with the expected outcomes", async () => {
    const written: string[] = [];
    const files: FilesAdapter = { writeNew: async (_root, rel) => (written.push(rel), rel) };
    const eng = new ReplayEngine(kaveriDemo(), files);
    eng.kickoff();
    eng.advance(10_000);
    expect(eng.state.employeeOrder).toEqual([THESEUS_ID, E1, E2]);
    expect(sidebarPreview(eng.state, E2, eng.now).kind).toBe("working");

    // Approve the activation + PAN email; reject the conflict; confirm both call-backs.
    approveAll(eng, (t) => (t.startsWith("Possible conflict") ? "rejected" : "approved"));
    await new Promise((r) => setTimeout(r, 0));
    eng.runToIdle();

    const emp = eng.state.plans[TASK_EMP]!;
    expect(itemStatus(emp, "A")).toBe("done");
    expect(itemStatus(emp, "B")).toBe("held");
    expect(itemStatus(emp, "C")).toBe("failed");

    const batch = eng.state.plans[TASK_BATCH]!;
    expect(batch.items[0]!.id).toBe("PL-02"); // MSME priority moved to the top
    for (const id of ["PL-08", "PL-10", "PL-11"]) expect(itemStatus(batch, id)).toBe("held");
    expect(summarize(batch)).toMatchObject({ done: 62, held: 3, failed: 0 });
    expect(eng.state.tasks[TASK_BATCH]!.status).toBe("done");
    expect(written).toEqual([
      "Vendor Desk/Bidders/T-2026-14 check results.csv",
      "Payments/W41/PB-2026-W41_bank_upload.csv",
      "Payments/W41/PB-2026-W41 check results.csv",
    ]);
    // Final reports and Theseus's roll-up.
    const last = eng.state.messages[E2]!.at(-1)!;
    expect(last.text).toMatch(/62 cleared .* 3 held, 1 corrected/);
    expect(last.attachments.map((a) => a.name)).toContain("PB-2026-W41_bank_upload.csv");
    expect(eng.state.messages[THESEUS_ID]!.at(-1)!.text).toMatch(/Both jobs are finished/);
    expect(sidebarPreview(eng.state, E2, eng.now)).toMatchObject({ kind: "completed" });
  });

  it("skip-and-continue: items waiting on you never block the rest", () => {
    const eng = new ReplayEngine(kaveriDemo());
    eng.kickoff();
    eng.runToIdle();
    const b = badges(eng.state, E2, 0);
    expect(b.needsYou).toBe(2); // two call-backs
    expect(eng.state.employees[E2]!.status).toBe("waiting_on_user");
    const s = summarize(eng.state.plans[TASK_BATCH]!);
    expect(s.needs_you).toBe(2);
    expect(s.done).toBe(60); // everything else finished meanwhile
    expect(sidebarPreview(eng.state, E2, eng.now)).toMatchObject({ kind: "waiting" });
  });

  it("a nudge to hold a vendor is acknowledged and applied", () => {
    const eng = new ReplayEngine(kaveriDemo());
    eng.kickoff();
    eng.advance(15_000);
    eng.send({ type: "send_message", threadId: E2, text: "Hold everything to Shree Ganesh, it's under dispute.", attachments: [] });
    eng.advance(5_000);
    const plan = eng.state.plans[TASK_BATCH]!;
    expect(plan.items.find((i) => i.id === "PL-03")!.held).toBe(true);
    const nudge = Object.values(eng.state.nudges)[0]!;
    expect(nudge.ack?.response).toMatch(/PL-03 · Shree Ganesh Constructions on hold/);
  });

  it("user skip / hold / retry from the grid change what runs next", () => {
    const eng = new ReplayEngine(kaveriDemo());
    eng.kickoff();
    eng.advance(10_000);
    eng.send({ type: "cell_action", taskId: TASK_BATCH, itemId: "PL-60", action: "skip" });
    eng.send({ type: "cell_action", taskId: TASK_BATCH, itemId: "PL-61", action: "hold" });
    approveAll(eng);
    let plan = eng.state.plans[TASK_BATCH]!;
    expect(itemStatus(plan, "PL-60")).toBe("skipped");
    expect(itemStatus(plan, "PL-61")).toBe("held");
    // Release a held item after the task finished: it is picked up again and cleared.
    eng.send({ type: "cell_action", taskId: TASK_BATCH, itemId: "PL-61", action: "release" });
    eng.runToIdle();
    plan = eng.state.plans[TASK_BATCH]!;
    expect(itemStatus(plan, "PL-61")).toBe("done");
    // Retry the failed EMD for bidder C (e.g. after the bank re-confirms): passes the second time.
    approveAll(eng);
    eng.send({ type: "cell_action", taskId: TASK_EMP, itemId: "C", action: "retry" });
    approveAll(eng);
    expect(itemStatus(eng.state.plans[TASK_EMP]!, "C")).toBe("done");
  });

  it("pause stops new work; resume continues", () => {
    const eng = new ReplayEngine(kaveriDemo());
    eng.kickoff();
    eng.advance(12_000);
    eng.send({ type: "task_control", taskId: TASK_BATCH, action: "pause" });
    eng.advance(5_000); // let the in-flight cell finish
    const before = eng.state.plans[TASK_BATCH]!.version;
    eng.advance(60_000);
    expect(eng.state.plans[TASK_BATCH]!.version).toBe(before);
    expect(badges(eng.state, E2, 99).warnings).toBeGreaterThanOrEqual(1);
    eng.send({ type: "task_control", taskId: TASK_BATCH, action: "resume" });
    eng.advance(10_000);
    expect(eng.state.plans[TASK_BATCH]!.version).toBeGreaterThan(before);
  });
});

describe("nudge matching", () => {
  it("matches single-letter item ids only as whole words", () => {
    const eng = new ReplayEngine(kaveriDemo());
    eng.kickoff();
    eng.advance(15_000);
    eng.send({ type: "send_message", threadId: E1, text: "Please skip bidder B for now", attachments: [] });
    eng.advance(5_000);
    const plan = eng.state.plans[TASK_EMP]!;
    expect(plan.items.find((i) => i.id === "B")!.skipReason).toBeDefined();
    expect(plan.items.find((i) => i.id === "A")!.skipReason).toBeUndefined();
    expect(plan.items.find((i) => i.id === "C")!.skipReason).toBeUndefined();
  });
});
