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
  validateProgram,
  type ProgramStep,
} from "./program.ts";
import {
  RouteDecision,
  Summary,
  composePrompt,
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
  send(employeeId: string, text: string): Promise<void> {
    return this.track(async () => {
      const st = this.mustEmployee(employeeId);
      this.post(employeeId, "user", text, st.current?.task.id);
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
          run.queue.push({ patch, actor: "user" });
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
    const finished = sum.done + sum.skipped + sum.failed;
    const parts = [`${finished}/${total} ${run.playbook?.item.plural ?? run.program?.itemKind ?? "items"} finished`];
    if (sum.held) parts.push(`${sum.held} held`);
    if (sum.needs_you) parts.push(`${sum.needs_you} need you`);
    if (sum.failed) parts.push(`${sum.failed} failed`);
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

  private post(employeeId: string, from: Actor, text: string, taskId?: string) {
    this.emit(
      {
        type: "message.posted",
        payload: { id: this.ids.next("msg"), threadId: employeeId, from, text, attachments: [], ...(taskId ? { taskId } : {}), ts: this.log.now },
      },
      from,
      { employeeId, ...(taskId ? { taskId } : {}) },
    );
  }

  private say(run: TaskRun, text: string) {
    this.post(run.employeeId, `employee:${run.employeeId}`, text, run.task.id);
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

    const loop = this.track(() => this.runTask(run)).catch((e) => {
      this.say(run, `I hit an internal error and stopped this task: ${(e as Error).message}`);
      this.setStatus(run, "failed", (e as Error).message);
    });
    this.loops.add(loop);
    void loop.finally(() => {
      this.loops.delete(loop);
      if (st.current === run) st.current = undefined;
      if (st.employee.currentTaskId === taskId) this.setEmployee(st, { status: "idle" });
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
      this.setStatus(run, "cancelled", "cancelled by you");
      return;
    }
    await this.finishTask(run);
  }

  /* ---- understand → orient → plan */

  private async understandAndPlan(run: TaskRun): Promise<boolean> {
    const pack = this.pack;
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

    // Tier 3: compose a program from tools.
    const program = await this.compose(run, index, decision.goal);
    if (!program) return false;
    run.program = program;
    const items = await this.programItems(run, program);
    if (!items) return false;
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
      if (picked.length) items = picked;
      else this.say(run, `I couldn't match "${filter.join(", ")}" to specific items, so I'm doing all ${items.length}.`);
    }
    return items;
  }

  private async compose(run: TaskRun, index: OrientIndex, goal: string): Promise<Program | null> {
    const tools = this.gateway.describe((t) => t.risk !== "irreversible");
    let problems: string[] = [];
    for (let attempt = 0; attempt < 2; attempt++) {
      let p: Program;
      try {
        p = await this.json("compose", this.system(run), composePrompt({ request: run.task.request, goal, index, tools, problems }), Program, run.task.id);
      } catch (e) {
        this.say(run, `I couldn't put together a plan for this: ${modelProblem(e)}`);
        this.setStatus(run, "failed", (e as Error).message);
        return null;
      }
      problems = validateProgram(p, this.gateway);
      if (!problems.length) return p;
    }
    this.say(run, `The plan I composed wasn't safe or valid, so I stopped: ${problems.join("; ")}`);
    this.setStatus(run, "failed", problems.join("; "));
    return null;
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

  private programHandler(step: ProgramStep): StepHandler {
    return async (ctx) => {
      const scope = { item: ctx.data.element, steps: (ctx.data.steps ??= {}) as Record<string, unknown>, params: ctx.params };
      const args = fillArgs(step.args, scope);
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
        return ack("Stopping this task. Nothing further will be changed; what's done so far stays done.");
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
    if (it && run.plan) {
      const cells = run.plan.steps.map((s) => {
        const c = run.plan!.cells[it.id]![s.id]!;
        return `${s.title}: ${c.state.replace("_", " ")}${c.note ? ` (${c.note})` : ""}`;
      });
      return `${it.label}: ${itemStatus(run.plan, it.id).replace("_", " ")}${it.holdReason ? `, held because ${it.holdReason}` : ""}. ${cells.join(" · ")}`;
    }
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
      results = v ? await v(ctx) : genericVerify(plan);
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

  private async programReport(run: TaskRun): Promise<string> {
    const p = run.program!;
    const plan = run.plan!;
    const rows = plan.items.map((it) => {
      const d = run.itemData.get(it.id) ?? {};
      const scope = { item: d.element, steps: d.steps ?? {} };
      const row: Record<string, unknown> = { id: it.id, label: it.label, status: itemStatus(plan, it.id) };
      for (const c of p.columns) row[c.title] = getPath(scope, c.path);
      if (d.flags?.length) row.flags = d.flags;
      return row;
    });
    const flagged = rows.filter((r) => r.flags);
    const table = flagged.length ? flagged : rows.slice(0, 40);
    const fallback = `${p.title}: ${flagged.length} of ${rows.length} flagged.${flagged.length ? `\n${flagged.map((r) => `• ${r.label}: ${(r.flags as string[]).join("; ")}`).join("\n")}` : ""}`;
    try {
      const s = await this.json("summary", this.system(run), summaryPrompt({ request: run.task.request, table, flagged: flagged.length, total: rows.length }), Summary, run.task.id);
      const unsupported = unsupportedClaims(s.summary, JSON.stringify(rows));
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
  const open = plan.items.filter((i) => !i.held && plan.steps.some((s) => !isTerminal(plan.cells[i.id]![s.id]!.state) && plan.cells[i.id]![s.id]!.state !== "needs_you"));
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
  return [...new Set(tokens)].filter((t) => !f.includes(norm(t)));
}
