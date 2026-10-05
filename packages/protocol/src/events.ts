import { z } from "zod";
import { Actor, Id, Timestamp } from "./common.ts";
import { Employee } from "./employee.ts";
import { Evidence } from "./evidence.ts";
import { Plan, PlanPatch } from "./plan.ts";
import { Plank } from "./planks.ts";
import { Approval, Message, Task, TaskStatus } from "./task.ts";
import { ToolError } from "./tools.ts";

/**
 * Append-only event log (Framework Spec §6). The UI, replay mode, chat
 * timestamps and the demo trace are all derived from these events.
 */
const ev = <T extends string, P extends z.ZodType>(type: T, payload: P) =>
  z.object({ type: z.literal(type), payload });

export const EventBody = z.discriminatedUnion("type", [
  ev("message.posted", Message),
  ev("employee.created", Employee),
  ev("employee.updated", z.object({ employeeId: Id, changes: Employee.partial() })),
  ev("task.created", Task),
  ev("task.updated", z.object({ taskId: Id, changes: Task.partial() })),
  ev("task.status_changed", z.object({ taskId: Id, status: TaskStatus, reason: z.string().optional() })),
  ev("plan.created", Plan),
  ev("plan.patched", z.object({ taskId: Id, version: z.number().int(), patch: PlanPatch })),
  ev(
    "tool.called",
    z.object({ callId: Id, taskId: Id, itemId: z.string().optional(), stepId: z.string().optional(), tool: z.string(), input: z.unknown() }),
  ),
  ev(
    "tool.completed",
    z.object({
      callId: Id,
      ok: z.boolean(),
      /** Small preview of the output for the trace; full data stays in the tool store. */
      preview: z.string().optional(),
      error: ToolError.optional(),
      durationMs: z.number().nonnegative(),
      evidenceIds: z.array(Id).default([]),
    }),
  ),
  ev("evidence.added", Evidence),
  ev("approval.requested", Approval),
  ev(
    "approval.resolved",
    z.object({ approvalId: Id, status: z.enum(["approved", "rejected"]), decidedBy: Actor, comment: z.string().optional() }),
  ),
  ev(
    "nudge.received",
    z.object({ nudgeId: Id, employeeId: Id, taskId: Id.optional(), itemId: z.string().optional(), text: z.string() }),
  ),
  ev("nudge.acknowledged", z.object({ nudgeId: Id, response: z.string() })),
  ev(
    "check.completed",
    z.object({
      taskId: Id,
      itemId: z.string().optional(),
      stepId: z.string().optional(),
      checkId: z.string(),
      verdict: z.enum(["pass", "fail", "uncertain"]),
      detail: z.string(),
      evidenceIds: z.array(Id).default([]),
    }),
  ),
  ev(
    "verification.completed",
    z.object({
      taskId: Id,
      results: z.array(
        z.object({ criterionId: z.string(), verdict: z.enum(["pass", "fail", "uncertain"]), detail: z.string(), evidenceIds: z.array(Id).default([]) }),
      ),
    }),
  ),
  ev("plank.proposed", Plank),
  ev(
    "plank.resolved",
    z.object({ rolePack: z.string(), plankId: z.string(), version: z.number().int(), status: z.enum(["active", "rejected"]), decidedBy: Actor }),
  ),
]);
export type EventBody = z.infer<typeof EventBody>;
export type EventType = EventBody["type"];

export const EventEnvelope = z.object({
  id: Id,
  /** Monotonic sequence number from the log. */
  seq: z.number().int().nonnegative(),
  ts: Timestamp,
  actor: Actor,
  employeeId: Id.optional(),
  taskId: Id.optional(),
});

export const TheseusEvent = z.intersection(EventEnvelope, EventBody);
export type TheseusEvent = z.infer<typeof TheseusEvent>;

/** Narrow an event to one type: `EventOf<"plan.patched">`. */
export type EventOf<T extends EventType> = z.infer<typeof EventEnvelope> & Extract<EventBody, { type: T }>;
