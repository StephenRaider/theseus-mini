/**
 * Pure functions that turn state into what the screen shows. Kept out of the
 * components so they can be unit-tested (see test/selectors.test.ts).
 */
import { THESEUS_ID, itemStatus, summarize, type Plan, type Task } from "@theseus/protocol";
import type { AppState } from "./store.ts";

/* ------------------------------------------------------------------ time */

const DAY = 86_400_000;

function dayKey(ts: string | number, timeZone?: string): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(ts));
}

/** "14:32" */
export function clock(ts: string, timeZone?: string): string {
  return new Intl.DateTimeFormat("en-GB", { timeZone, hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date(ts));
}

/** WhatsApp-style list time: today → 14:32 · yesterday → Yesterday · this week → Monday · older → 05/10/2026 */
export function listTime(ts: string, now: string, timeZone?: string): string {
  const d = dayKey(ts, timeZone);
  const n = dayKey(now, timeZone);
  if (d === n) return clock(ts, timeZone);
  if (d === dayKey(Date.parse(now) - DAY, timeZone)) return "Yesterday";
  const diffDays = Math.round((Date.parse(n) - Date.parse(d)) / DAY);
  if (diffDays > 0 && diffDays < 7) return new Intl.DateTimeFormat("en-GB", { timeZone, weekday: "long" }).format(new Date(ts));
  return new Intl.DateTimeFormat("en-GB", { timeZone, day: "2-digit", month: "2-digit", year: "numeric" }).format(new Date(ts));
}

/** Chat day separator: Today · Yesterday · Monday, 5 October 2026 */
export function dayLabel(ts: string, now: string, timeZone?: string): string {
  const d = dayKey(ts, timeZone);
  if (d === dayKey(now, timeZone)) return "Today";
  if (d === dayKey(Date.parse(now) - DAY, timeZone)) return "Yesterday";
  // Assembled from parts: Node/ICU versions disagree on the comma after the weekday.
  const parts = new Intl.DateTimeFormat("en-GB", { timeZone, weekday: "long", day: "numeric", month: "long", year: "numeric" }).formatToParts(new Date(ts));
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  return `${get("weekday")}, ${get("day")} ${get("month")} ${get("year")}`;
}

export const sameDay = (a: string, b: string, timeZone?: string) => dayKey(a, timeZone) === dayKey(b, timeZone);

/* ------------------------------------------------------------ tasks */

export const taskTitle = (t: Task) => t.goal ?? t.request;

export function currentTask(s: AppState, employeeId: string): Task | undefined {
  const id = s.employees[employeeId]?.currentTaskId;
  return id ? s.tasks[id] : undefined;
}

export function progress(plan: Plan | undefined): { done: number; total: number } {
  if (!plan) return { done: 0, total: 0 };
  const sum = summarize(plan);
  return { done: sum.done + sum.skipped + sum.failed + sum.held, total: plan.items.length };
}

export function pendingApprovals(s: AppState, employeeId: string) {
  return s.approvalOrder.map((id) => s.approvals[id]!).filter((a) => a.status === "pending" && s.tasks[a.taskId]?.employeeId === employeeId);
}

/** Blocking questions still waiting for an answer. */
export function openQuestions(s: AppState, employeeId: string) {
  return s.questionOrder.map((id) => s.questions[id]!).filter((q) => q.employeeId === employeeId && q.blocking && !q.answer);
}

/* ------------------------------------------------------------ left column */

/** How long a finished task keeps showing as "Completed …" before the list falls back to the last message. */
export const RECENT_MS = 2 * 60 * 60 * 1000;

export type PreviewKind = "working" | "waiting" | "completed" | "message" | "empty";

export interface Preview {
  kind: PreviewKind;
  text: string;
  /** "You: " / "Theseus: " prefix for message previews. */
  prefix?: string;
  hasAttachment?: boolean;
  /** "23/65" for working previews. */
  progress?: string;
}

/**
 * The line under each name, in priority order:
 * 1. working on something  → "Working · Friday batch check" + 23/65
 * 2. waiting for you       → "Needs you · Approve activation of Nandi Roadways"
 * 3. finished recently     → "Completed · Empanel T-2026-14 bidders"
 * 4. otherwise             → the last chat message
 */
export function sidebarPreview(s: AppState, employeeId: string, now: string): Preview {
  const emp = s.employees[employeeId];
  const task = currentTask(s, employeeId);
  if (emp && task && (emp.status === "working" || emp.status === "waiting_on_user" || emp.status === "paused")) {
    const p = progress(s.plans[task.id]);
    const prog = p.total ? `${p.done}/${p.total}` : undefined;
    if (emp.status === "waiting_on_user") {
      const first = pendingApprovals(s, employeeId)[0];
      const q = openQuestions(s, employeeId)[0];
      return { kind: "waiting", text: first ? first.title : q ? q.text : taskTitle(task), progress: prog };
    }
    return { kind: "working", text: (emp.status === "paused" ? "Paused · " : "") + taskTitle(task), progress: prog };
  }

  const msgs = s.messages[employeeId] ?? [];
  const last = msgs[msgs.length - 1];
  const doneIds = (s.tasksByEmployee[employeeId] ?? []).filter((id) => s.completedAt[id]);
  const lastDone = doneIds.sort((a, b) => s.completedAt[a]!.localeCompare(s.completedAt[b]!)).pop();
  if (lastDone) {
    const at = s.completedAt[lastDone]!;
    const recent = Date.parse(now) - Date.parse(at) < RECENT_MS;
    const userSpokeSince = msgs.some((m) => m.from === "user" && m.ts > at);
    if (recent && !userSpokeSince) return { kind: "completed", text: taskTitle(s.tasks[lastDone]!) };
  }
  if (last) {
    const prefix = last.from === "user" ? "You: " : employeeId !== THESEUS_ID && last.from === "theseus" ? "Theseus: " : undefined;
    return { kind: "message", text: last.text.split("\n")[0]!, prefix, hasAttachment: last.attachments.length > 0 };
  }
  return { kind: "empty", text: emp?.scope ?? "No messages yet" };
}

export interface Badges {
  /** Red: decisions/approvals waiting on you. */
  needsYou: number;
  /** Yellow: trouble the employee is handling (failed items, retries, paused). */
  warnings: number;
  /** Green: unread messages, like WhatsApp. */
  unread: number;
}

export function badges(s: AppState, employeeId: string, seenCount: number): Badges {
  const needsYou = pendingApprovals(s, employeeId).length + openQuestions(s, employeeId).length;
  let warnings = 0;
  const task = currentTask(s, employeeId);
  const plan = task ? s.plans[task.id] : undefined;
  if (plan) {
    for (const it of plan.items) {
      const st = itemStatus(plan, it.id);
      const retrying = plan.steps.some((step) => plan.cells[it.id]![step.id]!.state === "retrying");
      if (st === "failed" || retrying) warnings++;
    }
  }
  if (s.employees[employeeId]?.status === "paused") warnings++;
  const msgs = s.messages[employeeId] ?? [];
  const unread = msgs.slice(seenCount).filter((m) => m.from !== "user").length;
  return { needsYou, warnings, unread };
}

/** Theseus first; then whoever needs you; then most recent activity. */
export function sortedEmployees(s: AppState, seen: Record<string, number>): string[] {
  const rest = s.employeeOrder.filter((id) => id !== THESEUS_ID);
  const rank = (id: string) => (badges(s, id, seen[id] ?? 0).needsYou > 0 ? 0 : 1);
  rest.sort((a, b) => rank(a) - rank(b) || (s.lastActivity[b] ?? "").localeCompare(s.lastActivity[a] ?? ""));
  return s.employees[THESEUS_ID] ? [THESEUS_ID, ...rest] : rest;
}

export function initials(name: string): string {
  const m = /^Employee (\d+)$/.exec(name);
  if (m) return `E${m[1]}`;
  return name
    .split(/\s+/)
    .slice(0, 2)
    .map((w) => w[0]?.toUpperCase() ?? "")
    .join("");
}

/** Indian digit grouping: 1234567 → ₹12,34,567 */
export const inr = (n: number) => `₹${Math.round(n).toLocaleString("en-IN")}`;
