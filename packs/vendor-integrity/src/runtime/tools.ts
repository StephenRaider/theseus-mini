import { ToolFailure, documentText, fileTools, type FileSandbox, type Tool } from "@theseus/core";
import { z } from "zod";
import { findDuplicates, normalizeAddress, normalizeName, nameSimilarity } from "../matchers/names.ts";
import { msmeDeadline } from "../rules/msme.ts";
import { contractorTds } from "../rules/tds.ts";
import { checkGstin } from "../validators/gstin.ts";
import { checkIfsc } from "../validators/ifsc.ts";
import { checkPan } from "../validators/pan.ts";
import type { KaveriClient } from "./client.ts";

/**
 * The vendor-integrity toolbelt: thin, typed wrappers over the company's
 * systems plus the deterministic validators and rules. Every tool declares a
 * risk tier; writes declare which entities they touch (`subjects`) so standing
 * constraints can protect them; holds are `protective`.
 */

/* ------------------------------------------------------------------ world records (as the APIs return them) */

export interface BankRec {
  accountNumber: string;
  ifsc: string;
  holderName: string;
}
export interface VendorRec {
  id: string;
  legalName: string;
  tradeName?: string;
  pan?: string;
  gstin?: string;
  address: string;
  state: string;
  email: string;
  phone: string;
  bank: BankRec;
  udyam?: { number: string; category: "micro" | "small" | "medium" | "none" };
  agreedCreditDays?: number;
  status: "pending" | "active" | "inactive" | "blocked";
  paymentsOnHold: boolean;
  holdReason?: string;
  createdBy: string;
  approvedBy?: string;
  history: { at: string; by: string; field: string; before: unknown; after: unknown; source?: string }[];
}
export interface LineRec {
  id: string;
  vendorId: string;
  billNumber: string;
  workOrder: string;
  description: string;
  gross: number;
  tds: number;
  tdsRate: number;
  net: number;
  payTo: { accountNumber: string; ifsc: string };
  acceptedOn: string;
  status: "pending" | "cleared" | "held" | "corrected";
  note?: string;
}
export interface BatchRec {
  id: string;
  title: string;
  scheduledFor: string;
  status: "draft" | "released";
  lines: LineRec[];
}
export interface EmailRec {
  id: string;
  folder: string;
  from: string;
  fromName: string;
  to: string;
  subject: string;
  body?: string;
  receivedAt: string;
  attachments: { name: string; mime: string }[];
}
export interface TenderRec {
  id: string;
  title: string;
  status: string;
  qualifiedBidders: string[];
  publishedOn?: string;
  estimatedValue?: number;
  bidders?: { legalName: string; bidAmount: number; emdGuarantee?: string; documents: Record<string, string> }[];
}

/** What the runtime remembers about the world between calls (for constraints and steers). */
export class Directory {
  vendors = new Map<string, VendorRec>();
  /** "PB-2026-W41/PL-03" → "V-101" */
  lineVendor = new Map<string, string>();
  bidders = new Set<string>();

  rememberVendors(vs: VendorRec[]) {
    for (const v of vs) this.vendors.set(v.id, v);
  }
  rememberBatch(b: BatchRec) {
    for (const l of b.lines) this.lineVendor.set(`${b.id}/${l.id}`, l.vendorId);
  }
}

export const vendorKey = (id: string) => `vendor:${id}`;
export const nameKey = (name: string) => `name:${normalizeName(name)}`;
export const lineKey = (batchId: string, lineId: string) => `line:${batchId}/${lineId}`;

const enc = encodeURIComponent;
const slugFolder = (s: string) => s.replace(/[<>:"/\\|?*]+/g, " ").replace(/\s+/g, " ").trim();

export function vendorIntegrityTools(deps: { client: KaveriClient; sandbox: FileSandbox; rootId: string; dir: Directory; today: string }): Tool[] {
  const { client, sandbox, rootId, dir } = deps;

  const lineSubjects = async ({ batchId, lineId }: { batchId: string; lineId: string }) => {
    let vid = dir.lineVendor.get(`${batchId}/${lineId}`);
    if (!vid) {
      dir.rememberBatch(await client.json<BatchRec>("erp", "GET", `/api/payments/batches/${enc(batchId)}`));
      vid = dir.lineVendor.get(`${batchId}/${lineId}`);
    }
    return [lineKey(batchId, lineId), ...(vid ? [vendorKey(vid)] : [])];
  };

  /** Save downloaded bytes into the workspace; re-downloading the same file reuses it. */
  const saveDownload = async (folder: string, name: string, bytes: Buffer) => {
    const rel = `${folder}/${name}`;
    const size = await sandbox.sizeOf(rootId, rel).catch(() => undefined);
    if (size === bytes.length) return rel;
    return sandbox.writeNew(rootId, rel, bytes);
  };

  const tools: Tool[] = [
    /* ---------------------------------------------------------- mail */
    {
      name: "mail.search",
      description: "Search the company inbox (subject, sender, body). Newest first. Bodies not included.",
      risk: "read",
      idempotent: true,
      input: z.object({ q: z.string().optional(), folder: z.enum(["inbox", "sent", "drafts"]).optional() }),
      output: "{ messages: [{ id, from, fromName, subject, receivedAt, attachments: [{ name }] }] }",
      async run({ q, folder }) {
        const qs = new URLSearchParams({ ...(q ? { q } : {}), ...(folder ? { folder } : {}) });
        return { messages: await client.json<EmailRec[]>("mail", "GET", `/api/messages?${qs}`) };
      },
    },
    {
      name: "mail.read",
      description: "Read one email with headers and body",
      risk: "read",
      idempotent: true,
      input: z.object({ id: z.string() }),
      output: "{ id, from, fromName, to, subject, body, receivedAt, attachments }",
      async run({ id }, ctx) {
        const m = await client.json<EmailRec>("mail", "GET", `/api/messages/${enc(id)}`);
        ctx.evidence({ kind: "email", summary: `Email ${m.id} from ${m.from}: "${m.subject}"`, source: `mail:${m.id}`, fields: { from: m.from, subject: m.subject, receivedAt: m.receivedAt } });
        return m;
      },
    },
    {
      name: "mail.download_attachment",
      description: "Download an email attachment into a workspace folder (re-downloading reuses the file)",
      risk: "read",
      idempotent: true,
      input: z.object({ messageId: z.string(), name: z.string(), folder: z.string() }),
      output: "{ path }",
      async run({ messageId, name, folder }, ctx) {
        const bytes = await client.bytes("mail", `/api/messages/${enc(messageId)}/attachments/${enc(name)}`);
        const path = await saveDownload(folder, name, bytes);
        ctx.evidence({ kind: "document", summary: `${name} (attachment of ${messageId}) saved to ${path}`, source: `mail:${messageId}#${name}`, ref: path });
        return { path };
      },
    },
    {
      name: "mail.draft_reply",
      description: "Save an email draft (NOT sent)",
      risk: "write",
      idempotent: false,
      input: z.object({ to: z.string(), subject: z.string(), body: z.string() }),
      output: "{ id }",
      subjects: ({ to }) => [`email:${to.toLowerCase()}`],
      async run(input) {
        const d = await client.json<EmailRec>("mail", "POST", "/api/drafts", input);
        return { id: d.id, to: d.to, subject: d.subject };
      },
    },
    {
      name: "mail.send",
      description: "Send a saved draft outside the company (irreversible: needs your approval)",
      risk: "irreversible",
      idempotent: false,
      input: z.object({ draftId: z.string() }),
      async run({ draftId }, ctx) {
        const m = await client.json<EmailRec>("mail", "POST", `/api/messages/${enc(draftId)}/send`, { approvedBy: ctx.approval?.decidedBy });
        ctx.evidence({ kind: "email", summary: `Sent ${m.id} to ${m.to}: "${m.subject}"`, source: `mail:${m.id}` });
        return { id: m.id, to: m.to };
      },
    },

    /* ---------------------------------------------------------- eProcure */
    {
      name: "eproc.list_tenders",
      description: "List tenders on the e-procurement portal",
      risk: "read",
      idempotent: true,
      input: z.object({}),
      output: "{ tenders: [{ id, title, status, qualifiedBidders: [name], publishedOn, estimatedValue }] }",
      async run() {
        return { tenders: await client.json<TenderRec[]>("eproc", "GET", "/api/tenders") };
      },
    },
    {
      name: "eproc.get_tender",
      description: "Read one tender: qualified bidders, bid amounts, EMD bank guarantee numbers and bid documents",
      risk: "read",
      idempotent: true,
      input: z.object({ id: z.string() }),
      output: "{ id, title, status, qualifiedBidders: [name], bidders: [{ legalName, bidAmount, emdGuarantee, documents: { fileName: key } }] }",
      async run({ id }, ctx) {
        const t = await client.json<TenderRec>("eproc", "GET", `/api/tenders/${enc(id)}`);
        for (const b of t.qualifiedBidders) dir.bidders.add(b);
        ctx.evidence({ kind: "record", summary: `Tender ${t.id}: ${t.qualifiedBidders.length} qualified bidders`, source: `eproc:${t.id}` });
        return t;
      },
    },
    {
      name: "eproc.download_document",
      description: "Download a bidder's document from eProcure into a workspace folder",
      risk: "read",
      idempotent: true,
      input: z.object({ tenderId: z.string(), name: z.string(), folder: z.string() }),
      output: "{ path }",
      async run({ tenderId, name, folder }, ctx) {
        const bytes = await client.bytes("eproc", `/api/tenders/${enc(tenderId)}/documents/${enc(name)}`);
        const path = await saveDownload(folder, name, bytes);
        ctx.evidence({ kind: "document", summary: `${name} from eProcure ${tenderId} saved to ${path}`, source: `eproc:${tenderId}#${name}`, ref: path });
        return { path };
      },
    },

    /* ---------------------------------------------------------- documents */
    {
      name: "doc.extract_fields",
      description: 'Read a workspace document and return every "Label: value" line as fields, with the exact line quoted',
      risk: "read",
      idempotent: true,
      input: z.object({ path: z.string() }),
      output: "{ path, title, fields: { label: value }, quotes: { label: line }, text }",
      async run({ path }, ctx) {
        const text = await documentText(path, await sandbox.readBytes(rootId, path));
        const { title, fields, quotes } = parseLabelled(text);
        ctx.evidence({ kind: "document", summary: `${title || path}: ${Object.keys(fields).length} fields`, source: `file:${path}`, ref: path, fields });
        return { path, title, fields, quotes, text };
      },
    },

    /* ---------------------------------------------------------- validators (deterministic) */
    {
      name: "check.gstin",
      description: "GSTIN format, checksum, state and embedded-PAN checks",
      risk: "read",
      idempotent: true,
      input: z.object({ gstin: z.string(), pan: z.string().optional(), addressState: z.string().optional() }),
      output: "{ valid, gstin, stateName, pan, issues: [text], warnings: [text] }",
      async run({ gstin, pan, addressState }) {
        return checkGstin(gstin, { ...(pan ? { pan } : {}), ...(addressState ? { addressState } : {}) });
      },
    },
    {
      name: "check.pan",
      description: "PAN format and holder type (4th letter: P person, C company, F firm…)",
      risk: "read",
      idempotent: true,
      input: z.object({ pan: z.string() }),
      output: "{ valid, pan, holderCode, holderType, issues }",
      async run({ pan }) {
        return checkPan(pan);
      },
    },
    {
      name: "check.ifsc",
      description: "Is this IFSC a real bank branch? (offline RBI/Razorpay dataset)",
      risk: "read",
      idempotent: true,
      input: z.object({ ifsc: z.string() }),
      output: "{ valid, ifsc, known, bankName, issues }",
      async run({ ifsc }) {
        return checkIfsc(ifsc);
      },
    },
    {
      name: "rules.contractor_tds",
      description: "Contractor TDS under Sec. 393 (ex-194C): 1% individual/HUF, 2% others, 20% without PAN; thresholds ₹30,000 / ₹1,00,000",
      risk: "read",
      idempotent: true,
      input: z.object({ pan: z.string().optional(), amount: z.number(), paidEarlierThisYear: z.number().optional(), earlierPaidWithoutTds: z.number().optional() }),
      output: "{ applicable, rate, tds, catchUp, reason }",
      async run(i) {
        return contractorTds(i);
      },
    },
    {
      name: "rules.msme_deadline",
      description: "MSME payment deadline under Sec. 43B(h): micro/small within 15 days, or the written agreement (max 45)",
      risk: "read",
      idempotent: true,
      input: z.object({ category: z.enum(["micro", "small", "medium", "none"]), acceptedOn: z.string(), agreedDays: z.number().optional() }),
      output: "{ applies, dueOn, daysLeft, status: not_applicable|ok|due_soon|overdue, reason }",
      async run(i) {
        return msmeDeadline({ ...i, today: deps.today });
      },
    },

    /* ---------------------------------------------------------- government / bank */
    {
      name: "gov.gstin_status",
      description: "GST portal: registration status and legal name for a GSTIN",
      risk: "read",
      idempotent: true,
      input: z.object({ gstin: z.string() }),
      output: "{ gstin, legalName, status: Active|Cancelled|Suspended, registeredOn, stateCode }",
      async run({ gstin }, ctx) {
        const r = await client.json<{ gstin: string; legalName: string; status: string }>("gst", "GET", `/api/taxpayers/${enc(gstin)}`);
        ctx.evidence({ kind: "api_response", summary: `GST portal: ${r.gstin} is ${r.status}, legal name ${r.legalName}`, source: `gst:${r.gstin}`, fields: r as unknown as Record<string, unknown> });
        return r;
      },
    },
    {
      name: "udyam.lookup",
      description: "Udyam portal: verify an MSME registration number",
      risk: "read",
      idempotent: true,
      input: z.object({ number: z.string() }),
      output: "{ number, enterpriseName, category: micro|small|medium, status }",
      async run({ number }, ctx) {
        const r = await client.json<{ number: string; enterpriseName: string; category: string; status: string }>("udyam", "GET", `/api/udyam/${enc(number)}`);
        ctx.evidence({ kind: "api_response", summary: `Udyam: ${r.number} = ${r.enterpriseName}, ${r.category}, ${r.status}`, source: `udyam:${r.number}` });
        return r;
      },
    },
    {
      name: "bank.penny_drop",
      description: "Verify the account holder's name for an account number + IFSC (₹1 validation)",
      risk: "read",
      idempotent: true,
      input: z.object({ accountNumber: z.string(), ifsc: z.string() }),
      output: "{ ok, nameAtBank, accountNumber, ifsc } or { ok: false, reason }",
      async run(i, ctx) {
        const r = await client.json<{ ok: boolean; nameAtBank?: string; reason?: string }>("bank", "POST", "/api/beneficiary/validate", i);
        ctx.evidence({
          kind: "api_response",
          summary: r.ok ? `Penny-drop ${i.accountNumber}/${i.ifsc}: holder "${r.nameAtBank}"` : `Penny-drop ${i.accountNumber}/${i.ifsc} failed: ${r.reason}`,
          source: `bank:penny-drop:${i.accountNumber}`,
        });
        return r;
      },
    },
    {
      name: "bank.verify_guarantee",
      description: "Ask the issuing bank to confirm a bank guarantee by its number",
      risk: "read",
      idempotent: true,
      input: z.object({ number: z.string() }),
      output: "{ confirmed: true, issuingBank, amount, validUntil } or { confirmed: false, message }",
      async run({ number }, ctx) {
        const r = await client.json<{ confirmed: boolean; message?: string; issuingBank?: string; validUntil?: string }>("bank", "POST", "/api/guarantees/verify", { number });
        ctx.evidence({ kind: "api_response", summary: r.confirmed ? `Guarantee ${number} confirmed by ${r.issuingBank}, valid until ${r.validUntil}` : `Guarantee ${number} NOT confirmed: ${r.message}`, source: `bank:bg:${number}` });
        return r;
      },
    },

    /* ---------------------------------------------------------- vendor master */
    {
      name: "vendor.search",
      description: "Search the vendor master by name, id, PAN, GSTIN or email (empty q = all vendors)",
      risk: "read",
      idempotent: true,
      input: z.object({ q: z.string().optional() }),
      output: "{ vendors: [{ id, legalName, pan, gstin, status, email, phone, bank: { accountNumber, ifsc, holderName }, udyam: { number, category }, paymentsOnHold }] }",
      async run({ q }) {
        const vs = await client.json<VendorRec[]>("erp", "GET", `/api/vendors?q=${enc(q ?? "")}`);
        dir.rememberVendors(vs);
        return { vendors: vs };
      },
    },
    {
      name: "vendor.get",
      description: "Read one vendor with its change history",
      risk: "read",
      idempotent: true,
      input: z.object({ id: z.string() }),
      output: "{ id, legalName, status, pan, gstin, email, phone, bank, udyam, history: [{ at, by, field, before, after, source }] }",
      async run({ id }) {
        const v = await client.json<VendorRec>("erp", "GET", `/api/vendors/${enc(id)}`);
        dir.rememberVendors([v]);
        return v;
      },
    },
    {
      name: "vendor.create_pending",
      description: "Create a vendor in Pending status (cannot be paid until a human activates it)",
      risk: "write",
      idempotent: false,
      input: z.object({
        legalName: z.string(),
        tradeName: z.string().optional(),
        pan: z.string().optional(),
        gstin: z.string().optional(),
        address: z.string(),
        state: z.string(),
        email: z.string(),
        phone: z.string(),
        bank: z.object({ accountNumber: z.string(), ifsc: z.string(), holderName: z.string() }),
        udyam: z.object({ number: z.string(), category: z.enum(["micro", "small", "medium", "none"]) }).optional(),
      }),
      output: "{ id, status: pending }",
      subjects: (i) => [nameKey(i.legalName)],
      async run(input, ctx) {
        const v = await client.json<VendorRec>("erp", "POST", "/api/vendors", input);
        dir.rememberVendors([v]);
        ctx.evidence({ kind: "record", summary: `ERP: created ${v.id} ${v.legalName} as Pending`, source: `erp:vendor:${v.id}` });
        return v;
      },
    },
    {
      name: "vendor.activate",
      description: "Activate a Pending vendor (irreversible, maker-checker: needs your approval)",
      risk: "irreversible",
      idempotent: false,
      input: z.object({ id: z.string() }),
      subjects: ({ id }) => [vendorKey(id)],
      async run({ id }, ctx) {
        const v = await client.json<VendorRec>("erp", "POST", `/api/vendors/${enc(id)}/activate`, { approvedBy: ctx.approval?.decidedBy });
        ctx.evidence({ kind: "record", summary: `ERP: ${v.id} activated, approved by ${v.approvedBy}`, source: `erp:vendor:${v.id}` });
        return { id: v.id, status: v.status, approvedBy: v.approvedBy };
      },
    },
    {
      name: "vendor.hold_payments",
      description: "Put all payments to a vendor on hold, with a reason",
      risk: "write",
      idempotent: true,
      protective: true,
      input: z.object({ id: z.string(), reason: z.string() }),
      subjects: ({ id }) => [vendorKey(id)],
      async run({ id, reason }, ctx) {
        const v = await client.json<VendorRec>("erp", "POST", `/api/vendors/${enc(id)}/hold`, { reason });
        ctx.evidence({ kind: "record", summary: `ERP: payments to ${v.id} on hold: ${reason}`, source: `erp:vendor:${v.id}` });
        return { id: v.id, paymentsOnHold: v.paymentsOnHold };
      },
    },
    {
      name: "match.find_duplicates",
      description: "Find existing vendors that may be the same party (same GSTIN / PAN / bank account, or similar name). When checking a vendor already in the master, pass its id as excludeId so it doesn't match itself",
      risk: "read",
      idempotent: true,
      input: z.object({ name: z.string(), pan: z.string().optional(), gstin: z.string().optional(), bankAccount: z.string().optional(), excludeId: z.string().optional() }),
      output: "{ candidates: [{ id, legalName, score, reasons }] }",
      async run({ excludeId, ...probe }) {
        const vs = await client.json<VendorRec[]>("erp", "GET", "/api/vendors?q=");
        dir.rememberVendors(vs);
        // A vendor is never its own duplicate. Only by id: an identical second record IS a duplicate.
        const recs = vs.filter((v) => v.id !== excludeId).map((v) => ({ id: v.id, name: v.legalName, pan: v.pan, gstin: v.gstin, bankAccount: v.bank.accountNumber }));
        return { candidates: findDuplicates(probe, recs).map((c) => ({ id: c.record.id, legalName: c.record.name, score: Math.round(c.score * 100) / 100, reasons: c.reasons })) };
      },
    },
    {
      name: "hr.search_employees",
      description: "Search employees; with address or bankAccount, returns employees whose address/account matches (conflict check)",
      risk: "read",
      idempotent: true,
      input: z.object({ q: z.string().optional(), address: z.string().optional(), bankAccount: z.string().optional() }),
      output: "{ employees: [{ id, name, department, address }], matches: [{ id, name, department, address, why }] }",
      async run({ q, address, bankAccount }) {
        const all = await client.json<{ id: string; name: string; department: string; address: string; bankAccount: string }[]>("erp", "GET", `/api/hr/employees?q=${enc(q ?? "")}`);
        const matches: { id: string; name: string; department: string; address: string; why: string }[] = [];
        if (address || bankAccount) {
          const a = address ? normalizeAddress(address) : "";
          for (const e of all) {
            if (bankAccount && e.bankAccount === bankAccount) matches.push({ id: e.id, name: e.name, department: e.department, address: e.address, why: "same bank account" });
            else if (a && addressMatch(a, normalizeAddress(e.address))) matches.push({ id: e.id, name: e.name, department: e.department, address: e.address, why: "same address" });
          }
        }
        return { employees: all.map(({ bankAccount: _b, ...e }) => e), matches };
      },
    },
    {
      name: "lists.check_debarment",
      description: "Check the debarment / blacklist register by name and/or PAN",
      risk: "read",
      idempotent: true,
      input: z.object({ name: z.string().optional(), pan: z.string().optional() }),
      output: "{ hits: [{ name, pan, reason, until }] }",
      async run({ name, pan }) {
        const all = await client.json<{ name: string; pan?: string; reason: string; until: string }[]>("erp", "GET", "/api/lists/debarment?q=");
        const hits = all.filter((d) => (pan && d.pan && d.pan === pan.toUpperCase()) || (name && nameSimilarity(d.name, name) >= 0.9));
        return { hits };
      },
    },

    /* ---------------------------------------------------------- payments */
    {
      name: "payments.list_batches",
      description: "List payment batches (id, title, scheduled date, status, number of lines)",
      risk: "read",
      idempotent: true,
      input: z.object({}),
      output: "{ batches: [{ id, title, scheduledFor, status, lines }] }",
      async run() {
        return { batches: await client.json<unknown[]>("erp", "GET", "/api/payments/batches") };
      },
    },
    {
      name: "payments.get_batch",
      description: "Read a payment batch with all its lines",
      risk: "read",
      idempotent: true,
      input: z.object({ id: z.string() }),
      output: "{ id, title, scheduledFor, status, lines: [{ id, vendorId, billNumber, gross, tds, tdsRate, net, payTo: { accountNumber, ifsc }, acceptedOn, status, note }] }",
      async run({ id }) {
        const b = await client.json<BatchRec>("erp", "GET", `/api/payments/batches/${enc(id)}`);
        dir.rememberBatch(b);
        return b;
      },
    },
    {
      name: "payments.paid_bills",
      description: "Bills already paid, optionally for one vendor",
      risk: "read",
      idempotent: true,
      input: z.object({ vendorId: z.string().optional() }),
      output: "{ bills: [{ vendorId, billNumber, amount, paidOn }] }",
      async run({ vendorId }) {
        return { bills: await client.json<{ vendorId: string; billNumber: string; amount: number; paidOn: string }[]>("erp", "GET", `/api/payments/paid${vendorId ? `?vendorId=${enc(vendorId)}` : ""}`) };
      },
    },
    {
      name: "payments.hold_line",
      description: "Hold one payment line with a reason (cautious and reversible)",
      risk: "write",
      idempotent: true,
      protective: true,
      input: z.object({ batchId: z.string(), lineId: z.string(), reason: z.string() }),
      subjects: lineSubjects,
      async run({ batchId, lineId, reason }, ctx) {
        const l = await client.json<LineRec>("erp", "POST", `/api/payments/batches/${enc(batchId)}/lines/${enc(lineId)}/hold`, { reason });
        ctx.evidence({ kind: "record", summary: `ERP: ${batchId}/${lineId} held: ${reason}`, source: `erp:line:${batchId}/${lineId}` });
        return { id: l.id, status: l.status };
      },
    },
    {
      name: "payments.clear_line",
      description: "Mark one payment line as checked and OK to pay",
      risk: "write",
      idempotent: true,
      input: z.object({ batchId: z.string(), lineId: z.string(), note: z.string().optional() }),
      subjects: lineSubjects,
      async run({ batchId, lineId, note }, ctx) {
        const l = await client.json<LineRec>("erp", "POST", `/api/payments/batches/${enc(batchId)}/lines/${enc(lineId)}/clear`, { note });
        ctx.evidence({ kind: "record", summary: `ERP: ${batchId}/${lineId} cleared`, source: `erp:line:${batchId}/${lineId}` });
        return { id: l.id, status: l.status };
      },
    },
    {
      name: "payments.correct_line",
      description: "Correct the TDS on a payment line (net is recomputed), with a reason",
      risk: "write",
      idempotent: true,
      input: z.object({ batchId: z.string(), lineId: z.string(), tds: z.number(), reason: z.string() }),
      subjects: lineSubjects,
      async run({ batchId, lineId, tds, reason }, ctx) {
        const l = await client.json<LineRec>("erp", "POST", `/api/payments/batches/${enc(batchId)}/lines/${enc(lineId)}/correct`, { tds, reason });
        ctx.evidence({ kind: "record", summary: `ERP: ${batchId}/${lineId} TDS corrected to ₹${l.tds} (net ₹${l.net}): ${reason}`, source: `erp:line:${batchId}/${lineId}` });
        return { id: l.id, status: l.status, tds: l.tds, net: l.net };
      },
    },
    {
      name: "payments.release_batch",
      description: "Release a payment batch to the bank (irreversible; not done by this role)",
      risk: "irreversible",
      idempotent: false,
      input: z.object({ id: z.string() }),
      subjects: ({ id }) => [`batch:${id}`],
      async run() {
        throw new ToolFailure("policy_violation", "Releasing a batch is done by the Finance Head, not by this role");
      },
    },

    ...fileTools(sandbox, rootId),
  ];
  return tools;
}

/** "Label: value" lines → fields (+ the exact line as a quote). First line = title. */
export function parseLabelled(text: string): { title: string; fields: Record<string, string>; quotes: Record<string, string> } {
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const fields: Record<string, string> = {};
  const quotes: Record<string, string> = {};
  for (const l of lines) {
    const m = /^([A-Za-z][A-Za-z0-9 ./(),'-]{1,60}?):\s+(.+)$/.exec(l);
    if (!m) continue;
    const key = m[1]!.trim();
    if (fields[key] === undefined) {
      fields[key] = m[2]!.trim();
      quotes[key] = l;
    }
  }
  return { title: lines[0] ?? "", fields, quotes };
}

/** Same street address? Exact after normalising, or the shorter is contained in the longer (missing state / PIN words). */
function addressMatch(a: string, b: string): boolean {
  if (!a || !b) return false;
  if (a === b) return true;
  const ta = a.split(" ");
  const tb = new Set(b.split(" "));
  const common = ta.filter((t) => tb.has(t)).length;
  return common / Math.min(ta.length, tb.size) >= 0.9;
}

export const folderFor = (name: string) => `Vendor Desk/Bidders/${slugFolder(name)}`;
