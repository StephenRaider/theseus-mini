import { z } from "zod";
import { Actor, Id, Timestamp } from "./common.ts";
import { WidgetSpec } from "./widgets.ts";

/**
 * The plan is SHARED STATE: the agent and the user edit the same object, only
 * through patches. Every patch becomes a `plan.patched` event, so the plan can
 * always be rebuilt from the log (replay, undo, audit).
 */

export const CellState = z.enum([
  "pending",
  "running",
  "retrying",
  "done",
  "failed",
  "skipped",
  "needs_you", // parked: waiting for a human (approval, document, call-back, decision)
]);
export type CellState = z.infer<typeof CellState>;

export const Cell = z.object({
  state: CellState,
  /** Short human-readable note shown on hover / in the detail panel. */
  note: z.string().optional(),
  attempts: z.number().int().nonnegative().default(0),
  evidenceIds: z.array(Id).default([]),
  updatedAt: Timestamp.optional(),
});
export type Cell = z.infer<typeof Cell>;

export const PlanItem = z.object({
  id: z.string(),
  label: z.string(),
  /** Pointer to the real-world thing: vendor id, payment line id, email id… */
  ref: z.string().optional(),
  held: z.boolean().default(false),
  holdReason: z.string().optional(),
  skipReason: z.string().optional(),
});
export type PlanItem = z.infer<typeof PlanItem>;

export const PlanStep = z.object({ id: z.string(), title: z.string() });
export type PlanStep = z.infer<typeof PlanStep>;

export const Plan = z.object({
  taskId: Id,
  /** Increments on every patch. Clients use it to detect missed updates. */
  version: z.number().int().nonnegative(),
  playbookId: z.string(),
  playbookVersion: z.number().int(),
  widget: WidgetSpec,
  steps: z.array(PlanStep).min(1),
  /** Display and execution order. */
  items: z.array(PlanItem),
  /** cells[itemId][stepId] */
  cells: z.record(z.string(), z.record(z.string(), Cell)),
});
export type Plan = z.infer<typeof Plan>;

export const PlanPatch = z.discriminatedUnion("op", [
  z.object({ op: z.literal("add_items"), items: z.array(PlanItem).min(1) }),
  z.object({
    op: z.literal("set_cell"),
    itemId: z.string(),
    stepId: z.string(),
    state: CellState,
    note: z.string().optional(),
    evidenceIds: z.array(Id).optional(),
  }),
  z.object({ op: z.literal("reorder"), itemIds: z.array(z.string()).min(1) }),
  z.object({ op: z.literal("skip_item"), itemId: z.string(), reason: z.string() }),
  z.object({ op: z.literal("hold_item"), itemId: z.string(), reason: z.string() }),
  z.object({ op: z.literal("release_item"), itemId: z.string() }),
  /** Reset cells from `fromStepId` (default: first unfinished step) back to pending. */
  z.object({ op: z.literal("retry_item"), itemId: z.string(), fromStepId: z.string().optional() }),
]);
export type PlanPatch = z.infer<typeof PlanPatch>;

export class PlanPatchError extends Error {}

const TERMINAL: ReadonlySet<CellState> = new Set(["done", "skipped", "failed"]);
export const isTerminal = (s: CellState) => TERMINAL.has(s);

/** Create an empty plan from a playbook's steps. */
export function createPlan(args: {
  taskId: string;
  playbookId: string;
  playbookVersion: number;
  steps: PlanStep[];
  widget?: WidgetSpec;
}): Plan {
  return {
    taskId: args.taskId,
    version: 0,
    playbookId: args.playbookId,
    playbookVersion: args.playbookVersion,
    widget: args.widget ?? { type: "item_grid" },
    steps: args.steps,
    items: [],
    cells: {},
  };
}

/**
 * Apply one patch. Pure: returns a new plan, never mutates the input.
 * Throws PlanPatchError on an invalid patch (unknown item/step, bad reorder).
 */
export function applyPatch(plan: Plan, patch: PlanPatch, now: string, _actor?: Actor): Plan {
  const next: Plan = structuredClone(plan);
  const item = (id: string) => {
    const it = next.items.find((i) => i.id === id);
    if (!it) throw new PlanPatchError(`Unknown item "${id}"`);
    return it;
  };
  const cellsOf = (itemId: string) => next.cells[itemId]!;

  switch (patch.op) {
    case "add_items": {
      for (const it of patch.items) {
        if (next.items.some((i) => i.id === it.id)) throw new PlanPatchError(`Duplicate item "${it.id}"`);
        next.items.push({ ...it, held: it.held ?? false });
        next.cells[it.id] = Object.fromEntries(
          next.steps.map((s) => [s.id, { state: "pending", attempts: 0, evidenceIds: [] } satisfies Cell]),
        );
      }
      break;
    }
    case "set_cell": {
      item(patch.itemId);
      const cell = cellsOf(patch.itemId)[patch.stepId];
      if (!cell) throw new PlanPatchError(`Unknown step "${patch.stepId}"`);
      if (patch.state === "running" || patch.state === "retrying") cell.attempts += 1;
      cell.state = patch.state;
      if (patch.note !== undefined) cell.note = patch.note;
      if (patch.evidenceIds) cell.evidenceIds = [...new Set([...cell.evidenceIds, ...patch.evidenceIds])];
      cell.updatedAt = now;
      break;
    }
    case "reorder": {
      const ids = new Set(patch.itemIds);
      if (ids.size !== patch.itemIds.length || ids.size !== next.items.length || next.items.some((i) => !ids.has(i.id)))
        throw new PlanPatchError("Reorder must list every item exactly once");
      next.items = patch.itemIds.map((id) => next.items.find((i) => i.id === id)!);
      break;
    }
    case "skip_item": {
      const it = item(patch.itemId);
      it.skipReason = patch.reason;
      for (const cell of Object.values(cellsOf(it.id))) {
        if (!isTerminal(cell.state)) {
          cell.state = "skipped";
          cell.updatedAt = now;
        }
      }
      break;
    }
    case "hold_item": {
      const it = item(patch.itemId);
      it.held = true;
      it.holdReason = patch.reason;
      break;
    }
    case "release_item": {
      const it = item(patch.itemId);
      it.held = false;
      delete it.holdReason;
      break;
    }
    case "retry_item": {
      const it = item(patch.itemId);
      const cells = cellsOf(it.id);
      const startIdx = patch.fromStepId
        ? next.steps.findIndex((s) => s.id === patch.fromStepId)
        : next.steps.findIndex((s) => cells[s.id]!.state !== "done");
      if (startIdx < 0) throw new PlanPatchError("Nothing to retry");
      delete it.skipReason;
      for (const s of next.steps.slice(startIdx)) {
        const c = cells[s.id]!;
        c.state = "pending";
        delete c.note;
        c.updatedAt = now;
      }
      break;
    }
  }
  next.version = plan.version + 1;
  return next;
}

/** Overall status of one row, used for the row badge and the summary. */
export type ItemStatus = "held" | "needs_you" | "failed" | "running" | "done" | "skipped" | "pending";

export function itemStatus(plan: Plan, itemId: string): ItemStatus {
  const it = plan.items.find((i) => i.id === itemId);
  if (!it) throw new PlanPatchError(`Unknown item "${itemId}"`);
  const states = plan.steps.map((s) => plan.cells[itemId]![s.id]!.state);
  if (it.held) return "held";
  if (states.includes("needs_you")) return "needs_you";
  if (states.includes("failed")) return "failed";
  if (states.some((s) => s === "running" || s === "retrying")) return "running";
  if (states.every((s) => s === "skipped")) return "skipped";
  if (states.every((s) => s === "done" || s === "skipped")) return "done";
  return "pending";
}

/**
 * The next cell the kernel should work on, or null if nothing is runnable.
 * Rules: follow item order; skip held items and items that are parked or
 * failed; within an item, steps run strictly in order. This is where
 * "skip-and-continue" lives: a stuck item never blocks the next one.
 */
export function nextRunnableCell(plan: Plan): { itemId: string; stepId: string } | null {
  for (const it of plan.items) {
    if (it.held) continue;
    const status = itemStatus(plan, it.id);
    if (status === "needs_you" || status === "failed" || status === "done" || status === "skipped") continue;
    for (const s of plan.steps) {
      const c = plan.cells[it.id]![s.id]!;
      if (c.state === "done" || c.state === "skipped") continue;
      if (c.state === "pending" || c.state === "retrying") return { itemId: it.id, stepId: s.id };
      break; // running: someone is already on it
    }
  }
  return null;
}

/** Counts per item status, for "9 done · 2 need you · 1 failed" summaries. */
export function summarize(plan: Plan): Record<ItemStatus, number> {
  const out: Record<ItemStatus, number> = { held: 0, needs_you: 0, failed: 0, running: 0, done: 0, skipped: 0, pending: 0 };
  for (const it of plan.items) out[itemStatus(plan, it.id)]++;
  return out;
}
