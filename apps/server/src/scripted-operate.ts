import type { ModelRequest, ScriptRule } from "@theseus/core";

/**
 * Scripted stand-in for the model in OPERATE mode, for the brief's example:
 * "find the latest invoice from Hoysala, extract the amount and due date,
 * enter it into FinDesk (and post it)". It is a small REACTIVE policy: each
 * turn it reads the prompt the kernel built (subgoal, memory, the last
 * result: a page outline with refs, an email list, a PDF's text) and picks
 * the next action, exactly in the JSON shape a real model must produce.
 *
 * So a test or an offline demo exercises the real loop end to end: real
 * Chromium, real FinDesk forms and validation, the gateway's risk tiers and
 * approvals, memory checks and the verifier. It reacts to what it sees, so
 * injected faults (an expired session, a 503 on save) are recovered from by
 * observing the page, not by special-casing. Only the "thinking" is canned.
 */

const request = (r: ModelRequest) => /REQUEST: (.*)/.exec(r.prompt)?.[1] ?? "";
const subgoal = (r: ModelRequest) => Number(/YOU ARE ON SUBGOAL (\d+)/.exec(r.prompt)?.[1] ?? "1");
const lastTool = (r: ModelRequest) => /RESULT OF YOUR LAST ACTION \(([^)]+)\)/.exec(r.prompt)?.[1];
const lastResult = (r: ModelRequest) => /RESULT OF YOUR LAST ACTION \([^)]+\):\n([\s\S]*?)\nRULES:/.exec(r.prompt)?.[1] ?? "";
const memory = (r: ModelRequest): Record<string, string> => {
  const sec = /MEMORY \(facts you saw, with where\):\n([\s\S]*?)\n(?:[A-Z]{3,}|RECENT|SYSTEM|THE USER|MESSAGES)/.exec(r.prompt)?.[1] ?? "";
  return Object.fromEntries([...sec.matchAll(/^- (\w+) = (.*?)\s{3}\[seen/gm)].map((m) => [m[1]!, m[2]!]));
};
const appUrl = (r: ModelRequest, label: RegExp) => new RegExp(`- ${label.source}[^:]*: (http\\S+)`).exec(r.prompt)?.[1];
/** The ref of an element in a page outline: [e12] role "name". */
const ref = (page: string, role: string, name: RegExp) => {
  for (const m of page.matchAll(/\[(e\d+)\] (\w+) "([^"]*)"([^\n[]*)/g)) if (m[2] === role && name.test(m[3]!)) return { ref: m[1]!, rest: m[4]! };
  return undefined;
};
const digits = (v: string) => v.replace(/[^\d.]/g, "").replace(/\.00$/, "");

const turn = (thinking: string, more: Record<string, unknown> = {}) => ({ thinking, ...more });
const act = (thinking: string, tool: string, args: Record<string, string>, more: Record<string, unknown> = {}) => turn(thinking, { action: { tool, args }, ...more });

export function operateRules(): ScriptRule[] {
  const isInvoiceJob = (r: ModelRequest) => /invoice/i.test(request(r)) && /findesk|enter|book|post|system/i.test(request(r));
  return [
    {
      purpose: "route",
      match: isInvoiceJob,
      reply: {
        inScope: true,
        mode: "operate",
        tier: 3,
        goal: "Enter the latest Hoysala Steel invoice in FinDesk with its amount and due date",
        successCriteria: [],
        assumptions: ["“Latest” = the most recent invoice email from Hoysala Steel Fabricators"],
        questions: [],
        relevant: [],
      },
    },
    {
      purpose: "operate.plan",
      reply: (r: ModelRequest) => ({
        subgoals: [
          { title: "Find the latest Hoysala invoice email", doneWhen: "the newest invoice email from Hoysala is identified" },
          { title: "Read the invoice", doneWhen: "invoice number, dates and amounts are in memory" },
          { title: "Open FinDesk's invoice form", doneWhen: "the 'Enter supplier invoice' form is on screen" },
          { title: "Enter and save the invoice", doneWhen: "FinDesk says 'Saved as draft'" },
          ...(/\bpost\b/i.test(request(r)) ? [{ title: "Post it to the ledger", doneWhen: "FinDesk shows it as posted" }] : []),
        ],
        successCriteria: ["FinDesk has the latest Hoysala invoice with the right number, amount and due date"],
        assumptions: [],
      }),
    },
    { purpose: "operate.step", reply: (r: ModelRequest) => step(r) },
    {
      purpose: "operate.verify",
      reply: (r: ModelRequest) => {
        const sec = /MEMORY \(facts that were seen\):\n([\s\S]*?)\nWHAT WAS DONE/.exec(r.prompt)?.[1] ?? "";
        const m = Object.fromEntries([...sec.matchAll(/^- (\w+) = (.*)$/gm)].map((x) => [x[1]!, x[2]!]));
        const ap = appUrl(r, /Kaveri FinDesk/) ?? "";
        return {
          checks: [
            {
              criterion: "FinDesk shows the invoice with its number, total and due date",
              tool: "browser.open",
              args: { url: `${ap}/invoices/${m.findesk_doc ?? ""}` },
              expect: [m.invoice_number, digits(m.invoice_total ?? ""), m.due_date].filter(Boolean),
            },
          ],
        };
      },
    },
  ];
}

function step(r: ModelRequest): unknown {
  const n = subgoal(r);
  const tool = lastTool(r);
  const res = lastResult(r);
  const m = memory(r);
  const posting = /\bpost\b/i.test(request(r));

  // 1. Find the latest invoice email.
  if (n === 1) {
    if (tool !== "mail.search") return act("Searching the inbox for Hoysala's emails.", "mail.search", { q: "Hoysala" });
    // One chunk per message (newest first), from its id to the next id.
    const chunks = res.split(/(?="id": "msg_)/).slice(1);
    const msgs = chunks
      .map((c) => [c, /"id": "(msg_\d+)"/.exec(c)?.[1], /"subject": "([^"]*)"/.exec(c)?.[1], /"name": "([^"]+\.pdf)"/.exec(c)?.[1]] as const)
      .filter(([, id, subject, pdf]) => id && pdf && /invoice/i.test(subject ?? ""));
    const top = msgs[0];
    if (!top) return turn("No invoice email from Hoysala.", { cannot: "There is no invoice email from Hoysala Steel in the inbox." });
    const [, id, subject, pdf] = top;
    return turn(`The newest invoice email is ${id}: "${subject}".`, {
      remember: [
        { key: "invoice_email", value: id, quote: id },
        { key: "invoice_pdf", value: pdf, quote: pdf },
      ],
      subgoalDone: { proof: subject },
    });
  }

  // 2. Read the invoice PDF.
  if (n === 2) {
    if (tool !== "mail.download_attachment" && tool !== "files.read_text")
      return act("Downloading the invoice PDF.", "mail.download_attachment", { messageId: m.invoice_email ?? "", name: m.invoice_pdf ?? "", folder: "Invoices" });
    if (tool === "mail.download_attachment") return act("Reading the invoice.", "files.read_text", { path: /"path": "([^"]+)"/.exec(res)?.[1] ?? "" });
    const grab = (label: RegExp) => {
      const x = label.exec(res);
      return x ? { value: x[1]!.trim(), quote: x[0]!.trim() } : undefined;
    };
    const f = {
      invoice_number: grab(/Invoice No\.:\s*(\S+)/),
      invoice_date: grab(/Invoice Date:\s*(\d{2}\/\d{2}\/\d{4})/),
      due_date: grab(/Due Date:\s*(\d{2}\/\d{2}\/\d{4})/),
      taxable_value: grab(/Taxable value:\s*Rs\. ([\d,.]+)/),
      cgst: grab(/CGST @ 9%:\s*Rs\. ([\d,.]+)/),
      sgst: grab(/SGST @ 9%:\s*Rs\. ([\d,.]+)/),
      invoice_total: grab(/Invoice total:\s*Rs\. ([\d,.]+)/),
      work_order: grab(/Work order:\s*(\S+)/),
    };
    return turn(`Invoice ${f.invoice_number?.value}: total Rs. ${f.invoice_total?.value}, due ${f.due_date?.value}.`, {
      remember: Object.entries(f).filter(([, v]) => v).map(([key, v]) => ({ key, ...v })),
      subgoalDone: { proof: f.invoice_total?.quote ?? "Invoice total" },
    });
  }

  const ap = appUrl(r, /Kaveri FinDesk/) ?? "";
  const signIn = ref(res, "button", /Continue to FinDesk/);
  if (signIn && n >= 3) return act("FinDesk wants me to sign in first (single sign-on).", "browser.click", { ref: signIn.ref });

  // 3. Open the entry form.
  if (n === 3) {
    if (/Enter supplier invoice/.test(res)) return turn("The invoice form is open.", { subgoalDone: { proof: "Enter supplier invoice" } });
    return act("Opening FinDesk's invoice entry form.", "browser.open", { url: `${ap}/invoices/new` });
  }

  // 4. Fill and save.
  if (n === 4) {
    const saved = /Saved as draft (AP-\d{4}-\d{4})/.exec(res);
    if (saved) return turn(`Saved as ${saved[1]}.`, { remember: [{ key: "findesk_doc", value: saved[1], quote: saved[0] }], subgoalDone: { proof: saved[0] }, ...(posting ? {} : { report: report(m, saved[1]!) }) });
    if (/Duplicate: invoice/.test(res)) return turn("FinDesk refuses: it's a duplicate.", { cannot: /\[alert\] (Duplicate[^\n]*)/.exec(res)?.[1] ?? "duplicate invoice" });
    if (/TEMPORARILY_UNAVAILABLE|HTTP 50\d/.test(res)) return act("FinDesk had a temporary error; opening the form again.", "browser.open", { url: `${ap}/invoices/new` });
    if (!/Enter supplier invoice/.test(res)) return act("Going to the invoice form.", "browser.open", { url: `${ap}/invoices/new` });
    // Fill every empty field in ONE action (what the prompt asks a model to do), then save.
    const values: Record<string, string> = {};
    const vendor = ref(res, "select", /^Vendor$/);
    if (vendor && /selected="-- select vendor --"/.test(vendor.rest)) values[vendor.ref] = "Hoysala Steel";
    const fields: [RegExp, string][] = [
      [/Supplier invoice no/, m.invoice_number ?? ""],
      [/^Invoice date/, m.invoice_date ?? ""],
      [/^Due date/, m.due_date ?? ""],
      [/^Taxable value/, digits(m.taxable_value ?? "")],
      [/^GST amount/, String(Number(digits(m.cgst ?? "0")) + Number(digits(m.sgst ?? "0")))],
      [/^Invoice total/, digits(m.invoice_total ?? "")],
      [/^Work order/, m.work_order ?? ""],
      [/^Remarks/, `From email ${m.invoice_email ?? ""}`],
    ];
    for (const [name, value] of fields) {
      const f = ref(res, "textbox", name);
      if (f && / value=""/.test(f.rest) && value) values[f.ref] = value;
    }
    if (Object.keys(values).length) return act("Filling in the invoice form from what I read on the PDF.", "browser.fill_form", values);
    const save = ref(res, "button", /Save as draft/);
    if (save) return act("Every field is filled; saving the draft.", "browser.click", { ref: save.ref, about: "Hoysala Steel Fabricators invoice" });
    return turn("I can't find the save button.", { askUser: "FinDesk's form looks different from usual; can you check it?" });
  }

  // 5. Post (irreversible: the gateway asks you first).
  if (n === 5) {
    if (/posted to the ledger/.test(res)) return turn("Posted.", { subgoalDone: { proof: "posted to the ledger" }, report: report(m, m.findesk_doc ?? "", true) });
    if (/REJECTED/.test(res)) return turn("You rejected posting.", { cannot: "You chose not to post it; it stays as a draft." });
    const post = ref(res, "button", /Post to ledger/);
    if (post) return act("Posting the draft to the ledger (needs your OK).", "browser.click", { ref: post.ref, about: "Hoysala Steel Fabricators invoice" });
    return act("Opening the saved document.", "browser.open", { url: `${ap}/invoices/${m.findesk_doc ?? ""}` });
  }
  return turn("Nothing left to do.", { subgoalDone: { proof: "" } });
}

const report = (m: Record<string, string>, doc: string, posted = false) =>
  `Entered Hoysala Steel's latest invoice ${m.invoice_number} in FinDesk as ${doc}${posted ? " and posted it to the ledger" : " (draft)"}: total Rs. ${m.invoice_total}, due on ${m.due_date}.`;
