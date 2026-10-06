/**
 * The Kaveri vendor-desk demo (Demo Workflow v2), as a replay script.
 * Items and amounts come from the Kaveri seed (demo-data.ts); the outcomes
 * mirror the planted traps (apps/kaveri TRAPS), so the replay shows what a
 * correct agent run should look like.
 */
import { THESEUS_ID, summarize, type Attachment, type Employee, type TheseusEvent } from "@theseus/protocol";
import { attachmentRef, mimeOf } from "../bridge.ts";
import { inr } from "../state/selectors.ts";
import type { AppState } from "../state/store.ts";
import { DEMO_DATA } from "./demo-data.ts";
import type { DemoScript, Outcome, SimTaskSpec } from "./engine.ts";
import type { DemoData } from "./types.ts";

export const E1 = "emp_1";
export const E2 = "emp_2";
export const TASK_EMP = "task_empanel_t14";
export const TASK_BATCH = "task_batch_w41";

const ws = (rel: string): Attachment => ({ name: rel.split("/").pop()!, mime: mimeOf(rel), ref: attachmentRef("workspace", rel) });
const POLICY = ws("Vendor Desk/Policies/Vendor Master Policy.pdf");
const REGISTER = ws("Vendor Desk/Vendor Register.xlsx");

const IST = (local: string) => new Date(`${local}+05:30`).toISOString();

const employee = (id: string, name: string, kind: Employee["kind"], createdAt: string, scope?: string): Employee => ({
  id,
  kind,
  name,
  rolePack: kind === "employee" ? "vendor-integrity" : undefined,
  scope,
  allowedTools: [],
  status: "idle",
  createdAt,
});

/* ------------------------------------------------------------------ empanelment */

const EMP_STEPS = [
  { id: "docs", title: "Docs" },
  { id: "extract", title: "Extract" },
  { id: "gst", title: "GSTIN" },
  { id: "pan", title: "PAN" },
  { id: "bank", title: "Bank" },
  { id: "msme", title: "MSME" },
  { id: "conflict", title: "Conflict" },
  { id: "emd", title: "EMD" },
  { id: "create", title: "Create" },
  { id: "activate", title: "Approve" },
];

function empanelOutcomes(d: DemoData): Record<string, Outcome> {
  const [a, b, c] = d.bidders;
  return {
    "A:msme": { kind: "pass", note: "Small enterprise (UDYAM-KR-29-0006614)" },
    "A:emd": { kind: "pass", note: "Guarantee PBG/HDFC/2026/88123 confirmed by the issuing bank" },
    "A:activate": {
      kind: "needs_you",
      note: "all checks passed; activation needs a second person",
      approval: {
        title: `Activate vendor ${a!.name}`,
        reason: "GSTIN active, PAN matches, penny-drop name matches, guarantee confirmed, no conflicts. Policy: the person who creates a vendor can't also activate it (maker-checker).",
        toolCall: { tool: "erp.activate_vendor", input: { bidder: "A" } },
        diff: [{ field: "status", before: "pending", after: "active" }],
        risk: "irreversible",
      },
      onApprove: { state: "done", note: `${a!.name} is now active` },
      onReject: { state: "failed", note: `${a!.name} left as pending` },
    },
    "B:pan": {
      kind: "needs_you",
      note: "PAN card AAHFV2209L ≠ PAN inside the GSTIN AAHFV2290L (two digits swapped)",
      approval: {
        title: `Ask ${b!.name} for a corrected PAN`,
        reason: "The PAN card the bidder sent doesn't match the PAN embedded in their GSTIN. We can't onboard until it's resolved. I've drafted the email; sending outside the company needs you.",
        toolCall: { tool: "mail.send_draft", input: { to: "office@vrishabhaearth.example" } },
        diff: [],
        risk: "irreversible",
      },
      onApprove: { state: "done", note: "Email sent; parked until the bidder replies", hold: "Waiting for a corrected PAN from the bidder" },
      onReject: { state: "failed", note: "Not contacted; bidder not empanelled" },
    },
    "C:bank": {
      kind: "retry",
      error: "Penny-drop timed out (attempt 1). Retrying in a moment",
      note: "Holder LAKSHMI RAGHAVENDRA is the proprietor: allowed with a declaration",
    },
    "C:msme": { kind: "pass", note: "Micro enterprise (UDYAM-KR-26-0041188)" },
    "C:conflict": {
      kind: "needs_you",
      note: "registered address matches employee R. Prakash (E-07, Procurement)",
      approval: {
        title: `Possible conflict of interest: ${c!.name}`,
        reason: "The bidder's registered address (No. 14, 2nd Cross Road, Vijayanagar, Mysuru) is the home address of R. Prakash in HR records.",
        humanTask: "Ask HR for a relationship declaration from R. Prakash before we continue.",
        diff: [],
        risk: "irreversible",
      },
      onApprove: { state: "done", note: "Declaration received; continuing onboarding" },
      onReject: { state: "failed", note: "Escalated to Vigilance; not empanelled" },
    },
    "C:emd": { kind: "fail", note: "Bharat Bank does not confirm guarantee PBG/SBI/2026/40917 (possible fake EMD)" },
  };
}

function empanelSpec(d: DemoData): SimTaskSpec {
  return {
    taskId: TASK_EMP,
    employeeId: E1,
    request: "Please empanel the three qualified bidders on tender T-2026-14 (Road widening, Ramanagara). Follow the Vendor Master Policy.",
    goal: "Empanel T-2026-14 bidders",
    playbookId: "onboard-contractor",
    steps: EMP_STEPS,
    items: d.bidders.map((b) => ({ id: b.key, label: `Bidder ${b.key} · ${b.name}`, ref: b.name, held: false })),
    outcomes: empanelOutcomes(d),
    stepMs: { docs: 40_000, extract: 30_000, gst: 15_000, pan: 12_000, bank: 25_000, msme: 15_000, conflict: 20_000, emd: 25_000, create: 15_000, activate: 5_000 },
    startText: "On it. I'll follow the Vendor Master Policy: bid documents from eProcure and mail, then GST, PAN, penny-drop, Udyam, conflicts and the EMD guarantee for each bidder.",
    startAttachments: [POLICY],
  };
}

/* ------------------------------------------------------------------ payment batch */

const BATCH_STEPS = [
  { id: "vendor", title: "Vendor" },
  { id: "bank", title: "Bank" },
  { id: "dup", title: "Duplicate" },
  { id: "tds", title: "TDS" },
  { id: "msme", title: "MSME" },
  { id: "decide", title: "Decision" },
];

function batchOutcomes(d: DemoData): Record<string, Outcome> {
  const callBack = (vendor: string, why: string, okNote: string): Outcome => ({
    kind: "needs_you",
    note: why,
    approval: {
      title: `Call-back: confirm the new bank details of ${vendor}`,
      reason: `${why}. Policy: bank changes are confirmed by phone on the number already on record, never the one in the email.`,
      humanTask: `Call ${vendor} on the phone number in the vendor master and confirm the change. Approve if they confirm, reject if they don't.`,
      diff: [],
      risk: "irreversible",
    },
    onApprove: { state: "done", note: okNote },
    onReject: { state: "done", note: "Call-back did not confirm the change: held, flagged as possible fraud", hold: "Bank change not confirmed by call-back" },
  });
  const out: Record<string, Outcome> = {
    "PL-03:bank": callBack("Shree Ganesh Constructions", "Bank account changed 3 days ago after an email from a look-alike domain; new holder name ≠ legal name", "Call-back confirmed the new account"),
    "PL-12:bank": callBack("Arka Solar Systems", "IFSC changed last week (branch move); the request looks genuine but hasn't been called back", "Call-back confirmed the branch move"),
    "PL-08:dup": { kind: "hold", note: "Bill HSF/2026/0412 was already paid on 20 Sep 2026" },
    "PL-10:vendor": { kind: "hold", note: "Vendor V-109 is inactive in the ERP" },
    "PL-11:vendor": { kind: "hold", note: "Deccan Quarry Works is on the debarment register" },
    "PL-05:tds": { kind: "pass", note: "TDS corrected 2% → 1% (PAN of an individual): ₹3,120 → ₹1,560", effect: "corrected" },
    "PL-02:msme": { kind: "pass", note: "Micro enterprise: accepted 25 Aug, due 9 Oct (45 days). Moved to the top", effect: "prioritise" },
    "PL-13:tds": { kind: "pass", note: "No TDS due (≤ ₹30,000; FY total ≤ ₹1,00,000)" },
    "PL-20:vendor": { kind: "retry", error: "ERP timed out (attempt 1). Retrying", note: "ERP answered on the second attempt" },
    "PL-41:bank": { kind: "retry", error: "Bank portal returned 503 (attempt 1). Retrying" },
  };
  for (const l of d.batch.lines) {
    const key = `${l.id}:decide`;
    if (!out[key]) out[key] = { kind: "pass", note: `Cleared · net ${inr(l.id === "PL-05" ? l.gross * 0.99 : l.net)}` };
  }
  return out;
}

function batchSpec(d: DemoData): SimTaskSpec {
  return {
    taskId: TASK_BATCH,
    employeeId: E2,
    request: `Please run the pre-payment integrity check on ${d.batch.id} (${d.batch.lines.length} lines) and prepare the bank upload file for Anil. Payment run is Friday 9 Oct.`,
    goal: `Friday batch check · ${d.batch.id}`,
    playbookId: "payment-batch-check",
    steps: BATCH_STEPS,
    items: d.batch.lines.map((l) => ({ id: l.id, label: `${l.id} · ${l.vendorName}`, ref: l.bill, held: false })),
    outcomes: batchOutcomes(d),
    stepMs: { vendor: 3000, bank: 4000, dup: 2500, tds: 2000, msme: 1500, decide: 1500 },
    startText: `Starting. I've exported ${d.batch.id} from the ERP; checking every line for vendor status, bank details, duplicates, TDS and MSME due dates.`,
  };
}

/* ------------------------------------------------------------------ reports */

function csv(rows: (string | number)[][]): string {
  return rows.map((r) => r.map((v) => (/[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v))).join(",")).join("\r\n") + "\r\n";
}

function report(d: DemoData) {
  return (s: AppState, taskId: string, corrected: Set<string>) => {
    const plan = s.plans[taskId]!;
    const statusOf = (id: string) => {
      const it = plan.items.find((i) => i.id === id)!;
      const cells = plan.steps.map((st) => plan.cells[id]![st.id]!);
      if (it.held) return "held";
      if (cells.some((c) => c.state === "failed")) return "failed";
      if (cells.every((c) => c.state === "skipped")) return "skipped";
      if (cells.every((c) => c.state === "done" || c.state === "skipped")) return "done";
      return "open";
    };
    const lastNote = (id: string) => {
      const it = plan.items.find((i) => i.id === id)!;
      if (it.held) return it.holdReason ?? "";
      if (it.skipReason) return it.skipReason;
      const notes = plan.steps.map((st) => plan.cells[id]![st.id]!).filter((c) => c.state === "failed" && c.note);
      return notes.pop()?.note ?? "";
    };

    if (taskId === TASK_EMP) {
      const lines = plan.items.map((it) => {
        const st = statusOf(it.id);
        const word = st === "done" ? "✓ empanelled" : st === "held" ? "⏸ on hold" : st === "failed" ? "✗ not empanelled" : st === "skipped" ? "skipped" : "open";
        const why = st === "done" ? "" : ` (${lastNote(it.id)})`;
        return `• ${it.label.replace(/^Bidder . · /, "")}: ${word}${why}`;
      });
      const rows: (string | number)[][] = [["Bidder", ...plan.steps.map((st) => st.title), "Outcome"]];
      for (const it of plan.items) rows.push([it.label, ...plan.steps.map((st) => plan.cells[it.id]![st.id]!.note ?? plan.cells[it.id]![st.id]!.state), statusOf(it.id)]);
      return {
        text: `Done with T-2026-14:\n${lines.join("\n")}\nCheck results for each bidder attached; the Vendor Register is updated.`,
        files: [{ rootId: "workspace", rel: "Vendor Desk/Bidders/T-2026-14 check results.csv", text: csv(rows) }],
      };
    }

    const lines = d.batch.lines;
    const cleared = lines.filter((l) => statusOf(l.id) === "done");
    const held = plan.items.filter((i) => i.held);
    const sum = summarize(plan);
    const netOf = (l: (typeof lines)[number]) => (corrected.has(l.id) ? Math.round(l.gross * 0.99) : l.net);
    const total = cleared.reduce((a, l) => a + netOf(l), 0);
    const upload = csv([["beneficiary_name", "account_number", "ifsc", "amount", "reference"], ...cleared.map((l) => [l.vendorName, l.account, l.ifsc, netOf(l), l.bill])]);
    const results = csv([
      ["Line", "Vendor", "Bill", "Gross", ...plan.steps.map((st) => st.title), "Outcome", "Reason"],
      ...lines.map((l) => [l.id, l.vendorName, l.bill, l.gross, ...plan.steps.map((st) => plan.cells[l.id]![st.id]!.note ?? plan.cells[l.id]![st.id]!.state), statusOf(l.id), lastNote(l.id)]),
    ]);
    const heldLines = held.map((h) => `• ${h.label}: ${h.holdReason}`).join("\n");
    return {
      text:
        `${d.batch.id} checked: ${cleared.length} cleared (${inr(total)}), ${held.length} held, ${corrected.size} corrected${sum.failed ? `, ${sum.failed} failed` : ""}${sum.skipped ? `, ${sum.skipped} skipped` : ""}.` +
        (heldLines ? `\nHeld:\n${heldLines}` : "") +
        `\nThe bank upload file has only the cleared lines. Uploading it needs your approval at the bank (maker-checker).`,
      files: [
        { rootId: "workspace", rel: `Payments/W41/${d.batch.id}_bank_upload.csv`, text: upload },
        { rootId: "workspace", rel: `Payments/W41/${d.batch.id} check results.csv`, text: results },
      ],
    };
  };
}

/* ------------------------------------------------------------------ the script */

export function kaveriDemo(d: DemoData = DEMO_DATA): DemoScript {
  const startAt = IST(`${d.today}T10:00:00`);
  return {
    startAt,
    data: d,
    request: `Finish this week's vendor-desk work: empanel the T-2026-14 bidders and get Friday's batch ${d.batch.id} ready for Anil.`,

    history(): TheseusEvent[] {
      let seq = 0;
      const ev = (ts: string, actor: TheseusEvent["actor"], body: Record<string, unknown>, extra: Record<string, unknown> = {}) =>
        ({ id: `evt_h${seq}`, seq: seq++, ts, actor, ...extra, ...body }) as TheseusEvent;
      const msg = (local: string, threadId: string, from: TheseusEvent["actor"], text: string, attachments: Attachment[] = []) => {
        const ts = IST(local);
        return ev(ts, from, { type: "message.posted", payload: { id: `msg_h${seq}`, threadId, from, text, attachments, ts } });
      };
      const t0 = IST("2026-10-05T09:00:00");
      const t1 = IST("2026-10-05T10:15:00");
      const taskTs = IST("2026-10-06T15:20:00");
      const doneTs = IST("2026-10-06T16:05:00");
      return [
        ev(t0, "system", { type: "employee.created", payload: employee(THESEUS_ID, "Theseus", "manager", t0) }),
        msg("2026-10-05T10:12:00", THESEUS_ID, "user", "Morning. Can you set someone up for the vendor desk? Onboarding and payment checks."),
        ev(t1, "theseus", { type: "employee.created", payload: employee(E1, "Employee 1", "employee", t1, "Vendor onboarding & checks") }),
        msg("2026-10-05T10:15:30", THESEUS_ID, "theseus", "Done: Employee 1 will handle vendor onboarding and checks, using the vendor-integrity playbooks."),
        ev(taskTs, "theseus", {
          type: "task.created",
          payload: { id: "task_bg_expiry", employeeId: E1, request: "List bank guarantees expiring before 31 Dec.", goal: "Bank guarantee expiry check", successCriteria: [], status: "running", createdAt: taskTs },
        }),
        msg("2026-10-06T15:20:00", E1, "theseus", "Please list the bank guarantees expiring before 31 Dec and note them in the Vendor Register."),
        msg("2026-10-06T15:21:00", E1, "employee:emp_1", "On it."),
        ev(doneTs, "system", { type: "task.status_changed", payload: { taskId: "task_bg_expiry", status: "done" } }),
        msg("2026-10-06T16:05:00", E1, "employee:emp_1", "Done: 11 guarantees checked, 2 expire before 31 Dec (EMDs on T-2026-09 and T-2026-11). Both are noted in the Vendor Register.", [REGISTER]),
        msg("2026-10-06T18:40:00", THESEUS_ID, "user", "Thanks, that's all for today."),
        msg("2026-10-06T18:40:20", THESEUS_ID, "theseus", "Noted. Have a good evening; I'll have the vendor desk queue ready in the morning."),
      ];
    },

    delegate(dir) {
      dir.say(
        THESEUS_ID,
        "theseus",
        `Two separate jobs, so I'll run them in parallel:\n• Employee 1 → empanel the 3 qualified bidders on T-2026-14\n• Employee 2 (new) → integrity check on ${d.batch.id}, ${d.batch.lines.length} lines\nI'll summarise when both are done. Anything that needs a decision will come to you.`,
      );
      dir.after(2000, () => {
        dir.emit({ type: "employee.created", payload: employee(E2, "Employee 2", "employee", dir.now(), "Payment batch checks") }, "theseus", { employeeId: E2 });
        dir.startTask(empanelSpec(d));
      });
      dir.after(4500, () => dir.startTask(batchSpec(d)));
    },

    report: report(d),

    rollup(s) {
      const sum = (taskId: string) => (s.plans[taskId] ? summarize(s.plans[taskId]!) : undefined);
      const e = sum(TASK_EMP);
      const b = sum(TASK_BATCH);
      const parts: string[] = [];
      if (e) parts.push(`Empanelment: ${e.done} active, ${e.held} on hold, ${e.failed} not empanelled`);
      if (b) parts.push(`Batch: ${b.done} cleared, ${b.held} held${b.failed ? `, ${b.failed} failed` : ""}`);
      return `Both jobs are finished.\n${parts.map((p) => `• ${p}`).join("\n")}\nThe bank upload file is in Payments/W41; it still needs your approval at the bank before Friday.`;
    },

    theseusIdleReply(s) {
      const busy = Object.values(s.employees).filter((e) => e.status === "working" || e.status === "waiting_on_user");
      return busy.length
        ? `Noted. ${busy.map((e) => e.name).join(" and ")} ${busy.length === 1 ? "is" : "are"} still working; I'll pass it on.`
        : "Noted. Everyone is free right now; tell me what you need next.";
    },
  };
}
