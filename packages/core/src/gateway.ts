import { RETRY_POLICY, type Actor, type ErrorClass, type EvidenceKind, type RiskTier, type ToolError } from "@theseus/protocol";
import { z } from "zod";
import type { EventLog, IdMaker } from "./log.ts";
import { toModelSchema } from "./model.ts";

/**
 * The tool gateway: the one door every action goes through (Framework Spec
 * §10–§13). Before a tool runs it checks, in this order:
 *   1. the tool exists and this employee may use it (scope charter / allow-list)
 *   2. the input is valid (Zod)
 *   3. irreversible → a human approval for this exact call is attached
 *   4. write / irreversible → no standing constraint protects what it touches
 *   5. idempotency → a write already done under the same key is not repeated
 * Then it runs the tool, retries transient errors, records evidence, and logs
 * tool.called / tool.completed. Because the checks live here and not in a
 * prompt, they hold even when the model forgets an instruction.
 */

export interface EvidenceInput {
  kind: EvidenceKind;
  summary: string;
  source: string;
  ref?: string;
  fields?: Record<string, unknown>;
}

export interface Approved {
  approvalId: string;
  /** Must be a human ("user:…"). */
  decidedBy: Actor;
}

export interface CallContext {
  employeeId: string;
  taskId?: string;
  itemId?: string;
  stepId?: string;
  /** Present only when a human approved this exact call. */
  approval?: Approved;
  /** Same key → same effect: a repeated write returns the recorded result. */
  idempotencyKey?: string;
  /** Called before each retry of a transient failure (the kernel shows "retrying"). */
  onRetry?: (attempt: number, error: ToolError) => void;
}

export interface ToolRunContext extends CallContext {
  /** Record evidence; returns its id. */
  evidence(e: EvidenceInput): string;
}

export interface Tool<I = any, O = any> {
  /** Namespaced: "payments.hold_line", "files.read_text". */
  name: string;
  description: string;
  risk: RiskTier;
  /** Safe to repeat with the same input (affects retries). */
  idempotent: boolean;
  input: z.ZodType<I>;
  /** Short description of the output's shape, for composed plans (tier 3). */
  output?: string;
  /**
   * Protective writes (putting something ON hold) only reduce risk, so standing
   * constraints never block them: being cautious must stay cheap.
   */
  protective?: boolean;
  /** Entity keys this call touches ("vendor:V-101"), used by standing constraints. */
  subjects?(input: I): string[] | Promise<string[]>;
  run(input: I, ctx: ToolRunContext): Promise<O>;
}

/** Throw from a tool to report a classified failure (Framework Spec §4). */
export class ToolFailure extends Error {
  constructor(
    public readonly cls: ErrorClass,
    message: string,
    public readonly hint?: string,
  ) {
    super(message);
  }
}

export interface StandingConstraint {
  id: string;
  employeeId: string;
  taskId?: string;
  text: string;
  subjects: string[];
  itemIds: string[];
  blocks: "writes";
}

export type GatewayResult<O = unknown> =
  | { ok: true; callId: string; data: O; evidenceIds: string[]; replayed?: boolean }
  | { ok: false; callId: string; error: ToolError; blockedBy?: StandingConstraint };

export interface ToolDescription {
  name: string;
  description: string;
  risk: RiskTier;
  input: Record<string, unknown>;
  output?: string;
}

export class ToolGateway {
  private tools = new Map<string, Tool>();
  readonly constraints: StandingConstraint[] = [];
  private done = new Map<string, { data: unknown; evidenceIds: string[] }>();

  constructor(
    private readonly deps: {
      log: EventLog;
      ids: IdMaker;
      tools: Tool[];
      /** If set, only these tool names may be called (role pack manifest ∩ employee allow-list). */
      allowed?: Iterable<string>;
      sleep?: (ms: number) => Promise<void>;
    },
  ) {
    for (const t of deps.tools) {
      if (this.tools.has(t.name)) throw new Error(`Duplicate tool "${t.name}"`);
      this.tools.set(t.name, t);
    }
    if (deps.allowed) {
      const allow = new Set(deps.allowed);
      for (const name of [...this.tools.keys()]) if (!allow.has(name)) this.tools.delete(name);
    }
  }

  has(name: string): boolean {
    return this.tools.has(name);
  }

  get(name: string): Tool | undefined {
    return this.tools.get(name);
  }

  /** What the model sees when it composes a plan from tools. */
  describe(filter?: (t: Tool) => boolean): ToolDescription[] {
    return [...this.tools.values()]
      .filter((t) => !filter || filter(t))
      .map((t) => ({ name: t.name, description: t.description, risk: t.risk, input: toModelSchema(t.input), ...(t.output ? { output: t.output } : {}) }));
  }

  addConstraint(c: StandingConstraint): void {
    this.constraints.push(c);
  }

  liftConstraint(id: string): StandingConstraint | undefined {
    const i = this.constraints.findIndex((c) => c.id === id);
    return i >= 0 ? this.constraints.splice(i, 1)[0] : undefined;
  }

  /** The constraint that would block a write touching these subjects / this item, if any. */
  blocking(employeeId: string, subjects: string[], taskId?: string, itemId?: string): StandingConstraint | undefined {
    const subs = new Set(subjects);
    return this.constraints.find(
      (c) =>
        c.employeeId === employeeId &&
        (c.subjects.some((s) => subs.has(s)) || (!!itemId && c.taskId === taskId && c.itemIds.includes(itemId))),
    );
  }

  async call<O = unknown>(name: string, rawInput: unknown, ctx: CallContext): Promise<GatewayResult<O>> {
    const { log, ids } = this.deps;
    const callId = ids.next("call");
    const meta = { actor: `employee:${ctx.employeeId}` as Actor, employeeId: ctx.employeeId, taskId: ctx.taskId };
    log.append(
      { type: "tool.called", payload: { callId, taskId: ctx.taskId ?? "none", itemId: ctx.itemId, stepId: ctx.stepId, tool: name, input: rawInput } },
      meta,
    );
    const started = Date.now();
    const finish = (r: GatewayResult<O>, preview?: string): GatewayResult<O> => {
      log.append(
        {
          type: "tool.completed",
          payload: {
            callId,
            ok: r.ok,
            durationMs: Date.now() - started,
            evidenceIds: r.ok ? r.evidenceIds : [],
            ...(r.ok ? { preview: preview ?? previewOf(r.data) } : { error: r.error }),
          },
        },
        meta,
      );
      return r;
    };
    const fail = (cls: ErrorClass, message: string, hint?: string, blockedBy?: StandingConstraint) =>
      finish({ ok: false, callId, error: { class: cls, message, ...(hint ? { hint } : {}) }, ...(blockedBy ? { blockedBy } : {}) });

    // 1. exists + allowed
    const tool = this.tools.get(name);
    if (!tool) return fail("policy_violation", `Tool "${name}" is not available to this employee`);

    // 2. valid input
    const parsed = tool.input.safeParse(rawInput);
    if (!parsed.success)
      return fail("validation", `Invalid input for ${name}: ${parsed.error.issues.map((i) => `${i.path.join(".") || "input"}: ${i.message}`).join("; ")}`);
    const input = parsed.data;

    // 3. irreversible needs a human approval
    if (tool.risk === "irreversible" && !ctx.approval?.decidedBy?.startsWith("user"))
      return fail("policy_violation", `${name} is irreversible and needs your approval first`);

    // 4. standing constraints protect what the user told us not to touch
    if (tool.risk !== "read" && !tool.protective) {
      const subjects = tool.subjects ? await tool.subjects(input) : [];
      const c = this.blocking(ctx.employeeId, subjects, ctx.taskId, ctx.itemId);
      if (c) return fail("policy_violation", `Blocked by your instruction: "${c.text}"`, undefined, c);
    }

    // 5. idempotency: a write that already happened is not repeated
    const key = ctx.idempotencyKey ? `${name}|${ctx.idempotencyKey}` : undefined;
    if (key && this.done.has(key)) {
      const prev = this.done.get(key)!;
      return finish({ ok: true, callId, data: prev.data as O, evidenceIds: prev.evidenceIds, replayed: true }, "(already done earlier: result reused, not repeated)");
    }

    const evidenceIds: string[] = [];
    const runCtx: ToolRunContext = {
      ...ctx,
      evidence: (e) => {
        const id = ids.next("ev");
        log.append({ type: "evidence.added", payload: { id, capturedAt: log.now, ...e } }, meta);
        evidenceIds.push(id);
        return id;
      },
    };

    const sleep = this.deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
    for (let attempt = 0; ; attempt++) {
      try {
        const data = (await tool.run(input, runCtx)) as O;
        const r: GatewayResult<O> = { ok: true, callId, data, evidenceIds };
        if (key) this.done.set(key, { data, evidenceIds });
        return finish(r);
      } catch (e) {
        const cls: ErrorClass = e instanceof ToolFailure ? e.cls : "fatal";
        const error: ToolError = { class: cls, message: (e as Error).message, ...(e instanceof ToolFailure && e.hint ? { hint: e.hint } : {}) };
        const policy = RETRY_POLICY[cls];
        const safeToRepeat = tool.idempotent || tool.risk === "read" || !!key;
        if (cls === "transient" && safeToRepeat && attempt < policy.maxRetries) {
          ctx.onRetry?.(attempt + 1, error);
          await sleep(policy.backoffMs * 2 ** attempt);
          continue;
        }
        return finish({ ok: false, callId, error });
      }
    }
  }
}

/** A short, readable preview of a tool result for the activity trace. */
export function previewOf(data: unknown, max = 160): string {
  if (data === undefined || data === null) return "ok";
  const s = typeof data === "string" ? data : JSON.stringify(data);
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}
