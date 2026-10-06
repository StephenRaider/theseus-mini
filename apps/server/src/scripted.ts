import { ScriptedModel, type ModelRequest } from "@theseus/core";

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

export function scriptedModel(): ScriptedModel {
  return new ScriptedModel([
    /* ---------------- routing */
    {
      purpose: "route",
      match: has(/poem|marketing|flight|holiday|recipe|essay/i),
      reply: route({ inScope: false, tier: 1, goal: "Out of scope", refusal: "That's outside my role: I handle vendor and payment integrity at Kaveri Infra, so I'll leave that one with you." }),
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
