import type { PackCtx, StepCtx, StepHandler, StepOutcome, VerifyResult } from "@theseus/core";
import type { Plan, PlanItem } from "@theseus/protocol";
import type { BatchRec, LineRec, VendorRec } from "./tools.ts";

/**
 * Playbook "payment-batch-check": deterministic step handlers. No model calls:
 * every check is code over records fetched through the gateway, so it costs
 * nothing per line and gives the same answer every time (Framework Spec §16).
 * A failed check holds the line in the ERP right away (cheap, reversible) and
 * the item stops there; clean lines are cleared in the last step.
 */

const inr = (n: number) => `₹${Math.round(n).toLocaleString("en-IN")}`;
const DAY = 86_400_000;
const daysBetween = (a: string, b: string) => Math.round((Date.parse(b.slice(0, 10)) - Date.parse(a.slice(0, 10))) / DAY);
const fyStart = (today: string) => {
  const y = Number(today.slice(0, 4));
  return Number(today.slice(5, 7)) >= 4 ? `${y}-04-01` : `${y - 1}-04-01`;
};

async function batchOf(ctx: { shared: Record<string, any>; params: Record<string, string>; call: StepCtx["call"] }): Promise<BatchRec> {
  if (!ctx.shared.batch) ctx.shared.batch = await ctx.call<BatchRec>("payments.get_batch", { id: ctx.params.batchId });
  return ctx.shared.batch as BatchRec;
}

async function lineOf(ctx: StepCtx): Promise<LineRec> {
  const b = await batchOf(ctx);
  const l = b.lines.find((x) => x.id === ctx.item.id);
  if (!l) throw new Error(`Line ${ctx.item.id} is not in ${b.id}`);
  return l;
}

async function vendorOf(ctx: StepCtx, line: LineRec): Promise<VendorRec> {
  if (!ctx.data.vendor) ctx.data.vendor = await ctx.call<VendorRec>("vendor.get", { id: line.vendorId });
  return ctx.data.vendor as VendorRec;
}

async function hold(ctx: StepCtx, line: LineRec, reason: string, evidenceIds: string[] = []): Promise<StepOutcome> {
  await ctx.call("payments.hold_line", { batchId: ctx.params.batchId, lineId: line.id, reason });
  return { status: "hold", reason, note: `Held: ${reason}`, evidenceIds };
}

const vendor: StepHandler = async (ctx) => {
  const line = await lineOf(ctx);
  const v = await vendorOf(ctx, line);
  if (v.status !== "active") {
    const why = v.status === "inactive" ? `${v.legalName} (${v.id}) is inactive (dormant) in the vendor master` : `${v.legalName} (${v.id}) is ${v.status}, not active`;
    ctx.check("vendor_active", "fail", why);
    return hold(ctx, line, why);
  }
  const { hits } = await ctx.call<{ hits: { name: string; reason: string; until: string }[] }>("lists.check_debarment", { name: v.legalName, ...(v.pan ? { pan: v.pan } : {}) });
  if (hits.length) {
    const h = hits[0]!;
    const why = `${v.legalName} is on the debarment register until ${h.until}: ${h.reason}`;
    ctx.check("vendor_active", "fail", why);
    return hold(ctx, line, why);
  }
  if (v.paymentsOnHold) {
    const why = `All payments to ${v.legalName} are on hold in the ERP${v.holdReason ? ` (${v.holdReason})` : ""}`;
    ctx.check("vendor_active", "fail", why);
    return hold(ctx, line, why);
  }
  ctx.check("vendor_active", "pass", `${v.id} active, not debarred`);
  return { status: "done", note: "Active, not debarred" };
};

const bank: StepHandler = async (ctx) => {
  const line = await lineOf(ctx);
  const v = await vendorOf(ctx, line);
  if (line.payTo.accountNumber !== v.bank.accountNumber || line.payTo.ifsc !== v.bank.ifsc) {
    const why = `Line pays ${line.payTo.accountNumber}/${line.payTo.ifsc} but the vendor master has ${v.bank.accountNumber}/${v.bank.ifsc}`;
    ctx.check("bank_matches_master", "fail", why);
    return hold(ctx, line, why);
  }
  ctx.check("bank_matches_master", "pass", "Bank account equals the vendor master");
  const change = [...v.history].reverse().find((h) => h.field === "bank");
  if (change && daysBetween(change.at, ctx.today) <= 30) {
    const days = daysBetween(change.at, ctx.today);
    const flags: string[] = [`bank account changed ${days} day${days === 1 ? "" : "s"} ago (${change.at.slice(0, 10)})`];
    const evidenceIds: string[] = [];
    const msgId = /msg_\w+/.exec(change.source ?? "")?.[0];
    if (msgId) {
      const m = await ctx.call<{ from: string; subject: string }>("mail.read", { id: msgId });
      const onRecord = v.email.split("@")[1]?.toLowerCase();
      const sender = m.from.split("@")[1]?.toLowerCase();
      if (onRecord && sender && onRecord !== sender) flags.push(`the request (${msgId}) came from ${sender}, not ${onRecord} on record`);
    }
    const pd = await ctx.call<{ ok: boolean; nameAtBank?: string }>("bank.penny_drop", { accountNumber: v.bank.accountNumber, ifsc: v.bank.ifsc });
    if (pd.ok && pd.nameAtBank && !sameParty(pd.nameAtBank, v)) flags.push(`the bank says the account holder is "${pd.nameAtBank}", not ${v.legalName}`);
    const why = `${flags.join("; ")}. Call ${v.legalName} on ${v.phone} (number on record) before paying.`;
    ctx.check("no_recent_bank_change", "fail", why, evidenceIds);
    return hold(ctx, line, why, evidenceIds);
  }
  ctx.check("no_recent_bank_change", "pass", "No bank change in the last 30 days");
  return { status: "done", note: "Account matches master; no recent change" };
};

/** Bank holder name belongs to the vendor (legal name, or the proprietor named in the trade name). */
function sameParty(nameAtBank: string, v: Pick<VendorRec, "legalName" | "tradeName">): boolean {
  const norm = (s: string) => s.toUpperCase().replace(/[^A-Z0-9]+/g, " ").replace(/\b(PVT|PRIVATE|LTD|LIMITED|LLP|M S)\b/g, "").trim();
  if (norm(nameAtBank) === norm(v.legalName)) return true;
  const prop = /\(Prop\.?\s+([^)]+)\)/i.exec(v.tradeName ?? "")?.[1];
  return !!prop && norm(prop) === norm(nameAtBank);
}

const duplicate: StepHandler = async (ctx) => {
  const line = await lineOf(ctx);
  const { bills } = await ctx.call<{ bills: { billNumber: string; amount: number; paidOn: string }[] }>("payments.paid_bills", { vendorId: line.vendorId });
  const paid = bills.find((b) => b.billNumber === line.billNumber);
  if (paid) {
    const why = `Bill ${line.billNumber} was already paid on ${paid.paidOn} (${inr(paid.amount)})`;
    ctx.check("no_duplicate_bill", "fail", why);
    return hold(ctx, line, why);
  }
  const sameAmount = bills.find((b) => b.amount === line.gross && Math.abs(daysBetween(b.paidOn, ctx.today)) <= 30);
  if (sameAmount) {
    const why = `Same amount ${inr(line.gross)} was paid to this vendor on ${sameAmount.paidOn} (bill ${sameAmount.billNumber}): possible re-submission`;
    ctx.check("no_duplicate_bill", "fail", why);
    return hold(ctx, line, why);
  }
  const batch = await batchOf(ctx);
  const twin = batch.lines.find((l) => l.id !== line.id && l.vendorId === line.vendorId && l.billNumber === line.billNumber);
  if (twin) {
    const why = `Bill ${line.billNumber} appears twice in this batch (${twin.id})`;
    ctx.check("no_duplicate_bill", "fail", why);
    return hold(ctx, line, why);
  }
  ctx.check("no_duplicate_bill", "pass", "No earlier payment or twin line for this bill");
  return { status: "done", note: "No duplicate" };
};

const tds: StepHandler = async (ctx) => {
  const line = await lineOf(ctx);
  const v = await vendorOf(ctx, line);
  const { bills } = await ctx.call<{ bills: { amount: number; paidOn: string }[] }>("payments.paid_bills", { vendorId: line.vendorId });
  const thisYear = bills.filter((b) => b.paidOn >= fyStart(ctx.today));
  const paidEarlier = thisYear.reduce((a, b) => a + b.amount, 0);
  // Payments of ≤ ₹30,000 made while the year total was under ₹1 lakh had no TDS deducted.
  const untaxed = thisYear.filter((b) => b.amount <= 30_000).reduce((a, b) => a + b.amount, 0);
  const r = await ctx.call<{ tds: number; rate: number; reason: string }>("rules.contractor_tds", {
    ...(v.pan ? { pan: v.pan } : {}),
    amount: line.gross,
    paidEarlierThisYear: paidEarlier,
    earlierPaidWithoutTds: untaxed,
  });
  if (Math.abs(r.tds - line.tds) <= 1) {
    ctx.check("tds_correct", "pass", `TDS ${inr(line.tds)} is right: ${r.reason}`);
    return { status: "done", note: `TDS ${inr(line.tds)} correct` };
  }
  const reason = `TDS should be ${inr(r.tds)}, not ${inr(line.tds)}: ${r.reason}`;
  const fixed = await ctx.call<{ tds: number; net: number }>("payments.correct_line", { batchId: ctx.params.batchId, lineId: line.id, tds: r.tds, reason });
  ctx.data.corrected = { from: line.tds, to: fixed.tds };
  ctx.check("tds_correct", "pass", `Corrected: ${reason}`);
  return { status: "done", note: `Corrected TDS ${inr(line.tds)} → ${inr(fixed.tds)} (net ${inr(fixed.net)})` };
};

const msme: StepHandler = async (ctx) => {
  const line = await lineOf(ctx);
  const v = await vendorOf(ctx, line);
  const cat = v.udyam?.category ?? "none";
  const r = await ctx.call<{ status: string; reason: string; dueOn?: string; daysLeft?: number }>("rules.msme_deadline", {
    category: cat,
    acceptedOn: line.acceptedOn,
    ...(v.agreedCreditDays !== undefined ? { agreedDays: v.agreedCreditDays } : {}),
  });
  if (r.status === "due_soon" || r.status === "overdue") {
    ctx.data.msme = r;
    ctx.check("msme_deadline_ok", "uncertain", `Pay in this batch: ${r.reason}`);
    return { status: "done", note: `⚠ MSME ${r.status === "overdue" ? "overdue" : `due ${r.dueOn}`}: pay in this batch` };
  }
  ctx.check("msme_deadline_ok", "pass", r.reason);
  return { status: "done", note: r.status === "not_applicable" ? "Not micro/small" : `MSME due ${r.dueOn}` };
};

const decide: StepHandler = async (ctx) => {
  const line = await lineOf(ctx);
  const note = ctx.data.corrected ? `TDS corrected ${inr(ctx.data.corrected.from)} → ${inr(ctx.data.corrected.to)}; other checks passed` : "All checks passed";
  await ctx.call("payments.clear_line", { batchId: ctx.params.batchId, lineId: line.id, note });
  return { status: "done", note: ctx.data.corrected ? "Cleared (after TDS correction)" : "Cleared" };
};

export const batchHandlers: Record<string, StepHandler> = { vendor, bank, duplicate, tds, msme, decide };

export async function discoverBatch(ctx: PackCtx, vendorName: (id: string) => string | undefined): Promise<PlanItem[]> {
  const b = await ctx.call<BatchRec>("payments.get_batch", { id: ctx.params.batchId });
  ctx.shared.batch = b;
  if (b.status === "released") throw new Error(`${b.id} was already released`);
  return b.lines
    .filter((l) => l.status === "pending")
    .map((l) => ({ id: l.id, label: `${vendorName(l.vendorId) ?? l.vendorId} · ${l.billNumber} · ${inr(l.gross)}`, ref: `${b.id}/${l.id}`, held: false }));
}

export async function verifyBatch(ctx: PackCtx & { plan: Plan }): Promise<VerifyResult[]> {
  // Independent: re-read the batch from the ERP; don't trust what the steps said.
  const b = await ctx.call<BatchRec>("payments.get_batch", { id: ctx.params.batchId });
  const vendors = new Map<string, VendorRec>();
  const out: VerifyResult[] = [];
  const mismatched: string[] = [];
  const wrongAccount: string[] = [];
  for (const it of ctx.plan.items) {
    const l = b.lines.find((x) => x.id === it.id);
    if (!l) continue;
    const cells = ctx.plan.steps.map((s) => ctx.plan.cells[it.id]![s.id]!.state);
    const finished = cells.every((c) => c === "done" || c === "skipped");
    if (it.held && l.status !== "held") mismatched.push(`${it.id} held in plan but ${l.status} in ERP`);
    if (!it.held && finished && ctx.plan.steps.some((s) => s.id === "decide") && !["cleared", "corrected"].includes(l.status)) mismatched.push(`${it.id} finished but ${l.status} in ERP`);
    if (l.status === "cleared" || l.status === "corrected") {
      const v = vendors.get(l.vendorId) ?? (await ctx.call<VendorRec>("vendor.get", { id: l.vendorId }));
      vendors.set(l.vendorId, v);
      if (v.bank.accountNumber !== l.payTo.accountNumber || v.bank.ifsc !== l.payTo.ifsc) wrongAccount.push(l.id);
    }
  }
  out.push({ criterion: "ERP matches what I reported", verdict: mismatched.length ? "fail" : "pass", detail: mismatched.length ? mismatched.join("; ") : "every held / cleared line agrees with the ERP" });
  out.push({ criterion: "No cleared line pays a different account than the vendor master", verdict: wrongAccount.length ? "fail" : "pass", detail: wrongAccount.length ? wrongAccount.join(", ") : "all cleared lines match" });
  out.push({ criterion: "Batch not released by me", verdict: b.status === "draft" ? "pass" : "fail", detail: `batch status is ${b.status}` });
  return out;
}

export async function reportBatch(ctx: PackCtx & { plan: Plan }): Promise<string> {
  const plan = ctx.plan;
  const b = await ctx.call<BatchRec>("payments.get_batch", { id: ctx.params.batchId });
  const inPlan = new Set(plan.items.map((i) => i.id));
  const lines = b.lines.filter((l) => inPlan.has(l.id));
  const held = plan.items.filter((i) => i.held);
  const corrected = plan.items.filter((i) => (plan.cells[i.id]?.tds?.note ?? "").startsWith("Corrected"));
  const cleared = lines.filter((l) => l.status === "cleared" || l.status === "corrected");
  const msmeDue = plan.items.filter((i) => (plan.cells[i.id]?.msme?.note ?? "").startsWith("⚠"));
  const parked = plan.items.filter((i) => plan.steps.some((s) => plan.cells[i.id]![s.id]!.state === "needs_you" || plan.cells[i.id]![s.id]!.state === "failed"));
  const partial = !plan.steps.some((s) => s.id === "decide");
  const out = [
    `${b.id}: checked ${plan.items.length} line${plan.items.length === 1 ? "" : "s"}${partial ? ` (only: ${plan.steps.map((s) => s.title).join(", ")})` : ""}.`,
    partial
      ? `${corrected.length} corrected${held.length ? ` · ${held.length} held` : ""}${parked.length ? ` · ${parked.length} need you` : ""}.`
      : `${cleared.length} cleared${corrected.length ? ` (${corrected.length} after a TDS correction)` : ""} · ${held.length} held${parked.length ? ` · ${parked.length} need you` : ""}.`,
    corrected.length ? `Corrected:\n${corrected.map((i) => `• ${i.label}: ${plan.cells[i.id]!.tds!.note}`).join("\n")}` : "",
    held.length ? `Held:\n${held.map((i) => `• ${i.label}: ${i.holdReason}`).join("\n")}` : "",
    msmeDue.length ? `MSME payments due now (pay in this batch):\n${msmeDue.map((i) => `• ${i.label}: ${plan.cells[i.id]!.msme!.note!.replace(/^⚠\s*/, "")}`).join("\n")}` : "",
    parked.length ? `Need you:\n${parked.map((i) => `• ${i.label}`).join("\n")}` : "",
    partial ? "" : "The batch is NOT released: that's for the Finance Head after reviewing the holds.",
  ].filter(Boolean);
  const text = out.join("\n\n");
  try {
    const saved = await ctx.call<{ path: string }>("files.save_text", { path: `Payments/${b.id.split("-").pop()}/Integrity check ${b.id}.md`, text: `# Integrity check: ${b.id}\n\n${text}\n` });
    return `${text}\n\nSaved the report to ${saved.path}.`;
  } catch {
    return text;
  }
}
