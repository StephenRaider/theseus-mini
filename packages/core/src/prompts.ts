import type { Playbook, RolePackManifest } from "@theseus/protocol";
import { z } from "zod";
import type { ToolDescription } from "./gateway.ts";

/**
 * Every prompt the kernel sends, in one place. They are short and ask for
 * JSON against a schema: a weak model fills in a form far more reliably than
 * it writes an essay. Domain knowledge comes from the role pack (manifest,
 * playbooks, tool descriptions), never from here: this file is keel.
 */

export interface OrientSource {
  /** "file" | "email" | "tender" | "batch" | … (pack-defined) */
  kind: string;
  /** Stable pointer: workspace path, message id, record id. */
  ref: string;
  label: string;
  detail?: string;
  date?: string;
}

export interface OrientIndex {
  today: string;
  sources: OrientSource[];
}

/* ------------------------------------------------------------------ route */

export const RouteDecision = z.object({
  inScope: z.boolean().describe("false if the request is outside this role's scope"),
  mode: z
    .enum(["work", "operate", "about_me", "answer", "draft", "lookup"])
    .optional()
    .describe("work = do something with the company's records (default) · operate = a one-off job done by hand across the systems (find, read, type into a web app, submit) · lookup = tell me about specific named vendors/tenders · about_me = a question about you, your skills or how you work · answer = a general question you can answer without any records · draft = write a letter, note, email or document"),
  lookup: z.object({ subjects: z.array(z.string()).describe("The vendors / tenders named, EXACTLY as the user wrote them") }).optional().describe("For mode=lookup"),
  answer: z.string().optional().describe("For mode=answer: the answer, 2–6 sentences"),
  draft: z
    .object({
      document: z.string().describe('What to write, e.g. "formal letter confirming empanelment"'),
      subjects: z.array(z.string()).describe("The vendors / tenders it is about, EXACTLY as the user wrote them"),
    })
    .optional()
    .describe("For mode=draft"),
  refusal: z.string().optional().describe("If out of scope: one polite sentence naming the boundary"),
  tier: z.number().int().min(1).max(3).describe("1 = a whole playbook, 2 = only some steps of a playbook, 3 = no playbook fits (compose from tools)"),
  goal: z.string().describe("The end goal restated in one sentence"),
  successCriteria: z.array(z.string()).max(5),
  playbookId: z.string().optional().describe("For tier 1 or 2"),
  stepIds: z.array(z.string()).optional().describe("For tier 2: only the steps the user asked for"),
  params: z.record(z.string(), z.string()).optional().describe("Values the playbook needs, e.g. batchId"),
  itemFilter: z.array(z.string()).optional().describe("If the user named specific items (names, ids, letters), list them; otherwise omit"),
  assumptions: z.array(z.string()).max(6).describe("Anything you decided without being told"),
  questions: z
    .array(z.object({ text: z.string(), blocking: z.boolean(), default: z.string().optional() }))
    .max(3)
    .describe("Ask only if you truly cannot proceed; prefer an assumption with a default"),
  relevant: z.array(z.object({ ref: z.string(), why: z.string() })).max(8).describe("Sources from the index you will rely on (use their ref)"),
});
export type RouteDecision = z.infer<typeof RouteDecision>;

export function roleIntro(manifest: RolePackManifest, employeeName: string): string {
  const scope = manifest.scope;
  return [
    `You are ${employeeName}, a ${manifest.name}${manifest.company ? ` at ${manifest.company}` : ""}.`,
    scope.does.length ? `You DO: ${scope.does.join("; ")}.` : "",
    scope.does_not.length ? `You DO NOT: ${scope.does_not.join("; ")}.` : "",
    "You never invent facts. You reply with JSON only, following the schema exactly.",
  ]
    .filter(Boolean)
    .join("\n");
}

export function routePrompt(args: {
  request: string;
  index: OrientIndex;
  playbooks: { playbook: Playbook; params: Record<string, string> }[];
  tools: { name: string; description: string }[];
  answers?: { question: string; answer: string }[];
}): string {
  const pbs = args.playbooks
    .map(({ playbook: p, params }) =>
      [
        `- id: ${p.id} · "${p.title}" · use when: ${p.when_to_use.trim()}`,
        `  items: one per ${p.item.kind}`,
        `  steps: ${p.steps.map((s) => `${s.id} (${s.title}${s.needs.length ? `, needs ${s.needs.join("+")}` : ""})`).join(", ")}`,
        `  params: ${Object.entries(params).map(([k, v]) => `${k} = ${v}`).join("; ") || "none"}`,
      ].join("\n"),
    )
    .join("\n");
  const srcs = args.index.sources
    .slice(0, 60)
    .map((s) => `- [${s.kind}] ref=${s.ref} · ${s.label}${s.date ? ` · ${s.date}` : ""}${s.detail ? ` · ${s.detail}` : ""}`)
    .join("\n");
  return [
    `TODAY: ${args.index.today}`,
    `REQUEST: ${args.request}`,
    args.answers?.length ? `ANSWERS THE USER ALREADY GAVE:\n${args.answers.map((a) => `- ${a.question} → ${a.answer}`).join("\n")}` : "",
    "",
    "PLAYBOOKS (procedures you know well):",
    pbs,
    "",
    "TOOLS you could combine for a task no playbook covers (tier 3):",
    args.tools.map((t) => `- ${t.name}: ${t.description}`).join("\n"),
    "",
    "INDEX of what exists right now (files, emails, records):",
    srcs,
    "",
    "Decide how to handle the request:",
    "- Out of the role's scope → inScope=false and a polite refusal.",
    "- A question about YOU (what you can do, your skills, your workflow) → mode=about_me. Run nothing.",
    "- A general question about the job you can answer without looking at any record (\"what is TDS under 194C?\") → mode=answer with the answer. If it needs the company's records, it's work.",
    "- Write / prepare / draft a letter, note, email or document → mode=draft, with draft.subjects. NEVER run a playbook to write a document.",
    "- Information about specific NAMED vendors or tenders (\"everything on X\", \"X's bank details\", \"is X debarred?\") → mode=lookup with lookup.subjects.",
    "- A ONE-OFF job you would do by hand across the systems, step by step: find something (an email, an invoice, a file), read values from it, enter them into a web app (e.g. FinDesk, which has no API), submit or post a form, download or upload a file → mode=operate. Not for checks over a whole list of records (that's work).",
    "- Otherwise mode=work:",
    "- A whole playbook fits → tier 1 with its playbookId.",
    "- The user wants only part of a playbook (\"only check…\", \"just the TDS\") → tier 2, playbookId and the stepIds asked for.",
    "- No playbook fits but the tools can do it → tier 3 (no playbookId).",
    "- Fill params from the request or the index; if you had to pick between options, say so in assumptions.",
    "- If the user named specific items, put them in itemFilter.",
    "- Assumptions: only things you actually had to guess. Never swap a name the user gave for a different one; the systems may simply not be in the index.",
  ]
    .filter((l) => l !== "")
    .join("\n");
}

/* ------------------------------------------------------------------ compose (tier 3) */

export function composePrompt(args: { request: string; goal: string; index: OrientIndex; tools: ToolDescription[]; problems?: string[]; samples?: string }): string {
  return [
    `TODAY: ${args.index.today}`,
    `REQUEST: ${args.request}`,
    `GOAL: ${args.goal}`,
    "",
    "Write a small PROGRAM the system will run for you over every item:",
    "1. items: one READ tool call that returns the list of things to check; give listPath (path to the list in its output), idPath and a labelTemplate.",
    "2. steps: per item, 1–4 tool calls. Use templates like {{item.field}} or {{steps.<stepId>.field}} in args.",
    "   Add flagIf conditions for problems the user cares about (ANY true → flagged) and a flagNote.",
    "   FLAGGED = the items that answer the request. E.g. \"which permits expire within 30 days?\" → flag permits whose expiry is within 30 days.",
    "   If the user only wants information (\"give me everything on X\"), no flagIf is needed: put what they want in columns.",
    "   When checking an EXISTING record against the others (duplicates), exclude the record itself.",
    "   Date ops: days_until_lt / days_until_gt / days_ago_gt / days_ago_lt compare a date field with TODAY (value = a plain number of days, e.g. \"90\").",
    "   A path through a list (steps.x.rows[].date) gives many values: add agg (max = latest, min = earliest, count = how many). A missing date counts as \"never\".",
    "3. columns: what to show in the final table (paths like item.legalName or steps.verify.confirmed).",
    "Use ONLY the tools below, exactly as named, with inputs matching their schemas. Never use irreversible tools.",
    "",
    "SHAPE EXAMPLE (made-up tools, only to show the format):",
    JSON.stringify({
      title: "Overdue library books",
      itemKind: "loan",
      items: { tool: "library.list_loans", args: { branch: "central" }, listPath: "loans", idPath: "loanId", labelTemplate: "{{item.title}} ({{item.member}})", where: [{ path: "item.returned", op: "eq", value: "false" }] },
      steps: [
        { id: "member", title: "Member", tool: "library.get_member", args: { id: "{{item.memberId}}" }, flagIf: [{ path: "steps.member.blocked", op: "eq", value: "true" }], flagNote: "Member {{item.member}} is blocked" },
        { id: "due", title: "Due date", tool: "library.get_loan", args: { id: "{{item.loanId}}" }, flagIf: [{ path: "steps.due.dueOn", op: "days_ago_gt", value: "14" }], flagNote: "Overdue since {{steps.due.dueOn}}" },
      ],
      columns: [{ title: "Book", path: "item.title" }, { title: "Due", path: "steps.due.dueOn" }],
    }),
    "",
    "TOOLS:",
    JSON.stringify(args.tools, null, 0),
    args.problems?.length ? `\nYOUR PREVIOUS PROGRAM HAD PROBLEMS, fix them: ${args.problems.join("; ")}` : "",
    args.samples ? `\nWHAT THE TOOLS REALLY RETURNED on a trial run (use these exact field names):\n${args.samples}` : "",
  ].join("\n");
}

/* ------------------------------------------------------------------ triage */

export function triagePrompt(args: { message: string; status: string; openQuestions: string[] }): string {
  return [
    "A message arrived from your manager while you are working. Classify it.",
    "kinds: question (wants information) · steer (changes the work: hold / skip / prioritise / release something) · info (answers one of your open questions) · new_task (a separate job for later) · stop (cancel the task) · pause · resume · unclear.",
    "For steer, give action and the exact words naming the target. For question, answer briefly using ONLY the status below.",
    "",
    `STATUS:\n${args.status}`,
    args.openQuestions.length ? `YOUR OPEN QUESTIONS:\n${args.openQuestions.map((q) => `- ${q}`).join("\n")}` : "",
    "",
    `MESSAGE: ${args.message}`,
  ].join("\n");
}

/* ------------------------------------------------------------------ summary (tier 3 report) */

export const Summary = z.object({
  summary: z.string().describe("2–5 sentences for the manager. Mention only facts present in the table."),
});

export function summaryPrompt(args: { request: string; table: unknown; flagged: number; total: number; checks?: boolean }): string {
  return [
    `REQUEST: ${args.request}`,
    args.checks === false ? `RESULT: information on ${args.total} record(s); nothing was being checked.` : `RESULT: ${args.flagged} of ${args.total} match what was asked (flagged).`,
    "TABLE (the only facts you may use; every id, number or name you mention must appear here):",
    JSON.stringify(args.table),
    "Answer the request directly, the way a colleague would: lead with the answer. Don't talk about \"items\", \"rows\" or \"flags\".",
  ].join("\n");
}

/* ------------------------------------------------------------------ draft (letters, notes, documents) */

export const DraftDoc = z.object({
  fileName: z.string().describe('Short file name without folder, e.g. "Empanelment letter - Bhadra Concrete Works.docx"'),
  title: z.string().describe("Document title / letter heading"),
  subtitle: z.string().optional().describe('Reference and date line, e.g. "Ref: VD/2026/EMP-04 · 7 October 2026"'),
  blocks: z
    .array(
      z.object({
        kind: z.enum(["heading", "paragraph", "bullets", "table"]),
        text: z.string().optional(),
        items: z.array(z.string()).optional(),
        rows: z.array(z.array(z.string())).optional(),
      }),
    )
    .describe("The body, in order: address block, salutation, paragraphs, sign-off"),
});
export type DraftDoc = z.infer<typeof DraftDoc>;

export function draftPrompt(args: { request: string; document: string; today: string; sender: string; facts: { label: string; kind: string; facts: Record<string, unknown> }[] }): string {
  return [
    `TODAY: ${args.today}`,
    `REQUEST: ${args.request}`,
    `WRITE: ${args.document}`,
    `FROM: ${args.sender}`,
    "",
    "FACTS from the company's records (the ONLY facts you may use; every name, id, number and date you write must come from here, the request or TODAY):",
    JSON.stringify(args.facts, null, 1),
    "",
    "Write it as a formal Indian business document: plain, polite, short. Address the recipient by their legal name and registered details if given.",
    "Do not invent reference numbers, amounts, dates, terms or conditions. TODAY is only the letter's date: never present it as when something happened or takes effect unless FACTS say so. If something normal for such a letter is missing (e.g. a reference number or an effective date), leave a clear placeholder like [Ref. No.] or [Effective date].",
    "Never include bank account numbers, PAN or other sensitive data unless the request asks for them.",
    "Sign off from the Vendor Desk; leave the signatory as [Name, Designation].",
  ].join("\n");
}
