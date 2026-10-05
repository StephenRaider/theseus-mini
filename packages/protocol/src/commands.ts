import { z } from "zod";
import { Id } from "./common.ts";
import { Attachment } from "./task.ts";

/**
 * Commands flow UI → server (Framework Spec §7). The server validates each
 * one, turns it into events, and wakes the relevant employee. The UI never
 * mutates state directly.
 */
export const Command = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("send_message"),
    /** Employee id of the conversation (Theseus or an employee). */
    threadId: Id,
    text: z.string().min(1),
    attachments: z.array(Attachment).default([]),
  }),
  z.object({
    type: z.literal("nudge"),
    employeeId: Id,
    taskId: Id.optional(),
    itemId: z.string().optional(),
    text: z.string().min(1),
  }),
  z.object({
    type: z.literal("resolve_approval"),
    approvalId: Id,
    decision: z.enum(["approved", "rejected"]),
    comment: z.string().optional(),
  }),
  z.object({
    type: z.literal("cell_action"),
    taskId: Id,
    itemId: z.string(),
    action: z.enum(["skip", "retry", "hold", "release"]),
    reason: z.string().optional(),
    fromStepId: z.string().optional(),
  }),
  z.object({ type: z.literal("reorder_items"), taskId: Id, itemIds: z.array(z.string()).min(1) }),
  z.object({ type: z.literal("task_control"), taskId: Id, action: z.enum(["pause", "resume", "cancel"]) }),
  z.object({
    type: z.literal("create_employee"),
    name: z.string().optional(),
    rolePack: z.string(),
    scope: z.string().optional(),
  }),
  z.object({ type: z.literal("rename_employee"), employeeId: Id, name: z.string().min(1) }),
  z.object({
    type: z.literal("resolve_plank_proposal"),
    rolePack: z.string(),
    plankId: z.string(),
    version: z.number().int(),
    decision: z.enum(["active", "rejected"]),
  }),
]);
export type Command = z.infer<typeof Command>;
