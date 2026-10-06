import type { PackCtx, StepCtx, StepHandler, StepOutcome, VerifyResult } from "@theseus/core";
import type { Plan, PlanItem } from "@theseus/protocol";
import { z } from "zod";
import { nameSimilarity } from "../matchers/names.ts";
import { GST_STATE_CODES } from "../validators/states.ts";
import { folderFor, type EmailRec, type TenderRec, type VendorRec } from "./tools.ts";

/**
 * Playbook "onboard-contractor" (empanelment): collect documents from TWO
 * systems (mail + eProcure) into the workspace, read them, validate every
 * field against government and bank sources, check for duplicates and
 * conflicts, create the vendor as Pending, then ask you to activate it
 * (maker-checker). The model is used only if a document can't be read by rule.
 */

type DocKind = "gst" | "pan" | "cheque" | "udyam" | "bidform" | "emd" | "other";
interface Doc {
  path: string;
  kind: DocKind;
  fields: Record<string, string>;
  quotes: Record<string, string>;
  text: string;
  evidenceId?: string;
}

export interface BidderFields {
  legalName: string;
  tradeName?: string;
  gstin: string;
  panCard: string;
  constitution?: string;
  address: string;
  state?: string;
  accountNumber: string;
  ifsc: string;
  holderOnCheque?: string;
  udyamNumber?: string;
  udyamCategory?: "micro" | "small" | "medium" | "none";
  email?: string;
  phone?: string;
  emdGuarantee?: string;
}

const kindOf = (title: string, name: string): DocKind => {
  const t = `${title} ${name}`.toLowerCase();
  if (t.includes("gst reg") || (t.includes("gst") && t.includes("certificate"))) return "gst";
  if (t.includes("permanent account number") || /(^|[^a-z])pan([^a-z]|$)/.test(t)) return "pan";
  if (t.includes("cheque")) return "cheque";
  if (t.includes("udyam")) return "udyam";
  if (t.includes("bid form")) return "bidform";
  if (t.includes("guarantee")) return "emd";
  return "other";
};

async function tenderOf(ctx: StepCtx | PackCtx): Promise<TenderRec> {
  if (!ctx.shared.tender) ctx.shared.tender = await ctx.call<TenderRec>("eproc.get_tender", { id: ctx.params.tenderId });
  return ctx.shared.tender as TenderRec;
}

const collect: StepHandler = async (ctx) => {
  const name = ctx.item.label;
  const folder = folderFor(name);
  const docs: Doc[] = [];
  const evidenceIds: string[] = [];

  // 1. The bidder's own email with registration documents (inbox, not our own domain).
  const { messages } = await ctx.call<{ messages: EmailRec[] }>("mail.search", { q: name });
  const fromThem = messages.filter((m) => m.attachments.length && !/@kaveriinfra\.example$/i.test(m.from));
  const email = fromThem[0];
  if (email) {
    const full = await ctx.call<EmailRec>("mail.read", { id: email.id });
    ctx.data.email = { id: full.id, from: full.from, body: full.body ?? "" };
    for (const a of email.attachments) {
      const { path } = await ctx.call<{ path: string }>("mail.download_attachment", { messageId: email.id, name: a.name, folder });
      docs.push(await readDoc(ctx, path, a.name));
    }
  }

  // 2. The bid form and EMD guarantee from eProcure (contact details, declared PAN, EMD number).
  const tender = await tenderOf(ctx);
  const bid = tender.bidders?.find((b) => nameSimilarity(b.legalName, name) >= 0.9);
  if (bid) {
    ctx.data.bid = { amount: bid.bidAmount, emdGuarantee: bid.emdGuarantee };
    for (const fileName of Object.keys(bid.documents)) {
      const { path } = await ctx.call<{ path: string }>("eproc.download_document", { tenderId: tender.id, name: fileName, folder });
      docs.push(await readDoc(ctx, path, fileName));
    }
  }
  for (const d of docs) if (d.evidenceId) evidenceIds.push(d.evidenceId);
  ctx.data.docs = docs;

  const have = new Set(docs.map((d) => d.kind));
  const missing = (["gst", "pan", "cheque"] as const).filter((k) => !have.has(k));
  const label: Record<string, string> = { gst: "GST registration certificate", pan: "PAN card", cheque: "cancelled cheque / bank letter" };
  if (!email && !docs.length) return { status: "needs_you", note: `No documents found for ${name} in the inbox or on eProcure` };
  if (missing.length) {
    ctx.check("docs_complete", "fail", `Missing: ${missing.map((m) => label[m]).join(", ")}`, evidenceIds);
    return askBidder(ctx, `Missing documents: ${missing.map((m) => label[m]).join(", ")}`, `please send the following for your vendor registration: ${missing.map((m) => label[m]).join(", ")}.`);
  }
  ctx.check("docs_complete", "pass", `${docs.length} documents (${[...have].join(", ")})`, evidenceIds);
  return { status: "done", note: `${docs.length} documents saved to ${folder}`, evidenceIds };
};

async function readDoc(ctx: StepCtx, path: string, name: string): Promise<Doc> {
  const r = await ctx.tryCall<{ title: string; fields: Record<string, string>; quotes: Record<string, string>; text: string }>("doc.extract_fields", { path });
  if (!r.ok) return { path, kind: kindOf("", name), fields: {}, quotes: {}, text: "" };
  return { path, kind: kindOf(r.data.title, name), fields: r.data.fields, quotes: r.data.quotes, text: r.data.text, ...(r.evidenceIds[0] ? { evidenceId: r.evidenceIds[0] } : {}) };
}

/** Field → (document kind, label on the document). */
const FIELD_SOURCES: Record<keyof BidderFields, [DocKind, string][]> = {
  legalName: [["gst", "Legal Name"]],
  tradeName: [["gst", "Trade Name, if any"]],
  gstin: [["gst", "Registration Number (GSTIN)"], ["bidform", "GSTIN"]],
  panCard: [["pan", "Permanent Account Number"]],
  constitution: [["gst", "Constitution of Business"]],
  address: [["gst", "Address of Principal Place of Business"], ["bidform", "Registered address"]],
  state: [],
  accountNumber: [["cheque", "A/c No."]],
  ifsc: [["cheque", "IFSC"]],
  holderOnCheque: [["cheque", "A/c Holder"]],
  udyamNumber: [["udyam", "Udyam Registration Number"]],
  udyamCategory: [["udyam", "Type of Enterprise"]],
  email: [],
  phone: [],
  emdGuarantee: [["emd", "Guarantee No."]],
};
const REQUIRED: (keyof BidderFields)[] = ["legalName", "gstin", "panCard", "address", "accountNumber", "ifsc"];

const ExtractReply = z.object({
  fields: z.array(z.object({ field: z.string(), value: z.string(), quote: z.string().describe("the exact text from the document") })),
});

const extract: StepHandler = async (ctx) => {
  const docs = (ctx.data.docs ?? []) as Doc[];
  const out: Partial<Record<keyof BidderFields, string>> = {};
  const quotes: Record<string, string> = {};
  for (const [field, sources] of Object.entries(FIELD_SOURCES) as [keyof BidderFields, [DocKind, string][]][]) {
    for (const [kind, label] of sources) {
      const d = docs.find((x) => x.kind === kind && x.fields[label]);
      if (d) {
        out[field] = d.fields[label]!;
        quotes[field] = `${d.path}: "${d.quotes[label]}"`;
        break;
      }
    }
  }
  // Contact details from the bid form ("email · phone"), else the sender of the documents email.
  const contact = docs.find((d) => d.kind === "bidform")?.fields["Contact"];
  if (contact) {
    const [em, ph] = contact.split("·").map((s) => s.trim());
    if (em?.includes("@")) out.email = em;
    if (ph) out.phone = ph;
  }
  if (!out.email && ctx.data.email?.from) out.email = ctx.data.email.from;

  // Deterministic first; the model only fills required fields the rules couldn't find.
  const missing = REQUIRED.filter((f) => !out[f]);
  if (missing.length && docs.some((d) => d.text)) {
    try {
      const r = await ctx.json(
        "extract",
        `Extract these fields for ${ctx.item.label}: ${missing.join(", ")}. Quote the exact text you used.\n\n${docs.map((d) => `--- ${d.path}\n${d.text}`).join("\n").slice(0, 12_000)}`,
        ExtractReply,
      );
      for (const f of r.fields) {
        const key = f.field as keyof BidderFields;
        // Trust nothing the document doesn't literally say.
        if (missing.includes(key) && docs.some((d) => d.text.includes(f.quote) && f.quote.includes(f.value))) {
          out[key] = f.value;
          quotes[key] = `model, quoted: "${f.quote}"`;
        }
      }
    } catch {
      /* fall through to needs_you */
    }
  }
  const still = REQUIRED.filter((f) => !out[f]);
  if (still.length) {
    ctx.check("fields_extracted", "fail", `Couldn't find: ${still.join(", ")}`);
    return { status: "needs_you", note: `Couldn't read ${still.join(", ")} from the documents` };
  }
  out.state = Object.values(GST_STATE_CODES).find((s) => out.address!.toLowerCase().includes(s.toLowerCase()));
  if (out.udyamCategory) out.udyamCategory = out.udyamCategory.toLowerCase() as BidderFields["udyamCategory"];
  const fields = out as BidderFields;
  ctx.data.fields = fields;
  const id = ctx.evidence({ kind: "document", summary: `Extracted ${Object.keys(fields).length} fields for ${ctx.item.label}`, source: folderFor(ctx.item.label), fields: { ...fields, quotes } });
  ctx.check("fields_extracted", "pass", `${Object.keys(fields).length} fields, each with its source line`, [id]);
  return { status: "done", note: `GSTIN ${fields.gstin} · PAN ${fields.panCard} · A/c ${fields.accountNumber}`, evidenceIds: [id] };
};

/** Draft a polite email to the bidder; sending it is irreversible, so it goes to you for approval. */
async function askBidder(ctx: StepCtx, problem: string, request: string): Promise<StepOutcome> {
  const to = (ctx.data.fields?.email as string | undefined) ?? (ctx.data.email?.from as string | undefined);
  if (!to) return { status: "needs_you", note: `${problem}. I have no email address on file for them.` };
  const draft = await ctx.call<{ id: string }>("mail.draft_reply", {
    to,
    subject: `Vendor registration ${ctx.params.tenderId ?? ""}: ${ctx.item.label}`.trim(),
    body: `Dear Sir/Madam,\n\nThank you for your documents. To complete your vendor registration, ${request}\n\nRegards,\nVendor Desk, Kaveri Infra Pvt Ltd`,
  });
  return {
    status: "needs_you",
    note: problem,
    approval: {
      title: `Send ${ctx.item.label} an email: ${problem}`,
      reason: `${problem}. I drafted a request (${draft.id}) to ${to}; sending it leaves the company, so it needs your OK.`,
      toolCall: { tool: "mail.send", input: { draftId: draft.id } },
      risk: "irreversible",
      diff: [{ field: "to", before: "", after: to }],
      onApproved: () => ({ status: "needs_you", note: `${problem}. Asked them by email; waiting for their reply.` }),
      onRejected: () => ({ status: "needs_you", note: `${problem}. Not emailed; waiting for your decision.` }),
    },
  };
}

const gstin: StepHandler = async (ctx) => {
  const f = ctx.data.fields as BidderFields;
  const chk = await ctx.call<{ valid: boolean; issues: string[]; warnings: string[]; pan?: string }>("check.gstin", { gstin: f.gstin, pan: f.panCard, ...(f.state ? { addressState: f.state } : {}) });
  const portal = await ctx.tryCall<{ status: string; legalName: string }>("gov.gstin_status", { gstin: f.gstin });
  const problems = [...chk.issues];
  if (!portal.ok) problems.push(`GST portal has no record of ${f.gstin}`);
  else {
    if (portal.data.status !== "Active") problems.push(`GST portal shows ${f.gstin} as ${portal.data.status}`);
    if (nameSimilarity(portal.data.legalName, f.legalName) < 0.9) problems.push(`GST portal legal name "${portal.data.legalName}" ≠ "${f.legalName}"`);
  }
  const ev = portal.ok ? portal.evidenceIds : [];
  if (problems.length) {
    ctx.check("gstin_valid", "fail", problems.join("; "), ev);
    const panIssue = problems.find((p) => p.includes("does not match the PAN"));
    if (panIssue)
      return askBidder(
        ctx,
        `PAN card ${f.panCard} doesn't match the PAN inside GSTIN ${f.gstin} (${chk.pan})`,
        `the PAN on the PAN card you sent (${f.panCard}) does not match the PAN in your GSTIN (${chk.pan}). Please send a clear copy of the correct PAN card, or confirm which number is right.`,
      );
    return { status: "needs_you", note: problems.join("; "), evidenceIds: ev };
  }
  ctx.check("gstin_valid", "pass", `Format, checksum, state and PAN all match${chk.warnings.length ? ` (${chk.warnings.join("; ")})` : ""}`);
  ctx.check("gstin_active", "pass", `Active on the GST portal as ${portal.ok ? portal.data.legalName : ""}`, ev);
  return { status: "done", note: "Valid and Active on the GST portal", evidenceIds: ev };
};

const bank: StepHandler = async (ctx) => {
  const f = ctx.data.fields as BidderFields;
  const ifsc = await ctx.call<{ valid: boolean; issues: string[]; bankName?: string }>("check.ifsc", { ifsc: f.ifsc });
  if (!ifsc.valid) {
    ctx.check("ifsc_valid", "fail", ifsc.issues.join("; "));
    return { status: "needs_you", note: ifsc.issues.join("; ") };
  }
  ctx.check("ifsc_valid", "pass", `${f.ifsc} is ${ifsc.bankName ?? "a known branch"}`);
  const pd = await ctx.tryCall<{ ok: boolean; nameAtBank?: string; reason?: string }>("bank.penny_drop", { accountNumber: f.accountNumber, ifsc: f.ifsc });
  if (!pd.ok || !pd.data.ok || !pd.data.nameAtBank) {
    const why = pd.ok ? `Penny-drop failed: ${pd.data.reason}` : pd.error.message;
    ctx.check("account_name_matches", "fail", why);
    return { status: "needs_you", note: why };
  }
  const nameAtBank = pd.data.nameAtBank;
  ctx.data.nameAtBank = nameAtBank;
  if (nameSimilarity(nameAtBank, f.legalName) >= 0.85) {
    ctx.check("account_name_matches", "pass", `Bank says "${nameAtBank}"`, pd.evidenceIds);
    return { status: "done", note: `Penny-drop: "${nameAtBank}" matches`, evidenceIds: pd.evidenceIds };
  }
  // Proprietorship: an account in the owner's personal name is normal (anti-trap). Ask softly, don't reject.
  const proprietor = /\(Prop\.?\s+([^)]+)\)/i.exec(f.tradeName ?? "")?.[1] ?? (f.panCard[3] === "P" ? f.holderOnCheque : undefined);
  if (f.panCard[3] === "P" && proprietor && nameSimilarity(proprietor, nameAtBank) >= 0.85) {
    const ok = ctx.assume(
      "proprietor_account",
      `The bank account is in the proprietor's personal name (${nameAtBank}). That's normal for a proprietorship; I'll accept it and ask for their signed declaration. OK?`,
      "yes",
    );
    if (/^n/i.test(ok)) return { status: "needs_you", note: `You asked not to accept the proprietor's personal account (${nameAtBank})` };
    ctx.check("account_name_matches", "pass", `Proprietor's own account (${nameAtBank}); declaration to be collected`, pd.evidenceIds);
    return { status: "done", note: `Proprietor's personal account (${nameAtBank}): OK with declaration`, evidenceIds: pd.evidenceIds };
  }
  const why = `Bank says the account holder is "${nameAtBank}", not ${f.legalName}`;
  ctx.check("account_name_matches", "fail", why, pd.evidenceIds);
  return { status: "needs_you", note: why, evidenceIds: pd.evidenceIds };
};

const msme: StepHandler = async (ctx) => {
  const f = ctx.data.fields as BidderFields;
  if (!f.udyamNumber) {
    const said = /not registered under udyam/i.test(ctx.data.email?.body ?? "");
    ctx.check("msme_classified", "pass", said ? "Not MSME (bidder says so in their email)" : "No Udyam certificate: treated as not MSME");
    ctx.data.udyam = undefined;
    return { status: "done", note: said ? "Not MSME (stated in email)" : "No Udyam: not MSME" };
  }
  const r = await ctx.tryCall<{ enterpriseName: string; category: string; status: string }>("udyam.lookup", { number: f.udyamNumber });
  if (!r.ok) return { status: "needs_you", note: `Udyam ${f.udyamNumber} not found on the Udyam portal` };
  if (r.data.status !== "Active" || nameSimilarity(r.data.enterpriseName, f.legalName) < 0.9)
    return { status: "needs_you", note: `Udyam ${f.udyamNumber} is ${r.data.status} for "${r.data.enterpriseName}"`, evidenceIds: r.evidenceIds };
  ctx.data.udyam = { number: f.udyamNumber, category: r.data.category };
  ctx.check("msme_classified", "pass", `Udyam ${r.data.category}`, r.evidenceIds);
  return { status: "done", note: `${r.data.category[0]!.toUpperCase()}${r.data.category.slice(1)} enterprise (Udyam verified)`, evidenceIds: r.evidenceIds };
};

const risk: StepHandler = async (ctx) => {
  const f = ctx.data.fields as BidderFields;
  const pan = f.gstin.slice(2, 12);
  const dup = await ctx.call<{ candidates: { id: string; legalName: string; score: number; reasons: string[] }[] }>("match.find_duplicates", {
    name: f.legalName,
    pan,
    gstin: f.gstin,
    bankAccount: f.accountNumber,
  });
  const strong = dup.candidates.filter((c) => c.score >= 0.95);
  const deb = await ctx.call<{ hits: { name: string; reason: string; until: string }[] }>("lists.check_debarment", { name: f.legalName, pan });
  const emp = await ctx.call<{ matches: { id: string; name: string; department: string; why: string }[] }>("hr.search_employees", { address: f.address, bankAccount: f.accountNumber });

  if (deb.hits.length) {
    ctx.check("not_debarred", "fail", deb.hits.map((h) => `${h.name}: ${h.reason} (until ${h.until})`).join("; "));
    return { status: "failed", note: `Debarred: ${deb.hits[0]!.reason}` };
  }
  ctx.check("not_debarred", "pass", "Not on the debarment register");
  if (strong.length) {
    const what = strong.map((c) => `${c.id} ${c.legalName} (${c.reasons.join(", ")})`).join("; ");
    ctx.check("no_duplicates", "fail", what);
    return { status: "needs_you", note: `Possible duplicate: ${what}` };
  }
  ctx.check("no_duplicates", "pass", dup.candidates.length ? `Only weak name matches: ${dup.candidates.map((c) => c.legalName).join(", ")}` : "No similar vendor");
  if (emp.matches.length) {
    const m = emp.matches[0]!;
    const what = `${ctx.item.label}'s ${m.why === "same bank account" ? "bank account" : "registered address"} matches employee ${m.name} (${m.department}, ${m.id})`;
    ctx.check("no_employee_conflict", "fail", what);
    return {
      status: "needs_you",
      note: `Possible conflict of interest: ${what}`,
      approval: {
        title: `Possible conflict of interest: ${ctx.item.label}`,
        reason: `${what}. This is a classic sign of a vendor linked to an employee. I've stopped this bidder here.`,
        humanTask: `Check with HR / Legal whether ${m.name} is connected to ${ctx.item.label}. Approve only if there is no conflict (or it's declared and cleared).`,
        risk: "write",
        onApproved: () => {
          ctx.data.conflictCleared = `${m.name} (${m.id})`;
          return { status: "done", note: "You cleared the possible conflict" };
        },
        onRejected: () => ({ status: "failed", note: "Stopped: conflict of interest not cleared" }),
      },
    };
  }
  ctx.check("no_employee_conflict", "pass", "Address and bank account match no employee");
  return { status: "done", note: "No duplicates, conflicts or debarment" };
};

const create: StepHandler = async (ctx) => {
  const f = ctx.data.fields as BidderFields;
  // Idempotent by nature: if it already exists (a re-run), reuse it.
  const { vendors } = await ctx.call<{ vendors: VendorRec[] }>("vendor.search", { q: f.gstin });
  let v = vendors.find((x) => x.gstin === f.gstin);
  if (!v) {
    v = await ctx.call<VendorRec>("vendor.create_pending", {
      // The tender's spelling of the name (the GST certificate prints it in capitals).
      legalName: nameSimilarity(ctx.item.label, f.legalName) >= 0.9 ? ctx.item.label : f.legalName,
      ...(f.tradeName && f.tradeName.toLowerCase() !== f.legalName.toLowerCase() ? { tradeName: f.tradeName } : {}),
      pan: f.gstin.slice(2, 12),
      gstin: f.gstin,
      address: f.address,
      state: f.state ?? "",
      email: f.email ?? "",
      phone: f.phone ?? "",
      bank: { accountNumber: f.accountNumber, ifsc: f.ifsc, holderName: (ctx.data.nameAtBank as string | undefined) ?? f.holderOnCheque ?? f.legalName },
      ...(ctx.data.udyam ? { udyam: ctx.data.udyam } : {}),
    });
  }
  ctx.data.vendorId = v.id;
  ctx.check("vendor_pending_created", v.status === "pending" || v.status === "active" ? "pass" : "fail", `${v.id} is ${v.status}`);
  return { status: "done", note: `Created ${v.id} as Pending` };
};

const approve: StepHandler = async (ctx) => {
  const f = ctx.data.fields as BidderFields;
  const id = ctx.data.vendorId as string;
  const v = await ctx.call<VendorRec>("vendor.get", { id });
  if (v.status === "active") return { status: "done", note: `${id} already active` };
  return {
    status: "needs_you",
    note: "Waiting for your approval to activate",
    approval: {
      title: `Activate vendor ${v.legalName} (${id})`,
      reason: [
        "Documents complete; GSTIN valid and Active; bank account verified by penny-drop",
        ctx.data.nameAtBank && nameSimilarity(ctx.data.nameAtBank, f.legalName) < 0.85 ? `(proprietor's own account: ${ctx.data.nameAtBank}, declaration to collect)` : "",
        ctx.data.conflictCleared ? `; possible conflict with ${ctx.data.conflictCleared} cleared by you` : "; no duplicates, conflicts or debarment",
        ". Activation lets the company pay them, so it needs a second person (you).",
      ].join(" ").replace(/ ([;.(])/g, "$1").replace(/\(/, " ("),
      toolCall: { tool: "vendor.activate", input: { id } },
      risk: "irreversible",
      diff: [
        { field: "status", before: "pending", after: "active" },
        { field: "GSTIN", before: null, after: f.gstin },
        { field: "bank", before: null, after: `${f.accountNumber} / ${f.ifsc}` },
      ],
      onApproved: () => {
        ctx.check("maker_checker_approved", "pass", `Activated after your approval`);
        return { status: "done", note: `${id} activated (approved by you)` };
      },
      onRejected: () => ({ status: "skipped", note: `You declined to activate ${id}; it stays Pending` }),
    },
  };
};

export const onboardHandlers: Record<string, StepHandler> = { collect, extract, gstin, bank, msme, risk, create, approve };

export async function discoverBidders(ctx: PackCtx): Promise<PlanItem[]> {
  const t = await tenderOf(ctx);
  return t.qualifiedBidders.map((name, i) => {
    const letter = String.fromCharCode(65 + i);
    return { id: letter, label: name, ref: `${t.id}#${letter}`, held: false };
  });
}

export async function verifyOnboarding(ctx: PackCtx & { plan: Plan }): Promise<VerifyResult[]> {
  const { vendors } = await ctx.call<{ vendors: VendorRec[] }>("vendor.search", { q: "" });
  const problems: string[] = [];
  const activatedWithoutHuman = vendors.filter((v) => v.status === "active" && v.createdBy.startsWith("agent:") && !v.approvedBy?.startsWith("user:"));
  for (const it of ctx.plan.items) {
    const v = vendors.find((x) => nameSimilarity(x.legalName, it.label) >= 0.9 && x.createdBy.startsWith("agent:"));
    const approveCell = ctx.plan.cells[it.id]?.approve;
    if (approveCell?.state === "done" && v?.status !== "active") problems.push(`${it.label}: I reported it active but the ERP says ${v?.status ?? "missing"}`);
    if (approveCell && approveCell.state !== "done" && v?.status === "active") problems.push(`${it.label} is active without a finished approval`);
  }
  return [
    { criterion: "Plan matches the ERP", verdict: problems.length ? "fail" : "pass", detail: problems.length ? problems.join("; ") : "every bidder's ERP status agrees with the plan" },
    {
      criterion: "No vendor activated without a human approver",
      verdict: activatedWithoutHuman.length ? "fail" : "pass",
      detail: activatedWithoutHuman.length ? activatedWithoutHuman.map((v) => v.id).join(", ") : "maker-checker held",
    },
  ];
}

export function reportOnboarding(ctx: PackCtx & { plan: Plan }): string {
  const plan = ctx.plan;
  const lines = plan.items.map((it) => {
    const cells = plan.steps.map((s) => plan.cells[it.id]![s.id]!);
    const stuck = plan.steps.find((s) => ["needs_you", "failed"].includes(plan.cells[it.id]![s.id]!.state));
    const last = [...cells].reverse().find((c) => c.state === "done");
    if (stuck) return `• ${it.label}: ${plan.cells[it.id]![stuck.id]!.state === "failed" ? "stopped" : "needs you"} at ${stuck.title}: ${plan.cells[it.id]![stuck.id]!.note ?? ""}`;
    return `• ${it.label}: ${last?.note ?? "done"}`;
  });
  return [`${ctx.params.tenderId}: ${plan.items.length} bidder${plan.items.length === 1 ? "" : "s"} (${plan.steps.map((s) => s.title).join(" → ")}).`, ...lines].join("\n");
}
