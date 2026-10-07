import type { ScriptRule } from "@theseus/core";
import { ScriptedModel, type ModelRequest } from "@theseus/core";
import { operateRules } from "./scripted-operate.ts";

/**
 * A scripted stand-in for the model, for tests and for trying the harness
 * with no API key (`pnpm agent --scripted "…"`). It answers the kernel's
 * routing / composing questions for a handful of known requests, exactly in
 * the JSON shape a real model must produce. Everything else (Orient, tools,
 * checks, gateway, verifier) is the real thing.
 */
const req = (r: ModelRequest) => /REQUEST: (.*)/.exec(r.prompt)?.[1] ?? "";
const has = (re: RegExp) => (r: ModelRequest) => re.test(req(r));

const route = (d: Record<string, unknown>) => ({ inScope: true, successCriteria: [], assumptions: [], questions: [], relevant: [], ...d });

export function scriptedModel(extra: ScriptRule[] = []): ScriptedModel {
  return new ScriptedModel([
    ...extra,
    /* ---------------- operate (computer use): the invoice-entry job */
    ...operateRules(),
    /* ---------------- routing */
    {
      purpose: "route",
      match: has(/poem|marketing|flight|holiday|recipe|essay/i),
      reply: route({ inScope: false, tier: 1, goal: "Out of scope", refusal: "That's outside my role: I handle vendor and payment integrity at Kaveri Infra, so I'll leave that one with you." }),
    },
    {
      purpose: "route",
      match: has(/\b(everything|all (the )?info(rmation)?|tell me about|details (of|on|for))\b/i),
      reply: (r: ModelRequest) => {
        const subject = /\b(?:on|about|of|for)\s+([A-Z][\w&.]*(?:\s+[A-Za-z][\w&.]*){0,5}?)\s*[.?!]?$/.exec(req(r).trim())?.[1] ?? "";
        return route({ tier: 3, mode: "lookup", goal: `Everything on ${subject}`, lookup: { subjects: [subject.replace(/\.$/, "")] } });
      },
    },
    {
      purpose: "route",
      match: has(/\b(letter|draft|write|prepare)\b.*\b(doc|document|letter|note|email)\b|\b(letter|note) (to|for)\b/i),
      reply: (r: ModelRequest) => {
        const text = req(r);
        const subject = /\b(?:to|for)\s+([A-Z][\w&.]*(?:\s+[A-Za-z][\w&.]*){0,5}?)(?=\s+(?:and|informing|about|confirming|regarding)\b|[,.]|$)/.exec(text)?.[1] ?? "";
        return route({ tier: 3, mode: "draft", goal: `Draft a formal letter to ${subject}`, draft: { document: "a formal letter confirming successful empanelment", subjects: subject ? [subject] : [] } });
      },
    },
    {
      purpose: "route",
      match: has(/guarantee|\bEMD\b/i),
      reply: route({ tier: 3, goal: "Confirm every T-2026-14 bidder's EMD bank guarantee with the issuing bank and report the ones that don't check out", relevant: [{ ref: "tender:T-2026-14", why: "the tender's bidders and their EMD guarantees" }] }),
    },
    {
      purpose: "route",
      match: has(/dormant|haven'?t been paid|not been paid|inactive vendors/i),
      reply: route({ tier: 3, goal: "List active vendors with no payment in the last 180 days", assumptions: ["'Dormant' = no payment recorded in the last 180 days"] }),
    },
    {
      purpose: "route",
      match: has(/only.*gstin|gstin.*only|just.*gstin/i),
      reply: route({
        tier: 2,
        goal: "Validate the GSTINs of the T-2026-14 bidders",
        playbookId: "onboard-contractor",
        stepIds: ["gstin"],
        params: { tenderId: "T-2026-14" },
        relevant: [{ ref: "tender:T-2026-14", why: "the three qualified bidders" }, { ref: "email:msg_001", why: "Kavya's empanelment request" }],
      }),
    },
    {
      purpose: "route",
      match: has(/empanel|onboard|register/i),
      reply: route({
        tier: 1,
        goal: "Empanel the three qualified bidders of tender T-2026-14",
        playbookId: "onboard-contractor",
        params: { tenderId: "T-2026-14" },
        relevant: [{ ref: "email:msg_001", why: "Kavya asks to empanel the three bidders" }, { ref: "tender:T-2026-14", why: "bid forms and EMD guarantees" }],
      }),
    },
    {
      purpose: "route",
      match: has(/\bTDS\b/i),
      reply: route({ tier: 2, goal: "Recheck TDS on the W41 batch", playbookId: "payment-batch-check", stepIds: ["tds"], params: { batchId: "PB-2026-W41" } }),
    },
    {
      purpose: "route",
      match: has(/batch|payment/i),
      reply: route({
        tier: 1,
        goal: "Integrity-check payment batch PB-2026-W41 before Friday's release",
        playbookId: "payment-batch-check",
        params: { batchId: "PB-2026-W41" },
        relevant: [{ ref: "batch:PB-2026-W41", why: "the batch Anil asked about" }, { ref: "email:msg_018", why: "Anil's request for the integrity check" }],
      }),
    },

    /* ---------------- composing (tier 3) */
    {
      purpose: "compose",
      match: has(/guarantee|\bEMD\b/i),
      reply: {
        title: "EMD guarantee confirmation: T-2026-14",
        itemKind: "bank guarantee",
        items: { tool: "eproc.get_tender", args: { id: "T-2026-14" }, listPath: "bidders", idPath: "emdGuarantee", labelTemplate: "{{item.legalName}}" },
        steps: [
          {
            id: "verify",
            title: "Bank confirms",
            tool: "bank.verify_guarantee",
            args: { number: "{{item.emdGuarantee}}" },
            flagIf: [{ path: "steps.verify.confirmed", op: "eq", value: "false" }],
            flagNote: "{{steps.verify.message}}",
          },
        ],
        columns: [
          { title: "Bidder", path: "item.legalName" },
          { title: "Guarantee", path: "item.emdGuarantee" },
          { title: "Confirmed", path: "steps.verify.confirmed" },
          { title: "Valid until", path: "steps.verify.validUntil" },
        ],
      },
    },
    {
      purpose: "compose",
      match: has(/dormant|haven'?t been paid|not been paid|inactive vendors/i),
      reply: {
        title: "Dormant vendor review",
        itemKind: "vendor",
        items: { tool: "vendor.search", args: { q: "" }, listPath: "vendors", idPath: "id", labelTemplate: "{{item.legalName}} ({{item.id}})", where: [{ path: "item.status", op: "eq", value: "active" }] },
        steps: [
          {
            id: "paid",
            title: "Last paid",
            tool: "payments.paid_bills",
            args: { vendorId: "{{item.id}}" },
            flagIf: [{ path: "steps.paid.bills[].paidOn", agg: "max", op: "days_ago_gt", value: "180" }],
            flagNote: "No payment recorded in the last 180 days",
          },
        ],
        columns: [
          { title: "Vendor", path: "item.legalName" },
          { title: "Bills paid", path: "steps.paid.bills" },
        ],
      },
    },

    /* ---------------- drafting */
    {
      purpose: "draft",
      reply: (r: ModelRequest) => {
        const facts = JSON.parse(/FACTS[^\n]*\n([\s\S]*?)\n\nWrite it/.exec(r.prompt)?.[1] ?? "[]") as { label: string; facts: Record<string, string> }[];
        const v = facts[0]?.facts ?? {};
        const today = /TODAY: (\S+)/.exec(r.prompt)?.[1] ?? "";
        return {
          fileName: `Empanelment letter - ${v.legalName ?? "vendor"}.docx`,
          title: "Confirmation of Empanelment",
          subtitle: `Ref: [Ref. No.] · ${today}`,
          blocks: [
            { kind: "paragraph", text: `To\n${v.legalName ?? ""}\n${v.address ?? ""}` },
            { kind: "paragraph", text: "Dear Sir/Madam," },
            { kind: "paragraph", text: `We are pleased to inform you that ${v.legalName} has been successfully empanelled as an approved vendor of Kaveri Infra Pvt Ltd, under vendor code ${v.vendorId}.` },
            { kind: "table", rows: [["Detail", "On our records"], ["Vendor code", String(v.vendorId)], ["GSTIN", String(v.gstin ?? "")], ["PAN", String(v.pan ?? "")]] },
            { kind: "paragraph", text: "Please quote your vendor code on all invoices and correspondence. Any change to your bank details must be requested in writing on your letterhead and will be confirmed by a call-back before it takes effect." },
            { kind: "paragraph", text: "Yours faithfully,\n[Name, Designation]\nVendor Desk, Kaveri Infra Pvt Ltd" },
          ],
        };
      },
    },

    /* ---------------- summary of a composed task */
    {
      purpose: "summary",
      reply: (r: ModelRequest) => {
        const n = /RESULT: (\d+) of (\d+)/.exec(r.prompt);
        return { summary: n ? `${n[1]} of ${n[2]} items need attention; the details are listed below.` : "Done; details below." };
      },
    },

    /* ---------------- triage fallback */
    { purpose: "triage", reply: { kind: "unclear" } },
  ]);
}
