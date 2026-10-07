import { z } from "zod";
import type { ToolDescription } from "./gateway.ts";
import type { OrientIndex } from "./prompts.ts";

/**
 * OPERATE mode (computer use): for a one-off job done by hand across the
 * company's systems ("find the latest invoice from X, enter it into FinDesk").
 * No playbook, no list of items: the model plans a few subgoals once, then
 * works them one ACTION at a time, seeing the result of every action before
 * choosing the next (observe → decide → act). The kernel keeps the rails:
 *
 *   - every action goes through the tool gateway (risk per call, approvals,
 *     standing constraints, retries, evidence);
 *   - MEMORY is evidence-bound: a fact is only remembered with an exact quote
 *     of where it was seen, and the kernel checks the quote is really there;
 *   - a subgoal is only "done" with proof that is really on screen;
 *   - repeated failures, budgets and "I need you" stop the loop instead of
 *     letting it spin;
 *   - at the end an independent VERIFIER re-reads the systems fresh and
 *     checks the outcome against the facts and their sources.
 *
 * This file holds the schemas, prompts and pure helpers; the loop itself
 * lives in the kernel (it needs the run's plan, approvals and questions).
 */

/* ------------------------------------------------------------------ schemas */

export const OperatePlan = z.object({
  subgoals: z
    .array(
      z.object({
        title: z.string().describe("Short, max 40 characters, e.g. \"Find the latest Hoysala invoice\""),
        doneWhen: z.string().describe("What you will SEE when it's done, e.g. \"FinDesk shows 'Saved as draft'\""),
      }),
    )
    .min(1)
    .max(7),
  successCriteria: z.array(z.string()).min(1).max(5).describe("How the user would check the end result"),
  assumptions: z.array(z.string()).max(5),
});
export type OperatePlan = z.infer<typeof OperatePlan>;

export const OperateTurn = z.object({
  thinking: z.string().describe("One or two sentences: what you see now and why the next action"),
  remember: z
    .array(
      z.object({
        key: z.string().describe("snake_case name, e.g. invoice_total"),
        value: z.string().describe("The value, as written where you saw it"),
        quote: z.string().describe("The exact text (a line or phrase) where you saw it, copied character for character"),
      }),
    )
    .max(8)
    .optional()
    .describe("Facts you'll need later. Only things you have actually seen."),
  action: z
    .object({ tool: z.string(), args: z.record(z.string(), z.string()) })
    .optional()
    .describe("The ONE next action (tool + args as strings)"),
  subgoalDone: z.object({ proof: z.string().describe("Exact text you can see that shows it's done") }).optional(),
  askUser: z.string().optional().describe("Only if you cannot continue without the user (missing information, an ambiguous choice)"),
  cannot: z.string().optional().describe("If this subgoal cannot be done at all (e.g. the system refuses it as a duplicate): why, in one sentence"),
  report: z.string().optional().describe("Only with the LAST subgoal done: 2–4 sentences for your manager with the key facts"),
});
export type OperateTurn = z.infer<typeof OperateTurn>;

export const OperateVerify = z.object({
  checks: z
    .array(
      z.object({
        criterion: z.string(),
        tool: z.string().describe("A READ tool that shows the outcome fresh (e.g. browser.open of the record's page, mail.read, vendor.get)"),
        args: z.record(z.string(), z.string()),
        expect: z.array(z.string()).min(1).describe("Exact values that must appear in what the tool returns (copy them from MEMORY)"),
      }),
    )
    .min(1)
    .max(5),
});
export type OperateVerify = z.infer<typeof OperateVerify>;

/* ------------------------------------------------------------------ state */

export interface Fact {
  key: string;
  value: string;
  quote: string;
  /** The action whose result showed it. */
  source: { tool: string; args: Record<string, unknown> };
  turn: number;
  evidenceId?: string;
}

export interface Seen {
  turn: number;
  subgoal: number;
  tool: string;
  args: Record<string, unknown>;
  ok: boolean;
  /** What the model was shown (clipped). */
  text: string;
  /** Short line for the history. */
  summary: string;
}

export interface OperateState {
  goal: string;
  plan: OperatePlan;
  facts: Fact[];
  seen: Seen[];
  turns: number;
  /** Messages from the user that arrived mid-work. */
  inbox: string[];
  /** Kernel notes for the next turn (rejected memory, failed proof, repeated failure). */
  notes: string[];
  report?: string;
  /** Answers to askUser, by subgoal index. */
  answers: Record<number, string[]>;
}

export const OPERATE_LIMITS = { turnsPerSubgoal: 20, turnsPerTask: 80, sameFailure: 3 };

/* ------------------------------------------------------------------ helpers */

/** Normalise text for "did it really appear there?" checks: case, spaces, ₹/Rs., thousands separators. */
export function norm(s: string): string {
  return s
    .toLowerCase()
    .replace(/₹|\brs\.?\s*|inr\s*/g, "")
    .replace(/(\d),(?=\d)/g, "$1")
    .replace(/[\s ]+/g, " ")
    .replace(/["'“”‘’]/g, "")
    .trim();
}

/** Does `needle` appear in `hay`? Tolerant of formatting (₹4,27,160.00 contains 427160), never of partial numbers (42716). */
export function appearsIn(needle: string, hay: string): boolean {
  let n = norm(needle);
  if (!n) return false;
  const h = norm(hay);
  // A whole number may be written with decimals (427160 ↔ 427160.00).
  const whole = /^\d+(\.0+)?$/.test(n);
  if (whole) n = n.replace(/\.0+$/, "");
  const esc = n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  // Digit boundaries, but a full stop after a number ("…427160.") is just the end of a sentence.
  const start = /^\d/.test(n) ? "(?<!\\d|\\d\\.)" : "";
  const end = whole ? "(?:\\.0+)?(?!\\.?\\d)" : /\d$/.test(n) ? "(?!\\.?\\d)" : "";
  return new RegExp(`${start}${esc}${end}`).test(h);
}

/** Where (if anywhere) a fact's quote and value were seen. */
export function sourceOf(fact: { value: string; quote: string }, seen: Seen[]): Seen | undefined {
  for (let i = seen.length - 1; i >= 0; i--) {
    const s = seen[i]!;
    if (!s.ok) continue;
    if (appearsIn(fact.quote, s.text) && (appearsIn(fact.value, fact.quote) || appearsIn(fact.value, s.text))) return s;
  }
  return undefined;
}

export function argsLine(args: Record<string, unknown>): string {
  return Object.entries(args)
    .filter(([k]) => k !== "expect")
    .map(([k, v]) => `${k}=${JSON.stringify(v)}`)
    .join(" ")
    .slice(0, 160);
}

/** A tool result as text for the model (pages as their outline, records as JSON), clipped. */
export function resultText(data: unknown, max = 7000): string {
  if (data && typeof data === "object" && "page" in data && typeof (data as { page: unknown }).page === "string") {
    const v = data as { url: string; title: string; status?: number; dialog?: string; downloaded?: string; page: string; note?: string };
    const head = [`URL: ${v.url}`, `TITLE: ${v.title}`, v.status ? `HTTP ${v.status}` : "", v.dialog ?? "", v.downloaded ? `DOWNLOADED: ${v.downloaded}` : "", v.note ? `NOTE: ${v.note}` : ""].filter(Boolean).join("\n");
    const page = v.page.length > max ? `${v.page.slice(0, max)}\n…(cut)` : v.page;
    return `${head}\nPAGE:\n${page}`;
  }
  // Long text fields (a document's text, an email body) are shown as text, not as an escaped JSON string.
  let t: string;
  if (data && typeof data === "object" && !Array.isArray(data)) {
    const long = Object.entries(data).filter(([, v]) => typeof v === "string" && (v.length > 200 || v.includes("\n")));
    const rest = Object.fromEntries(Object.entries(data).filter(([k]) => !long.some(([l]) => l === k)));
    t = [JSON.stringify(rest, null, 1), ...long.map(([k, v]) => `${k.toUpperCase()}:\n${v as string}`)].join("\n");
  } else t = typeof data === "string" ? data : JSON.stringify(data, null, 1);
  return t.length > max ? `${t.slice(0, max)}\n…(cut)` : t;
}

/* ------------------------------------------------------------------ prompts */

const toolLines = (tools: ToolDescription[]) =>
  tools.map((t) => `- ${t.name} (${t.risk}): ${t.description} · args ${JSON.stringify((t.input as { properties?: Record<string, unknown> }).properties ? Object.keys((t.input as { properties: Record<string, unknown> }).properties) : [])}`).join("\n");

export function operatePlanPrompt(args: { request: string; goal: string; index: OrientIndex; tools: ToolDescription[] }): string {
  const srcs = args.index.sources
    .slice(0, 45)
    .map((s) => `- [${s.kind}] ${s.label}${s.date ? ` · ${s.date}` : ""}${s.detail ? ` · ${s.detail}` : ""}`)
    .join("\n");
  return [
    `TODAY: ${args.index.today}`,
    `REQUEST: ${args.request}`,
    `GOAL: ${args.goal}`,
    "",
    "You will do this job yourself, by hand, in the company's systems (web apps, mailbox, files), one action at a time.",
    "First write a short plan: 2–6 SUBGOALS in order, each something you can see is finished. Don't plan clicks; plan outcomes.",
    "Prefer the dedicated tools (mail.*, files.*, vendor.*) when they exist; use the browser for systems that have no tool (like FinDesk).",
    "Anything that can't be undone (posting, sending, releasing) needs the user's approval: plan it as its own subgoal, and ONLY if the request asks for it.",
    "",
    "WHAT EXISTS (apps, emails, files):",
    srcs,
    "",
    "TOOLS:",
    toolLines(args.tools),
  ].join("\n");
}

export function operateTurnPrompt(args: {
  request: string;
  today: string;
  state: OperateState;
  subgoal: number;
  apps: { label: string; url: string; note?: string }[];
  tools: ToolDescription[];
  last?: Seen;
  answers?: string[];
}): string {
  const st = args.state;
  const sg = st.plan.subgoals;
  const history = st.seen.slice(-10).map((s) => `#${s.turn} ${s.ok ? "" : "FAILED "}${s.tool} ${argsLine(s.args)} → ${s.summary}`);
  return [
    `TODAY: ${args.today}`,
    `REQUEST: ${args.request}`,
    `GOAL: ${st.goal}`,
    "",
    "PLAN:",
    ...sg.map((s, i) => `${i < args.subgoal ? "✓" : i === args.subgoal ? "→" : " "} ${i + 1}. ${s.title} (done when: ${s.doneWhen})`),
    `YOU ARE ON SUBGOAL ${args.subgoal + 1}: ${sg[args.subgoal]!.title}`,
    "",
    args.apps.length ? `APPS you can open in the browser:\n${args.apps.map((a) => `- ${a.label}: ${a.url}${a.note ? ` (${a.note})` : ""}`).join("\n")}` : "",
    `MEMORY (facts you saw, with where):\n${st.facts.length ? st.facts.map((f) => `- ${f.key} = ${f.value}   [seen: "${f.quote.slice(0, 90)}"]`).join("\n") : "(nothing yet)"}`,
    st.inbox.length ? `MESSAGES FROM YOUR MANAGER WHILE YOU WORKED (follow them):\n${st.inbox.map((m) => `- ${m}`).join("\n")}` : "",
    args.answers?.length ? `THE USER ANSWERED YOUR QUESTION:\n${args.answers.map((a) => `- ${a}`).join("\n")}` : "",
    history.length ? `RECENT ACTIONS:\n${history.join("\n")}` : "RECENT ACTIONS: none yet",
    st.notes.length ? `SYSTEM NOTES (important):\n${st.notes.map((n) => `- ${n}`).join("\n")}` : "",
    "",
    args.last ? `RESULT OF YOUR LAST ACTION (${args.last.tool}):\n${args.last.text}` : "No action yet: start with the first step of this subgoal.",
    "",
    "RULES:",
    "- Do ONE action per turn and wait for its result. Refs like e12 come from the latest page only.",
    "- Fill a form with ONE browser.fill_form (all fields at once), then submit it with browser.click. Copy values exactly from MEMORY, in the format the form asks for (its hints say e.g. DD/MM/YYYY, digits only).",
    "- If something failed, read the error and fix the cause; don't repeat the same action unchanged.",
    "- remember: every fact needs an exact quote from a result you were shown. Remember the values the user asked for.",
    "- When this subgoal is visibly done, set subgoalDone with the proof text (and remember anything you need later). No action needed in that turn.",
    "- If the system refuses for a business reason (duplicate, inactive vendor), don't force it: set cannot.",
    "- If the user rejected an action, don't try it again.",
    "",
    "TOOLS:",
    toolLines(args.tools),
  ]
    .filter((l) => l !== "")
    .join("\n");
}

export function operateVerifyPrompt(args: { request: string; goal: string; criteria: string[]; facts: Fact[]; actions: string[]; tools: ToolDescription[]; apps: { label: string; url: string }[] }): string {
  return [
    `REQUEST: ${args.request}`,
    `GOAL: ${args.goal}`,
    `SUCCESS CRITERIA:\n${args.criteria.map((c) => `- ${c}`).join("\n")}`,
    `MEMORY (facts that were seen):\n${args.facts.map((f) => `- ${f.key} = ${f.value}`).join("\n") || "(none)"}`,
    `WHAT WAS DONE:\n${args.actions.join("\n") || "(nothing)"}`,
    args.apps.length ? `APPS:\n${args.apps.map((a) => `- ${a.label}: ${a.url}`).join("\n")}` : "",
    "",
    "You are the VERIFIER. Don't trust what was done: choose fresh READ calls that show the real outcome in the systems now,",
    "and the exact values that must appear in them if the job really succeeded (e.g. open the saved record's page and expect its number, amount and due date).",
    "Use only READ tools from this list:",
    toolLines(args.tools),
  ]
    .filter(Boolean)
    .join("\n");
}
