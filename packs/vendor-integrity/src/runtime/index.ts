import { FileSandbox, loadRolePack, type OrientIndex, type OrientSource, type PackRuntime } from "@theseus/core";
import type { PlanItem } from "@theseus/protocol";
import { PACK_DIR } from "../index.ts";
import { nameSimilarity, normalizeName } from "../matchers/names.ts";
import { batchHandlers, discoverBatch, reportBatch, verifyBatch } from "./batch.ts";
import { KaveriClient, type ClientOptions } from "./client.ts";
import { discoverBidders, onboardHandlers, reportOnboarding, verifyOnboarding } from "./onboard.ts";
import { Directory, lineKey, nameKey, vendorIntegrityTools, vendorKey, type EmailRec, type TenderRec, type VendorRec } from "./tools.ts";

export { KaveriClient, type ClientOptions, type SiteKey } from "./client.ts";
export { Directory, parseLabelled } from "./tools.ts";

/**
 * Builds the vendor-integrity role pack's RUNTIME: the declarative pack
 * (pack.yaml + playbooks, loaded and cross-checked by the keel) plus the code
 * planks: tools over the company's systems, step handlers, item discovery,
 * Orient sources, and how words in a chat map to vendors and lines.
 */
export interface VendorIntegrityOptions {
  client: ClientOptions;
  /** Absolute path of the employee's workspace folder (granted root "workspace"). */
  workspaceDir: string;
  /** The world's date (scenario date). */
  today: string;
}

export async function createVendorIntegrityRuntime(opts: VendorIntegrityOptions): Promise<PackRuntime & { directory: Directory }> {
  const { manifest, playbooks } = await loadRolePack(PACK_DIR);
  const client = new KaveriClient(opts.client);
  const sandbox = new FileSandbox([{ id: "workspace", label: "Workspace", path: opts.workspaceDir }]);
  const dir = new Directory();
  const tools = vendorIntegrityTools({ client, sandbox, rootId: "workspace", dir, today: opts.today });
  const vendorName = (id: string) => dir.vendors.get(id)?.legalName;

  const runtime: PackRuntime & { directory: Directory } = {
    manifest,
    playbooks,
    tools,
    directory: dir,
    today: () => opts.today,

    handlers: { "payment-batch-check": batchHandlers, "onboard-contractor": onboardHandlers },

    params: {
      "payment-batch-check": { batchId: "payment batch id, e.g. PB-2026-W41 (see the batches in the index)" },
      "onboard-contractor": { tenderId: "tender id, e.g. T-2026-14 (see the tenders in the index)" },
    },

    resolveParams(playbookId, params, index, request) {
      const assumptions: string[] = [];
      const problems: string[] = [];
      const out = { ...params };
      const pick = (key: string, kind: string, pattern: RegExp, open: (s: OrientSource) => boolean, noun: string) => {
        const known = index.sources.filter((s) => s.kind === kind);
        const exists = (id?: string) => !!id && known.some((s) => s.ref === `${kind}:${id}`);
        if (exists(out[key])) return;
        const inText = request.toUpperCase().match(pattern)?.[0];
        const fuzzy = (id: string) => known.find((s) => s.ref.endsWith(id) || s.ref.endsWith(`-${id.replace(/^\D+-?/, "")}`));
        const fromText = inText ? (exists(inText) ? inText : fuzzy(inText)?.ref.slice(kind.length + 1)) : undefined;
        if (fromText) {
          out[key] = fromText;
          return;
        }
        const candidates = known.filter(open);
        if (candidates.length === 1) {
          out[key] = candidates[0]!.ref.slice(kind.length + 1);
          assumptions.push(`You didn't name the ${noun}, so I took the only open one: ${out[key]}`);
        } else problems.push(candidates.length ? `which ${noun}? (${candidates.map((c) => c.ref.slice(kind.length + 1)).join(", ")})` : `I can't find an open ${noun}`);
      };
      if (playbookId === "payment-batch-check") pick("batchId", "batch", /PB-\d{4}-W\d+|W\d{2}/, (s) => /draft/i.test(s.detail ?? ""), "payment batch");
      if (playbookId === "onboard-contractor") pick("tenderId", "tender", /T-\d{4}-\d+|T-\d+/, (s) => /evaluation/i.test(s.detail ?? ""), "tender");
      return { params: out, assumptions, problems };
    },

    discover: {
      "payment-batch-check": async (ctx) => {
        if (!dir.vendors.size) await ctx.call("vendor.search", { q: "" });
        return discoverBatch(ctx, vendorName);
      },
      "onboard-contractor": discoverBidders,
    },

    async orient({ request, call }): Promise<OrientIndex> {
      const sources: OrientSource[] = [];
      const words = (request.toLowerCase().match(/[a-z0-9-]{4,}/g) ?? []).filter((w) => !STOP.has(w));
      await call("vendor.search", { q: "" }).catch(() => undefined); // directory for steers / constraints
      const { batches } = await call<{ batches: { id: string; title: string; scheduledFor: string; status: string; lines: number }[] }>("payments.list_batches", {}).catch(() => ({ batches: [] }));
      for (const b of batches) sources.push({ kind: "batch", ref: `batch:${b.id}`, label: b.title, detail: `${b.status}, ${b.lines} lines, scheduled ${b.scheduledFor}`, date: b.scheduledFor });
      const { tenders } = await call<{ tenders: TenderRec[] }>("eproc.list_tenders", {}).catch(() => ({ tenders: [] as TenderRec[] }));
      for (const t of tenders) sources.push({ kind: "tender", ref: `tender:${t.id}`, label: t.title, detail: `${t.status}, bidders: ${t.qualifiedBidders.join(", ")}`, ...(t.publishedOn ? { date: t.publishedOn } : {}) });
      const { messages } = await call<{ messages: EmailRec[] }>("mail.search", {}).catch(() => ({ messages: [] as EmailRec[] }));
      const score = (m: EmailRec) => words.filter((w) => `${m.subject} ${m.fromName} ${m.from}`.toLowerCase().includes(w)).length;
      const ranked = [...messages].sort((a, b) => score(b) - score(a) || b.receivedAt.localeCompare(a.receivedAt)).slice(0, 25);
      for (const m of ranked)
        sources.push({ kind: "email", ref: `email:${m.id}`, label: m.subject, detail: `from ${m.fromName} <${m.from}>${m.attachments.length ? `, ${m.attachments.length} attachment(s)` : ""}`, date: m.receivedAt.slice(0, 10) });
      const { files } = await call<{ files: { path: string; modified: string }[] }>("files.list", {}).catch(() => ({ files: [] }));
      for (const f of files.slice(0, 30)) sources.push({ kind: "file", ref: `file:${f.path}`, label: f.path, date: f.modified.slice(0, 10) });
      return { today: opts.today, sources };
    },

    resolveTarget(words) {
      const w = words.trim();
      const line = /\bPL-\d+\b/i.exec(w)?.[0]?.toUpperCase();
      if (line) {
        const keys = [...dir.lineVendor.keys()].filter((k) => k.endsWith(`/${line}`));
        if (keys.length) return { label: line, subjects: keys.map((k) => `line:${k}`) };
      }
      const vid = /\bV-\d+\b/i.exec(w)?.[0]?.toUpperCase();
      const n = normalizeName(w);
      let best: { id: string; name: string; score: number } | undefined;
      for (const v of dir.vendors.values()) {
        const vn = normalizeName(v.legalName);
        const score = v.id === vid ? 2 : n.length >= 4 && (vn.startsWith(n) || vn.includes(` ${n}`)) ? 1.5 : nameSimilarity(v.legalName, w);
        if (score >= 0.85 && (!best || score > best.score)) best = { id: v.id, name: v.legalName, score };
      }
      if (best) return { label: best.name, subjects: [vendorKey(best.id), nameKey(best.name)] };
      const bidder = [...dir.bidders].find((b) => nameSimilarity(b, w) >= 0.85 || normalizeName(b).includes(n));
      if (bidder && n.length >= 4) return { label: bidder, subjects: [nameKey(bidder)] };
      return null;
    },

    itemSubjects(item: PlanItem) {
      const ref = item.ref ?? "";
      if (/^PB-.+\/PL-\d+$/.test(ref)) {
        const [batchId, lineId] = ref.split("/") as [string, string];
        const vid = dir.lineVendor.get(ref);
        return [lineKey(batchId, lineId), ...(vid ? [vendorKey(vid)] : [])];
      }
      return [nameKey(item.label)];
    },

    holdCall(item, reason) {
      const ref = item.ref ?? "";
      if (!/^PB-.+\/PL-\d+$/.test(ref)) return undefined;
      const [batchId, lineId] = ref.split("/") as [string, string];
      return { tool: "payments.hold_line", input: { batchId, lineId, reason } };
    },

    async lookup(subject, ctx, depth = "letter") {
      const w = subject.trim();
      // Tender by id.
      const tid = /\bT-\d{4}-\d+\b/i.exec(w)?.[0]?.toUpperCase();
      if (tid) {
        const t = await ctx.call<TenderRec>("eproc.get_tender", { id: tid }).catch(() => null);
        if (t) return { found: { label: `${t.id} ${t.title}`, kind: "tender", facts: { id: t.id, title: t.title, status: t.status, publishedOn: t.publishedOn, qualifiedBidders: t.qualifiedBidders } }, suggestions: [] };
      }
      if (!dir.vendors.size) await ctx.call("vendor.search", { q: "" }).catch(() => undefined);
      // Vendor by id or name (exact-ish only: a near miss gets suggested, never assumed).
      const vid = /\bV-\d+\b/i.exec(w)?.[0]?.toUpperCase();
      const n = normalizeName(w);
      const scored = [...dir.vendors.values()]
        .map((v) => ({ v, score: v.id === vid ? 2 : normalizeName(v.legalName) === n ? 1.9 : nameSimilarity(v.legalName, w) }))
        .sort((a, b) => b.score - a.score);
      const best = scored[0];
      if (best && best.score >= 0.9) {
        const v = await ctx.call<VendorRec>("vendor.get", { id: best.v.id }).catch(() => best.v);
        if (depth === "full") return { found: await vendorProfile(v, ctx), suggestions: [] };
        // Letters don't need bank details or the audit trail.
        const facts = {
          vendorId: v.id, legalName: v.legalName, ...(v.tradeName ? { tradeName: v.tradeName } : {}), status: v.status,
          address: v.address, state: v.state, email: v.email, phone: v.phone, pan: v.pan, gstin: v.gstin,
          ...(v.udyam ? { msme: `${v.udyam.category} (${v.udyam.number})` } : {}),
          activatedBy: v.approvedBy,
          onboardedOn: v.history.find((h) => h.field === "status" && h.after === "active")?.at?.slice(0, 10),
        };
        return { found: { label: v.legalName, kind: "vendor", facts }, suggestions: [] };
      }
      // A bidder on a tender (not yet a vendor).
      const bidder = [...dir.bidders].find((b) => nameSimilarity(b, w) >= 0.9);
      if (bidder) return { found: { label: bidder, kind: "bidder", facts: { legalName: bidder, note: "a bidder on an open tender, not yet in the vendor master" } }, suggestions: [] };
      return { found: null, suggestions: scored.filter((x) => x.score >= 0.6).slice(0, 3).map((x) => x.v.legalName) };
    },

    verify: { "payment-batch-check": verifyBatch, "onboard-contractor": verifyOnboarding },
    report: { "payment-batch-check": reportBatch, "onboard-contractor": reportOnboarding },
  };
  return runtime;
}

const STOP = new Set(["please", "check", "the", "this", "that", "with", "from", "have", "make", "sure", "run", "for", "and", "all"]);

/* ------------------------------------------------------------------ "tell me everything about X" */

const inr = (n: number) => `₹${n.toLocaleString("en-IN")}`;

/** Everything the desk knows about one vendor, read live from each system, as facts + a readable profile. */
async function vendorProfile(v: VendorRec, ctx: Parameters<NonNullable<PackRuntime["lookup"]>>[1]) {
  const safe = async <T,>(p: Promise<T>) => p.catch(() => undefined);
  const [gst, debar, bills, batches] = await Promise.all([
    v.gstin ? safe(ctx.call<{ status: string; registeredOn?: string; legalName?: string }>("gov.gstin_status", { gstin: v.gstin })) : undefined,
    safe(ctx.call<{ hits: { reason: string; until: string }[] }>("lists.check_debarment", { name: v.legalName, ...(v.pan ? { pan: v.pan } : {}) })),
    safe(ctx.call<{ bills: { billNumber: string; amount: number; paidOn: string }[] }>("payments.paid_bills", { vendorId: v.id })),
    safe(ctx.call<{ batches: { id: string; status: string }[] }>("payments.list_batches", {})),
  ]);
  const open: string[] = [];
  for (const b of batches?.batches ?? []) {
    const full = await safe(ctx.call<{ id: string; lines: { id: string; vendorId: string; billNumber: string; net: number; status: string; note?: string }[] }>("payments.get_batch", { id: b.id }));
    for (const l of full?.lines ?? []) if (l.vendorId === v.id) open.push(`${full!.id} ${l.id}: bill ${l.billNumber}, net ${inr(l.net)}, ${l.status}${l.note ? ` (${l.note})` : ""}`);
  }
  const paid = [...(bills?.bills ?? [])].sort((a, b) => b.paidOn.localeCompare(a.paidOn));
  const changes = v.history.filter((h) => h.field !== "status" || h.after !== "pending").slice(-5);
  const lines = [
    `${v.legalName} (${v.id}) · ${v.status}${v.paymentsOnHold ? ` · PAYMENTS ON HOLD${v.holdReason ? `: ${v.holdReason}` : ""}` : ""}`,
    `Address: ${v.address}${v.state && !v.address.includes(v.state) ? `, ${v.state}` : ""}`,
    `Contact: ${v.email} · ${v.phone}`,
    `PAN: ${v.pan ?? "not on record"} · GSTIN: ${v.gstin ?? "not on record"}${gst ? ` (GST portal: ${gst.status})` : ""}`,
    `Bank: ${v.bank.accountNumber} / ${v.bank.ifsc}, holder "${v.bank.holderName}"`,
    `MSME: ${v.udyam ? `${v.udyam.category} (${v.udyam.number})` : "not registered"}${v.agreedCreditDays ? ` · credit terms ${v.agreedCreditDays} days` : ""}`,
    `Debarment register: ${debar?.hits.length ? debar.hits.map((h) => `DEBARRED until ${h.until}: ${h.reason}`).join("; ") : "not listed"}`,
    `Payments made: ${paid.length ? `${paid.length}, last on ${paid[0]!.paidOn} (${paid.slice(0, 3).map((b) => `${b.billNumber} ${inr(b.amount)} on ${b.paidOn}`).join("; ")})` : "none on record"}`,
    open.length ? `In payment batches: ${open.join("; ")}` : "",
    changes.length ? `Recent changes to the record: ${changes.map((h) => `${h.at.slice(0, 10)} ${h.field} by ${h.by}${h.source ? ` (${h.source})` : ""}`).join("; ")}` : "",
  ].filter(Boolean);
  return { label: v.legalName, kind: "vendor", facts: { ...v, gstPortal: gst?.status, debarred: !!debar?.hits.length, paidBills: paid, inBatches: open }, profile: lines.join("\n") };
}
