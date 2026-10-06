import {
  THESEUS_ID,
  applyPatch,
  createPlan,
  isTerminal,
  itemStatus,
  nextRunnableCell,
  summarize,
  type Actor,
  type Approval,
  type Command,
  type Employee,
  type EventBody,
  type FieldDiff,
  type OnFail,
  type Plan,
  type PlanItem,
  type PlanPatch,
  type Playbook,
  type RiskTier,
  type RolePackManifest,
  type Task,
  type TaskStatus,
  type ToolError,
} from "@theseus/protocol";
import { createHash } from "node:crypto";
import type { z } from "zod";
import { ToolGateway, type EvidenceInput, type GatewayResult, type StandingConstraint, type Tool } from "./gateway.ts";
import { EventLog, IdMaker, type Clock } from "./log.ts";
import { ModelError, generateJson, type ModelAdapter, type ModelRequest, type ModelResponse } from "./model.ts";
import {
  Program,
  allTrue,
  anyTrue,
  coerceArgs,
  describeCondition,
  fillArgs,
  getPath,
  interpolate,
  normalizeProgram,
  pathResolves,
  programPaths,
  validateProgram,
  type ProgramStep,
} from "./program.ts";
import {
  DraftDoc,
  RouteDecision,
  Summary,
  composePrompt,
  draftPrompt,
  roleIntro,
  routePrompt,
  summaryPrompt,
  triagePrompt,
  type OrientIndex,
} from "./prompts.ts";
import { ModelTriage, triageByRules, type SteerAction, type Triage } from "./triage.ts";

/* =====================================================================
 * Contracts between the keel (this file) and a role pack (the planks).
 * ===================================================================== */

export interface ApprovalAsk {
  title: string;
  reason: string;
  humanTask?: string;
  /** The exact call that runs if you approve (absent for pure human tasks). */
  toolCall?: { tool: string; input: unknown };
  diff?: FieldDiff[];
  evidenceIds?: string[];
  risk: RiskTier;
  /** What the cell becomes after approval (after toolCall ran). Default: done. */
  onApproved?: (result: unknown) => StepOutcome | Promise<StepOutcome>;
  /** What the cell becomes after rejection. Default: skipped. */
  onRejected?: () => StepOutcome | Promise<StepOutcome>;
}

export interface QuestionAsk {
  /** Stable key the handler reads the answer from (ctx.answers[key]). */
  key: string;
  text: string;
  options?: string[];
}

export type StepOutcome =
  | { status: "done"; note?: string; evidenceIds?: string[] }
  /** The item must not go further; the handler already did any real-world hold. */
  | { status: "hold"; reason: string; note?: string; evidenceIds?: string[] }
  | { status: "failed"; note: string; evidenceIds?: string[] }
  | { status: "skipped"; note: string }
  | { status: "needs_you"; note: string; evidenceIds?: string[]; approval?: ApprovalAsk; question?: QuestionAsk };

/** A failed tool call inside a step (thrown by ctx.call). */
export class StepFailure extends Error {
  constructor(
    public readonly error: ToolError,
    public readonly blockedBy?: StandingConstraint,
  ) {
    super(error.message);
  }
}

export interface StepCtx {
  task: Task;
  readonly plan: Plan;
  item: PlanItem;
  stepId: string;
  params: Record<string, string>;
  /** Per-item scratch space shared by the item's steps. */
  data: Record<string, any>;
  /** Per-task scratch space (e.g. the batch, loaded once). */
  shared: Record<string, any>;
  /** Answers to this item's questions, by key. */
  answers: Record<string, string>;
  today: string;
  /** Call a tool through the gateway; throws StepFailure on error. Writes get an idempotency key automatically. */
  call<T = any>(tool: string, input: unknown): Promise<T>;
  /** Like call, but returns the result instead of throwing. */
  tryCall<T = any>(tool: string, input: unknown): Promise<GatewayResult<T>>;
  evidence(e: EvidenceInput): string;
  /** Record a check verdict (shows in the activity trace and the verifier). */
  check(checkId: string, verdict: "pass" | "fail" | "uncertain", detail: string, evidenceIds?: string[]): void;
  /** A soft question: proceeds with `fallback` now; if you answer differently later, the step re-runs. */
  assume(key: string, text: string, fallback: string): string;
  /** Structured model call (extraction, drafting). Use sparingly: deterministic first. */
  json<T>(purpose: string, prompt: string, schema: z.ZodType<T>): Promise<T>;
  say(text: string): void;
}

export type StepHandler = (ctx: StepCtx) => Promise<StepOutcome>;

export interface PackCtx {
  employeeId: string;
  taskId: string;
  params: Record<string, string>;
  shared: Record<string, any>;
  today: string;
  call<T = any>(tool: string, input: unknown): Promise<T>;
  evidence(e: EvidenceInput): string;
}

export interface VerifyResult {
  criterion: string;
  verdict: "pass" | "fail" | "uncertain";
  detail: string;
}

export interface PackRuntime {
  manifest: RolePackManifest;
  playbooks: Map<string, Playbook>;
  tools: Tool[];
  /** Step handlers per playbook. A playbook without handlers is not offered to the router. */
  handlers: Record<string, Record<string, StepHandler>>;
  /** What each playbook needs to start, for the router: { batchId: "payment batch id, e.g. PB-2026-W41" }. */
  params: Record<string, Record<string, string>>;
  /** Fill in / correct params deterministically (e.g. the only draft batch). */
  resolveParams?(playbookId: string, params: Record<string, string>, index: OrientIndex, request: string): { params: Record<string, string>; assumptions: string[]; problems: string[] };
  /** Find the items of a playbook run. */
  discover: Record<string, (ctx: PackCtx) => Promise<PlanItem[]>>;
  /** Look around before deciding (Framework Spec §10: Orient). */
  orient(ctx: { request: string; call: PackCtx["call"] }): Promise<OrientIndex>;
  /** The world's "today" (the scenario date, not the wall clock). */
  today(): string;
  /** Turn words ("Shree Ganesh") into entity keys, for steers and constraints. */
  resolveTarget?(words: string, ctx: { plan?: Plan; shared: Record<string, any> }): { label: string; subjects: string[] } | null;
  /** Entity keys of a plan item, so a constraint can find the items it covers. */
  itemSubjects?(item: PlanItem, shared: Record<string, any>): string[];
  /** The protective real-world call for holding an item (e.g. hold the ERP payment line). */
  holdCall?(item: PlanItem, reason: string, shared: Record<string, any>): { tool: string; input: unknown } | undefined;
  verify?: Record<string, (ctx: PackCtx & { plan: Plan }) => Promise<VerifyResult[]>>;
  report?: Record<string, (ctx: PackCtx & { plan: Plan }) => string | Promise<string>>;
  /**
   * Find what the records say about a subject the user named ("Bhadra Concrete
   * Works", "T-2026-14"), for drafting documents. null + suggestions if not found.
   */
  lookup?(subject: string, ctx: PackCtx, depth?: "letter" | "full"): Promise<{ found: LookupResult | null; suggestions: string[] }>;
}

export interface LookupResult {
  label: string;
  kind: string;
  facts: Record<string, unknown>;
  /** A readable profile ("full" lookups): shown to the user as is. */
  profile?: string;
}

/* =====================================================================
 * Kernel
 * ===================================================================== */

interface PendingApproval {
  run: TaskRun;
  approval: Approval;
  ask: ApprovalAsk;
  itemId?: string;
  stepId?: string;
}

interface OpenQuestion {
  id: string;
  employeeId: string;
  run?: TaskRun;
  itemId?: string;
  stepId?: string;
  key: string;
  text: string;
  blocking: boolean;
  fallback?: string;
  /** Task-level questions (asked before planning) resolve this. */
  resolve?: (answer: string) => void;
}

interface TaskRun {
  task: Task;
  employeeId: string;
  plan?: Plan;
  playbook?: Playbook;
  program?: Program;
  params: Record<string, string>;
  shared: Record<string, any>;
  itemData: Map<string, Record<string, any>>;
  answers: Map<string, Record<string, string>>;
  queue: { patch: PlanPatch; actor: Actor; then?: () => Promise<void> }[];
  paused: boolean;
  cancelled: boolean;
  wake: () => void;
  fatalStreak: number;
}

interface EmployeeState {
  employee: Employee;
  current?: TaskRun;
  backlog: string[];
}

export interface KernelOptions {
  pack: PackRuntime;
  model: ModelAdapter;
  log?: EventLog;
  clock?: Clock;
  /** Name used when you approve ("user:<name>"). */
  approver?: string;
  /** Backoff sleep (tests pass a no-op). */
  sleep?: (ms: number) => Promise<void>;
  /** Thinking effort for routing / composing. */
  thinking?: ModelRequest["thinking"];
  /** Pause after every step (ms) so a person can follow along and nudge (demos). 0 = full speed. */
  stepDelayMs?: number;
}

const stableHash = (v: unknown) => createHash("sha1").update(JSON.stringify(v ?? null)).digest("hex").slice(0, 10);

export class Kernel {
  readonly log: EventLog;
  readonly ids = new IdMaker();
  readonly gateway: ToolGateway;
  readonly employees = new Map<string, EmployeeState>();
  readonly runs = new Map<string, TaskRun>();
  private approvals = new Map<string, PendingApproval>();
  private questions = new Map<string, OpenQuestion>();
  private busy = 0;
  private settleWaiters: (() => void)[] = [];
  private loops = new Set<Promise<void>>();

  constructor(private readonly opts: KernelOptions) {
    this.log = opts.log ?? new EventLog({ clock: opts.clock });
    this.gateway = new ToolGateway({
      log: this.log,
      ids: this.ids,
      tools: opts.pack.tools,
      allowed: opts.pack.manifest.tools.map((t) => t.name),
      sleep: opts.sleep,
    });
  }

  get pack() {
    return this.opts.pack;
  }

  /* ------------------------------------------------------------------ public API */

  createEmployee(args: { name: string; scope?: string; id?: string }): Employee {
    const id = args.id ?? this.ids.next("emp");
    const employee: Employee = {
      id,
      kind: "employee",
      name: args.name,
      rolePack: this.pack.manifest.id,
      ...(args.scope ? { scope: args.scope } : {}),
      allowedTools: [],
      status: "idle",
      createdAt: this.log.now,
    };
    this.employees.set(id, { employee, backlog: [] });
    this.emit({ type: "employee.created", payload: employee }, "system");
    return employee;
  }

  /** A message from you to an employee: a new task if idle, otherwise handled by the conversation lane. */
  send(employeeId: string, text: string, opts: { from?: Actor } = {}): Promise<void> {
    return this.track(async () => {
      const st = this.mustEmployee(employeeId);
      this.post(employeeId, opts.from ?? "user", text, st.current?.task.id);
      const open = this.openQuestionsOf(employeeId);
      if (!st.current) {
        if (open.length) return this.answerQuestion(open[0]!.id, text, "user");
        this.startTask(st, text);
        return;
      }
      await this.converse(st, text);
    });
  }

  /** Commands from the UI (or the CLI). */
  command(cmd: Command): Promise<void> {
    return this.track(async () => {
      switch (cmd.type) {
        case "send_message":
          if (cmd.threadId !== THESEUS_ID) await this.send(cmd.threadId, cmd.text);
          return;
        case "nudge":
          await this.send(cmd.employeeId, cmd.text);
          return;
        case "resolve_approval":
          return this.resolveApproval(cmd.approvalId, cmd.decision, cmd.comment);
        case "answer_question":
          return this.answerQuestion(cmd.questionId, cmd.answer, "user");
        case "cell_action": {
          const run = this.runs.get(cmd.taskId);
          if (!run) return;
          const reason = cmd.reason ?? "by you";
          const patch: PlanPatch =
            cmd.action === "skip"
              ? { op: "skip_item", itemId: cmd.itemId, reason }
              : cmd.action === "hold"
                ? { op: "hold_item", itemId: cmd.itemId, reason }
                : cmd.action === "release"
                  ? { op: "release_item", itemId: cmd.itemId }
                  : { op: "retry_item", itemId: cmd.itemId, ...(cmd.fromStepId ? { fromStepId: cmd.fromStepId } : {}) };
          const item = run.plan?.items.find((i) => i.id === cmd.itemId);
          // Holding from the grid also holds it in the real system (protective, never blocked).
          run.queue.push({ patch, actor: "user", ...(cmd.action === "hold" && item ? { then: () => this.protectiveHold(run, item, `You held it: ${reason}`) } : {}) });
          run.wake();
          return;
        }
        case "reorder_items": {
          const run = this.runs.get(cmd.taskId);
          if (!run?.plan) return;
          run.queue.push({ patch: { op: "reorder", itemIds: completeOrder(run.plan, cmd.itemIds) }, actor: "user" });
          run.wake();
          return;
        }
        case "task_control": {
          const run = this.runs.get(cmd.taskId);
          if (run) this.control(run, cmd.action);
          return;
        }
        case "rename_employee": {
          const st = this.employees.get(cmd.employeeId);
          if (!st) return;
          st.employee = { ...st.employee, name: cmd.name };
          this.emit({ type: "employee.updated", payload: { employeeId: cmd.employeeId, changes: { name: cmd.name } } }, "user");
          return;
        }
        case "create_employee":
          this.createEmployee({ name: cmd.name ?? `Employee ${this.employees.size + 1}`, ...(cmd.scope ? { scope: cmd.scope } : {}) });
          return;
        case "resolve_plank_proposal":
          return; // M7
      }
    });
  }

  /** Post a chat message from someone other than an employee (e.g. Theseus, the manager). */
  postMessage(threadId: string, from: Actor, text: string, taskId?: string) {
    this.post(threadId, from, text, taskId);
  }

  /** Resolves when nothing is actively running (every task is done or waiting for you). */
  settled(): Promise<void> {
    if (this.busy === 0) return Promise.resolve();
    return new Promise((r) => this.settleWaiters.push(r));
  }

  pendingApprovals(employeeId?: string): Approval[] {
    return [...this.approvals.values()].filter((p) => !employeeId || p.run.employeeId === employeeId).map((p) => p.approval);
  }

  openQuestionsOf(employeeId: string): OpenQuestion[] {
    return [...this.questions.values()].filter((q) => q.employeeId === employeeId);
  }

  /** Short status line for chat answers and the CLI. */
  status(taskId: string): string {
    const run = this.runs.get(taskId);
    if (!run) return "No such task.";
    if (!run.plan) return `${run.task.status}: ${run.task.goal ?? run.task.request}`;
    const sum = summarize(run.plan);
    const total = run.plan.items.length;
    const checked = sum.done + sum.skipped + sum.failed + sum.held + sum.needs_you;
    const noun = run.playbook?.item.plural ?? (run.program ? `${run.program.itemKind}s` : "items");
    const breakdown = [sum.done ? `${sum.done} done` : "", sum.held ? `${sum.held} held` : "", sum.needs_you ? `${sum.needs_you} need you` : "", sum.failed ? `${sum.failed} failed` : "", sum.skipped ? `${sum.skipped} skipped` : ""].filter(Boolean);
    const parts = [`${checked}/${total} ${noun} checked${breakdown.length ? ` (${breakdown.join(", ")})` : ""}`];
    const cur = run.plan.items.find((i) => run.plan!.steps.some((s) => run.plan!.cells[i.id]![s.id]!.state === "running"));
    if (cur) parts.push(`working on ${cur.label}`);
    if (run.paused) parts.push("paused");
    return `${parts.join(" · ")}.`;
  }

  /* ------------------------------------------------------------------ bookkeeping */

  private track<T>(fn: () => Promise<T>): Promise<T> {
    this.busy++;
    return fn().finally(() => {
      this.busy--;
      this.checkSettled();
    });
  }

  private checkSettled() {
    if (this.busy === 0) {
      const ws = this.settleWaiters.splice(0);
      for (const w of ws) w();
    }
  }

  private emit(body: EventBody, actor: Actor, meta: { employeeId?: string; taskId?: string } = {}) {
    return this.log.append(body, { actor, ...meta });
  }

  private mustEmployee(id: string): EmployeeState {
    const st = this.employees.get(id);
    if (!st) throw new Error(`Unknown employee ${id}`);
    return st;
  }

  private post(employeeId: string, from: Actor, text: string, taskId?: string, attachments: { name: string; mime: string; ref: string }[] = []) {
    this.emit(
      {
        type: "message.posted",
        payload: { id: this.ids.next("msg"), threadId: employeeId, from, text, attachments, ...(taskId ? { taskId } : {}), ts: this.log.now },
      },
      from,
      { employeeId, ...(taskId ? { taskId } : {}) },
    );
  }

  private say(run: TaskRun, text: string, attachments: { name: string; mime: string; ref: string }[] = []) {
    this.post(run.employeeId, `employee:${run.employeeId}`, text, run.task.id, attachments);
  }

  private setEmployee(st: EmployeeState, changes: Partial<Employee>) {
    st.employee = { ...st.employee, ...changes };
    this.emit({ type: "employee.updated", payload: { employeeId: st.employee.id, changes } }, "system", { employeeId: st.employee.id });
  }

  private setStatus(run: TaskRun, status: TaskStatus, reason?: string) {
    if (run.task.status === status) return;
    run.task = { ...run.task, status };
    this.emit({ type: "task.status_changed", payload: { taskId: run.task.id, status, ...(reason ? { reason } : {}) } }, `employee:${run.employeeId}`, {
      employeeId: run.employeeId,
      taskId: run.task.id,
    });
    const st = this.employees.get(run.employeeId)!;
    const empStatus = status === "waiting_on_user" ? "waiting_on_user" : run.paused ? "paused" : ["done", "failed", "cancelled"].includes(status) ? "idle" : "working";
    if (st.employee.status !== empStatus) this.setEmployee(st, { status: empStatus });
  }

  private updateTask(run: TaskRun, changes: Partial<Task>) {
    run.task = { ...run.task, ...changes };
    this.emit({ type: "task.updated", payload: { taskId: run.task.id, changes } }, `employee:${run.employeeId}`, { employeeId: run.employeeId, taskId: run.task.id });
  }

  private patch(run: TaskRun, patch: PlanPatch, actor: Actor) {
    run.plan = applyPatch(run.plan!, patch, this.log.now, actor);
    this.emit({ type: "plan.patched", payload: { taskId: run.task.id, version: run.plan.version, patch } }, actor, {
      employeeId: run.employeeId,
      taskId: run.task.id,
    });
  }

  private async callModel(req: ModelRequest, taskId?: string): Promise<ModelResponse> {
    const callId = this.ids.next("llm");
    const t0 = Date.now();
    try {
      const res = await this.opts.model.generate(req);
      this.emit(
        { type: "model.called", payload: { callId, purpose: req.purpose, model: this.opts.model.name, ok: true, cached: !!res.cached, durationMs: Date.now() - t0, ...(taskId ? { taskId } : {}) } },
        "system",
        taskId ? { taskId } : {},
      );
      return res;
    } catch (e) {
      this.emit(
        {
          type: "model.called",
          payload: { callId, purpose: req.purpose, model: this.opts.model.name, ok: false, cached: false, durationMs: Date.now() - t0, error: (e as Error).message, ...(taskId ? { taskId } : {}) },
        },
        "system",
        taskId ? { taskId } : {},
      );
      throw e;
    }
  }

  private json<T>(purpose: string, system: string, prompt: string, schema: z.ZodType<T>, taskId?: string): Promise<T> {
    return generateJson((r) => this.callModel(r, taskId), { purpose, system, prompt, thinking: this.opts.thinking ?? "low" }, schema);
  }

  private system(run: { employeeId: string }) {
    return roleIntro(this.pack.manifest, this.mustEmployee(run.employeeId).employee.name);
  }

  private packCtx(run: TaskRun): PackCtx {
    return {
      employeeId: run.employeeId,
      taskId: run.task.id,
      params: run.params,
      shared: run.shared,
      today: this.pack.today(),
      call: async (tool, input) => {
        const r = await this.gateway.call(tool, input, { employeeId: run.employeeId, taskId: run.task.id });
        if (!r.ok) throw new StepFailure(r.error, r.blockedBy);
        return r.data as any;
      },
      evidence: (e) => this.addEvidence(run, e),
    };
  }

  private addEvidence(run: { employeeId: string; task: Task }, e: EvidenceInput): string {
    const id = this.ids.next("ev");
    this.emit({ type: "evidence.added", payload: { id, capturedAt: this.log.now, ...e } }, `employee:${run.employeeId}`, {
      employeeId: run.employeeId,
      taskId: run.task.id,
    });
    return id;
  }

  /* ------------------------------------------------------------------ task lifecycle */

  private startTask(st: EmployeeState, request: string) {
    const taskId = this.ids.next("task");
    const task: Task = { id: taskId, employeeId: st.employee.id, request, successCriteria: [], status: "understanding", createdAt: this.log.now };
    let wakeFn = () => {};
    const run: TaskRun = {
      task,
      employeeId: st.employee.id,
      params: {},
      shared: {},
      itemData: new Map(),
      answers: new Map(),
      queue: [],
      paused: false,
      cancelled: false,
      wake: () => wakeFn(),
      fatalStreak: 0,
    };
    // A fresh promise each time the loop waits; wake() resolves it.
    (run as TaskRun & { _sleep: () => Promise<void> })._sleep = () =>
      new Promise<void>((r) => {
        wakeFn = () => {
          wakeFn = () => {};
          r();
        };
      });
    this.runs.set(taskId, run);
    st.current = run;
    this.emit({ type: "task.created", payload: task }, "user", { employeeId: st.employee.id, taskId });
    this.setEmployee(st, { status: "working", currentTaskId: taskId });

    const loop = this.track(async () => {
      try {
        await this.runTask(run);
      } catch (e) {
        this.say(run, `I hit an internal error and stopped this task: ${(e as Error).message}`);
        this.setStatus(run, "failed", (e as Error).message);
      } finally {
        // Free the employee BEFORE settled() resolves, so the next message starts a new task.
        if (st.current === run) st.current = undefined;
        if (st.employee.currentTaskId === taskId) this.setEmployee(st, { status: "idle" });
      }
    });
    this.loops.add(loop);
    void loop.finally(() => {
      this.loops.delete(loop);
      const next = st.backlog.shift();
      if (next) this.track(async () => this.startTask(st, next));
    });
  }

  /** Wait (not busy) until something wakes the run: an approval, an answer, a nudge, resume. */
  private async idleWait(run: TaskRun) {
    const p = (run as TaskRun & { _sleep: () => Promise<void> })._sleep();
    this.busy--;
    this.checkSettled();
    try {
      await p;
    } finally {
      this.busy++;
    }
  }

  private async runTask(run: TaskRun) {
    // Answer at once, before the (slower) model call: a person says "on it" first
    // (not for "what can you do?", which is answered straight away anyway).
    if (!isAboutMe(run.task.request)) this.say(run, acknowledge(run.task.request, run.task.id));
    const ok = await this.understandAndPlan(run);
    if (!ok) return;
    this.setStatus(run, "running");

    while (!run.cancelled) {
      await this.applyQueued(run);
      if (run.cancelled) break;
      if (run.paused) {
        await this.idleWait(run);
        continue;
      }
      const next = nextRunnableCell(run.plan!);
      if (next) {
        await this.runCell(run, next.itemId, next.stepId);
        if (this.opts.stepDelayMs) await new Promise((r) => setTimeout(r, this.opts.stepDelayMs));
        continue;
      }
      const waiting = [...this.approvals.values()].some((a) => a.run === run) || [...this.questions.values()].some((q) => q.run === run && q.blocking);
      if (waiting || run.queue.length) {
        if (!run.queue.length) {
          this.setStatus(run, "waiting_on_user");
          await this.idleWait(run);
          if (!run.cancelled && !run.paused) this.setStatus(run, "running");
        }
        continue;
      }
      break;
    }
    if (run.cancelled) {
      this.closeQuestions(run);
      if (run.plan) this.say(run, `Stopped as you asked. Where it stands: ${this.status(run.task.id)} Nothing else will be changed; what's done stays done.`);
      this.setStatus(run, "cancelled", "cancelled by you");
      return;
    }
    await this.finishTask(run);
  }

  /* ---- understand → orient → plan */

  private async understandAndPlan(run: TaskRun): Promise<boolean> {
    const pack = this.pack;
    // "What can you do?" needs no model call and no records.
    if (isAboutMe(run.task.request)) {
      this.finishWithAnswer(run, "Explain what I can do", this.aboutMe());
      return false;
    }
    const call = this.packCtx(run).call;
    const index = await pack.orient({ request: run.task.request, call });
    const offered = [...pack.playbooks.values()].filter((p) => pack.handlers[p.id]);
    const toolList = this.gateway.describe((t) => t.risk !== "irreversible").map((t) => ({ name: t.name, description: t.description }));
    const answers: { question: string; answer: string }[] = [];

    let decision: RouteDecision;
    for (let round = 0; ; round++) {
      try {
        decision = await this.json(
          "route",
          this.system(run),
          routePrompt({ request: run.task.request, index, playbooks: offered.map((p) => ({ playbook: p, params: pack.params[p.id] ?? {} })), tools: toolList, answers }),
          RouteDecision,
          run.task.id,
        );
      } catch (e) {
        const fallback = this.keywordRoute(run.task.request, offered);
        if (!fallback) {
          this.say(run, `I couldn't work out how to handle this: ${modelProblem(e)}`);
          this.setStatus(run, "failed", (e as Error).message);
          return false;
        }
        this.say(run, `The model is unavailable (${modelProblem(e)}), so I matched your request to "${fallback.title}" by keywords.`);
        decision = { inScope: true, tier: 1, goal: fallback.title, successCriteria: fallback.success_criteria, playbookId: fallback.id, assumptions: ["Routed by keywords because the model was unavailable"], questions: [], relevant: [] };
      }
      const blocking = decision.questions.filter((q) => q.blocking && !q.default);
      if (!decision.inScope || !blocking.length || round >= 2) break;
      // Ask before planning; only this task waits.
      for (const q of blocking) {
        const answer = await this.askTaskQuestion(run, q.text);
        if (run.cancelled) return false;
        answers.push({ question: q.text, answer });
      }
    }

    if (!decision.inScope) {
      this.say(run, decision.refusal ?? "That's outside what I do in this role, so I'll leave it with you.");
      this.updateTask(run, { goal: decision.goal });
      this.setStatus(run, "cancelled", "out of scope");
      return false;
    }
    if (decision.mode === "about_me") {
      this.finishWithAnswer(run, decision.goal, this.aboutMe());
      return false;
    }
    if (decision.mode === "answer" && decision.answer?.trim()) {
      this.finishWithAnswer(run, decision.goal, `${decision.answer.trim()}\n\n(That's general knowledge of the job, not something I checked in our records.)`);
      return false;
    }
    if (decision.mode === "lookup" && decision.lookup?.subjects.length && this.pack.lookup) {
      await this.lookupSubjects(run, decision);
      return false;
    }
    if (decision.mode === "draft" || (decision.draft && !decision.playbookId)) {
      await this.draftDocument(run, decision);
      return false;
    }

    const assumptions = [...decision.assumptions];
    for (const q of decision.questions.filter((x) => x.default)) {
      assumptions.push(`${q.text} → assuming "${q.default}" (tell me if not)`);
      this.openSoftQuestion(run, q.text, q.default!);
    }

    let playbook = decision.playbookId ? pack.playbooks.get(decision.playbookId) : undefined;
    if (playbook && !pack.handlers[playbook.id]) playbook = undefined;
    let tier = decision.tier;
    if (tier !== 3 && !playbook) tier = 3;

    if (playbook) {
      const resolved = pack.resolveParams?.(playbook.id, decision.params ?? {}, index, run.task.request) ?? { params: decision.params ?? {}, assumptions: [], problems: [] };
      assumptions.push(...resolved.assumptions);
      if (resolved.problems.length) {
        this.say(run, `I can't start yet: ${resolved.problems.join("; ")}`);
        this.setStatus(run, "failed", resolved.problems.join("; "));
        return false;
      }
      run.params = resolved.params;
      run.playbook = playbook;
      let steps = playbook.steps;
      if (tier === 2 && decision.stepIds?.length) {
        const wanted = new Set(decision.stepIds.filter((s) => playbook!.steps.some((x) => x.id === s)));
        const addNeeds = (id: string) => {
          for (const n of playbook!.steps.find((s) => s.id === id)?.needs ?? []) if (!wanted.has(n)) (wanted.add(n), addNeeds(n));
        };
        for (const id of [...wanted]) addNeeds(id);
        steps = playbook.steps.filter((s) => wanted.has(s.id));
        if (!steps.length || steps.length === playbook.steps.length) (tier = 1), (steps = playbook.steps);
      } else tier = 1;

      const items = await this.discoverItems(run, playbook.id, decision.itemFilter);
      if (!items) return false;
      run.plan = createPlan({ taskId: run.task.id, playbookId: playbook.id, playbookVersion: playbook.version, steps: steps.map((s) => ({ id: s.id, title: s.title })), widget: playbook.widget });
      this.emitOrient(run, index, decision, assumptions);
      this.updateTask(run, {
        goal: decision.goal,
        successCriteria: (decision.successCriteria.length ? decision.successCriteria : playbook.success_criteria).map((t, i) => ({ id: `c${i + 1}`, text: t })),
        playbookId: playbook.id,
        playbookVersion: playbook.version,
        tier,
        assumptions,
      });
      this.emit({ type: "plan.created", payload: run.plan }, `employee:${run.employeeId}`, { employeeId: run.employeeId, taskId: run.task.id });
      if (items.length) this.patch(run, { op: "add_items", items }, `employee:${run.employeeId}`);
      this.say(
        run,
        [
          `${tier === 2 ? "Doing part of" : "Running"} "${playbook.title}": ${items.length} ${items.length === 1 ? playbook.item.kind : playbook.item.plural} × ${steps.length} step${steps.length === 1 ? "" : "s"} (${steps.map((s) => s.title).join(" → ")}).`,
          assumptions.length ? `Assumptions: ${assumptions.join(" · ")}` : "",
        ]
          .filter(Boolean)
          .join("\n"),
      );
      return true;
    }

    // Tier 3: compose a program from tools, try it on a few items, fix it if it reads the wrong fields.
    const composed = await this.compose(run, index, decision.goal);
    if (!composed) return false;
    const { program, items } = composed;
    run.program = program;
    assumptions.push(...composed.notes);
    run.plan = createPlan({ taskId: run.task.id, playbookId: "composed", playbookVersion: 1, steps: program.steps.map((s) => ({ id: s.id, title: s.title.slice(0, 24) })) });
    this.emitOrient(run, index, decision, assumptions);
    this.updateTask(run, {
      goal: decision.goal,
      successCriteria: (decision.successCriteria.length ? decision.successCriteria : [decision.goal]).map((t, i) => ({ id: `c${i + 1}`, text: t })),
      playbookId: "composed",
      tier: 3,
      assumptions,
    });
    this.emit({ type: "plan.created", payload: run.plan }, `employee:${run.employeeId}`, { employeeId: run.employeeId, taskId: run.task.id });
    if (items.length) this.patch(run, { op: "add_items", items }, `employee:${run.employeeId}`);
    this.say(
      run,
      [
        `No playbook covers this, so I composed a plan from my tools: ${items.length} ${program.itemKind}${items.length === 1 ? "" : "s"} × ${program.steps.map((s) => s.title).join(" → ")}.`,
        assumptions.length ? `Assumptions: ${assumptions.join(" · ")}` : "",
      ]
        .filter(Boolean)
        .join("\n"),
    );
    return true;
  }

  private emitOrient(run: TaskRun, index: OrientIndex, d: RouteDecision, assumptions: string[]) {
    const byRef = new Map(index.sources.map((s) => [s.ref, s]));
    const found = d.relevant
      .map((r) => {
        const s = byRef.get(r.ref) ?? index.sources.find((x) => x.ref.endsWith(`:${r.ref}`) || x.label === r.ref);
        return s ? { kind: s.kind, ref: s.ref, label: s.label, why: r.why } : undefined;
      })
      .filter((x): x is NonNullable<typeof x> => !!x);
    this.emit({ type: "orient.completed", payload: { taskId: run.task.id, found, assumptions } }, `employee:${run.employeeId}`, {
      employeeId: run.employeeId,
      taskId: run.task.id,
    });
  }

  /** Simple keyword router used only when the model is unavailable (graceful degradation). */
  private keywordRoute(request: string, playbooks: Playbook[]): Playbook | undefined {
    const words = new Set(request.toLowerCase().match(/[a-z]{4,}/g) ?? []);
    let best: { p: Playbook; score: number } | undefined;
    for (const p of playbooks) {
      const text = `${p.title} ${p.when_to_use} ${p.item.plural}`.toLowerCase();
      const score = [...words].filter((w) => text.includes(w)).length;
      if (score >= 2 && (!best || score > best.score)) best = { p, score };
    }
    return best?.p;
  }

  private async discoverItems(run: TaskRun, playbookId: string, filter?: string[]): Promise<PlanItem[] | null> {
    const fn = this.pack.discover[playbookId];
    let items: PlanItem[];
    try {
      items = fn ? await fn(this.packCtx(run)) : [];
    } catch (e) {
      this.say(run, `I couldn't find the items to work on: ${(e as Error).message}`);
      this.setStatus(run, "failed", (e as Error).message);
      return null;
    }
    if (filter?.length) {
      const picked = items.filter((it) => filter.some((f) => matchesItem(it, f)));
      if (!picked.length) {
        // Never widen a request: doing ALL items when the user named one could change records they never asked about.
        this.say(
          run,
          `You named ${filter.map((f) => `"${f}"`).join(", ")}, but that isn't one of the items this job covers (${items.slice(0, 8).map((i) => i.label).join(", ")}${items.length > 8 ? ", …" : ""}). I haven't started anything. Tell me which one you meant, or ask in other words.`,
        );
        this.setStatus(run, "failed", "named item not found");
        return null;
      }
      items = picked;
    }
    return items;
  }

  private finishWithAnswer(run: TaskRun, goal: string, text: string) {
    this.updateTask(run, { goal });
    this.say(run, text);
    this.setStatus(run, "done");
  }

  /** "What can you do?", answered from the role pack itself, so it is always true. */
  aboutMe(): string {
    const m = this.pack.manifest;
    const pbs = [...this.pack.playbooks.values()].filter((p) => this.pack.handlers[p.id]);
    const tools = this.gateway.describe();
    const lines = [
      `I'm a ${m.name}${m.company ? ` at ${m.company.replace(/\s*\(fictional\)/i, "")}` : ""}. What I do:`,
      ...m.scope.does.map((d) => `• ${d.charAt(0).toUpperCase()}${d.slice(1)}`),
      "",
      "Procedures I know by heart:",
      ...pbs.map((p) => `• ${p.title}: ${p.steps.map((s) => s.title).join(" → ")}`),
      "",
      `For related jobs no procedure covers, I put a plan together from my ${tools.length} tools (inbox, eProcure, ERP, GST and Udyam lookups, bank checks, files) and try it on a few items before running it.`,
      "",
      "How I work: I look around first (inbox, tenders, payment batches, files), tell you how I'll handle it and what I assumed, then go item by item. Anything that can't be undone, like activating a vendor or sending an email, waits for your OK. You can message me while I work (\"hold Malnad\", \"how far are you?\") and I keep going. At the end I re-check the results on a fresh read and report.",
      "",
      `What I don't do: ${m.scope.does_not.join("; ")}.`,
    ];
    return lines.join("\n");
  }

  /** mode=lookup: "everything on Malnad", read live from every system by the pack; no plan, no extra model call. */
  private async lookupSubjects(run: TaskRun, decision: RouteDecision) {
    this.updateTask(run, { goal: decision.goal, tier: 3 });
    const parts: string[] = [];
    for (const subject of decision.lookup!.subjects) {
      const r = await this.pack.lookup!(subject, this.packCtx(run), "full").catch((e: Error) => ({ found: null, suggestions: [], error: e.message }));
      if (r.found) parts.push(r.found.profile ?? `${r.found.label}:\n${Object.entries(r.found.facts).map(([k, v]) => `${k}: ${typeof v === "object" ? JSON.stringify(v) : String(v)}`).join("\n")}`);
      else parts.push(`I couldn't find "${subject}" in our records${r.suggestions.length ? `. Did you mean ${r.suggestions.join(" or ")}?` : "."}`);
    }
    this.say(run, parts.join("\n\n"));
    this.setStatus(run, "done");
  }

  /** mode=draft: look up the subjects, write the document once, save it as a NEW Word file, send nothing. */
  private async draftDocument(run: TaskRun, decision: RouteDecision) {
    const ask = decision.draft ?? { document: decision.goal, subjects: [] };
    this.updateTask(run, { goal: decision.goal, tier: 3, assumptions: decision.assumptions });
    const facts: LookupResult[] = [];
    const missing: { subject: string; suggestions: string[] }[] = [];
    for (const subject of ask.subjects) {
      const r = this.pack.lookup ? await this.pack.lookup(subject, this.packCtx(run)).catch(() => ({ found: null, suggestions: [] })) : { found: null, suggestions: [] };
      if (r.found) facts.push(r.found);
      else missing.push({ subject, suggestions: r.suggestions });
    }
    if (missing.length) {
      this.say(
        run,
        `I couldn't find ${missing.map((m) => `"${m.subject}"${m.suggestions.length ? ` (closest: ${m.suggestions.join(", ")})` : ""}`).join(" or ")} in our records, so I haven't written anything. A letter about a party we can't find would have to be made up. Tell me who you meant.`,
      );
      this.setStatus(run, "failed", "subject not found");
      return;
    }
    this.say(run, `Writing ${ask.document}${facts.length ? ` for ${facts.map((f) => f.label).join(", ")}` : ""}, from our records.`);
    let doc: DraftDoc;
    try {
      doc = await this.json(
        "draft",
        this.system(run),
        draftPrompt({ request: run.task.request, document: ask.document, today: this.pack.today(), sender: `Vendor Desk, ${(this.pack.manifest.company ?? "the company").replace(/\s*\(fictional\)/i, "")}`, facts }),
        DraftDoc,
        run.task.id,
      );
    } catch (e) {
      this.say(run, `I couldn't write it: ${modelProblem(e)}`);
      this.setStatus(run, "failed", (e as Error).message);
      return;
    }
    const allText = [doc.title, doc.subtitle ?? "", ...doc.blocks.flatMap((b) => [b.text ?? "", ...(b.items ?? []), ...(b.rows ?? []).flat()])].join("\n");
    const unsupported = unsupportedClaims(allText, `${run.task.request} ${this.pack.today()} ${JSON.stringify(facts)}`);
    const file = doc.fileName.replace(/[\\/:*?"<>|]+/g, " ").trim() || "Draft.docx";
    const r = await this.gateway.call("files.save_docx", { path: `Drafts/${file}`, title: doc.title, ...(doc.subtitle ? { subtitle: doc.subtitle } : {}), blocks: doc.blocks }, { employeeId: run.employeeId, taskId: run.task.id });
    if (!r.ok) {
      this.say(run, `I wrote it but couldn't save it: ${r.error.message}`);
      this.setStatus(run, "failed", r.error.message);
      return;
    }
    const path = (r.data as { path: string }).path;
    const placeholders = [...new Set(allText.match(/\[[^\]]{2,40}\]/g) ?? [])];
    // Today's date belongs on the letter, not in its claims ("effective from <today>").
    const body = doc.blocks.flatMap((b) => [b.text ?? "", ...(b.items ?? []), ...(b.rows ?? []).flat()]).join("\n");
    if (dateForms(this.pack.today()).some((f) => body.includes(f))) unsupported.push(`today's date used in the text (${this.pack.today()}); is that really when it happened?`);
    this.say(
      run,
      [
        `Done: "${doc.title}" is saved as ${path}. Open it to review.`,
        placeholders.length ? `Fill in before it goes out: ${placeholders.join(", ")}.` : "",
        unsupported.length ? `Check these, they aren't in our records: ${unsupported.join(", ")}.` : "",
        "Nothing has been sent. If you want it emailed, tell me; sending needs your OK.",
      ]
        .filter(Boolean)
        .join("\n"),
      [{ name: path.split("/").pop()!, mime: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", ref: `workspace:${path}` }],
    );
    this.setStatus(run, "done");
  }

  /**
   * Tier 3. The model writes a program; the kernel checks it statically, lists
   * the items, then does a TRIAL RUN of the read steps on up to three items and
   * checks every field the program reads really exists in what the tools return.
   * If not, the model gets one or two chances to fix it, shown the real data.
   * Extra model calls happen only when the first program is broken.
   */
  private async compose(run: TaskRun, index: OrientIndex, goal: string): Promise<{ program: Program; items: PlanItem[]; notes: string[] } | null> {
    const tools = this.gateway.describe((t) => t.risk !== "irreversible");
    let problems: string[] = [];
    let samples: string | undefined;
    for (let attempt = 0; attempt < 3; attempt++) {
      let p: Program;
      try {
        p = await this.json("compose", this.system(run), composePrompt({ request: run.task.request, goal, index, tools, problems, ...(samples ? { samples } : {}) }), Program, run.task.id);
      } catch (e) {
        this.say(run, `I couldn't put together a plan for this: ${modelProblem(e)}`);
        this.setStatus(run, "failed", (e as Error).message);
        return null;
      }
      const { notes } = normalizeProgram(p);
      problems = validateProgram(p, this.gateway);
      if (problems.length) continue;
      run.itemData.clear();
      const items = await this.programItems(run, p);
      if (!items) return null;
      if (!items.length) return { program: p, items, notes };
      const probe = await this.probeProgram(run, p, items);
      if (!probe.problems.length) return { program: p, items, notes };
      problems = probe.problems;
      samples = probe.samples;
      if (attempt < 2) this.say(run, `A trial run on a few items showed my plan was reading the wrong data (${problems[0]}). Fixing it before I start.`);
    }
    this.say(run, `I couldn't compose a plan that works on the real data, so I stopped rather than give you a wrong answer: ${problems.join("; ")}`);
    this.setStatus(run, "failed", problems.join("; "));
    return null;
  }

  /** Run the READ steps of a program on up to three items and check its paths against the real outputs. */
  private async probeProgram(run: TaskRun, p: Program, items: PlanItem[]): Promise<{ problems: string[]; samples: string }> {
    const ctx = { employeeId: run.employeeId, taskId: run.task.id };
    const picks = [...new Set([items[0]!, items[Math.floor(items.length / 2)]!, items[items.length - 1]!])];
    const problems: string[] = [];
    const scopes: { item: unknown; steps: Record<string, unknown>; params: unknown }[] = [];
    let ranSteps = 0;
    for (const it of picks) {
      const scope = { item: run.itemData.get(it.id)?.element, steps: {} as Record<string, unknown>, params: run.params };
      let n = 0;
      for (const st of p.steps) {
        if (this.gateway.get(st.tool)?.risk !== "read") break;
        const prepared = this.programArgs(st, scope);
        if ("missing" in prepared) break; // this item lacks the data (e.g. no GSTIN): not the plan's fault
        const args = prepared.args;
        let r = await this.gateway.call(st.tool, args, ctx);
        if (!r.ok && r.error.class === "validation") r = await this.gateway.call(st.tool, coerceArgs(args), ctx);
        if (!r.ok) {
          problems.push(`step "${st.id}" failed on ${it.label}: ${r.error.message}`);
          break;
        }
        scope.steps[st.id] = r.data;
        n++;
      }
      ranSteps = Math.max(ranSteps, n);
      scopes.push(scope);
    }
    if (picks.every((it) => it.id.startsWith("item_"))) problems.push(`items.idPath "${p.items.idPath}" isn't in the listed items`);
    for (const { path, where, cond, stepIndex } of programPaths(p)) {
      const stepId = path.startsWith("steps.") ? path.split(".")[1]!.replace(/\[\]$/, "") : undefined;
      if (stepId && p.steps.findIndex((s) => s.id === stepId) >= ranSteps) continue; // not tried (a write step)
      if (stepIndex > ranSteps && !where.startsWith("column")) continue;
      const res = scopes.map((sc) => pathResolves(sc, path));
      if (res.length && res.every((r) => r === false)) {
        problems.push(`${where}: "${path}" doesn't exist in the data`);
        continue;
      }
      if (cond && !cond.agg && !["exists", "missing", "contains", "not_contains"].includes(cond.op) && scopes.some((sc) => Array.isArray(getPath(sc, path)))) {
        problems.push(`${where}: "${path}" is a list; add agg (max = latest, min = earliest, count = how many)`);
      }
    }
    const clip = (v: unknown, n: number) => {
      const t = JSON.stringify(v);
      return t.length > n ? `${t.slice(0, n)}…` : t;
    };
    const first = scopes[0];
    const samples = first
      ? [`item (one element of the list): ${clip(first.item, 700)}`, ...Object.entries(first.steps).map(([id, out]) => `steps.${id}: ${clip(out, 900)}`)].join("\n")
      : "";
    return { problems, samples };
  }

  private async programItems(run: TaskRun, p: Program): Promise<PlanItem[] | null> {
    const today = this.pack.today();
    const tryList = async (args: Record<string, unknown>) => this.gateway.call(p.items.tool, args, { employeeId: run.employeeId, taskId: run.task.id });
    const args = fillArgs(p.items.args, { params: run.params });
    let r = await tryList(args);
    if (!r.ok && r.error.class === "validation") r = await tryList(coerceArgs(args));
    if (!r.ok) {
      this.say(run, `I couldn't list the items (${p.items.tool}): ${r.error.message}`);
      this.setStatus(run, "failed", r.error.message);
      return null;
    }
    const list = getPath(r.data, p.items.listPath);
    if (!Array.isArray(list)) {
      this.say(run, `The item list wasn't where I expected (${p.items.listPath || "the whole output"} is not a list).`);
      this.setStatus(run, "failed", "item list not found");
      return null;
    }
    const items: PlanItem[] = [];
    const seen = new Set<string>();
    for (const el of list.slice(0, 300)) {
      if (!allTrue(p.items.where, { item: el }, today)) continue;
      let id = String(getPath(el, p.items.idPath) ?? "").trim() || `item_${items.length + 1}`;
      while (seen.has(id)) id = `${id}*`;
      seen.add(id);
      run.itemData.set(id, { element: el, steps: {} });
      items.push({ id, label: String(interpolate(p.items.labelTemplate, { item: el })).slice(0, 80) || id, ref: id, held: false });
    }
    return items;
  }

  private askTaskQuestion(run: TaskRun, text: string): Promise<string> {
    return new Promise<string>((resolve) => {
      const id = this.ids.next("q");
      this.questions.set(id, { id, employeeId: run.employeeId, run, key: "task", text, blocking: true, resolve });
      this.emit(
        { type: "question.asked", payload: { questionId: id, employeeId: run.employeeId, taskId: run.task.id, text, blocking: true, options: [] } },
        `employee:${run.employeeId}`,
        { employeeId: run.employeeId, taskId: run.task.id },
      );
      this.say(run, `Before I start: ${text}`);
      this.setStatus(run, "waiting_on_user");
      // Not busy while we wait for you.
      this.busy--;
      this.checkSettled();
    }).finally(() => {
      this.busy++;
      this.setStatus(run, "planning");
    });
  }

  private openSoftQuestion(run: TaskRun, text: string, fallback: string, itemId?: string, stepId?: string, key = "task") {
    const id = this.ids.next("q");
    this.questions.set(id, { id, employeeId: run.employeeId, run, key, text, blocking: false, fallback, ...(itemId ? { itemId } : {}), ...(stepId ? { stepId } : {}) });
    this.emit(
      {
        type: "question.asked",
        payload: { questionId: id, employeeId: run.employeeId, taskId: run.task.id, ...(itemId ? { itemId } : {}), ...(stepId ? { stepId } : {}), text, blocking: false, default: fallback, options: [] },
      },
      `employee:${run.employeeId}`,
      { employeeId: run.employeeId, taskId: run.task.id },
    );
  }

  /* ---- running cells */

  private async runCell(run: TaskRun, itemId: string, stepId: string) {
    const actor: Actor = `employee:${run.employeeId}`;
    this.patch(run, { op: "set_cell", itemId, stepId, state: "running" }, actor);
    const item = run.plan!.items.find((i) => i.id === itemId)!;
    const step = run.playbook?.steps.find((s) => s.id === stepId);
    const onFail: OnFail = step?.on_fail ?? "fail_item";
    let outcome: StepOutcome;
    try {
      const handler = run.program ? this.programHandler(run.program.steps.find((s) => s.id === stepId)!) : this.pack.handlers[run.playbook!.id]?.[stepId];
      if (!handler) throw new StepFailure({ class: "fatal", message: `No handler for step "${stepId}"` });
      outcome = await handler(this.stepCtx(run, item, stepId));
      run.fatalStreak = 0;
    } catch (e) {
      outcome = await this.outcomeFromError(run, item, e, onFail);
    }
    await this.applyOutcome(run, itemId, stepId, outcome);
  }

  private async outcomeFromError(run: TaskRun, item: PlanItem, e: unknown, onFail: OnFail): Promise<StepOutcome> {
    const err: ToolError = e instanceof StepFailure ? e.error : { class: "fatal", message: (e as Error).message };
    if (e instanceof StepFailure && e.blockedBy) {
      const reason = `You said: "${e.blockedBy.text}"`;
      await this.protectiveHold(run, item, reason);
      return { status: "hold", reason, note: `Held, not done: ${reason}` };
    }
    if (err.class === "fatal") {
      run.fatalStreak++;
      if (run.fatalStreak >= 3 && !run.paused) {
        this.control(run, "pause");
        this.say(run, `Three steps in a row failed with the same kind of error (${err.message}). I've paused so nothing else goes wrong; say "resume" when it's fixed.`);
      }
      return { status: "failed", note: err.message };
    }
    const note = `${err.class.replace(/_/g, " ")}: ${err.message}${err.hint ? ` (${err.hint})` : ""}`;
    switch (onFail) {
      case "continue":
        return { status: "done", note: `Couldn't complete, moved on: ${note}` };
      case "skip_item":
        return { status: "skipped", note };
      case "fail_item":
        return { status: "failed", note };
      default:
        return { status: "needs_you", note };
    }
  }

  private async applyOutcome(run: TaskRun, itemId: string, stepId: string, o: StepOutcome) {
    const actor: Actor = `employee:${run.employeeId}`;
    const ev = "evidenceIds" in o && o.evidenceIds?.length ? { evidenceIds: o.evidenceIds } : {};
    switch (o.status) {
      case "done":
        this.patch(run, { op: "set_cell", itemId, stepId, state: "done", ...(o.note ? { note: o.note } : {}), ...ev }, actor);
        return;
      case "hold":
        this.patch(run, { op: "set_cell", itemId, stepId, state: "done", note: o.note ?? `Held: ${o.reason}`, ...ev }, actor);
        if (!run.plan!.items.find((i) => i.id === itemId)?.held) this.patch(run, { op: "hold_item", itemId, reason: o.reason }, actor);
        return;
      case "failed":
        this.patch(run, { op: "set_cell", itemId, stepId, state: "failed", note: o.note, ...ev }, actor);
        return;
      case "skipped":
        this.patch(run, { op: "set_cell", itemId, stepId, state: "skipped", note: o.note }, actor);
        return;
      case "needs_you": {
        this.patch(run, { op: "set_cell", itemId, stepId, state: "needs_you", note: o.note, ...ev }, actor);
        if (o.approval) this.requestApproval(run, o.approval, itemId, stepId);
        if (o.question) {
          const id = this.ids.next("q");
          this.questions.set(id, { id, employeeId: run.employeeId, run, itemId, stepId, key: o.question.key, text: o.question.text, blocking: true });
          this.emit(
            {
              type: "question.asked",
              payload: { questionId: id, employeeId: run.employeeId, taskId: run.task.id, itemId, stepId, text: o.question.text, blocking: true, options: o.question.options ?? [] },
            },
            actor,
            { employeeId: run.employeeId, taskId: run.task.id },
          );
          const label = run.plan!.items.find((i) => i.id === itemId)?.label ?? itemId;
          this.say(run, `Question about ${label}: ${o.question.text} (the other items keep going)`);
        }
        return;
      }
    }
  }

  private requestApproval(run: TaskRun, ask: ApprovalAsk, itemId?: string, stepId?: string) {
    const approval: Approval = {
      id: this.ids.next("apr"),
      taskId: run.task.id,
      ...(itemId ? { itemId } : {}),
      ...(stepId ? { stepId } : {}),
      title: ask.title,
      reason: ask.reason,
      ...(ask.humanTask ? { humanTask: ask.humanTask } : {}),
      ...(ask.toolCall ? { toolCall: ask.toolCall } : {}),
      diff: ask.diff ?? [],
      evidenceIds: ask.evidenceIds ?? [],
      risk: ask.risk,
      status: "pending",
    };
    this.approvals.set(approval.id, { run, approval, ask, ...(itemId ? { itemId } : {}), ...(stepId ? { stepId } : {}) });
    this.emit({ type: "approval.requested", payload: approval }, `employee:${run.employeeId}`, { employeeId: run.employeeId, taskId: run.task.id });
  }

  private async resolveApproval(approvalId: string, decision: "approved" | "rejected", comment?: string) {
    const p = this.approvals.get(approvalId);
    if (!p) return;
    this.approvals.delete(approvalId);
    const decidedBy: Actor = `user:${this.opts.approver ?? "you"}`;
    this.emit(
      { type: "approval.resolved", payload: { approvalId, status: decision, decidedBy, ...(comment ? { comment } : {}) } },
      "user",
      { employeeId: p.run.employeeId, taskId: p.run.task.id },
    );
    let outcome: StepOutcome;
    if (decision === "approved") {
      let result: unknown;
      if (p.ask.toolCall) {
        const r = await this.gateway.call(p.ask.toolCall.tool, p.ask.toolCall.input, {
          employeeId: p.run.employeeId,
          taskId: p.run.task.id,
          ...(p.itemId ? { itemId: p.itemId } : {}),
          ...(p.stepId ? { stepId: p.stepId } : {}),
          approval: { approvalId, decidedBy },
          idempotencyKey: `approval:${approvalId}`,
        });
        if (!r.ok) {
          outcome = { status: "failed", note: `Approved, but it failed: ${r.error.message}` };
          if (p.itemId && p.stepId) await this.applyOutcome(p.run, p.itemId, p.stepId, outcome);
          p.run.wake();
          return;
        }
        result = r.data;
      }
      outcome = (await p.ask.onApproved?.(result)) ?? { status: "done", note: `Approved by you${p.ask.toolCall ? " and done" : ""}` };
    } else {
      outcome = (await p.ask.onRejected?.()) ?? { status: "skipped", note: `You rejected: ${p.ask.title}${comment ? ` (${comment})` : ""}` };
    }
    if (p.itemId && p.stepId) await this.applyOutcome(p.run, p.itemId, p.stepId, outcome);
    p.run.wake();
  }

  private async answerQuestion(questionId: string, answer: string, by: Actor) {
    const q = this.questions.get(questionId);
    if (!q) return;
    this.questions.delete(questionId);
    this.emit({ type: "question.answered", payload: { questionId, answer, by, usedDefault: false } }, by, { employeeId: q.employeeId, ...(q.run ? { taskId: q.run.task.id } : {}) });
    if (q.resolve) return q.resolve(answer);
    const run = q.run;
    if (!run) return;
    if (q.itemId) {
      const a = run.answers.get(q.itemId) ?? {};
      a[q.key] = answer;
      run.answers.set(q.itemId, a);
    }
    const changed = q.blocking || (q.fallback !== undefined && answer.trim().toLowerCase() !== q.fallback.trim().toLowerCase());
    if (changed && q.itemId && q.stepId && run.plan) {
      run.queue.push({ patch: { op: "retry_item", itemId: q.itemId, fromStepId: q.stepId }, actor: "user" });
      this.say(run, q.blocking ? "Thanks, picking that item up again." : "Thanks, re-doing that item with your answer.");
    } else this.say(run, "Noted, thanks.");
    run.wake();
  }

  private stepCtx(run: TaskRun, item: PlanItem, stepId: string): StepCtx {
    const kernel = this;
    const data = run.itemData.get(item.id) ?? {};
    run.itemData.set(item.id, data);
    const answers = run.answers.get(item.id) ?? {};
    run.answers.set(item.id, answers);
    const base = { employeeId: run.employeeId, taskId: run.task.id, itemId: item.id, stepId };
    const allowed = run.playbook?.steps.find((s) => s.id === stepId)?.tools;
    const tryCall = async <T>(tool: string, input: unknown): Promise<GatewayResult<T>> => {
      // A playbook step may only use the tools its YAML declares (guard rail for the planks).
      if (allowed && !allowed.includes(tool))
        return { ok: false, callId: "none", error: { class: "policy_violation", message: `Step "${stepId}" may not use ${tool} (not in its playbook tool list)` } };
      const t = this.gateway.get(tool);
      const key = t && t.risk !== "read" ? `${run.task.id}:${item.id}:${stepId}:${stableHash(input)}` : undefined;
      return this.gateway.call<T>(tool, input, {
        ...base,
        ...(key ? { idempotencyKey: key } : {}),
        onRetry: (attempt, err) => this.patch(run, { op: "set_cell", itemId: item.id, stepId, state: "retrying", note: `Retry ${attempt}: ${err.message}` }, `employee:${run.employeeId}`),
      });
    };
    return {
      task: run.task,
      get plan() {
        return run.plan!;
      },
      item,
      stepId,
      params: run.params,
      data,
      shared: run.shared,
      answers,
      today: this.pack.today(),
      tryCall,
      async call(tool, input) {
        const r = await tryCall(tool, input);
        if (!r.ok) throw new StepFailure(r.error, r.blockedBy);
        return r.data as any;
      },
      evidence: (e) => this.addEvidence(run, e),
      check: (checkId, verdict, detail, evidenceIds = []) =>
        this.emit(
          { type: "check.completed", payload: { taskId: run.task.id, itemId: item.id, stepId, checkId, verdict, detail, evidenceIds } },
          `employee:${run.employeeId}`,
          { employeeId: run.employeeId, taskId: run.task.id },
        ),
      assume(key, text, fallback) {
        if (answers[key] !== undefined) return answers[key]!;
        const already = [...kernel.questions.values()].some((q) => q.run === run && q.itemId === item.id && q.key === key);
        if (!already) kernel.openSoftQuestion(run, `${item.label}: ${text}`, fallback, item.id, stepId, key);
        return fallback;
      },
      json: (purpose, prompt, schema) => this.json(purpose, this.system(run), prompt, schema, run.task.id),
      say: (text) => this.say(run, text),
    };
  }

  /** Fill a program step's args; empty optional args are left out, empty required ones reported. */
  private programArgs(step: ProgramStep, scope: unknown): { args: Record<string, unknown> } | { missing: string[] } {
    const args = fillArgs(step.args, scope);
    const shape = (this.gateway.get(step.tool)?.input as { shape?: Record<string, { safeParse(v: unknown): { success: boolean } }> } | undefined)?.shape ?? {};
    const missing: string[] = [];
    for (const [k, tpl] of Object.entries(step.args)) {
      if (!/\{\{/.test(tpl) || (args[k] != null && args[k] !== "")) continue;
      if (shape[k]?.safeParse(undefined).success) delete args[k];
      else missing.push(/\{\{\s*([^}]+?)\s*\}\}/.exec(tpl)![1]!.split(".").pop()!.replace(/\[\]$/, ""));
    }
    return missing.length ? { missing } : { args };
  }

  private programHandler(step: ProgramStep): StepHandler {
    return async (ctx) => {
      const scope = { item: ctx.data.element, steps: (ctx.data.steps ??= {}) as Record<string, unknown>, params: ctx.params };
      const prepared = this.programArgs(step, scope);
      // A field the item doesn't have (no GSTIN on record) is a finding, not a crash.
      if ("missing" in prepared) throw new StepFailure({ class: "not_found", message: `Couldn't check: no ${prepared.missing.join(", ")} on record` });
      const args = prepared.args;
      let r = await ctx.tryCall(step.tool, args);
      if (!r.ok && r.error.class === "validation") r = await ctx.tryCall(step.tool, coerceArgs(args));
      if (!r.ok) throw new StepFailure(r.error, r.blockedBy);
      scope.steps[step.id] = r.data;
      const evidenceIds = r.evidenceIds;
      const hit = step.flagIf?.find((c) => anyTrue([c], scope, ctx.today));
      if (hit) {
        const note = step.flagNote ? String(interpolate(step.flagNote, scope)) : `Flagged: ${describeCondition(hit)}`;
        ctx.data.flags = [...(ctx.data.flags ?? []), note];
        ctx.check(step.id, "fail", note, evidenceIds);
        return { status: "done", note: `⚑ ${note}`, evidenceIds };
      }
      return { status: "done", evidenceIds };
    };
  }

  /* ---- conversation lane */

  private async converse(st: EmployeeState, text: string) {
    const run = st.current!;
    const nudgeId = this.ids.next("nudge");
    this.emit({ type: "nudge.received", payload: { nudgeId, employeeId: run.employeeId, taskId: run.task.id, text } }, "user", {
      employeeId: run.employeeId,
      taskId: run.task.id,
    });
    const open = this.openQuestionsOf(run.employeeId);
    let tri: Triage | null = triageByRules(text, { openQuestions: open.length });
    let modelAnswer: string | undefined;
    if (!tri) {
      try {
        const m = await this.json(
          "triage",
          this.system(run),
          triagePrompt({ message: text, status: `${run.task.goal ?? run.task.request}\n${this.status(run.task.id)}`, openQuestions: open.map((q) => q.text) }),
          ModelTriage,
          run.task.id,
        );
        tri = { kind: m.kind, by: "model", ...(m.action ? { action: m.action } : {}), ...(m.target ? { target: m.target } : {}) };
        modelAnswer = m.answer;
      } catch {
        tri = { kind: "unclear", by: "rules" };
      }
    }
    this.emit(
      { type: "nudge.triaged", payload: { nudgeId, kind: tri.kind, by: tri.by, ...(tri.action ? { detail: `${tri.action} ${tri.target ?? ""}`.trim() } : {}) } },
      `employee:${run.employeeId}`,
      { employeeId: run.employeeId, taskId: run.task.id },
    );
    const ack = (response: string) => {
      this.emit({ type: "nudge.acknowledged", payload: { nudgeId, response } }, `employee:${run.employeeId}`, { employeeId: run.employeeId, taskId: run.task.id });
      this.say(run, response);
    };

    switch (tri.kind) {
      case "steer":
        return ack(this.steer(run, tri.action ?? "hold", tri.target ?? text, text, nudgeId));
      case "question":
        return ack(modelAnswer ?? this.answerFromState(run, text));
      case "info": {
        const q = open[0];
        if (q) {
          ack(`Got it, applying that to: ${q.text}`);
          return this.answerQuestion(q.id, text, "user");
        }
        return ack("Noted.");
      }
      case "pause":
        this.control(run, "pause");
        return ack(`Paused. ${this.status(run.task.id)} Say "resume" to continue.`);
      case "resume":
        this.control(run, "resume");
        return ack("Resuming.");
      case "stop":
        this.control(run, "cancel");
        return ack("Stopping now.");
      case "new_task":
        st.backlog.push(text);
        return ack("I'll take that up as soon as the current task is finished.");
      default:
        return ack(`I'm not sure what you'd like me to change. I'm still working (${this.status(run.task.id)}). You can say things like "hold X", "skip Y", "pause" or ask a question.`);
    }
  }

  private control(run: TaskRun, action: "pause" | "resume" | "cancel") {
    const st = this.employees.get(run.employeeId)!;
    if (action === "pause") {
      run.paused = true;
      this.setEmployee(st, { status: "paused" });
    } else if (action === "resume") {
      run.paused = false;
      this.setEmployee(st, { status: "working" });
    } else {
      run.cancelled = true;
      for (const [id, a] of this.approvals) if (a.run === run) this.approvals.delete(id);
      for (const [id, q] of this.questions) if (q.run === run) this.questions.delete(id);
    }
    run.wake();
  }

  /** Items a target refers to: by name/label/ref, or by entity keys. */
  private itemsFor(run: TaskRun, words: string, subjects: string[]): PlanItem[] {
    if (!run.plan) return [];
    const subs = new Set(subjects);
    return run.plan.items.filter(
      (it) => matchesItem(it, words) || (this.pack.itemSubjects?.(it, run.shared) ?? []).some((s) => subs.has(s)),
    );
  }

  private steer(run: TaskRun, action: SteerAction, target: string, text: string, nudgeId: string): string {
    const resolved = this.pack.resolveTarget?.(target, { ...(run.plan ? { plan: run.plan } : {}), shared: run.shared }) ?? null;
    const subjects = resolved?.subjects ?? [];
    const label = resolved?.label ?? target;
    const items = this.itemsFor(run, target, subjects);
    const names = (xs: PlanItem[]) => xs.map((i) => i.label).slice(0, 6).join(", ") + (xs.length > 6 ? ` and ${xs.length - 6} more` : "");
    const actor: Actor = "user";

    if (action === "hold") {
      if (!subjects.length && !items.length) return `I couldn't find "${target}" in this task or in our records, so I haven't changed anything. Can you give me the exact name?`;
      const c: StandingConstraint = {
        id: this.ids.next("con"),
        employeeId: run.employeeId,
        taskId: run.task.id,
        text,
        subjects,
        itemIds: items.map((i) => i.id),
        blocks: "writes",
      };
      this.gateway.addConstraint(c);
      this.emit(
        { type: "constraint.added", payload: { constraintId: c.id, employeeId: c.employeeId, taskId: c.taskId, text: c.text, subjects: c.subjects, itemIds: c.itemIds, blocks: "writes", sourceNudgeId: nudgeId } },
        actor,
        { employeeId: run.employeeId, taskId: run.task.id },
      );
      const reason = `You said: "${text}"`;
      const open = items.filter((i) => !i.held && !["done", "skipped"].includes(itemStatus(run.plan!, i.id)));
      const finished = items.filter((i) => !i.held && itemStatus(run.plan!, i.id) === "done");
      for (const it of open) run.queue.push({ patch: { op: "hold_item", itemId: it.id, reason }, actor, then: () => this.protectiveHold(run, it, reason) });
      for (const it of finished) {
        const call = this.pack.holdCall?.(it, reason, run.shared);
        if (call)
          this.requestApproval(run, {
            title: `Put ${it.label} back on hold`,
            reason: `It was already finished before your message. ${reason}`,
            toolCall: call,
            risk: "write",
            onApproved: () => ({ status: "done", note: "Re-held after your instruction" }),
            onRejected: () => ({ status: "done", note: "Left as finished" }),
          });
      }
      run.wake();
      return [
        `Got it. From now on I won't make any change that pays or alters ${label}.`,
        open.length ? `Holding ${open.length} open item${open.length === 1 ? "" : "s"}: ${names(open)}.` : "",
        finished.length ? `${names(finished)} ${finished.length === 1 ? "was" : "were"} already finished before your message; I've asked you whether to put ${finished.length === 1 ? "it" : "them"} back on hold.` : "",
        !items.length ? "Nothing in this task involves them right now." : "",
      ]
        .filter(Boolean)
        .join(" ");
    }

    if (!items.length) return `I couldn't find "${target}" among the items of this task, so nothing changed.`;
    if (action === "skip") {
      const open = items.filter((i) => !["done", "skipped"].includes(itemStatus(run.plan!, i.id)));
      for (const it of open) run.queue.push({ patch: { op: "skip_item", itemId: it.id, reason: `You said: "${text}"` }, actor });
      run.wake();
      return open.length ? `Skipping ${names(open)}.` : `${names(items)} ${items.length === 1 ? "is" : "are"} already finished.`;
    }
    if (action === "release") {
      for (const c of [...this.gateway.constraints]) {
        if (c.employeeId !== run.employeeId) continue;
        if (c.subjects.some((s) => subjects.includes(s)) || c.itemIds.some((i) => items.some((x) => x.id === i))) {
          this.gateway.liftConstraint(c.id);
          this.emit({ type: "constraint.lifted", payload: { constraintId: c.id, reason: `You said: "${text}"` } }, actor, { employeeId: run.employeeId, taskId: run.task.id });
        }
      }
      const held = items.filter((i) => i.held);
      for (const it of held) run.queue.push({ patch: { op: "release_item", itemId: it.id }, actor });
      run.wake();
      return held.length
        ? `Released ${names(held)} in my plan; they'll be checked like the others. (Any hold already placed in the ERP stays until a person lifts it there.)`
        : `${names(items)} wasn't held in my plan; I've lifted any instruction that blocked it.`;
    }
    // prioritise
    const order = [...items.map((i) => i.id), ...run.plan!.items.filter((i) => !items.includes(i)).map((i) => i.id)];
    run.queue.push({ patch: { op: "reorder", itemIds: order }, actor });
    run.wake();
    return `Moving ${names(items)} to the front.`;
  }

  private async protectiveHold(run: TaskRun, item: PlanItem, reason: string) {
    const call = this.pack.holdCall?.(item, reason, run.shared);
    if (!call) return;
    await this.gateway.call(call.tool, call.input, {
      employeeId: run.employeeId,
      taskId: run.task.id,
      itemId: item.id,
      idempotencyKey: `hold:${run.task.id}:${item.id}`,
    });
  }

  private answerFromState(run: TaskRun, text: string): string {
    const it = run.plan?.items.find((i) => matchesItem(i, text, true));
    if (it && run.plan) return describeItem(run.plan, it);
    return this.status(run.task.id);
  }

  private async applyQueued(run: TaskRun) {
    while (run.queue.length) {
      const q = run.queue.shift()!;
      try {
        this.patch(run, q.patch, q.actor);
        if (q.then) await q.then();
      } catch {
        /* an outdated patch (e.g. item already removed) is dropped */
      }
    }
  }

  /* ---- verify → report */

  /** Soft questions still open when a task ends are settled with their defaults. */
  private closeQuestions(run: TaskRun) {
    for (const [id, q] of this.questions) {
      if (q.run !== run) continue;
      this.questions.delete(id);
      if (q.fallback !== undefined)
        this.emit({ type: "question.answered", payload: { questionId: id, answer: q.fallback, by: "system", usedDefault: true } }, "system", {
          employeeId: run.employeeId,
          taskId: run.task.id,
        });
    }
  }

  private async finishTask(run: TaskRun) {
    this.closeQuestions(run);
    this.setStatus(run, "verifying");
    const plan = run.plan!;
    const ctx = { ...this.packCtx(run), plan };
    let results: VerifyResult[] = [];
    try {
      const v = run.playbook ? this.pack.verify?.[run.playbook.id] : undefined;
      results = v ? await v(ctx) : run.program ? await this.verifyProgram(run) : genericVerify(plan);
    } catch (e) {
      results = [{ criterion: "Verification", verdict: "uncertain", detail: `The verifier couldn't run: ${(e as Error).message}` }];
    }
    this.emit(
      {
        type: "verification.completed",
        payload: { taskId: run.task.id, results: results.map((r, i) => ({ criterionId: `v${i + 1}`, verdict: r.verdict, detail: `${r.criterion}: ${r.detail}`, evidenceIds: [] })) },
      },
      "system",
      { employeeId: run.employeeId, taskId: run.task.id },
    );

    let report: string;
    if (run.program) report = await this.programReport(run);
    else {
      const r = run.playbook ? this.pack.report?.[run.playbook.id] : undefined;
      report = r ? await Promise.resolve().then(() => r(ctx)).catch((e: Error) => `${genericReport(plan)}\n(The detailed report failed: ${e.message})`) : genericReport(plan);
    }
    const failedChecks = results.filter((r) => r.verdict !== "pass");
    const verifyLine = failedChecks.length
      ? `\nVerifier: ${failedChecks.map((r) => `${r.verdict === "fail" ? "✗" : "?"} ${r.criterion}: ${r.detail}`).join(" · ")}`
      : `\nVerifier: all ${results.length} check${results.length === 1 ? "" : "s"} passed on a fresh read.`;
    this.say(run, report + verifyLine);
    this.setStatus(run, "done");
  }

  /**
   * Verifier for composed plans (they have no hand-written verifier):
   * 1. every item was handled; 2. every condition could actually be read on
   * the items (a missing field means the answer can't be trusted); 3. a fresh
   * re-read of a few items, flagged and not, gives the same verdict.
   */
  private async verifyProgram(run: TaskRun): Promise<VerifyResult[]> {
    const p = run.program!;
    const plan = run.plan!;
    const today = this.pack.today();
    const results = genericVerify(plan);
    const done = plan.items.filter((it) => run.itemData.get(it.id)?.steps && Object.keys(run.itemData.get(it.id)!.steps!).length);
    const unreadable: string[] = [];
    for (const st of p.steps)
      for (const c of st.flagIf ?? []) {
        const tried = done.filter((it) => (run.itemData.get(it.id)!.steps as Record<string, unknown>)[st.id] !== undefined);
        const bad = tried.filter((it) => pathResolves({ item: run.itemData.get(it.id)!.element, steps: run.itemData.get(it.id)!.steps }, c.path) === false);
        if (tried.length && bad.length === tried.length) unreadable.push(`"${c.path}" was missing on every item`);
        else if (bad.length) unreadable.push(`"${c.path}" was missing on ${bad.length} of ${tried.length} items`);
      }
    const nFlagged = done.filter((it) => run.itemData.get(it.id)!.flags?.length).length;
    if (done.length >= 10 && nFlagged / done.length > 0.8)
      results.push({
        criterion: "The result is plausible",
        verdict: "uncertain",
        detail: `${nFlagged} of ${done.length} were flagged; when almost everything matches, the check itself is often wrong. Spot-check a few before acting on it`,
      });
    results.push({
      criterion: "Every condition could be read",
      verdict: unreadable.length ? "fail" : "pass",
      detail: unreadable.length ? `${unreadable.join("; ")}, so those results can't be trusted` : "every field the plan checks was present",
    });
    if (p.steps.every((st) => this.gateway.get(st.tool)?.risk === "read") && done.length) {
      const flagged = done.filter((it) => run.itemData.get(it.id)!.flags?.length);
      const clean = done.filter((it) => !run.itemData.get(it.id)!.flags?.length);
      const sample = [...flagged.slice(0, 2), ...clean.slice(0, 2)];
      const ctx = { employeeId: run.employeeId, taskId: run.task.id };
      const disagree: string[] = [];
      for (const it of sample) {
        const scope = { item: run.itemData.get(it.id)!.element, steps: {} as Record<string, unknown>, params: run.params };
        let hit = false;
        for (const st of p.steps) {
          const prepared = this.programArgs(st, scope);
          if ("missing" in prepared) break;
          const args = prepared.args;
          let r = await this.gateway.call(st.tool, args, ctx);
          if (!r.ok && r.error.class === "validation") r = await this.gateway.call(st.tool, coerceArgs(args), ctx);
          if (!r.ok) break;
          scope.steps[st.id] = r.data;
          if (anyTrue(st.flagIf, scope, today)) hit = true;
        }
        if (hit !== !!run.itemData.get(it.id)!.flags?.length) disagree.push(it.label);
      }
      results.push({
        criterion: "A fresh re-read agrees",
        verdict: disagree.length ? "fail" : "pass",
        detail: disagree.length ? `different result on re-read for ${disagree.join(", ")}` : `re-checked ${sample.length} item(s) (${Math.min(2, flagged.length)} flagged, ${Math.min(2, clean.length)} not): same result`,
      });
    }
    return results;
  }

  private async programReport(run: TaskRun): Promise<string> {
    const p = run.program!;
    const plan = run.plan!;
    const rows = plan.items.map((it) => {
      const d = run.itemData.get(it.id) ?? {};
      const scope = { item: d.element, steps: d.steps ?? {} };
      const st = itemStatus(plan, it.id);
      // The grid's own "done" is not a fact about the vendor; only unusual outcomes are worth mentioning.
      const row: Record<string, unknown> = { id: it.id, label: it.label, ...(st !== "done" ? { outcome: st === "failed" ? "could not be checked" : st.replace("_", " ") } : {}) };
      for (const c of p.columns) row[c.title] = getPath(scope, c.path);
      if (d.flags?.length) row.flags = d.flags;
      return row;
    });
    const flagged = rows.filter((r) => r.flags);
    const failed = plan.items.filter((it) => itemStatus(plan, it.id) === "failed");
    const table = flagged.length ? flagged : rows.slice(0, 40);
    const hasChecks = p.steps.some((s) => s.flagIf?.length);
    const details = (r: Record<string, unknown>) =>
      p.columns
        .map((c) => {
          const v = r[c.title];
          return v == null || v === "" ? "" : `${c.title}: ${typeof v === "object" ? JSON.stringify(v).slice(0, 120) : String(v)}`;
        })
        .filter(Boolean)
        .join(" · ");
    const failedLines = failed.length
      ? `\nCouldn't check ${failed.length}:\n${failed
          .slice(0, 15)
          .map((it) => `• ${it.label}: ${plan.steps.map((s) => plan.cells[it.id]![s.id]!.note).filter(Boolean).pop() ?? "failed"}`)
          .join("\n")}${failed.length > 15 ? `\n… and ${failed.length - 15} more` : ""}`
      : "";
    const fallback =
      !hasChecks || rows.length <= 3
        ? `${p.title}:\n${rows.map((r) => `• ${r.label}${details(r) ? `: ${details(r)}` : ""}${r.flags ? ` ⚠ ${(r.flags as string[]).join("; ")}` : ""}`).join("\n")}${failedLines}`
        : `${p.title}: ${flagged.length} of ${rows.length} flagged.${flagged.length ? `\n${flagged.map((r) => `• ${r.label}: ${(r.flags as string[]).join("; ")}`).join("\n")}` : ""}${failedLines}`;
    try {
      const s = await this.json("summary", this.system(run), summaryPrompt({ request: run.task.request, table, flagged: flagged.length, total: rows.length, checks: hasChecks }), Summary, run.task.id);
      const unsupported = unsupportedClaims(s.summary, `${run.task.request} ${flagged.length} of ${rows.length} ${JSON.stringify(rows)}`);
      if (unsupported.length) return `${fallback}\n(I dropped a drafted summary because it mentioned things not in the results: ${unsupported.join(", ")}.)`;
      return `${s.summary}\n\n${fallback}`;
    } catch {
      return fallback;
    }
  }
}

/* =====================================================================
 * Helpers
 * ===================================================================== */

/** Does free text name this item? Matches label words, ref tokens or the id. */
export function matchesItem(it: PlanItem, text: string, inside = false): boolean {
  const t = text.toLowerCase().trim();
  if (!t) return false;
  const label = it.label.toLowerCase();
  const tokens = new Set([it.id.toLowerCase(), ...(it.ref ?? "").toLowerCase().split(/[\s:#/|]+/).filter(Boolean)]);
  if (tokens.has(t)) return true;
  if (inside) {
    if ([...tokens].some((x) => x.length >= 4 && new RegExp(`\\b${escapeRe(x)}\\b`).test(t))) return true;
    const words = label.split(/[^a-z0-9]+/).filter((w) => w.length >= 4);
    return words.length > 0 && words.slice(0, 2).every((w) => t.includes(w));
  }
  if (t.length >= 3 && (label.includes(t) || [...tokens].some((x) => x.length >= 3 && x.includes(t)))) return true;
  const words = t.split(/[^a-z0-9]+/).filter((w) => w.length >= 3);
  return words.length > 0 && words.every((w) => label.includes(w));
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

function completeOrder(plan: Plan, first: string[]): string[] {
  const set = new Set(first.filter((id) => plan.items.some((i) => i.id === id)));
  return [...set, ...plan.items.map((i) => i.id).filter((id) => !set.has(id))];
}

/** "2026-10-07" → the ways a letter might write it. */
export function dateForms(iso: string): string[] {
  const d = new Date(`${iso}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return [iso];
  const months = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
  const day = d.getUTCDate();
  const m = months[d.getUTCMonth()]!;
  const y = d.getUTCFullYear();
  const dd = String(day).padStart(2, "0");
  const mm = String(d.getUTCMonth() + 1).padStart(2, "0");
  return [iso, `${day} ${m} ${y}`, `${dd} ${m} ${y}`, `${m} ${day}, ${y}`, `${dd}/${mm}/${y}`, `${dd}.${mm}.${y}`, `${dd}-${mm}-${y}`];
}

/** One item, in a sentence or two a person would say ("why is Deccan held?"). */
export function describeItem(plan: Plan, it: PlanItem): string {
  const st = itemStatus(plan, it.id);
  const cells = plan.steps.map((s) => ({ step: s, cell: plan.cells[it.id]![s.id]! }));
  const notes = cells.filter((c) => c.cell.note && c.cell.state !== "pending").map((c) => c.cell.note!.replace(/^⚑\s*/, ""));
  const end = (t: string) => (/[.!?]$/.test(t) ? t : `${t}.`);
  if (it.held) return `${it.label} is held. ${end(it.holdReason ?? notes.at(-1) ?? "No reason was recorded")}`;
  if (st === "skipped") return `${it.label} was skipped${it.holdReason ? `: ${end(it.holdReason)}` : ", as you asked."}`;
  if (st === "done") {
    const extra = notes.filter((n) => !/^(Cleared|All checks passed)/.test(n));
    return `${it.label} is done${extra.length ? `: ${end(extra.join("; "))}` : ", every check passed."}`;
  }
  if (st === "failed" || st === "needs_you") {
    const c = cells.find((x) => x.cell.state === "failed" || x.cell.state === "needs_you");
    return `${it.label} ${st === "failed" ? "couldn't be finished" : "needs you"} at ${c?.step.title ?? "a step"}${c?.cell.note ? `: ${end(c.cell.note)}` : "."}`;
  }
  const running = cells.find((x) => x.cell.state === "running" || x.cell.state === "retrying");
  if (running) return `I'm checking ${it.label} right now (${running.step.title}).`;
  const ahead = plan.items.slice(0, plan.items.indexOf(it)).filter((x) => ["pending", "running"].includes(itemStatus(plan, x.id)) && !x.held).length;
  return `${it.label} isn't checked yet${ahead ? `; ${ahead} line${ahead === 1 ? "" : "s"} ahead of it` : "; it's next"}.`;
}

/** "What can you do / your skills / how do you work": answered without any model call. */
export function isAboutMe(request: string): boolean {
  const t = request.toLowerCase();
  return (
    /\b(what|which)\b[^.?]{0,25}\b(can|could|do)\s+you\s+(do|help with|handle)\s*(for me\s*)?([?.!,]|$)/.test(t) ||
    /\byour\s+(skills?|skill ?sets?|capabilities|abilities|speciali[sz]ation|role|job|workflow)\b/.test(t) ||
    /\bwho are you\b|\bhow do you work\b|\bwhat are you (good at|for)\b/.test(t)
  );
}

/**
 * The instant reply to a new request. Fixed sentences, no model call; picked
 * by the task id so it varies between tasks but is repeatable in tests.
 */
export function acknowledge(request: string, taskId: string): string {
  const question = /\?\s*$/.test(request) || /^(which|what|who|how|when|where|is|are|do|does|did|can|has|have)\b/i.test(request.trim());
  const lines = question
    ? ["Let me find out. I'll check the records first.", "Good question, looking into it now.", "I'll check and come back to you shortly."]
    : ["On it. I'll look around first, then tell you how I'll go about it.", "Got it, starting now. I'll check what we have first.", "Sure, I'm on it. Give me a moment to look around."];
  let h = 0;
  for (const ch of taskId) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return lines[h % lines.length]!;
}

function modelProblem(e: unknown): string {
  if (e instanceof ModelError) {
    if (e.kind === "quota") return "today's model budget is used up";
    if (e.kind === "auth") return "the API key was rejected (check .env)";
    if (e.kind === "rate_limited") return "the model is rate-limited right now";
    if (e.kind === "network") return "the model couldn't be reached";
  }
  return (e as Error).message;
}

function genericVerify(plan: Plan): VerifyResult[] {
  const open = plan.items.filter((i) => !i.held && ["pending", "running"].includes(itemStatus(plan, i.id)));
  return [
    {
      criterion: "Every item was handled",
      verdict: open.length ? "fail" : "pass",
      detail: open.length ? `${open.length} item(s) unfinished` : `${plan.items.length} item(s) finished, held or waiting for you`,
    },
  ];
}

function genericReport(plan: Plan): string {
  const sum = summarize(plan);
  const lines = [`Done: ${sum.done} finished · ${sum.held} held · ${sum.needs_you} need you · ${sum.failed} failed · ${sum.skipped} skipped.`];
  for (const it of plan.items) {
    const st = itemStatus(plan, it.id);
    if (st === "done" || st === "skipped") continue;
    const note = plan.steps.map((s) => plan.cells[it.id]![s.id]!.note).filter(Boolean).pop();
    lines.push(`• ${it.label}: ${st.replace("_", " ")}${it.holdReason ? ` (${it.holdReason})` : note ? ` (${note})` : ""}`);
  }
  return lines.join("\n");
}

/**
 * Evidence-bound summary (Framework Spec §15, light version): every id-like
 * token or number in the model's summary must appear in the results.
 */
export function unsupportedClaims(summary: string, facts: string): string[] {
  const norm = (s: string) => s.replace(/[,\s₹]/g, "").toLowerCase();
  const f = norm(facts);
  const tokens = summary.match(/\b[A-Z]{1,6}[-/][A-Z0-9/-]{2,}\b|\b\d[\d,]{3,}\b/g) ?? [];
  const out = [...new Set(tokens)].filter((t) => !f.includes(norm(t)));
  // Counts: "40 vendors" or "forty vendors" must be a number that appears in the results.
  const nums = new Set((facts.match(/\d+/g) ?? []).map(Number));
  for (const m of summary.matchAll(/(?<![\d,./₹-])\b(\d{1,3}|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|(?:twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety)(?:-(?:one|two|three|four|five|six|seven|eight|nine))?|hundred)\b(?![\d,./-])(?!\s*(?:days?|weeks?|months?|years?|%))/gi)) {
    const n = /^\d/.test(m[1]!) ? Number(m[1]) : wordToNumber(m[1]!);
    if (n !== undefined && n > 10 && !nums.has(n)) out.push(m[1]!);
  }
  return [...new Set(out)];
}

function wordToNumber(w: string): number | undefined {
  const units: Record<string, number> = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9 };
  const base: Record<string, number> = {
    eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19,
    twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90, hundred: 100,
  };
  const [a, b] = w.toLowerCase().split("-");
  const n = base[a!];
  return n === undefined ? undefined : n + (b ? (units[b] ?? 0) : 0);
}
