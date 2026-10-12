/**
 * Pure derivations for the trust features: show-working, undo, rehearsal,
 * batch approvals and memory. Components stay thin; the logic is tested in
 * test/trust.test.ts.
 */
import type { Approval, Evidence } from "@theseus/protocol";
import { clock } from "./selectors.ts";
import type { AppState, EffectView, MemoryView, PreviewRowView, ToolCallView, VerificationView } from "./store.ts";

/* ------------------------------------------------------------ show working */

type Result = VerificationView["results"][number];

export interface ReportLine {
  text: string;
  kind: "heading" | "verifier" | "line";
  evidenceIds: string[];
  callIds: string[];
  /** Verification results this line relates to. */
  criteria: (Result & { text: string })[];
}

export const basename = (source: string) => source.split(/[\\/]/).filter(Boolean).pop() ?? source;

/** The final answer of a task: the latest non-user message that belongs to it. */
export function reportOf(s: AppState, taskId: string): { text: string; at: string } | undefined {
  const t = s.tasks[taskId];
  if (!t) return undefined;
  const msgs = (s.messages[t.employeeId] ?? []).filter((m) => m.taskId === taskId && m.from !== "user");
  const last = msgs[msgs.length - 1];
  return last ? { text: last.text, at: last.ts } : undefined;
}

/** Strings in an evidence item that a report line would quote if it relied on it. */
function needles(ev: Evidence): string[] {
  const out: string[] = [];
  for (const v of Object.values(ev.fields ?? {})) {
    if (typeof v === "string" || typeof v === "number") {
      const t = String(v).trim();
      if (t.length >= 4) out.push(t.toLowerCase());
    }
  }
  const b = basename(ev.source);
  if (b.length >= 4) out.push(b.toLowerCase());
  if (ev.summary.length >= 8) out.push(ev.summary.toLowerCase());
  out.push(ev.id.toLowerCase());
  return out;
}

/** Evidence ids that belong to a task: from its tool calls, checks, verification and the evidence event itself. */
export function taskEvidenceIds(s: AppState, taskId: string): string[] {
  const ids = new Set<string>();
  for (const e of s.log) if (e.type === "evidence.added" && e.taskId === taskId) ids.add(e.payload.id);
  for (const c of Object.values(s.toolCalls)) if (c.taskId === taskId) for (const id of c.done?.evidenceIds ?? []) ids.add(id);
  for (const c of s.checks) if (c.taskId === taskId) for (const id of c.evidenceIds) ids.add(id);
  for (const r of s.verifications[taskId]?.results ?? []) for (const id of r.evidenceIds) ids.add(id);
  return s.evidenceOrder.filter((id) => ids.has(id));
}

export function toolCallsOfTask(s: AppState, taskId: string): ToolCallView[] {
  return s.toolCallOrder.map((id) => s.toolCalls[id]!).filter((c) => c.taskId === taskId);
}

/** Link every line of the final report to what supports it. Honest: a line with nothing found has empty arrays. */
export function linkReport(s: AppState, taskId: string): ReportLine[] {
  const rep = reportOf(s, taskId);
  if (!rep) return [];
  const evIds = taskEvidenceIds(s, taskId);
  const calls = toolCallsOfTask(s, taskId);
  const ver = s.verifications[taskId];
  const crit = (r: Result) => ({ ...r, text: s.tasks[taskId]?.successCriteria.find((c) => c.id === r.criterionId)?.text ?? r.criterionId });
  const lines: ReportLine[] = [];
  for (const raw of rep.text.split("\n")) {
    const text = raw.trim();
    if (!text) continue;
    const low = text.toLowerCase();
    const isVerifier = /^verifier:/i.test(text);
    const isHeading = !isVerifier && /:$/.test(text) && text.length <= 40;
    if (isHeading) {
      lines.push({ text, kind: "heading", evidenceIds: [], callIds: [], criteria: [] });
      continue;
    }
    const ev = new Set<string>();
    const cl = new Set<string>();
    const criteria: ReportLine["criteria"] = [];
    if (isVerifier) {
      for (const r of ver?.results ?? []) {
        criteria.push(crit(r));
        for (const id of r.evidenceIds) ev.add(id);
      }
    } else {
      for (const id of evIds) {
        const e = s.evidence[id];
        if (e && needles(e).some((n) => low.includes(n))) ev.add(id);
      }
      for (const r of ver?.results ?? []) {
        const c = crit(r);
        if (c.text.length >= 8 && low.includes(c.text.toLowerCase())) criteria.push(c);
      }
    }
    for (const c of calls) {
      const viaEvidence = (c.done?.evidenceIds ?? []).some((id) => ev.has(id));
      if (viaEvidence || (!isVerifier && c.tool.length >= 5 && low.includes(c.tool.toLowerCase()))) cl.add(c.callId);
    }
    lines.push({ text, kind: isVerifier ? "verifier" : "line", evidenceIds: [...ev], callIds: [...cl], criteria });
  }
  return lines;
}

export const lineHasSource = (l: ReportLine) => l.evidenceIds.length + l.callIds.length + l.criteria.length > 0;

const VERB: Record<Evidence["kind"], string> = {
  document: "read",
  record: "looked up",
  api_response: "fetched",
  screenshot: "captured",
  email: "read",
  text: "noted",
};

/** 'GST certificate p.1 · scan0231.pdf, read at 10:42, says “gstin: 29AAQ…”' */
export function describeEvidence(e: Evidence, timeZone?: string): string {
  const first = Object.entries(e.fields ?? {}).find(([, v]) => typeof v === "string" || typeof v === "number");
  const says = first ? `, says “${first[0].replace(/_/g, " ")}: ${String(first[1])}”` : "";
  return `${e.summary} · ${basename(e.source)}, ${VERB[e.kind]} at ${clock(e.capturedAt, timeZone)}${says}`;
}

export interface WorkingRow {
  evidence: Evidence;
  facts: { key: string; value: string }[];
  calls: ToolCallView[];
  /** What this evidence backs: criteria and checks, in words. */
  supports: string[];
}

/** facts -> evidence -> tool call chain for the Working tab. */
export function workingRows(s: AppState, taskId: string): WorkingRow[] {
  const calls = toolCallsOfTask(s, taskId);
  const ver = s.verifications[taskId];
  return taskEvidenceIds(s, taskId).flatMap((id) => {
    const evidence = s.evidence[id];
    if (!evidence) return [];
    const supports: string[] = [];
    for (const r of ver?.results ?? []) if (r.evidenceIds.includes(id)) supports.push(`${s.tasks[taskId]?.successCriteria.find((c) => c.id === r.criterionId)?.text ?? r.criterionId} (${r.verdict})`);
    for (const c of s.checks) if (c.taskId === taskId && c.evidenceIds.includes(id)) supports.push(`check ${c.checkId} (${c.verdict})`);
    return [
      {
        evidence,
        facts: Object.entries(evidence.fields ?? {}).map(([key, v]) => ({ key: key.replace(/_/g, " "), value: typeof v === "string" ? v : JSON.stringify(v) })),
        calls: calls.filter((c) => c.done?.evidenceIds.includes(id)),
        supports,
      },
    ];
  });
}

export type SourceTarget = { kind: "url"; href: string } | { kind: "image"; src: string } | { kind: "file"; rootId: string; rel: string } | { kind: "none" };

/** How to open an evidence source. Files only for document/screenshot kinds; mail and records show their detail instead. */
export function sourceTarget(e: Evidence): SourceTarget {
  for (const raw of [e.ref, e.source]) {
    if (!raw) continue;
    if (/^data:image\//.test(raw)) return { kind: "image", src: raw };
    if (/^https?:\/\//.test(raw)) return e.kind === "screenshot" && /\.(png|jpe?g|webp|gif)(\?|$)/i.test(raw) ? { kind: "image", src: raw } : { kind: "url", href: raw };
    if (e.kind === "document" || e.kind === "screenshot") {
      const m = /^([\w-]{2,}):(.+)$/.exec(raw);
      if (m && !/^(mail|email|record|erp|api|http|https|mailto)$/i.test(m[1]!)) return { kind: "file", rootId: m[1]!, rel: m[2]! };
    }
  }
  return { kind: "none" };
}

/* ------------------------------------------------------------ undo */

export function effectsOfTask(s: AppState, taskId: string): EffectView[] {
  return s.effectOrder.map((id) => s.effects[id]!).filter((f) => (f.taskId ?? s.toolCalls[f.callId]?.taskId) === taskId);
}

export const isUndone = (f: EffectView) => f.undone?.ok === true;
export const canUndo = (f: EffectView) => !!f.undo && !isUndone(f);
export const undoableCount = (fs: EffectView[]) => fs.filter(canUndo).length;

/* ------------------------------------------------------------ rehearsal */

export interface PreviewGroup {
  tool: string;
  rows: PreviewRowView[];
  headline: string;
}

export function humanTool(tool: string): string {
  const [ns, ...rest] = tool.split(".");
  return rest.length ? `${ns} (${rest.join(" ").replace(/_/g, " ")})` : tool.replace(/_/g, " ");
}

export function groupPreviews(rows: PreviewRowView[]): PreviewGroup[] {
  const by = new Map<string, PreviewRowView[]>();
  for (const r of rows) by.set(r.tool, [...(by.get(r.tool) ?? []), r]);
  return [...by].map(([tool, rs]) => ({
    tool,
    rows: rs,
    headline: rs.length === 1 ? rs[0]!.summary : `${rs.length} changes would be made: ${humanTool(tool)}`,
  }));
}

/** A rehearsal is waiting for a decision. */
export const rehearsalPending = (s: AppState, taskId: string) => s.tasks[taskId]?.rehearsal === "preview";

/* ------------------------------------------------------------ batch approvals */

/** "Activate vendor Shree Ganesh Constructions" -> "activate vendor": leading words up to the first name, number or quote. */
export function titlePattern(title: string): string {
  const words = title.trim().split(/\s+/);
  const out: string[] = [];
  for (let i = 0; i < words.length && out.length < 4; i++) {
    const w = words[i]!;
    if (/[\d"“'‘₹#]/.test(w) || (i > 0 && /^[A-Z]/.test(w))) break;
    out.push(w);
  }
  return (out.length ? out : words.slice(0, 1)).join(" ").toLowerCase();
}

export interface ApprovalGroup {
  key: string;
  label: string;
  tool?: string;
  taskId: string;
  approvals: Approval[];
}

/** Pending approvals that look alike (same task, tool and title pattern). Human-action approvals are never batched. */
export function groupApprovals(pending: Approval[]): ApprovalGroup[] {
  const map = new Map<string, ApprovalGroup>();
  for (const a of pending) {
    if (a.humanTask) continue;
    const pattern = titlePattern(a.title);
    const key = `${a.taskId}|${a.toolCall?.tool ?? ""}|${pattern}`;
    const g = map.get(key) ?? { key, label: pattern.charAt(0).toUpperCase() + pattern.slice(1), ...(a.toolCall ? { tool: a.toolCall.tool } : {}), taskId: a.taskId, approvals: [] };
    g.approvals.push(a);
    map.set(key, g);
  }
  return [...map.values()].filter((g) => g.approvals.length >= 2);
}

/** "Select all in group": if everything is already selected, clear the group; otherwise select it all. */
export function toggleAll(selected: ReadonlySet<string>, ids: string[]): Set<string> {
  const next = new Set(selected);
  const all = ids.every((id) => next.has(id));
  for (const id of ids) {
    if (all) next.delete(id);
    else next.add(id);
  }
  return next;
}

/* ------------------------------------------------------------ memory */

export function memoriesOf(s: AppState, employeeId: string): MemoryView[] {
  return s.memoryOrder.map((id) => s.memories[id]!).filter((m) => m.employeeId === employeeId);
}
