/**
 * UI state = a fold over the event log. The UI never edits this directly:
 * it sends Commands, the engine (replay simulator now, the real kernel
 * later) answers with events, and `reduce` applies them. Same events in →
 * same screen out, which is what makes replay and audit possible.
 */
import { applyPatch, type Approval, type Employee, type Message, type Plan, type Task, type TheseusEvent } from "@theseus/protocol";

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
      s.checks = [...s.checks, { taskId: p.taskId, itemId: p.itemId, stepId: p.stepId, checkId: p.checkId, verdict: p.verdict, detail: p.detail, at: e.ts }];
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
