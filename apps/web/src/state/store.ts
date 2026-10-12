/**
 * UI state = a fold over the event log. The UI never edits this directly:
 * it sends Commands, the engine (replay simulator now, the real kernel
 * later) answers with events, and `reduce` applies them. Same events in →
 * same screen out, which is what makes replay and audit possible.
 */
import { applyPatch, type Approval, type Employee, type Evidence, type Message, type Plan, type Task, type TheseusEvent } from "@theseus/protocol";

export interface NudgeView {
  id: string;
  employeeId: string;
  taskId?: string;
  itemId?: string;
  text: string;
  at: string;
  ack?: { response: string; at: string };
}

export interface CheckView {
  taskId: string;
  itemId?: string;
  stepId?: string;
  checkId: string;
  verdict: "pass" | "fail" | "uncertain";
  detail: string;
  evidenceIds: string[];
  at: string;
}

export interface ToolCallView {
  callId: string;
  taskId: string;
  itemId?: string;
  stepId?: string;
  tool: string;
  input: unknown;
  at: string;
  done?: { ok: boolean; preview?: string; error?: string; durationMs: number; evidenceIds: string[]; at: string };
}

export interface VerificationView {
  taskId: string;
  results: { criterionId: string; verdict: "pass" | "fail" | "uncertain"; detail: string; evidenceIds: string[] }[];
  at: string;
}

export interface EffectView {
  id: string;
  callId: string;
  taskId?: string;
  tool: string;
  summary: string;
  /** Present = the employee knows how to take it back. Treated as opaque. */
  undo?: { tool: string; input: unknown };
  at: string;
  undone?: { ok: boolean; detail: string; by: string; at: string };
}

export interface PreviewRowView {
  id: string;
  callId: string;
  taskId?: string;
  tool: string;
  input: unknown;
  summary: string;
  at: string;
}

export interface RehearsalOutcome {
  decision: "applied" | "discarded";
  applied: number;
  failed: number;
  by: string;
  at: string;
}

export interface MemoryView {
  id: string;
  employeeId: string;
  text: string;
  taskId?: string;
  at: string;
}

export interface QuestionView {
  id: string;
  employeeId: string;
  taskId?: string;
  itemId?: string;
  text: string;
  blocking: boolean;
  default?: string;
  options: string[];
  at: string;
  answer?: { text: string; by: string; usedDefault: boolean; at: string };
}

export interface ConstraintView {
  id: string;
  employeeId: string;
  taskId?: string;
  text: string;
  subjects: string[];
  at: string;
  lifted?: { reason: string; at: string };
}

export interface OrientView {
  taskId: string;
  found: { kind: string; ref: string; label: string; why?: string }[];
  assumptions: string[];
  at: string;
}

export interface AppState {
  evidence: Record<string, Evidence>;
  evidenceOrder: string[];
  toolCalls: Record<string, ToolCallView>;
  toolCallOrder: string[];
  verifications: Record<string, VerificationView>;
  effects: Record<string, EffectView>;
  effectOrder: string[];
  /** Rehearsal rows per task, in the order they were previewed. */
  previews: Record<string, PreviewRowView[]>;
  rehearsals: Record<string, RehearsalOutcome>;
  /** Live memories (memory.added minus memory.removed), in order. */
  memories: Record<string, MemoryView>;
  memoryOrder: string[];
  /** Questions employees asked you mid-work (Framework Spec §11). */
  questions: Record<string, QuestionView>;
  questionOrder: string[];
  /** Standing instructions ("hold everything to X"), enforced at the tool gateway. */
  constraints: Record<string, ConstraintView>;
  /** What each task looked at before planning, and what it assumed. */
  orients: Record<string, OrientView>;
  /** Model calls so far (live runs spend a daily quota). */
  modelCalls: number;
  employees: Record<string, Employee>;
  /** Display order: Theseus first, then creation order. */
  employeeOrder: string[];
  tasks: Record<string, Task>;
  /** Task ids per employee, oldest first. */
  tasksByEmployee: Record<string, string[]>;
  /** When each task reached "done" (for "Completed …" previews). */
  completedAt: Record<string, string>;
  plans: Record<string, Plan>;
  messages: Record<string, Message[]>;
  approvals: Record<string, Approval>;
  approvalOrder: string[];
  nudges: Record<string, NudgeView>;
  checks: CheckView[];
  /** Every event, for the activity timeline. */
  log: TheseusEvent[];
  /** Last time anything happened per employee (list sorting + time label). */
  lastActivity: Record<string, string>;
}

export const emptyState = (): AppState => ({
  evidence: {},
  evidenceOrder: [],
  toolCalls: {},
  toolCallOrder: [],
  verifications: {},
  effects: {},
  effectOrder: [],
  previews: {},
  rehearsals: {},
  memories: {},
  memoryOrder: [],
  questions: {},
  questionOrder: [],
  constraints: {},
  orients: {},
  modelCalls: 0,
  employees: {},
  employeeOrder: [],
  tasks: {},
  tasksByEmployee: {},
  completedAt: {},
  plans: {},
  messages: {},
  approvals: {},
  approvalOrder: [],
  nudges: {},
  checks: [],
  log: [],
  lastActivity: {},
});

const touch = (s: AppState, employeeId: string | undefined, ts: string) => {
  if (employeeId) s.lastActivity[employeeId] = ts;
};

/** Apply one event. Returns a new state object (shallow copies of what changed). */
export function reduce(prev: AppState, e: TheseusEvent): AppState {
  const s: AppState = { ...prev, log: [...prev.log, e], lastActivity: { ...prev.lastActivity } };
  const taskEmployee = (taskId: string | undefined) => (taskId ? s.tasks[taskId]?.employeeId : undefined);

  switch (e.type) {
    case "employee.created": {
      s.employees = { ...s.employees, [e.payload.id]: e.payload };
      s.employeeOrder = [...s.employeeOrder, e.payload.id];
      touch(s, e.payload.id, e.ts);
      break;
    }
    case "employee.updated": {
      const cur = s.employees[e.payload.employeeId];
      if (cur) s.employees = { ...s.employees, [cur.id]: { ...cur, ...e.payload.changes } };
      break;
    }
    case "task.created": {
      s.tasks = { ...s.tasks, [e.payload.id]: e.payload };
      const list = s.tasksByEmployee[e.payload.employeeId] ?? [];
      s.tasksByEmployee = { ...s.tasksByEmployee, [e.payload.employeeId]: [...list, e.payload.id] };
      touch(s, e.payload.employeeId, e.ts);
      break;
    }
    case "task.updated":
    case "task.status_changed": {
      const cur = s.tasks[e.payload.taskId];
      if (!cur) break;
      const changes = e.type === "task.updated" ? e.payload.changes : { status: e.payload.status };
      s.tasks = { ...s.tasks, [cur.id]: { ...cur, ...changes } };
      if (e.type === "task.status_changed" && e.payload.status === "done") s.completedAt = { ...s.completedAt, [cur.id]: e.ts };
      touch(s, cur.employeeId, e.ts);
      break;
    }
    case "plan.created": {
      s.plans = { ...s.plans, [e.payload.taskId]: e.payload };
      touch(s, taskEmployee(e.payload.taskId), e.ts);
      break;
    }
    case "plan.patched": {
      const plan = s.plans[e.payload.taskId];
      if (!plan) break;
      s.plans = { ...s.plans, [plan.taskId]: applyPatch(plan, e.payload.patch, e.ts, e.actor) };
      touch(s, taskEmployee(plan.taskId), e.ts);
      break;
    }
    case "message.posted": {
      const m = e.payload;
      s.messages = { ...s.messages, [m.threadId]: [...(s.messages[m.threadId] ?? []), m] };
      touch(s, m.threadId, m.ts);
      break;
    }
    case "approval.requested": {
      s.approvals = { ...s.approvals, [e.payload.id]: e.payload };
      s.approvalOrder = [...s.approvalOrder, e.payload.id];
      touch(s, taskEmployee(e.payload.taskId), e.ts);
      break;
    }
    case "approval.resolved": {
      const a = s.approvals[e.payload.approvalId];
      if (!a) break;
      s.approvals = {
        ...s.approvals,
        [a.id]: { ...a, status: e.payload.status, decidedBy: e.payload.decidedBy, comment: e.payload.comment },
      };
      touch(s, taskEmployee(a.taskId), e.ts);
      break;
    }
    case "nudge.received": {
      const p = e.payload;
      s.nudges = { ...s.nudges, [p.nudgeId]: { id: p.nudgeId, employeeId: p.employeeId, taskId: p.taskId, itemId: p.itemId, text: p.text, at: e.ts } };
      touch(s, p.employeeId, e.ts);
      break;
    }
    case "nudge.acknowledged": {
      const n = s.nudges[e.payload.nudgeId];
      if (n) s.nudges = { ...s.nudges, [n.id]: { ...n, ack: { response: e.payload.response, at: e.ts } } };
      break;
    }
    case "check.completed": {
      const p = e.payload;
      s.checks = [...s.checks, { taskId: p.taskId, itemId: p.itemId, stepId: p.stepId, checkId: p.checkId, verdict: p.verdict, detail: p.detail, evidenceIds: p.evidenceIds ?? [], at: e.ts }];
      break;
    }
    case "question.asked": {
      const p = e.payload;
      s.questions = {
        ...s.questions,
        [p.questionId]: { id: p.questionId, employeeId: p.employeeId, ...(p.taskId ? { taskId: p.taskId } : {}), ...(p.itemId ? { itemId: p.itemId } : {}), text: p.text, blocking: p.blocking, ...(p.default !== undefined ? { default: p.default } : {}), options: p.options, at: e.ts },
      };
      s.questionOrder = [...s.questionOrder, p.questionId];
      touch(s, p.employeeId, e.ts);
      break;
    }
    case "question.answered": {
      const q = s.questions[e.payload.questionId];
      if (q) s.questions = { ...s.questions, [q.id]: { ...q, answer: { text: e.payload.answer, by: e.payload.by, usedDefault: e.payload.usedDefault, at: e.ts } } };
      break;
    }
    case "constraint.added": {
      const p = e.payload;
      s.constraints = { ...s.constraints, [p.constraintId]: { id: p.constraintId, employeeId: p.employeeId, ...(p.taskId ? { taskId: p.taskId } : {}), text: p.text, subjects: p.subjects, at: e.ts } };
      break;
    }
    case "constraint.lifted": {
      const c = s.constraints[e.payload.constraintId];
      if (c) s.constraints = { ...s.constraints, [c.id]: { ...c, lifted: { reason: e.payload.reason, at: e.ts } } };
      break;
    }
    case "evidence.added": {
      const ev = e.payload;
      if (!s.evidence[ev.id]) s.evidenceOrder = [...s.evidenceOrder, ev.id];
      s.evidence = { ...s.evidence, [ev.id]: ev };
      break;
    }
    case "tool.called": {
      const p = e.payload;
      s.toolCalls = { ...s.toolCalls, [p.callId]: { callId: p.callId, taskId: p.taskId, ...(p.itemId ? { itemId: p.itemId } : {}), ...(p.stepId ? { stepId: p.stepId } : {}), tool: p.tool, input: p.input, at: e.ts } };
      s.toolCallOrder = [...s.toolCallOrder, p.callId];
      break;
    }
    case "tool.completed": {
      const p = e.payload;
      const c = s.toolCalls[p.callId];
      if (c)
        s.toolCalls = {
          ...s.toolCalls,
          [c.callId]: { ...c, done: { ok: p.ok, ...(p.preview !== undefined ? { preview: p.preview } : {}), ...(p.error ? { error: p.error.message } : {}), durationMs: p.durationMs, evidenceIds: p.evidenceIds ?? [], at: e.ts } },
        };
      break;
    }
    case "verification.completed": {
      const p = e.payload;
      s.verifications = { ...s.verifications, [p.taskId]: { taskId: p.taskId, results: p.results.map((r) => ({ ...r, evidenceIds: r.evidenceIds ?? [] })), at: e.ts } };
      break;
    }
    case "effect.recorded": {
      const p = e.payload;
      if (!s.effects[p.id]) s.effectOrder = [...s.effectOrder, p.id];
      s.effects = { ...s.effects, [p.id]: { ...(s.effects[p.id] ?? {}), id: p.id, callId: p.callId, ...(p.taskId ? { taskId: p.taskId } : {}), tool: p.tool, summary: p.summary, ...(p.undo ? { undo: p.undo } : {}), at: p.at } };
      break;
    }
    case "effect.undone": {
      const p = e.payload;
      const f = s.effects[p.effectId];
      // A failed attempt must not hide an earlier success.
      if (f && !f.undone?.ok) s.effects = { ...s.effects, [f.id]: { ...f, undone: { ok: p.ok, detail: p.detail, by: p.by, at: e.ts } } };
      break;
    }
    case "effect.previewed": {
      const p = e.payload;
      const tid = p.taskId ?? s.toolCalls[p.callId]?.taskId;
      if (!tid) break;
      s.previews = { ...s.previews, [tid]: [...(s.previews[tid] ?? []), { id: p.id, callId: p.callId, taskId: tid, tool: p.tool, input: p.input, summary: p.summary, at: p.at }] };
      break;
    }
    case "rehearsal.resolved": {
      const p = e.payload;
      s.rehearsals = { ...s.rehearsals, [p.taskId]: { decision: p.decision, applied: p.applied, failed: p.failed, by: p.by, at: e.ts } };
      const t = s.tasks[p.taskId];
      if (t) s.tasks = { ...s.tasks, [t.id]: { ...t, rehearsal: p.decision } };
      break;
    }
    case "memory.added": {
      const p = e.payload;
      if (!s.memories[p.id]) s.memoryOrder = [...s.memoryOrder, p.id];
      s.memories = { ...s.memories, [p.id]: { id: p.id, employeeId: p.employeeId, text: p.text, ...(p.taskId ? { taskId: p.taskId } : {}), at: p.at } };
      break;
    }
    case "memory.removed": {
      const { [e.payload.id]: _gone, ...rest } = s.memories;
      s.memories = rest;
      s.memoryOrder = s.memoryOrder.filter((id) => id !== e.payload.id);
      break;
    }
    case "orient.completed":
      s.orients = { ...s.orients, [e.payload.taskId]: { ...e.payload, at: e.ts } };
      break;
    case "model.called":
      s.modelCalls = prev.modelCalls + 1;
      break;
    default:
      break;
  }
  return s;
}

export const reduceAll = (events: TheseusEvent[], from: AppState = emptyState()) => events.reduce(reduce, from);
