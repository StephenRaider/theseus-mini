import { z } from "zod";
import { RiskTier } from "./common.ts";
import { Evidence } from "./evidence.ts";

/**
 * Error taxonomy (Framework Spec §4). Every tool failure is classified so the
 * kernel can pick a policy instead of guessing.
 */
export const ErrorClass = z.enum([
  "transient", // timeout, 5xx, rate limit → retry with backoff
  "ui_changed", // element missing / page differs → re-observe, then alternate route
  "validation", // target system rejected the input → fix from evidence, else ask
  "not_found", // record/document missing → search alternatives, else ask
  "blocked_needs_human", // needs a call-back, document or decision → park, continue others
  "policy_violation", // not allowed by risk tier / policy → stop that action
  "fatal", // bug or broken environment → fail the item
]);
export type ErrorClass = z.infer<typeof ErrorClass>;

export const ToolError = z.object({
  class: ErrorClass,
  message: z.string(),
  /** Hint for the agent: what might fix it. */
  hint: z.string().optional(),
});
export type ToolError = z.infer<typeof ToolError>;

export const ToolResult = z.discriminatedUnion("ok", [
  z.object({ ok: z.literal(true), data: z.unknown(), evidence: z.array(Evidence).default([]) }),
  z.object({ ok: z.literal(false), error: ToolError }),
]);
export type ToolResult = z.infer<typeof ToolResult>;

/** Serializable description of a tool (what the model and the UI see). */
export const ToolDescriptor = z.object({
  /** Namespaced name, e.g. "mail.search", "erp.vendor.create", "check.gstin". */
  name: z.string().regex(/^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/),
  description: z.string(),
  risk: RiskTier,
  /** Safe to call twice with the same input (affects retry policy). */
  idempotent: z.boolean(),
  /** JSON Schema of the input, generated from the tool's Zod schema. */
  inputSchema: z.record(z.string(), z.unknown()),
});
export type ToolDescriptor = z.infer<typeof ToolDescriptor>;

/** Default retry policy per error class. The kernel may tighten this per tool. */
export const RETRY_POLICY: Record<ErrorClass, { maxRetries: number; backoffMs: number }> = {
  transient: { maxRetries: 3, backoffMs: 1000 },
  ui_changed: { maxRetries: 1, backoffMs: 0 },
  validation: { maxRetries: 1, backoffMs: 0 },
  not_found: { maxRetries: 0, backoffMs: 0 },
  blocked_needs_human: { maxRetries: 0, backoffMs: 0 },
  policy_violation: { maxRetries: 0, backoffMs: 0 },
  fatal: { maxRetries: 0, backoffMs: 0 },
};
