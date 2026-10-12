import type { Approval, TheseusEvent } from "@theseus/protocol";
import { createElement as h } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { BatchApprovals } from "../src/components/BatchApprovals.tsx";
import { Changes, PreviewPanel } from "../src/components/Changes.tsx";
import { Memory } from "../src/components/Memory.tsx";
import { Working } from "../src/components/Working.tsx";
import { emptyState, reduceAll, type AppState } from "../src/state/store.ts";
import { canUndo, effectsOfTask, groupApprovals, groupPreviews, linkReport, memoriesOf, titlePattern, toggleAll, workingRows, sourceTarget, describeEvidence } from "../src/state/trust.ts";

let seq = 0;
const ev = (type: string, payload: unknown, extra: Record<string, unknown> = {}) =>
  ({ id: `evt_${++seq}`, seq, ts: `2026-10-07T05:${String(seq % 60).padStart(2, "0")}:00.000Z`, actor: "system", ...extra, type, payload }) as unknown as TheseusEvent;

const T = "task_1";
const E = "emp_1";
const base = (): TheseusEvent[] => [
  ev("employee.created", { id: E, kind: "employee", name: "Employee 1", allowedTools: [], status: "idle", createdAt: "2026-10-07T05:00:00.000Z" }),
  ev("task.created", { id: T, employeeId: E, request: "Check vendor", successCriteria: [{ id: "c1", text: "Legal name matches the GST certificate" }], status: "running", createdAt: "2026-10-07T05:00:00.000Z" }),
  ev("tool.called", { callId: "call_1", taskId: T, tool: "files.read_text", input: { path: "Docs/scan0231.pdf" } }, { taskId: T }),
  ev("evidence.added", { id: "evd_1", kind: "document", summary: "GST certificate p.1", source: "ws:Docs/scan0231.pdf", fields: { gstin: "29AAQFN6623R1ZX" }, capturedAt: "2026-10-07T05:10:00.000Z" }, { taskId: T }),
  ev("tool.completed", { callId: "call_1", ok: true, preview: "GSTIN 29AAQFN6623R1ZX", durationMs: 12, evidenceIds: ["evd_1"] }),
  ev("verification.completed", { taskId: T, results: [{ criterionId: "c1", verdict: "pass", detail: "Names match", evidenceIds: ["evd_1"] }] }),
  ev("message.posted", { id: "msg_1", threadId: E, from: `employee:${E}`, text: "What I found:\nGSTIN is 29AAQFN6623R1ZX\nVendor is lovely\nVerifier: all 1 check passed on a fresh read.", attachments: [], taskId: T, ts: "2026-10-07T05:20:00.000Z" }),
];

describe("show working", () => {
  const s = reduceAll(base());
  it("links report lines to evidence, tool calls and verification, and is honest about gaps", () => {
    const lines = linkReport(s, T);
    expect(lines.map((l) => l.kind)).toEqual(["heading", "line", "line", "verifier"]);
    expect(lines[1]!.evidenceIds).toEqual(["evd_1"]);
    expect(lines[1]!.callIds).toEqual(["call_1"]);
    expect(lines[2]!.evidenceIds).toEqual([]);
    expect(lines[2]!.callIds).toEqual([]);
    expect(lines[3]!.criteria[0]!.verdict).toBe("pass");
  });
  it("builds the facts -> evidence -> tool call chain", () => {
    const rows = workingRows(s, T);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.facts).toEqual([{ key: "gstin", value: "29AAQFN6623R1ZX" }]);
    expect(rows[0]!.calls[0]!.tool).toBe("files.read_text");
    expect(rows[0]!.supports[0]).toContain("Legal name matches");
    expect(describeEvidence(rows[0]!.evidence, "UTC")).toBe("GST certificate p.1 · scan0231.pdf, read at 05:10, says “gstin: 29AAQFN6623R1ZX”");
  });
  it("decides how a source opens", () => {
    const e = s.evidence.evd_1!;
    expect(sourceTarget(e)).toEqual({ kind: "file", rootId: "ws", rel: "Docs/scan0231.pdf" });
    expect(sourceTarget({ ...e, source: "https://x.test/a" })).toEqual({ kind: "url", href: "https://x.test/a" });
    expect(sourceTarget({ ...e, kind: "email", source: "mail:123" }).kind).toBe("none");
  });
  it("renders", () => {
    const html = renderToStaticMarkup(h(Working, { state: s, task: s.tasks[T]! }));
    expect(html).toContain("no source recorded");
    expect(html).toContain("scan0231.pdf");
  });
});

describe("undo", () => {
  const events = [
    ...base(),
    ev("effect.recorded", { id: "eff_1", callId: "call_1", taskId: T, tool: "files.move", summary: "Moved a.pdf", undo: { tool: "files.move", input: {} }, at: "2026-10-07T05:30:00.000Z" }),
    ev("effect.recorded", { id: "eff_2", callId: "call_1", tool: "mail.send", summary: "Sent email", at: "2026-10-07T05:31:00.000Z" }),
    ev("effect.undone", { effectId: "eff_1", by: "user", ok: false, detail: "file missing" }),
  ];
  const s = reduceAll(events);
  it("tracks effects, failure keeps Undo available, success strikes through", () => {
    const fx = effectsOfTask(s, T);
    expect(fx.map((f) => f.id)).toEqual(["eff_1", "eff_2"]); // eff_2 found via its call
    expect(canUndo(fx[0]!)).toBe(true);
    expect(canUndo(fx[1]!)).toBe(false);
    const s2 = reduceAll([ev("effect.undone", { effectId: "eff_1", by: "user", ok: true, detail: "restored" }), ev("effect.undone", { effectId: "eff_1", by: "user", ok: false, detail: "again" })], s);
    expect(s2.effects.eff_1!.undone).toMatchObject({ ok: true, detail: "restored" });
    expect(canUndo(s2.effects.eff_1!)).toBe(false);
  });
  it("renders", () => {
    const html = renderToStaticMarkup(h(Changes, { state: s, task: s.tasks[T]!, send: () => {} }));
    expect(html).toContain("Undo everything this task did");
    expect(html).toContain("cannot be undone");
    expect(html).toContain("undo failed");
  });
});

describe("rehearsal", () => {
  const rows = [
    ev("effect.previewed", { id: "p1", callId: "c", taskId: T, tool: "files.move", input: {}, summary: "Move a.pdf", at: "2026-10-07T05:30:00.000Z" }),
    ev("effect.previewed", { id: "p2", callId: "c", taskId: T, tool: "files.move", input: {}, summary: "Move b.pdf", at: "2026-10-07T05:30:00.000Z" }),
    ev("effect.previewed", { id: "p3", callId: "c", taskId: T, tool: "mail.send", input: {}, summary: "Email Ravi", at: "2026-10-07T05:30:00.000Z" }),
  ];
  it("groups by tool and shows the panel until resolved", () => {
    let s = reduceAll([...base(), ev("task.updated", { taskId: T, changes: { rehearsal: "preview" } }), ...rows]);
    const g = groupPreviews(s.previews[T]!);
    expect(g.map((x) => [x.tool, x.rows.length])).toEqual([["files.move", 2], ["mail.send", 1]]);
    expect(g[0]!.headline).toContain("2 changes");
    expect(g[1]!.headline).toBe("Email Ravi");
    const html = renderToStaticMarkup(h(PreviewPanel, { state: s, task: s.tasks[T]!, send: () => {} }));
    expect(html).toContain("Apply");
    expect(html).toContain("Discard");
    s = reduceAll([ev("rehearsal.resolved", { taskId: T, decision: "applied", applied: 3, failed: 0, by: "user" })], s);
    expect(s.tasks[T]!.rehearsal).toBe("applied");
    expect(renderToStaticMarkup(h(PreviewPanel, { state: s, task: s.tasks[T]!, send: () => {} }))).toContain("3 changes made");
  });
});

describe("batch approvals", () => {
  const ap = (id: string, title: string, tool = "erp.activate"): Approval => ({ id, taskId: T, title, reason: "r", diff: [], evidenceIds: [], risk: "irreversible", status: "pending", toolCall: { tool, input: {} } });
  it("derives title patterns and groups look-alikes of 2 or more", () => {
    expect(titlePattern("Activate vendor Shree Ganesh Constructions")).toBe("activate vendor");
    expect(titlePattern("Pay ₹4,000 to X")).toBe("pay");
    const g = groupApprovals([ap("a1", "Activate vendor Shree Ganesh"), ap("a2", "Activate vendor Nandi Roadways"), ap("a3", "Email vendor Kaveri", "mail.send")]);
    expect(g).toHaveLength(1);
    expect(g[0]!.approvals.map((a) => a.id)).toEqual(["a1", "a2"]);
  });
  it("toggles select-all", () => {
    expect([...toggleAll(new Set(), ["a", "b"])]).toEqual(["a", "b"]);
    expect([...toggleAll(new Set(["a", "b"]), ["a", "b"])]).toEqual([]);
    expect([...toggleAll(new Set(["a"]), ["a", "b"])].sort()).toEqual(["a", "b"]);
  });
  it("renders a group card", () => {
    const s: AppState = reduceAll([...base(), ev("approval.requested", ap("a1", "Activate vendor A")), ev("approval.requested", ap("a2", "Activate vendor B"))]);
    const html = renderToStaticMarkup(h(BatchApprovals, { state: s, employeeId: E, send: () => {} }));
    expect(html).toContain("Select all in group");
    expect(html).toContain("Approve 0");
  });
});

describe("memory", () => {
  it("is memory.added minus memory.removed, per employee", () => {
    const s = reduceAll([
      ev("memory.added", { id: "m1", employeeId: E, text: "Always CC Ravi", at: "2026-10-07T05:00:00.000Z" }),
      ev("memory.added", { id: "m2", employeeId: E, text: "Dates are DD/MM", at: "2026-10-07T05:01:00.000Z" }),
      ev("memory.added", { id: "m3", employeeId: "emp_2", text: "other", at: "2026-10-07T05:02:00.000Z" }),
      ev("memory.removed", { id: "m1", by: "user" }),
    ], emptyState());
    expect(memoriesOf(s, E).map((m) => m.text)).toEqual(["Dates are DD/MM"]);
    const html = renderToStaticMarkup(h(Memory, { state: s, employeeId: E, send: () => {} }));
    expect(html).toContain("Dates are DD/MM");
    expect(html).toContain("Forget");
    expect(html).toContain("Add a note");
    expect(html).not.toContain("Always CC Ravi");
  });
});
