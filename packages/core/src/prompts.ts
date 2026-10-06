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
    "- A whole playbook fits → tier 1 with its playbookId.",
    "- The user wants only part of a playbook (\"only check…\", \"just the TDS\") → tier 2, playbookId and the stepIds asked for.",
    "- No playbook fits but the tools can do it → tier 3 (no playbookId).",
    "- Fill params from the request or the index; if you had to pick between options, say so in assumptions.",
    "- If the user named specific items, put them in itemFilter.",
  ]
    .filter((l) => l !== "")
    .join("\n");
}

/* ------------------------------------------------------------------ compose (tier 3) */

export function composePrompt(args: { request: string; goal: string; index: OrientIndex; tools: ToolDescription[]; problems?: string[] }): string {
  return [
    `TODAY: ${args.index.today}`,
    `REQUEST: ${args.request}`,
    `GOAL: ${args.goal}`,
    "",
    "Write a small PROGRAM the system will run for you over every item:",
    "1. items: one READ tool call that returns the list of things to check; give listPath (path to the list in its output), idPath and a labelTemplate.",
    "2. steps: per item, 1–4 tool calls. Use templates like {{item.field}} or {{steps.<stepId>.field}} in args.",
    "   Add flagIf conditions for problems the user cares about (ANY true → flagged) and a flagNote.",
    "   Date ops: days_until_lt / days_until_gt / days_ago_gt / days_ago_lt compare a date field with TODAY (value = number of days).",
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

export function summaryPrompt(args: { request: string; table: unknown; flagged: number; total: number }): string {
  return [
    `REQUEST: ${args.request}`,
    `RESULT: ${args.flagged} of ${args.total} items flagged.`,
    "TABLE (the only facts you may use; every id, number or name you mention must appear here):",
    JSON.stringify(args.table),
    "Write the summary.",
  ].join("\n");
}
