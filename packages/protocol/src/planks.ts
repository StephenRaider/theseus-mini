import { z } from "zod";
import { Actor, Id, Timestamp } from "./common.ts";

/**
 * Ship of Theseus: the replaceable parts of an employee. The keel (kernel)
 * is code we own; planks are versioned artefacts an employee may propose to
 * change. A proposal goes through evals and human approval before it's active.
 */
export const PlankKind = z.enum(["playbook", "tool", "check", "prompt"]);
export type PlankKind = z.infer<typeof PlankKind>;

export const PlankStatus = z.enum(["active", "proposed", "rejected", "retired"]);

export const EvalSummary = z.object({
  suite: z.string(),
  runs: z.number().int().positive(),
  /** Fraction of tasks that passed all k runs (pass^k, after τ-bench). */
  passK: z.number().min(0).max(1),
  passAt1: z.number().min(0).max(1),
  avgCostUsd: z.number().nonnegative().optional(),
});
export type EvalSummary = z.infer<typeof EvalSummary>;

export const Plank = z.object({
  kind: PlankKind,
  /** Stable id within the role pack, e.g. "onboard-contractor". */
  id: z.string(),
  version: z.number().int().positive(),
  parentVersion: z.number().int().positive().optional(),
  status: PlankStatus,
  /** Full content (YAML for playbooks, source for tools/checks, text for prompts). */
  content: z.string(),
  contentHash: z.string(),
  /** Why this version exists. Required for proposals. */
  rationale: z.string().optional(),
  proposedBy: Actor.optional(),
  /** Eval results for the parent (before) and this version (after). */
  evalBefore: EvalSummary.optional(),
  evalAfter: EvalSummary.optional(),
  createdAt: Timestamp,
  rolePack: z.string(),
  proposalId: Id.optional(),
});
export type Plank = z.infer<typeof Plank>;
