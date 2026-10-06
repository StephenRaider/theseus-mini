/**
 * Replay engine: a tiny SIMULATED kernel for UI v0 (no model, no API key).
 *
 * It speaks the real protocol: it receives Commands from the UI and answers
 * with TheseusEvents, which the store folds into state. Work is NOT a fixed
 * recording: like the real kernel, it repeatedly asks `nextRunnableCell(plan)`
 * what to do next and looks up a scripted OUTCOME for that cell (pass, retry,
 * fail, hold, needs-you). So skip / hold / release / retry / reorder / approve
 * from the UI change what happens next, exactly as they will with live agents.
 *
 * Time is simulated: `advance(ms)` moves the clock; the UI calls it from a
 * timer, tests call it directly (fully deterministic, no real timers).
 */
import {
  THESEUS_ID,
  createPlan,
  isTerminal,
  itemStatus,
  nextRunnableCell,
  type Actor,
  type Approval,
  type Attachment,
  type Command,
  type EventBody,
  type PlanItem,
  type PlanPatch,
  type PlanStep,
  type TheseusEvent,
} from "@theseus/protocol";
import { mimeOf, attachmentRef } from "../bridge.ts";
import { emptyState, reduce, type AppState } from "../state/store.ts";
import type { DemoData } from "./types.ts";

/* ------------------------------------------------------------------ script types */

export type CellResult = { state: "done" | "failed"; note: string; hold?: string };

export type Outcome =
  | { kind: "pass"; note?: string; effect?: string }
  | { kind: "retry"; error: string; note?: string }
  | { kind: "fail"; note: string }
  | { kind: "hold"; note: string }
  | {
      kind: "needs_you";
      note: string;
      approval: Pick<Approval, "title" | "reason" | "humanTask" | "toolCall" | "diff" | "risk">;
      onApprove: CellResult;
      onReject: CellResult;
    };

export interface SimTaskSpec {
  taskId: string;
  employeeId: string;
  request: string;
  goal: string;
  playbookId: string;
  steps: PlanStep[];
  items: PlanItem[];
  /** keyed "itemId:stepId"; anything missing passes. */
  outcomes: Record<string, Outcome>;
  /** Simulated duration per step (ms of simulated time). */
  stepMs: Record<string, number>;
  /** Message from the employee when it starts. */
  startText: string;
  startAttachments?: Attachment[];
}

export interface FilesAdapter {
  /** Create a new file in a granted folder; returns the path actually used. */
  writeNew(rootId: string, rel: string, text: string): Promise<string>;
}

interface RunningTask {
  spec: SimTaskSpec;
  used: Set<string>;
  running: { itemId: string; stepId: string } | null;
  paused: boolean;
  finished: boolean;
  corrected: Set<string>;
}

interface PendingApproval {
  taskId: string;
  itemId: string;
  stepId: string;
  onApprove: CellResult;
  onReject: CellResult;
}

type Timer = { at: number; seq: number; fn: () => void };

/* ------------------------------------------------------------------ engine */

export class ReplayEngine {
  readonly kind = "replay" as const;
  state: AppState = emptyState();
  private clock: number;
  private seq = 0;
  private timers: Timer[] = [];
  private timerSeq = 0;
  private tasks = new Map<string, RunningTask>();
  private approvals = new Map<string, PendingApproval>();
  private listeners = new Set<() => void>();
  private started = false;
  private idSeq = 0;

  constructor(
    private readonly script: DemoScript,
    private readonly files?: FilesAdapter,
  ) {
    this.clock = Date.parse(script.startAt);
    for (const e of script.history()) this.push(e);
  }

  /* ---------------- public API */

  get now(): string {
    return new Date(this.clock).toISOString();
  }

  get hasStarted(): boolean {
    return this.started;
  }

  subscribe(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  /** Move simulated time forward, running everything that falls due. */
  advance(ms: number): void {
    const target = this.clock + ms;
    for (;;) {
      this.timers.sort((a, b) => a.at - b.at || a.seq - b.seq);
      const next = this.timers[0];
      if (!next || next.at > target) break;
      this.timers.shift();
      this.clock = Math.max(this.clock, next.at);
      next.fn();
    }
    this.clock = target;
    this.notify();
  }

  /** Run until nothing is scheduled (tests). */
  runToIdle(maxMs = 6 * 60 * 60 * 1000): void {
    const stop = this.clock + maxMs;
    while (this.timers.length && this.clock < stop) {
      this.timers.sort((a, b) => a.at - b.at);
      this.advance(Math.max(0, this.timers[0]!.at - this.clock));
    }
  }

  /** Start the scripted scenario (same as sending the suggested request to Theseus). */
  kickoff(text = this.script.request): void {
    this.send({ type: "send_message", threadId: THESEUS_ID, text, attachments: [] });
  }

  send(cmd: Command): void {
    switch (cmd.type) {
      case "send_message":
        this.onMessage(cmd.threadId, cmd.text, cmd.attachments);
        break;
      case "resolve_approval":
        this.onApproval(cmd.approvalId, cmd.decision, cmd.comment);
        break;
      case "cell_action":
        this.onCellAction(cmd.taskId, cmd.itemId, cmd.action, cmd.reason);
        break;
      case "reorder_items":
        this.patch(cmd.taskId, { op: "reorder", itemIds: cmd.itemIds }, "user");
        break;
      case "task_control":
        this.onTaskControl(cmd.taskId, cmd.action);
        break;
      case "rename_employee":
        this.emit({ type: "employee.updated", payload: { employeeId: cmd.employeeId, changes: { name: cmd.name } } }, "user");
        break;
      case "nudge":
        this.onNudge(cmd.employeeId, cmd.text);
        break;
      case "create_employee": {
        const id = this.nextId("emp_new");
        const name = cmd.name ?? `Employee ${this.state.employeeOrder.length}`;
        this.emit(
          { type: "employee.created", payload: { id, kind: "employee", name, rolePack: cmd.rolePack, scope: cmd.scope, allowedTools: [], status: "idle", createdAt: this.now } },
          "user",
          { employeeId: id },
        );
        this.say(id, `employee:${id}`, `Hi, I'm ${name}. I run the ${cmd.rolePack} playbooks. In this replay I can chat but not take tasks yet; live agents arrive in the next milestone.`);
        break;
      }
      default:
        break;
    }
    this.notify();
  }

  /* ---------------- events */

  private notify() {
    for (const l of this.listeners) l();
  }

  private push(e: TheseusEvent) {
    this.seq = Math.max(this.seq, e.seq + 1);
    this.state = reduce(this.state, e);
  }

  private emit(body: EventBody, actor: Actor, extra: { employeeId?: string; taskId?: string } = {}) {
    const e = { id: `evt_${this.seq}`, seq: this.seq, ts: this.now, actor, ...extra, ...body } as TheseusEvent;
    this.seq++;
    this.state = reduce(this.state, e);
  }

  private nextId(prefix: string) {
    return `${prefix}_${++this.idSeq}`;
  }

  private after(ms: number, fn: () => void) {
    this.timers.push({ at: this.clock + ms, seq: this.timerSeq++, fn });
  }

  private say(threadId: string, from: Actor, text: string, attachments: Attachment[] = [], taskId?: string) {
    this.emit(
      { type: "message.posted", payload: { id: this.nextId("msg"), threadId, from, text, attachments, taskId, ts: this.now } },
      from,
      { employeeId: threadId, taskId },
    );
  }

  private patch(taskId: string, patch: PlanPatch, actor: Actor) {
    const plan = this.state.plans[taskId];
    if (!plan) return;
    this.emit({ type: "plan.patched", payload: { taskId, version: plan.version + 1, patch } }, actor, {
      taskId,
      employeeId: this.state.tasks[taskId]?.employeeId,
    });
  }

  private setEmployee(employeeId: string, changes: Record<string, unknown>) {
    this.emit({ type: "employee.updated", payload: { employeeId, changes } }, "system", { employeeId });
  }

  private setTaskStatus(taskId: string, status: AppState["tasks"][string]["status"], reason?: string) {
    if (this.state.tasks[taskId]?.status === status) return;
    this.emit({ type: "task.status_changed", payload: { taskId, status, reason } }, "system", {
      taskId,
      employeeId: this.state.tasks[taskId]?.employeeId,
    });
  }

  /* ---------------- scenario */

  private onMessage(threadId: string, text: string, attachments: Attachment[]) {
    this.say(threadId, "user", text, attachments);
    if (threadId === THESEUS_ID) {
      if (!this.started) {
        this.started = true;
        this.after(4000, () => this.script.delegate(this.director()));
      } else {
        this.after(2500, () => {
          this.say(THESEUS_ID, "theseus", this.script.theseusIdleReply(this.state));
          this.notify();
        });
      }
      return;
    }
    const emp = this.state.employees[threadId];
    const task = emp?.currentTaskId ? this.tasks.get(emp.currentTaskId) : undefined;
    if (task && !task.finished) {
      this.onNudge(threadId, text, true);
    } else {
      this.after(2000, () => {
        this.say(threadId, `employee:${threadId}`, "Noted. I'm free right now: ask Theseus to assign me something, or give me a task here.");
        this.notify();
      });
    }
  }

  /** What the script needs to drive the story. */
  private director(): Director {
    return {
      say: (threadId, from, text, attachments) => this.say(threadId, from, text, attachments),
      emit: (body, actor, extra) => this.emit(body, actor, extra),
      after: (ms, fn) => this.after(ms, () => {
        fn();
        this.notify();
      }),
      startTask: (spec) => this.startTask(spec),
      now: () => this.now,
    };
  }

  private startTask(spec: SimTaskSpec) {
    const plan = createPlan({ taskId: spec.taskId, playbookId: spec.playbookId, playbookVersion: 1, steps: spec.steps });
    this.emit(
      {
        type: "task.created",
        payload: {
          id: spec.taskId,
          employeeId: spec.employeeId,
          request: spec.request,
          goal: spec.goal,
          successCriteria: [],
          playbookId: spec.playbookId,
          playbookVersion: 1,
          parentTaskId: undefined,
          status: "planning",
          createdAt: this.now,
        },
      },
      "theseus",
      { taskId: spec.taskId, employeeId: spec.employeeId },
    );
    this.setEmployee(spec.employeeId, { status: "working", currentTaskId: spec.taskId });
    this.say(spec.employeeId, "theseus", spec.request, [], spec.taskId);
    this.emit({ type: "plan.created", payload: plan }, `employee:${spec.employeeId}`, { taskId: spec.taskId, employeeId: spec.employeeId });
    this.patch(spec.taskId, { op: "add_items", items: spec.items }, `employee:${spec.employeeId}`);
    this.tasks.set(spec.taskId, { spec, used: new Set(), running: null, paused: false, finished: false, corrected: new Set() });
    this.after(1500, () => {
      this.say(spec.employeeId, `employee:${spec.employeeId}`, spec.startText, spec.startAttachments ?? [], spec.taskId);
      this.setTaskStatus(spec.taskId, "running");
      this.pump(spec.taskId);
      this.notify();
    });
  }

  /* ---------------- the simulated kernel loop */

  private duration(t: RunningTask, itemId: string, stepId: string) {
    const base = t.spec.stepMs[stepId] ?? 3000;
    let h = 0;
    for (const ch of `${itemId}:${stepId}`) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
    return Math.round(base * (0.7 + (h % 600) / 1000)); // deterministic jitter 0.7–1.3×
  }

  private pump(taskId: string) {
    const t = this.tasks.get(taskId);
    if (!t || t.finished || t.paused || t.running) return;
    const plan = this.state.plans[taskId]!;
    const next = nextRunnableCell(plan);
    const emp = t.spec.employeeId;
    if (next) {
      if (this.state.tasks[taskId]?.status !== "running") {
        this.setTaskStatus(taskId, "running");
        this.setEmployee(emp, { status: "working" });
      }
      t.running = next;
      this.patch(taskId, { op: "set_cell", itemId: next.itemId, stepId: next.stepId, state: "running" }, `employee:${emp}`);
      this.after(this.duration(t, next.itemId, next.stepId), () => this.finishCell(t));
      return;
    }
    const waiting = [...this.approvals.values()].some((a) => a.taskId === taskId);
    if (waiting) {
      this.setTaskStatus(taskId, "waiting_on_user", "Waiting for your decision");
      this.setEmployee(emp, { status: "waiting_on_user" });
      return;
    }
    this.completeTask(t);
  }

  private finishCell(t: RunningTask) {
    const cur = t.running;
    if (!cur) return;
    const taskId = t.spec.taskId;
    const emp = t.spec.employeeId;
    const actor: Actor = `employee:${emp}`;
    const plan = this.state.plans[taskId]!;
    const cell = plan.cells[cur.itemId]?.[cur.stepId];
    // The user skipped this item while we were working on it: drop the result.
    if (!cell || (cell.state !== "running" && cell.state !== "retrying")) {
      t.running = null;
      this.after(300, () => this.pump(taskId));
      return;
    }
    const key = `${cur.itemId}:${cur.stepId}`;
    const outcome: Outcome = t.used.has(key) ? { kind: "pass", note: retryPassNote(t.spec.outcomes[key]) } : (t.spec.outcomes[key] ?? { kind: "pass" });
    t.used.add(key);
    const set = (state: "done" | "failed" | "needs_you" | "retrying", note?: string) =>
      this.patch(taskId, { op: "set_cell", itemId: cur.itemId, stepId: cur.stepId, state, note }, actor);
    const check = (verdict: "pass" | "fail", detail: string) =>
      this.emit(
        { type: "check.completed", payload: { taskId, itemId: cur.itemId, stepId: cur.stepId, checkId: cur.stepId, verdict, detail, evidenceIds: [] } },
        actor,
        { taskId, employeeId: emp },
      );

    switch (outcome.kind) {
      case "pass":
        set("done", outcome.note);
        if (outcome.note) check("pass", outcome.note);
        if (outcome.effect) this.applyEffect(t, outcome.effect, cur.itemId);
        break;
      case "retry":
        set("retrying", outcome.error);
        // Same cell again after a back-off; the second attempt passes.
        this.after(this.duration(t, cur.itemId, cur.stepId) + 1500, () => this.finishCell(t));
        return;
      case "fail":
        set("failed", outcome.note);
        check("fail", outcome.note);
        this.say(emp, actor, `⚠ ${labelOf(plan, cur.itemId)}: ${outcome.note}. Parked it and moving on.`, [], taskId);
        break;
      case "hold":
        set("done", outcome.note);
        check("fail", outcome.note);
        this.patch(taskId, { op: "hold_item", itemId: cur.itemId, reason: outcome.note }, actor);
        break;
      case "needs_you": {
        set("needs_you", outcome.note);
        const id = this.nextId("apr");
        this.approvals.set(id, { taskId, itemId: cur.itemId, stepId: cur.stepId, onApprove: outcome.onApprove, onReject: outcome.onReject });
        this.emit(
          {
            type: "approval.requested",
            payload: { id, taskId, itemId: cur.itemId, stepId: cur.stepId, evidenceIds: [], status: "pending", ...outcome.approval, diff: outcome.approval.diff ?? [] },
          },
          actor,
          { taskId, employeeId: emp },
        );
        this.say(emp, actor, `I need you on ${labelOf(plan, cur.itemId)}: ${outcome.note}. The rest keeps going.`, [], taskId);
        break;
      }
    }
    t.running = null;
    this.after(400, () => this.pump(taskId));
  }

  private applyEffect(t: RunningTask, effect: string, itemId: string) {
    const taskId = t.spec.taskId;
    if (effect === "corrected") t.corrected.add(itemId);
    if (effect === "prioritise") {
      const plan = this.state.plans[taskId]!;
      const ids = plan.items.map((i) => i.id);
      this.patch(taskId, { op: "reorder", itemIds: [itemId, ...ids.filter((i) => i !== itemId)] }, `employee:${t.spec.employeeId}`);
    }
  }

  private completeTask(t: RunningTask) {
    t.finished = true;
    const taskId = t.spec.taskId;
    const emp = t.spec.employeeId;
    this.setTaskStatus(taskId, "verifying");
    this.after(3000, () => {
      this.emit(
        {
          type: "verification.completed",
          payload: { taskId, results: [{ criterionId: "all-items-decided", verdict: "pass", detail: "Every item is done, held, failed or skipped with a reason", evidenceIds: [] }] },
        },
        "system",
        { taskId, employeeId: emp },
      );
      this.setTaskStatus(taskId, "done");
      this.setEmployee(emp, { status: "idle", currentTaskId: undefined });
      const report = this.script.report(this.state, taskId, t.corrected);
      const post = (rels: { rootId: string; rel: string }[]) => {
        const atts: Attachment[] = rels.map((r) => ({ name: r.rel.split("/").pop()!, mime: mimeOf(r.rel), ref: attachmentRef(r.rootId, r.rel) }));
        this.say(emp, `employee:${emp}`, report.text, atts, taskId);
        if ([...this.tasks.values()].every((x) => x.finished) && this.tasks.size > 0) {
          this.after(2500, () => {
            this.say(THESEUS_ID, "theseus", this.script.rollup(this.state));
            this.notify();
          });
        }
        this.notify();
      };
      if (this.files && report.files.length) {
        Promise.all(report.files.map((f) => this.files!.writeNew(f.rootId, f.rel, f.text).then((rel) => ({ rootId: f.rootId, rel }))))
          .then(post)
          .catch(() => post([]));
      } else {
        post(report.files.map((f) => ({ rootId: f.rootId, rel: f.rel })));
      }
    });
  }

  /* ---------------- user actions */

  private onApproval(approvalId: string, decision: "approved" | "rejected", comment?: string) {
    const p = this.approvals.get(approvalId);
    if (!p) return;
    this.approvals.delete(approvalId);
    this.emit({ type: "approval.resolved", payload: { approvalId, status: decision, decidedBy: "user", comment } }, "user", { taskId: p.taskId });
    const res = decision === "approved" ? p.onApprove : p.onReject;
    const emp = this.state.tasks[p.taskId]!.employeeId;
    const actor: Actor = `employee:${emp}`;
    this.patch(p.taskId, { op: "set_cell", itemId: p.itemId, stepId: p.stepId, state: res.state, note: res.note }, actor);
    if (res.hold) this.patch(p.taskId, { op: "hold_item", itemId: p.itemId, reason: res.hold }, actor);
    this.after(1200, () => {
      this.say(emp, actor, `${decision === "approved" ? "Thanks" : "Understood"}: ${res.note}.`, [], p.taskId);
      this.pump(p.taskId);
      this.notify();
    });
  }

  private dropApprovalsFor(taskId: string, itemId: string, why: string) {
    for (const [id, a] of this.approvals) {
      if (a.taskId === taskId && a.itemId === itemId) {
        this.approvals.delete(id);
        this.emit({ type: "approval.resolved", payload: { approvalId: id, status: "rejected", decidedBy: "user", comment: why } }, "user", { taskId });
      }
    }
  }

  private onCellAction(taskId: string, itemId: string, action: "skip" | "retry" | "hold" | "release", reason?: string) {
    const t = this.tasks.get(taskId);
    const plan = this.state.plans[taskId];
    if (!plan || !plan.items.some((i) => i.id === itemId)) return;
    if (action === "skip") {
      this.dropApprovalsFor(taskId, itemId, "Item skipped");
      this.patch(taskId, { op: "skip_item", itemId, reason: reason ?? "Skipped by you" }, "user");
    } else if (action === "retry") {
      const st = itemStatus(plan, itemId);
      if (st === "done") return;
      this.dropApprovalsFor(taskId, itemId, "Item retried");
      const retryFrom = plan.steps.find((s) => !isTerminal(plan.cells[itemId]![s.id]!.state) || plan.cells[itemId]![s.id]!.state === "failed");
      this.patch(taskId, { op: "retry_item", itemId, fromStepId: retryFrom?.id }, "user");
      if (plan.items.find((i) => i.id === itemId)?.held) this.patch(taskId, { op: "release_item", itemId }, "user");
    } else if (action === "hold") {
      this.patch(taskId, { op: "hold_item", itemId, reason: reason ?? "Held by you" }, "user");
    } else {
      this.patch(taskId, { op: "release_item", itemId }, "user");
    }
    if (t?.finished && (action === "retry" || action === "release")) {
      // Re-open a finished task: the employee picks the item back up.
      t.finished = false;
      this.setEmployee(t.spec.employeeId, { status: "working", currentTaskId: taskId });
    }
    this.after(300, () => {
      this.pump(taskId);
      this.notify();
    });
  }

  private onTaskControl(taskId: string, action: "pause" | "resume" | "cancel") {
    const t = this.tasks.get(taskId);
    if (!t) return;
    if (action === "pause") {
      t.paused = true;
      this.setEmployee(t.spec.employeeId, { status: "paused" });
    } else if (action === "resume") {
      t.paused = false;
      this.setEmployee(t.spec.employeeId, { status: "working" });
      this.after(200, () => this.pump(taskId));
    } else {
      t.finished = true;
      t.paused = true;
      this.setTaskStatus(taskId, "cancelled");
      this.setEmployee(t.spec.employeeId, { status: "idle", currentTaskId: undefined });
    }
  }

  /**
   * A message to a working employee is a NUDGE (UX gripe G3): it's picked up
   * at the next step boundary and acknowledged visibly. The simulator
   * understands "hold …" / "skip …" + a vendor or line; anything else is noted.
   */
  private onNudge(employeeId: string, text: string, alreadyPosted = false) {
    const emp = this.state.employees[employeeId];
    const taskId = emp?.currentTaskId;
    if (!alreadyPosted) this.say(employeeId, "user", text);
    const nudgeId = this.nextId("ndg");
    this.emit({ type: "nudge.received", payload: { nudgeId, employeeId, taskId, text } }, "user", { employeeId, taskId });
    this.after(2500, () => {
      const response = taskId ? this.interpretNudge(taskId, text) : "Noted.";
      this.emit({ type: "nudge.acknowledged", payload: { nudgeId, response } }, `employee:${employeeId}`, { employeeId, taskId });
      this.say(employeeId, `employee:${employeeId}`, response, [], taskId);
      if (taskId) this.pump(taskId);
      this.notify();
    });
  }

  private interpretNudge(taskId: string, text: string): string {
    const plan = this.state.plans[taskId];
    if (!plan) return "Noted.";
    const lower = text.toLowerCase();
    const wantsHold = /\bhold\b|\bstop\b|\bdon'?t pay\b/.test(lower);
    const wantsSkip = /\bskip\b|\bignore\b/.test(lower);
    if (!wantsHold && !wantsSkip) return "Noted. I'll apply that from the next step onwards.";
    const hits = plan.items.filter((it) => {
      const name = (it.label.split(" · ")[1] ?? it.label).toLowerCase();
      const short = name.split(/\s+/).slice(0, 2).join(" ");
      const word = (w: string) => new RegExp(`(^|[^a-z0-9])${w.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&")}([^a-z0-9]|$)`).test(lower);
      return word(it.id.toLowerCase()) || word(short) || (it.ref ? word(it.ref.toLowerCase()) : false);
    });
    if (!hits.length) return "I couldn't match that to an item in this task. Which line or vendor do you mean?";
    for (const it of hits) {
      if (wantsSkip) {
        this.dropApprovalsFor(taskId, it.id, "Skipped on your instruction");
        this.patch(taskId, { op: "skip_item", itemId: it.id, reason: `Your instruction: "${text}"` }, "user");
      } else {
        this.patch(taskId, { op: "hold_item", itemId: it.id, reason: `Your instruction: "${text}"` }, "user");
      }
    }
    const list = hits.map((h) => h.label).join(", ");
    return wantsSkip ? `Done: skipped ${list}.` : `Done: ${list} on hold. ${hits.length === 1 ? "It" : "They"} won't go into the bank file.`;
  }
}

/* ------------------------------------------------------------------ script contract */

export interface Director {
  say(threadId: string, from: Actor, text: string, attachments?: Attachment[]): void;
  emit(body: EventBody, actor: Actor, extra?: { employeeId?: string; taskId?: string }): void;
  after(ms: number, fn: () => void): void;
  startTask(spec: SimTaskSpec): void;
  now(): string;
}

export interface DemoScript {
  /** Simulated wall-clock when the demo starts. */
  startAt: string;
  /** The request the user sends to Theseus to kick things off. */
  request: string;
  data: DemoData;
  /** Events that happened before today (older chats, existing employees). */
  history(): TheseusEvent[];
  /** Theseus splits the request and starts the employees. */
  delegate(d: Director): void;
  report(s: AppState, taskId: string, corrected: Set<string>): { text: string; files: { rootId: string; rel: string; text: string }[] };
  rollup(s: AppState): string;
  theseusIdleReply(s: AppState): string;
}

function labelOf(plan: { items: PlanItem[] }, itemId: string) {
  return plan.items.find((i) => i.id === itemId)?.label ?? itemId;
}

function retryPassNote(o: Outcome | undefined): string | undefined {
  return o?.kind === "retry" ? (o.note ?? "OK on retry") : undefined;
}
