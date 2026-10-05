import type { BankAccount, Email, KaveriState, PaymentBatch, PaymentLine, UdyamCategory, Vendor } from "./domain.ts";
import { initialState } from "./seed/scenario.ts";

/** Business error with an HTTP status and a stable code the agent can classify. */
export class KaveriError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

/**
 * Fault injection: make the world misbehave on purpose so reliability can be
 * demonstrated and evaluated, not hoped for.
 *  - failNext: fail the next N calls of an operation (deterministic, for demos/evals)
 *  - failRate: probability any write fails transiently (seeded, reproducible)
 *  - latencyMs: added delay on every operation
 */
export interface FaultConfig {
  failNext: Record<string, number>;
  failRate: number;
  latencyMs: number;
  seed: number;
}
export const NO_FAULTS: FaultConfig = { failNext: {}, failRate: 0, latencyMs: 0, seed: 42 };

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
const bankKey = (a: { accountNumber: string; ifsc: string }) => `${a.accountNumber}|${a.ifsc}`;
const isHumanApprover = (by: string | undefined) => !!by && by.startsWith("user:");

export class Kaveri {
  state: KaveriState = initialState();
  faults: FaultConfig = structuredClone(NO_FAULTS);
  private rngState = NO_FAULTS.seed;
  private seq = 0;

  reset(faults: Partial<FaultConfig> = {}) {
    this.state = initialState();
    this.setFaults({ ...NO_FAULTS, ...faults });
    this.seq = 0;
  }

  setFaults(f: Partial<FaultConfig>) {
    this.faults = { ...this.faults, ...f, failNext: { ...(f.failNext ?? this.faults.failNext) } };
    this.rngState = this.faults.seed;
  }

  private rand() {
    // mulberry32: tiny seeded PRNG so "random" faults are reproducible
    let t = (this.rngState += 0x6d2b79f5);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  /** Every operation passes through here: latency + injected failures. */
  async gate(op: string, kind: "read" | "write") {
    if (this.faults.latencyMs > 0) await new Promise((r) => setTimeout(r, this.faults.latencyMs));
    const n = this.faults.failNext[op] ?? 0;
    if (n > 0) {
      this.faults.failNext[op] = n - 1;
      throw new KaveriError(503, "TEMPORARILY_UNAVAILABLE", `ERP service timed out while processing ${op}. Please retry.`);
    }
    if (kind === "write" && this.faults.failRate > 0 && this.rand() < this.faults.failRate)
      throw new KaveriError(503, "TEMPORARILY_UNAVAILABLE", `ERP service timed out while processing ${op}. Please retry.`);
  }

  private now() {
    return new Date().toISOString();
  }
  private audit(actor: string, action: string, detail: string) {
    this.state.auditLog.push({ at: this.now(), actor, action, detail });
  }

  /* ------------------------------------------------------------- mail */

  listMail(opts: { folder?: string; q?: string } = {}): Omit<Email, "body">[] {
    const folder = opts.folder ?? "inbox";
    const q = opts.q ? norm(opts.q) : "";
    return this.state.mail
      .filter((m) => m.folder === folder)
      .filter((m) => !q || norm(`${m.from} ${m.fromName} ${m.subject} ${m.body}`).includes(q))
      .sort((a, b) => b.receivedAt.localeCompare(a.receivedAt))
      .map(({ body: _b, ...rest }) => rest);
  }

  getMail(id: string): Email {
    const m = this.state.mail.find((x) => x.id === id);
    if (!m) throw new KaveriError(404, "NOT_FOUND", `No email with id ${id}`);
    m.read = true;
    return m;
  }

  attachmentKey(id: string, name: string): string {
    const a = this.getMail(id).attachments.find((x) => x.name === name);
    if (!a) throw new KaveriError(404, "NOT_FOUND", `Email ${id} has no attachment "${name}"`);
    return a.docKey;
  }

  saveDraft(input: { to: string; subject: string; body: string }, by: string): Email {
    const draft: Email = {
      id: `msg_d${String(++this.seq).padStart(3, "0")}`,
      folder: "drafts",
      from: "ap@kaveriinfra.example",
      fromName: "Kaveri Infra · Accounts Payable",
      to: input.to,
      subject: input.subject,
      body: input.body,
      receivedAt: this.now(),
      attachments: [],
      read: true,
    };
    this.state.mail.push(draft);
    this.audit(by, "mail.draft", `${draft.id} → ${input.to}: ${input.subject}`);
    return draft;
  }

  sendDraft(id: string, approvedBy: string | undefined): Email {
    const m = this.getMail(id);
    if (m.folder !== "drafts") throw new KaveriError(409, "NOT_A_DRAFT", `${id} is not a draft`);
    if (!isHumanApprover(approvedBy))
      throw new KaveriError(403, "APPROVAL_REQUIRED", "External email requires a human approver (approvedBy: user:…)");
    m.folder = "sent";
    m.receivedAt = this.now();
    this.audit(approvedBy!, "mail.send", `${id} → ${m.to}`);
    return m;
  }

  /* ---------------------------------------------------------- vendors */

  searchVendors(q = ""): Vendor[] {
    const n = norm(q);
    return this.state.vendors.filter(
      (v) => !n || norm(`${v.id} ${v.legalName} ${v.tradeName ?? ""} ${v.pan ?? ""} ${v.gstin ?? ""} ${v.email}`).includes(n),
    );
  }

  getVendor(id: string): Vendor {
    const v = this.state.vendors.find((x) => x.id === id);
    if (!v) throw new KaveriError(404, "NOT_FOUND", `No vendor with id ${id}`);
    return v;
  }

  createPendingVendor(
    input: {
      legalName: string;
      tradeName?: string;
      pan?: string;
      gstin?: string;
      address: string;
      state: string;
      email: string;
      phone: string;
      bank: BankAccount;
      udyam?: { number: string; category: UdyamCategory };
      agreedCreditDays?: number;
    },
    by: string,
  ): Vendor {
    if (input.gstin && this.state.vendors.some((v) => v.gstin === input.gstin))
      throw new KaveriError(409, "DUPLICATE_GSTIN", `A vendor with GSTIN ${input.gstin} already exists`);
    if (!/^[0-9]{6,18}$/.test(input.bank.accountNumber))
      throw new KaveriError(422, "INVALID_ACCOUNT", "Bank account number must be 6–18 digits");
    if (!/^[A-Z]{4}0[A-Z0-9]{6}$/.test(input.bank.ifsc)) throw new KaveriError(422, "INVALID_IFSC", "IFSC format is invalid");
    const next = Math.max(...this.state.vendors.map((v) => Number(v.id.slice(2)))) + 1;
    const v: Vendor = {
      ...input,
      id: `V-${next}`,
      status: "pending",
      paymentsOnHold: false,
      createdBy: by,
      createdAt: this.now(),
      history: [{ at: this.now(), by, field: "status", before: null, after: "pending", source: "created" }],
    };
    this.state.vendors.push(v);
    this.audit(by, "vendor.create_pending", `${v.id} ${v.legalName}`);
    return v;
  }

  updatePendingVendor(id: string, patch: Partial<Vendor>, by: string): Vendor {
    const v = this.getVendor(id);
    if (v.status !== "pending") throw new KaveriError(409, "NOT_PENDING", `${id} is ${v.status}; only pending vendors can be edited`);
    for (const [field, after] of Object.entries(patch)) {
      if (["id", "status", "history", "createdBy", "createdAt", "approvedBy"].includes(field)) continue;
      const before = (v as unknown as Record<string, unknown>)[field];
      (v as unknown as Record<string, unknown>)[field] = after;
      v.history.push({ at: this.now(), by, field, before, after });
    }
    this.audit(by, "vendor.update_pending", `${id} ${Object.keys(patch).join(", ")}`);
    return v;
  }

  /** Maker-checker: the approver must be a human and not the creator. */
  activateVendor(id: string, approvedBy: string | undefined): Vendor {
    const v = this.getVendor(id);
    if (v.status !== "pending") throw new KaveriError(409, "NOT_PENDING", `${id} is ${v.status}`);
    if (!isHumanApprover(approvedBy))
      throw new KaveriError(403, "APPROVAL_REQUIRED", "Activation requires a human approver (approvedBy: user:…)");
    if (approvedBy === v.createdBy) throw new KaveriError(403, "MAKER_CHECKER", "The approver cannot be the person who created the vendor");
    v.status = "active";
    v.approvedBy = approvedBy;
    v.history.push({ at: this.now(), by: approvedBy!, field: "status", before: "pending", after: "active" });
    this.audit(approvedBy!, "vendor.activate", id);
    return v;
  }

  holdVendorPayments(id: string, reason: string, by: string): Vendor {
    const v = this.getVendor(id);
    if (!reason.trim()) throw new KaveriError(422, "REASON_REQUIRED", "A hold needs a reason");
    v.paymentsOnHold = true;
    v.holdReason = reason;
    v.history.push({ at: this.now(), by, field: "paymentsOnHold", before: false, after: true, source: reason });
    this.audit(by, "vendor.hold_payments", `${id}: ${reason}`);
    return v;
  }

  releaseVendorPayments(id: string, by: string): Vendor {
    const v = this.getVendor(id);
    v.paymentsOnHold = false;
    delete v.holdReason;
    v.history.push({ at: this.now(), by, field: "paymentsOnHold", before: true, after: false });
    this.audit(by, "vendor.release_payments", id);
    return v;
  }

  /** Bank change: human approver AND a recorded call-back reference are mandatory. */
  changeVendorBank(id: string, bank: BankAccount, opts: { approvedBy?: string; callbackRef?: string; source?: string }): Vendor {
    const v = this.getVendor(id);
    if (!isHumanApprover(opts.approvedBy))
      throw new KaveriError(403, "APPROVAL_REQUIRED", "Bank changes require a human approver (approvedBy: user:…)");
    if (!opts.callbackRef?.trim())
      throw new KaveriError(403, "CALLBACK_REQUIRED", "Bank changes require a call-back reference (verified on the phone number on record)");
    const before = v.bank;
    v.bank = bank;
    v.history.push({ at: this.now(), by: opts.approvedBy!, field: "bank", before, after: bank, source: `${opts.source ?? "request"}; call-back ${opts.callbackRef}` });
    this.audit(opts.approvedBy!, "vendor.change_bank", `${id} → ${bank.accountNumber}/${bank.ifsc}`);
    return v;
  }

  /* ------------------------------------------- government / bank / lists */

  gstinLookup(gstin: string) {
    const r = this.state.gstRegistry.find((g) => g.gstin === gstin.trim().toUpperCase());
    if (!r) throw new KaveriError(404, "NOT_FOUND", `GSTIN ${gstin} not found in the GST registry`);
    return r;
  }

  pennyDrop(accountNumber: string, ifsc: string) {
    const name = this.state.bankRegistry[bankKey({ accountNumber, ifsc: ifsc.toUpperCase() })];
    if (!name) return { ok: false as const, reason: "ACCOUNT_NOT_FOUND", message: "Beneficiary account could not be validated" };
    return { ok: true as const, nameAtBank: name, accountNumber, ifsc: ifsc.toUpperCase() };
  }

  verifyGuarantee(number: string) {
    const g = this.state.guarantees.find((x) => x.number === number.trim());
    if (!g) return { confirmed: false, message: `No record of guarantee ${number} at the issuing bank` };
    return g.genuine
      ? { confirmed: true, issuingBank: g.issuingBank, amount: g.amount, validUntil: g.validUntil }
      : { confirmed: false, message: `${g.issuingBank} has no record of issuing guarantee ${number}` };
  }

  searchEmployees(q = "") {
    const n = norm(q);
    return this.state.employees.filter((e) => !n || norm(`${e.name} ${e.department} ${e.address} ${e.bankAccount}`).includes(n));
  }

  searchDebarment(q = "") {
    const n = norm(q);
    return this.state.debarment.filter((d) => !n || norm(`${d.name} ${d.pan ?? ""}`).includes(n));
  }

  /* --------------------------------------------------------- payments */

  getBatch(id: string): PaymentBatch {
    const b = this.state.batches.find((x) => x.id === id);
    if (!b) throw new KaveriError(404, "NOT_FOUND", `No payment batch ${id}`);
    return b;
  }

  private line(batchId: string, lineId: string): { batch: PaymentBatch; line: PaymentLine } {
    const batch = this.getBatch(batchId);
    if (batch.status === "released") throw new KaveriError(409, "BATCH_RELEASED", `${batchId} was already released`);
    const line = batch.lines.find((l) => l.id === lineId);
    if (!line) throw new KaveriError(404, "NOT_FOUND", `No line ${lineId} in ${batchId}`);
    return { batch, line };
  }

  paidBills(vendorId?: string) {
    return this.state.paidBills.filter((p) => !vendorId || p.vendorId === vendorId);
  }

  holdLine(batchId: string, lineId: string, reason: string, by: string): PaymentLine {
    const { line } = this.line(batchId, lineId);
    if (!reason.trim()) throw new KaveriError(422, "REASON_REQUIRED", "A hold needs a reason");
    line.history.push({ at: this.now(), by, field: "status", before: line.status, after: "held", source: reason });
    line.status = "held";
    line.note = reason;
    this.audit(by, "payments.hold_line", `${batchId}/${lineId}: ${reason}`);
    return line;
  }

  clearLine(batchId: string, lineId: string, by: string, note?: string): PaymentLine {
    const { line } = this.line(batchId, lineId);
    line.history.push({ at: this.now(), by, field: "status", before: line.status, after: "cleared", source: note });
    line.status = "cleared";
    if (note) line.note = note;
    this.audit(by, "payments.clear_line", `${batchId}/${lineId}`);
    return line;
  }

  correctLine(batchId: string, lineId: string, fix: { tds: number; reason: string }, by: string): PaymentLine {
    const { line } = this.line(batchId, lineId);
    if (!Number.isFinite(fix.tds) || fix.tds < 0 || fix.tds > line.gross)
      throw new KaveriError(422, "INVALID_AMOUNT", "TDS must be between 0 and the gross amount");
    if (!fix.reason.trim()) throw new KaveriError(422, "REASON_REQUIRED", "A correction needs a reason");
    const before = { tds: line.tds, net: line.net };
    line.tds = Math.round(fix.tds);
    line.tdsRate = Math.round((line.tds / line.gross) * 10000) / 10000;
    line.net = line.gross - line.tds;
    line.status = "corrected";
    line.note = fix.reason;
    line.history.push({ at: this.now(), by, field: "tds", before, after: { tds: line.tds, net: line.net }, source: fix.reason });
    this.audit(by, "payments.correct_line", `${batchId}/${lineId}: TDS ${before.tds} → ${line.tds}`);
    return line;
  }

  releaseBatch(id: string, approvedBy: string | undefined): PaymentBatch {
    const b = this.getBatch(id);
    if (b.status === "released") throw new KaveriError(409, "BATCH_RELEASED", `${id} was already released`);
    if (!isHumanApprover(approvedBy)) throw new KaveriError(403, "APPROVAL_REQUIRED", "Releasing a batch requires a human approver");
    const pending = b.lines.filter((l) => l.status === "pending");
    if (pending.length) throw new KaveriError(409, "LINES_PENDING", `${pending.length} line(s) still pending review: ${pending.map((l) => l.id).join(", ")}`);
    b.status = "released";
    b.releasedBy = approvedBy;
    this.audit(approvedBy!, "payments.release_batch", id);
    return b;
  }
}
