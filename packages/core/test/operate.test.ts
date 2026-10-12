import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { ElementInfo } from "@theseus/browser";
import { describe, expect, it } from "vitest";
import { classifyElement, type UiRiskRule } from "../src/browsertools.ts";
import { FileSandbox } from "../src/files.ts";
import { buildDocx, fileTools } from "../src/filetools.ts";
import { appearsIn, resultText, sourceOf, type Seen } from "../src/operate.ts";

describe("operate: evidence-bound memory", () => {
  const seen = (text: string, ok = true): Seen => ({ turn: 1, subgoal: 0, tool: "files.read_text", args: { path: "a.pdf" }, ok, text, summary: "" });

  it("matches values the way documents write them (₹, Rs., lakh commas, decimals)", () => {
    expect(appearsIn("427160", "Invoice total: Rs. 4,27,160.00")).toBe(true);
    expect(appearsIn("4,27,160", "₹4,27,160")).toBe(true);
    expect(appearsIn("02/11/2026", "Due Date:  02/11/2026")).toBe(true);
    expect(appearsIn("42716", "Invoice total: Rs. 4,27,160.00")).toBe(false); // no partial numbers
    expect(appearsIn("2026-11-02", "Due Date: 02/11/2026")).toBe(false); // a reformatted date is not "seen"
    expect(appearsIn("427160", "The total is 427160.")).toBe(true); // end of a sentence, not a decimal
    expect(appearsIn("27160", "Total 427160")).toBe(false);
  });

  it("a fact is only remembered if its quote is really in something the agent was shown", () => {
    const s = [seen("TAX INVOICE\nInvoice No.:  HSF/2026/0447\nInvoice total:  Rs. 4,27,160.00")];
    expect(sourceOf({ value: "4,27,160.00", quote: "Invoice total:  Rs. 4,27,160.00" }, s)).toBe(s[0]);
    // A made-up value with a real-looking quote is refused…
    expect(sourceOf({ value: "5,00,000", quote: "Invoice total: Rs. 5,00,000" }, s)).toBeUndefined();
    // …and so is a true-looking value seen only in a FAILED result.
    expect(sourceOf({ value: "HSF/2026/0447", quote: "Invoice No.:  HSF/2026/0447" }, [seen("Invoice No.:  HSF/2026/0447", false)])).toBeUndefined();
  });

  it("shows pages as their outline and long text fields as text, not escaped JSON", () => {
    expect(resultText({ url: "http://x/a", title: "A", page: "# Hello\n[e1] button \"Go\"" })).toBe('URL: http://x/a\nTITLE: A\nPAGE:\n# Hello\n[e1] button "Go"');
    const t = resultText({ path: "Inv.pdf", text: "Line one\nLine two" });
    expect(t).toContain("TEXT:\nLine one\nLine two");
  });
});

describe("browser clicks: risk is decided per click, not per verb", () => {
  const rules: UiRiskRule[] = [
    { label: "post to ledger", risk: "irreversible", why: "posting makes the invoice a payable" },
    { label: "delete", url: "/delete", risk: "irreversible" },
    { label: "continue to findesk", risk: "read" },
  ];
  const el = (e: Partial<ElementInfo>): ElementInfo => ({ ref: "e1", role: "button", name: "", tag: "button", title: "T", url: "http://x/p", ...e });
  const post = (action: string) => ({ method: "post", action: `http://x${action}`, fields: [] });

  it("links and GET forms read, POST forms write, the pack's rules mark the irreversible ones", () => {
    expect(classifyElement(el({ role: "link", name: "Invoice register", tag: "a", href: "http://x/invoices" }), rules).risk).toBe("read");
    expect(classifyElement(el({ name: "Search", form: { method: "get", action: "http://x/invoices", fields: [] } }), rules).risk).toBe("read");
    expect(classifyElement(el({ name: "Save as draft", form: post("/invoices") }), rules).risk).toBe("write");
    expect(classifyElement(el({ name: "Post to ledger", form: post("/invoices/AP-1/post") }), rules)).toEqual({ risk: "irreversible", why: "posting makes the invoice a payable" });
    expect(classifyElement(el({ name: "Delete draft", form: post("/invoices/AP-1/delete") }), rules).risk).toBe("irreversible");
    expect(classifyElement(el({ name: "Continue to FinDesk", form: post("/signin") }), rules).risk).toBe("read");
    expect(classifyElement(el({ name: "Do something" }), rules).risk).toBe("write"); // unknown JS button: cautious
  });
});

describe("file tools: search inside documents, read Word", () => {
  it("finds files by name or by the text inside PDFs, Word and CSV files", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "theseus-search-"));
    await fs.mkdir(path.join(root, "Letters"));
    await fs.writeFile(path.join(root, "Letters", "Empanelment.docx"), await buildDocx({ title: "Confirmation", blocks: [{ kind: "paragraph", text: "Bhadra Concrete Works is empanelled." }] }));
    await fs.writeFile(path.join(root, "register.csv"), "vendor,amount\nHoysala Steel,427160\n");
    await fs.writeFile(path.join(root, "hoysala-notes.txt"), "nothing");
    const tools = fileTools(new FileSandbox([{ id: "w", label: "W", path: root }]), "w");
    const ctx = { employeeId: "e", evidence: () => "ev" };
    const search = tools.find((t) => t.name === "files.search")!;
    const read = tools.find((t) => t.name === "files.read_text")!;

    const a = await search.run({ query: "bhadra empanelled" }, ctx);
    expect(a.matches).toEqual([expect.objectContaining({ path: "Letters/Empanelment.docx", where: "content" })]);
    const b = await search.run({ query: "hoysala" }, ctx);
    expect(b.matches.map((m: { path: string; where: string }) => `${m.path}:${m.where}`).sort()).toEqual(["hoysala-notes.txt:name", "register.csv:content"]);
    const doc = await read.run({ path: "Letters/Empanelment.docx" }, ctx);
    expect(doc.text).toBe("Confirmation\nBhadra Concrete Works is empanelled.");
    await fs.rm(root, { recursive: true, force: true });
  });
});

/* ------------------------------------------------------------------ found by the first live Claude run */
import { extractJson } from "../src/model.ts";
import { browserTools } from "../src/browsertools.ts";
import { operateTurnPrompt, operateVerifyPrompt, type OperateState } from "../src/operate.ts";

describe("first live Claude run: replies and arguments real models actually produce", () => {
  it("reads the first JSON value even with text, a second object, or braces in prose around it", () => {
    expect(extractJson('{"a":1}')).toEqual({ a: 1 });
    expect(extractJson('Sure!\n```json\n{"a":1}\n```\nHope that helps.')).toEqual({ a: 1 });
    expect(extractJson('{"a":1}\n{"a":2}')).toEqual({ a: 1 }); // the failure seen live: "Unexpected non-whitespace character after JSON"
    expect(extractJson('{"a":1}\n\nNote: use {curly} braces for objects.')).toEqual({ a: 1 });
    expect(extractJson('The answer is {here}: {"a":{"b":"}"},"c":[1,2]}')).toEqual({ a: { b: "}" }, c: [1, 2] }); // a brace inside a string, prose braces before
    expect(extractJson('[{"x":1}] trailing')).toEqual([{ x: 1 }]);
    expect(() => extractJson("no json at all")).toThrow(/not JSON/);
  });

  it("a click is not rejected when the model fills in `expect` with text (it is system-filled)", () => {
    const click = browserTools({ pool: {} as never, sandbox: {} as never, rootId: "w", rules: [] }).find((t) => t.name === "browser.click")!;
    expect(click.input.safeParse({ ref: "e12", expect: "button Save as draft" }).success).toBe(true);
    expect(click.input.safeParse({ ref: "e12", expect: { role: "button", name: "Save" }, about: "x" }).success).toBe(true);
    expect(click.input.safeParse({ ref: "12" }).success).toBe(false); // refs still must look like e12
  });

  it("the model is not shown system-filled arguments, and is told not to ask permission for what was requested", () => {
    const tools = browserTools({ pool: {} as never, sandbox: {} as never, rootId: "w", rules: [] }).map((t) => ({ name: t.name, description: t.description, risk: t.risk, input: { properties: { ref: {}, expect: {}, about: {} } } as Record<string, unknown> }));
    const state: OperateState = { goal: "g", plan: { subgoals: [{ title: "Post it", doneWhen: "posted" }], successCriteria: ["c"], assumptions: [] }, facts: [], seen: [], turns: 0, inbox: [], notes: [], answers: {} };
    const { prompt } = operateTurnPrompt({ request: "r", today: "2026-10-12", state, subgoal: 0, apps: [], tools });
    expect(prompt).toContain('browser.click (write): ');
    expect(prompt).toContain('args ["ref","about"]');
    expect(prompt).not.toContain('"expect"');
    expect(prompt).toMatch(/Never ask the user for permission to do something the request already asked for/);
  });

  it("the verifier is told to expect values that persist on a fresh read, not one-time confirmation messages", () => {
    // Seen live: it expected the banner "posted to the ledger" (shown once after the click), failing a correct run.
    const p = operateVerifyPrompt({ request: "r", goal: "g", criteria: ["c"], facts: [], actions: [], tools: [], apps: [] });
    expect(p).toMatch(/Expect SHORT exact values that stay on the page/);
    expect(p).toMatch(/NEVER expect a sentence or a confirmation message/);
  });
});
