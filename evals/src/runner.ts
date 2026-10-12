import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Kernel, ModelAdapter } from "@theseus/core";
import type { TheseusEvent } from "@theseus/protocol";
import { createHarness } from "@theseus/server";
import { inProcessWorld } from "@theseus/server/world";
import type { Check, CaseCtx, LiveCase } from "./cases.ts";

export interface CaseResult {
  id: string;
  title: string;
  /** Every check passed. */
  pass: boolean;
  /** The case could not run to the end (timeout, crash, budget). */
  error?: string;
  checks: Check[];
  modelCalls: number;
  costUsd: number;
  inputTokens: number;
  outputTokens: number;
  seconds: number;
  /** Route the employee chose, for the report (not asserted). */
  tier?: number;
  /** What the employee finally said (clipped). */
  said: string;
}

export interface RunOptions {
  /** Makes a fresh model for each case (so cases don't share a rate limiter state unless they should). */
  model: () => ModelAdapter;
  headed?: boolean;
  slowMo?: number;
  /** Give up on a case after this many seconds (live models on a free tier can be slow). */
  timeoutSec?: number;
  /** If the employee sits waiting for a person with nothing pending to approve this long, the case fails with its question (default 20). */
  idleGraceSec?: number;
  /** Save the full event log of a FAILED case here (one .jsonl per case) so it can be analysed afterwards. */
  eventsDir?: string;
  log?: (line: string) => void;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Run one case in a brand-new company world (so cases never affect each other). */
export async function runCase(c: LiveCase, o: RunOptions): Promise<CaseResult> {
  const t0 = Date.now();
  const world = await inProcessWorld({ workspaceDir: "temp", listen: !!c.browser });
  const h = await createHarness({
    world,
    model: o.model(),
    sleep: async () => {},
    ...(c.stepDelayMs ? { stepDelayMs: c.stepDelayMs } : {}),
    ...(c.browser ? { browser: { headless: !o.headed, ...(o.slowMo ? { slowMo: o.slowMo } : {}) } } : {}),
  });
  const { kernel, employee } = h;
  const result: CaseResult = { id: c.id, title: c.title, pass: false, checks: [], modelCalls: 0, costUsd: 0, inputTokens: 0, outputTokens: 0, seconds: 0, said: "" };
  try {
    if (c.faults) world.kaveri!.setFaults({ failNext: c.faults });
    if (c.constraint) kernel.gateway.addConstraint({ id: "con_check", employeeId: employee.id, text: c.constraint.text, subjects: c.constraint.subjects, itemIds: [], blocks: "writes" });
    // Approvals: decided automatically so the run can finish unattended.
    const approves = (title: string) => (typeof c.approve === "function" ? c.approve(title) : c.approve === "all");
    kernel.log.subscribe((e: TheseusEvent) => {
      if (e.type === "approval.requested")
        setTimeout(() => void kernel.command({ type: "resolve_approval", approvalId: e.payload.id, decision: approves(e.payload.title) ? "approved" : "rejected" }), 0);
    });
    if (c.nudge) {
      let sent = false;
      kernel.log.subscribe((e: TheseusEvent) => {
        if (!sent && c.nudge!.when(e)) {
          sent = true;
          void kernel.send(employee.id, c.nudge!.text);
        }
      });
    }
    const notes: Record<string, any> = {};
    await c.before?.({ world, notes });
    await kernel.command({ type: "send_message", threadId: employee.id, text: c.request, attachments: [], ...(c.rehearse ? { rehearse: true } : {}) });
    await untilOver(kernel, (o.timeoutSec ?? 300) * 1000, (o.idleGraceSec ?? 20) * 1000);
    await kernel.settled();

    const run = [...kernel.runs.values()].at(-1)!;
    const said = kernel.log.ofType("message.posted").filter((m) => m.payload.from.startsWith("employee:")).map((m) => m.payload.text);
    const ctx: CaseCtx = { kernel, employeeId: employee.id, world, said, lastSaid: said.at(-1) ?? "", task: run, events: kernel.log.events, notes };
    await c.after?.(ctx);
    result.checks = c.check(ctx);
    result.pass = result.checks.every((x) => x.ok);
    result.tier = run.task.tier;
    result.said = ctx.lastSaid.length > 700 ? `${ctx.lastSaid.slice(0, 700)}…` : ctx.lastSaid;
  } catch (e) {
    result.error = (e as Error).message;
    const said = kernel.log.ofType("message.posted").filter((m) => m.payload.from.startsWith("employee:")).map((m) => m.payload.text);
    result.said = said.at(-1)?.slice(0, 700) ?? "";
  } finally {
    const calls = kernel.log.ofType("model.called");
    result.modelCalls = calls.length;
    result.costUsd = calls.reduce((n, m) => n + (m.payload.costUsd ?? 0), 0);
    result.inputTokens = calls.reduce((n, m) => n + (m.payload.inputTokens ?? 0), 0);
    result.outputTokens = calls.reduce((n, m) => n + (m.payload.outputTokens ?? 0), 0);
    const failedCall = calls.find((m) => !m.payload.ok);
    if (failedCall && !result.error && !result.pass) result.error = `a model call failed: ${failedCall.payload.error}`;
    result.seconds = (Date.now() - t0) / 1000;
    if (o.eventsDir && !result.pass) {
      try {
        mkdirSync(o.eventsDir, { recursive: true });
        writeFileSync(join(o.eventsDir, `${c.id}.events.jsonl`), kernel.log.events.map((e) => JSON.stringify(e)).join("\n"));
      } catch {
        /* saving evidence must never break the report */
      }
    }
    await h.close().catch(() => undefined);
  }
  return result;
}

/**
 * Wait until the task is done, failed or cancelled (approvals and nudges are handled by listeners).
 * The deadline is enforced even while the task is busy: `settled()` only resolves when the employee
 * stops, so it is raced against the clock. On timeout the task is cancelled, so a stuck run cannot
 * keep calling the model (and spending) in the background.
 */
async function untilOver(k: Kernel, ms: number, graceMs: number) {
  const t0 = Date.now();
  let idleSince = 0;
  const cancel = () => {
    const run = [...k.runs.values()].at(-1);
    if (run) void k.command({ type: "task_control", taskId: run.task.id, action: "cancel" });
  };
  for (;;) {
    const left = ms - (Date.now() - t0);
    if (left <= 0) {
      const run = [...k.runs.values()].at(-1);
      cancel();
      throw new Error(`timed out after ${Math.round(ms / 1000)}s (task status: ${run?.task.status ?? "not started"}); the task was cancelled`);
    }
    await Promise.race([k.settled(), sleep(Math.min(left, 1000))]);
    const run = [...k.runs.values()].at(-1);
    if (run && ["done", "failed", "cancelled"].includes(run.task.status)) return;
    // Waiting for a person with nothing to approve (approvals are decided automatically here): it asked a question
    // instead of acting. Say so after a short grace period rather than waiting out the whole time limit.
    const emp = run?.employeeId;
    const stuck = run?.task.status === "waiting_on_user" && k.pendingApprovals().length === 0;
    if (!stuck) idleSince = 0;
    else if (!idleSince) idleSince = Date.now();
    else if (Date.now() - idleSince > graceMs) {
      const asked = emp ? k.openQuestionsOf(emp).map((q) => q.text) : [];
      cancel();
      throw new Error(`the employee stopped and waited for a person (nothing to approve)${asked.length ? `; it asked: ${asked.map((t) => `"${t}"`).join(" / ")}` : "; no open question was recorded"}`);
    }
    await sleep(50);
  }
}

export const money = (n: number) => `$${n.toFixed(n < 0.1 ? 3 : 2)}`;

/** A readable report: one block per case, then totals. */
export function formatReport(results: CaseResult[], meta: { model: string; spent?: { total: number; cap: number } }): string {
  const lines: string[] = [];
  for (const r of results) {
    lines.push(`${r.pass ? "PASS" : "FAIL"}  ${r.id.padEnd(17)} ${r.title}`);
    lines.push(`      ${r.modelCalls} model calls · ${r.inputTokens + r.outputTokens} tokens · ${money(r.costUsd)} · ${r.seconds.toFixed(0)}s${r.tier ? ` · route tier ${r.tier}` : ""}`);
    if (r.error) lines.push(`      ERROR: ${r.error}`);
    for (const c of r.checks) lines.push(`      ${c.ok ? "✓" : "✗"} ${c.name}${!c.ok && c.detail ? `  [${c.detail}]` : ""}`);
    if (!r.pass && r.said) lines.push(`      employee said: ${r.said.replace(/\n/g, "\n                     ")}`);
  }
  const passed = results.filter((r) => r.pass).length;
  const cost = results.reduce((n, r) => n + r.costUsd, 0);
  lines.push("", `${passed}/${results.length} cases passed · model ${meta.model} · this run ${money(cost)}${meta.spent ? ` · Claude total ${money(meta.spent.total)} of ${money(meta.spent.cap)} cap` : ""}`);
  return lines.join("\n");
}
