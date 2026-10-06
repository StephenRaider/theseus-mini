import { z } from "zod";
import { Actor, Id, RiskTier, Timestamp } from "./common.ts";

export const TaskStatus = z.enum([
  "understanding", // turning the request into a goal + success criteria
  "planning", // choosing a playbook, discovering items
  "running",
  "waiting_on_user", // nothing runnable until a human acts
  "verifying",
  "done",
  "failed",
  "cancelled",
]);
export type TaskStatus = z.infer<typeof TaskStatus>;

export const SuccessCriterion = z.object({
  id: z.string(),
  text: z.string(),
  /** Last verifier verdict for this criterion, if any. */
  verdict: z.enum(["pass", "fail", "uncertain"]).optional(),
});
export type SuccessCriterion = z.infer<typeof SuccessCriterion>;

export const Task = z.object({
  id: Id,
  employeeId: Id,
  /** The user's words, unchanged. */
  request: z.string(),
  /** The agent's restatement of the end goal. */
  goal: z.string().optional(),
  successCriteria: z.array(SuccessCriterion).default([]),
  playbookId: z.string().optional(),
  playbookVersion: z.number().int().optional(),
  /** If Theseus delegated this, the parent task. */
  parentTaskId: Id.optional(),
  status: TaskStatus,
  createdAt: Timestamp,
});
export type Task = z.infer<typeof Task>;

/** A field-level change shown on an approval card. */
export const FieldDiff = z.object({ field: z.string(), before: z.unknown(), after: z.unknown() });
export type FieldDiff = z.infer<typeof FieldDiff>;

export const ApprovalStatus = z.enum(["pending", "approved", "rejected"]);

/**
 * A request for a human decision. Raised before irreversible actions and when
 * policy demands a human (call-back verification, maker-checker).
 */
export const Approval = z.object({
  id: Id,
  taskId: Id,
  itemId: z.string().optional(),
  stepId: z.string().optional(),
  /** Plain-language description: "Activate vendor Shree Ganesh Constructions". */
  title: z.string(),
  /** Why the agent wants to do it / why a human is needed. */
  reason: z.string(),
  /** Concrete thing the human is asked to do first, e.g. "Call +91… (number on record)". */
  humanTask: z.string().optional(),
  /** The exact tool call that runs if approved (absent for pure human tasks). */
  toolCall: z.object({ tool: z.string(), input: z.unknown() }).optional(),
  diff: z.array(FieldDiff).default([]),
  evidenceIds: z.array(Id).default([]),
  risk: RiskTier,
  status: ApprovalStatus.default("pending"),
  decidedBy: Actor.optional(),
  comment: z.string().optional(),
});
export type Approval = z.infer<typeof Approval>;

/** A chat message. Each employee has its own thread with the user. */
export const Attachment = z.object({ name: z.string(), mime: z.string(), ref: z.string() });
export type Attachment = z.infer<typeof Attachment>;
export const Message = z.object({
  id: Id,
  /** Which conversation (employee id) this belongs to. */
  threadId: Id,
  from: Actor,
  text: z.string(),
  attachments: z.array(Attachment).default([]),
  /** Optional link to a task this message is about. */
  taskId: Id.optional(),
  ts: Timestamp,
});
export type Message = z.infer<typeof Message>;
