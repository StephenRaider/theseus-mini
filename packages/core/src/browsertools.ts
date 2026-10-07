import type { BrowserPool, BrowserSession, ElementInfo, Observation, RefInfo } from "@theseus/browser";
import { BrowserError } from "@theseus/browser";
import type { RiskTier } from "@theseus/protocol";
import { z } from "zod";
import { SandboxError, type FileSandbox } from "./files.ts";
import { ToolFailure, type CallContext, type Tool, type ToolRunContext } from "./gateway.ts";

/**
 * Browser tools (keel, any role): the employee operates the company's web
 * apps like a person, through @theseus/browser. Every verb goes through the
 * tool gateway like any other tool, so the same rails apply:
 *
 *  - RISK PER CALL: a click's risk is decided from what the element does, not
 *    from the verb. A link or GET form is a read; a POST form is a write; the
 *    role pack's ui_risks rules mark the irreversible ones ("Post to ledger",
 *    "Release", "Send"), which then wait for a human approval.
 *  - STANDING CONSTRAINTS: a write click's subjects come from the page, the
 *    table row and the form's values, so "hold everything to X" also blocks
 *    a click that would book or pay X.
 *  - EVIDENCE: before/after screenshots of every write, saved as files.
 *  - Typing, selecting and ticking are reads: nothing changes in a system
 *    until a form is submitted, and that submit is the gated action.
 */

export interface UiRiskRule {
  label: string;
  url?: string;
  risk: RiskTier;
  why?: string;
}

export interface BrowserToolsOptions {
  pool: BrowserPool;
  /** Files: downloads land here, screenshots go to Evidence/. */
  sandbox: FileSandbox;
  rootId: string;
  rules: UiRiskRule[];
  /** Entity keys mentioned in a piece of page text (role pack: vendors, lines…). */
  subjectsIn?: (text: string) => string[];
  /** Headers every request carries, per employee (identity for the systems' own rules). */
  headers?: (employeeId: string) => Record<string, string>;
}

/** What the model gets back after every browser action. */
export interface PageView {
  url: string;
  title: string;
  status?: number;
  dialog?: string;
  downloaded?: string;
  page: string;
  note?: string;
}

const Ref = z.string().regex(/^e\d+$/, 'a ref from the page, like "e12"').describe('Element ref from the page outline, e.g. "e12"');
const Expect = z
  .object({ role: z.string(), name: z.string() })
  .optional()
  .describe("Filled in by the system: what the ref was when you saw it");

/** Judge one element: a pack rule if one matches, else what it does. */
export function classifyElement(info: ElementInfo, rules: UiRiskRule[]): { risk: RiskTier; why: string } {
  const target = info.form?.action ?? info.href ?? info.url;
  for (const r of rules) {
    if (!new RegExp(r.label, "i").test(info.name)) continue;
    if (r.url && !new RegExp(r.url, "i").test(target)) continue;
    return { risk: r.risk, why: r.why ?? `"${info.name}" is marked ${r.risk} in the role pack` };
  }
  if (info.role === "link" && !info.form) return { risk: "read", why: "a link only opens a page" };
  if (["textbox", "select", "checkbox", "radio", "file"].includes(info.role)) return { risk: "read", why: "filling a field changes nothing until the form is submitted" };
  if (info.form) return info.form.method === "get" ? { risk: "read", why: "a search / GET form only reads" } : { risk: "write", why: `submits a form (POST ${new URL(info.form.action).pathname})` };
  return { risk: "write", why: "a button with an unknown effect: treated as a change" };
}

function failure(e: unknown): never {
  if (e instanceof ToolFailure) throw e;
  if (e instanceof BrowserError) {
    switch (e.kind) {
      case "stale_ref":
        throw new ToolFailure("ui_changed", e.message, "Use browser.look to see the page as it is now, then pick the element again");
      case "blocked":
        throw new ToolFailure("policy_violation", e.message);
      case "http":
      case "timeout":
        throw new ToolFailure("transient", e.message);
      case "invalid":
        throw new ToolFailure("validation", e.message);
      default:
        throw new ToolFailure("fatal", e.message);
    }
  }
  if (e instanceof SandboxError) throw new ToolFailure(e.code === "not_found" ? "not_found" : "policy_violation", e.message);
  throw e;
}

export function browserTools(o: BrowserToolsOptions): Tool[] {
  const session = (ctx: CallContext): Promise<BrowserSession> => o.pool.session(ctx.employeeId, o.headers?.(ctx.employeeId) ?? { "x-actor": `agent:${ctx.employeeId}` }).catch(failure);
  const shots = new Map<string, number>();

  const view = async (obs: Observation, ctx: ToolRunContext): Promise<PageView> => {
    let downloaded: string | undefined;
    if (obs.download) {
      downloaded = await o.sandbox.writeNew(o.rootId, `Downloads/${obs.download.name.replace(/[\\/:*?"<>|]+/g, "_")}`, obs.download.bytes).catch(failure);
      ctx.evidence({ kind: "document", summary: `Downloaded ${obs.download.name} from ${new URL(obs.url.startsWith("http") ? obs.url : "http://x/").host}`, source: `browser:${obs.url}`, ref: downloaded });
    }
    const notes: string[] = [];
    if (obs.status && obs.status >= 400) notes.push(`The server answered HTTP ${obs.status}.${obs.status >= 500 ? " That's usually temporary: try the same thing again." : ""}`);
    if (obs.truncated) notes.push("The page is long and was cut off; search or filter to see the rest.");
    if (downloaded) notes.push(`The file was saved as ${downloaded}; read it with files.read_text.`);
    return {
      url: obs.url,
      title: obs.title,
      ...(obs.status ? { status: obs.status } : {}),
      ...(obs.dialog ? { dialog: `A confirmation dialog said "${obs.dialog}" and was accepted.` } : {}),
      ...(downloaded ? { downloaded } : {}),
      page: obs.outline,
      ...(notes.length ? { note: notes.join(" ") } : {}),
    };
  };

  /** Screenshot saved as evidence (before/after a change). */
  const screenshot = async (s: BrowserSession, ctx: ToolRunContext, label: string): Promise<string | undefined> => {
    try {
      const jpeg = await s.screenshot();
      const key = ctx.taskId ?? "adhoc";
      const n = (shots.get(key) ?? 0) + 1;
      shots.set(key, n);
      const slug = label.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40);
      const path = await o.sandbox.writeNew(o.rootId, `Evidence/${key}/${String(n).padStart(2, "0")}-${slug}.jpg`, jpeg);
      ctx.evidence({ kind: "screenshot", summary: `${label} (${s.url})`, source: `browser:${s.url}`, ref: path });
      return path;
    } catch {
      return undefined; // evidence must never break the action
    }
  };

  const describe = async (ref: string, ctx: CallContext) => (await session(ctx)).describe(ref).catch(failure);
  const riskOfRef = async ({ ref }: { ref: string }, ctx: CallContext): Promise<RiskTier> => classifyElement(await describe(ref, ctx), o.rules).risk;
  const subjectsOfRef = async ({ ref, about }: { ref: string; about?: string }, ctx: CallContext): Promise<string[]> => {
    if (!o.subjectsIn) return [];
    const info = await describe(ref, ctx);
    const text = [about ?? "", info.name, info.row ?? "", info.heading ?? "", info.title, ...(info.form?.fields.map((f) => f.value) ?? []), info.url].join(" \n ");
    return o.subjectsIn(text);
  };
  const explainRef = async ({ ref }: { ref: string }, ctx: CallContext) => {
    const info = await describe(ref, ctx);
    const { why } = classifyElement(info, o.rules);
    const site = new URL(info.url).host;
    return {
      summary: `Click "${info.name}" on ${info.title || site}${info.heading ? ` (${info.heading})` : ""}: ${why}`,
      fields: [
        { label: "Page", value: info.url },
        ...(info.row ? [{ label: "Row", value: info.row.slice(0, 200) }] : []),
        ...(info.form?.fields.filter((f) => f.value).map((f) => ({ label: f.label || f.name, value: f.value.slice(0, 200) })) ?? []),
      ],
    };
  };

  /** Run a page-changing action with before/after screenshots when it changes something. */
  const changing = async (s: BrowserSession, ctx: ToolRunContext, ref: string, label: string, act: () => Promise<Observation>): Promise<PageView> => {
    const info = await s.describe(ref).catch(failure);
    const risky = classifyElement(info, o.rules).risk !== "read";
    if (risky) await screenshot(s, ctx, `before ${label} ${info.name}`);
    const obs = await act().catch(failure);
    if (risky) await screenshot(s, ctx, `after ${label} ${info.name}`);
    return view(obs, ctx);
  };

  const open: Tool<{ url: string }> = {
    name: "browser.open",
    description: "Open a page in your browser (the company's web apps only). Returns the page as an outline with element refs like [e12]",
    risk: "read",
    idempotent: true,
    input: z.object({ url: z.string().describe("Full address, e.g. http://127.0.0.1:4107/invoices") }),
    output: "{ url, title, status, page }",
    async run({ url }, ctx) {
      const s = await session(ctx);
      const obs = await s.open(url).catch(failure);
      if (obs.status && obs.status >= 500) throw new ToolFailure("transient", `${new URL(obs.url).host} answered HTTP ${obs.status}`);
      return view(obs, ctx);
    },
  };

  const look: Tool<Record<string, never>> = {
    name: "browser.look",
    description: "Look at the current page again (fresh outline and refs)",
    risk: "read",
    idempotent: true,
    input: z.object({}),
    output: "{ url, title, page }",
    async run(_i, ctx) {
      return view(await (await session(ctx)).look().catch(failure), ctx);
    },
  };

  const click: Tool<{ ref: string; about?: string; expect?: RefInfo }> = {
    name: "browser.click",
    description: "Click a link or button by its ref. Saving or posting a form is a change: it is logged, screenshotted, and the irreversible ones wait for approval",
    risk: "write",
    idempotent: false,
    input: z.object({ ref: Ref, about: z.string().optional().describe("Which record this is about, e.g. the vendor or invoice"), expect: Expect }),
    output: "{ url, title, status, dialog, downloaded, page }",
    riskOf: riskOfRef,
    subjects: subjectsOfRef,
    explain: explainRef,
    async pin(i, ctx) {
      const s = await session(ctx);
      return { ...i, expect: i.expect ?? s.refs[i.ref] };
    },
    async run({ ref, expect }, ctx) {
      const s = await session(ctx);
      return changing(s, ctx, ref, "click", () => s.click(ref, expect));
    },
  };

  const type: Tool<{ ref: string; text: string; submit?: boolean; about?: string; expect?: RefInfo }> = {
    name: "browser.type",
    description: "Type text into a field (replaces what's there). submit=true presses Enter afterwards, which submits the form",
    risk: "read",
    idempotent: true,
    input: z.object({ ref: Ref, text: z.string(), submit: z.boolean().optional(), about: z.string().optional(), expect: Expect }),
    output: "{ url, title, page }",
    // Typing alone changes nothing; pressing Enter submits the field's form, so it is judged like that form.
    async riskOf(i, ctx) {
      if (!i.submit) return "read";
      const info = await describe(i.ref, ctx);
      return info.form ? classifyElement({ ...info, role: "button", name: "submit" }, o.rules).risk : "read";
    },
    subjects: (i, ctx) => (i.submit ? subjectsOfRef(i, ctx) : []),
    explain: explainRef,
    async pin(i, ctx) {
      const s = await session(ctx);
      return { ...i, expect: i.expect ?? s.refs[i.ref] };
    },
    async run({ ref, text, submit, expect }, ctx) {
      const s = await session(ctx);
      if (!submit) return view(await s.type(ref, text, { ...(expect ? { expect } : {}) }).catch(failure), ctx);
      return changing(s, ctx, ref, "submit", () => s.type(ref, text, { submit: true, ...(expect ? { expect } : {}) }));
    },
  };

  const fillForm: Tool<Record<string, string>> = {
    name: "browser.fill_form",
    description:
      'Fill SEVERAL fields of a form in one action (nothing is submitted). Args: one entry per field, ref → value, e.g. {"e4": "HSF/2026/0447", "e5": "03/10/2026", "e3": "Hoysala Steel"}. Drop-downs take the option text; checkboxes "true"/"false"',
    risk: "read",
    idempotent: true,
    input: z.record(z.string().regex(/^e\d+$/, 'keys are refs like "e4"'), z.string()).refine((r) => Object.keys(r).length > 0, "give at least one field"),
    output: "{ url, title, page }",
    async run(values, ctx) {
      const s = await session(ctx);
      let obs: Observation | undefined;
      const problems: string[] = [];
      for (const [ref, value] of Object.entries(values)) {
        const role = s.refs[ref]?.role;
        try {
          obs = role === "select" ? await s.select(ref, value) : role === "checkbox" || role === "radio" ? await s.check(ref, /^(true|yes|on|1)$/i.test(value)) : await s.type(ref, value);
        } catch (e) {
          problems.push(`${ref}${s.refs[ref] ? ` (${s.refs[ref]!.name})` : ""}: ${(e as Error).message}`);
        }
      }
      if (!obs) failure(new BrowserError("invalid", `Couldn't fill any field: ${problems.join("; ")}`));
      const v = await view(obs!, ctx);
      return problems.length ? { ...v, note: `${v.note ? `${v.note} ` : ""}NOT filled: ${problems.join("; ")}` } : v;
    },
  };

  const select: Tool<{ ref: string; option: string; expect?: RefInfo }> = {
    name: "browser.select",
    description: "Choose an option in a drop-down by its visible text (a unique part of it is enough)",
    risk: "read",
    idempotent: true,
    input: z.object({ ref: Ref, option: z.string(), expect: Expect }),
    output: "{ url, title, page }",
    async run({ ref, option, expect }, ctx) {
      return view(await (await session(ctx)).select(ref, option, expect).catch(failure), ctx);
    },
  };

  const check: Tool<{ ref: string; checked: boolean; expect?: RefInfo }> = {
    name: "browser.check",
    description: "Tick or untick a checkbox / radio button",
    risk: "read",
    idempotent: true,
    input: z.object({ ref: Ref, checked: z.boolean(), expect: Expect }),
    output: "{ url, title, page }",
    async run({ ref, checked, expect }, ctx) {
      return view(await (await session(ctx)).check(ref, checked, expect).catch(failure), ctx);
    },
  };

  const upload: Tool<{ ref: string; path: string; expect?: RefInfo }> = {
    name: "browser.upload",
    description: "Attach a workspace file to a file field (it is sent when the form is submitted)",
    risk: "read",
    idempotent: true,
    input: z.object({ ref: Ref, path: z.string().describe("Workspace path, e.g. Downloads/Invoice.pdf"), expect: Expect }),
    output: "{ url, title, page }",
    async run({ ref, path, expect }, ctx) {
      const bytes = await o.sandbox.readBytes(o.rootId, path).catch(failure);
      const name = path.split("/").pop()!;
      const mimeType = /\.pdf$/i.test(name) ? "application/pdf" : /\.xlsx$/i.test(name) ? "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" : "application/octet-stream";
      return view(await (await session(ctx)).upload(ref, { name, mimeType, buffer: bytes }, expect).catch(failure), ctx);
    },
  };

  const back: Tool<Record<string, never>> = {
    name: "browser.back",
    description: "Go back to the previous page",
    risk: "read",
    idempotent: false,
    input: z.object({}),
    output: "{ url, title, page }",
    async run(_i, ctx) {
      return view(await (await session(ctx)).back().catch(failure), ctx);
    },
  };

  return [open, look, click, type, fillForm, select, check, upload, back];
}
