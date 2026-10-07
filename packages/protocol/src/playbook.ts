import { z } from "zod";
import { RiskTier } from "./common.ts";
import { WidgetSpec } from "./widgets.ts";

/** What happens when a step can't be completed after its retries. */
export const OnFail = z.enum([
  "needs_you", // park the item for a human, continue with other items
  "skip_item", // mark the rest of the item skipped with a reason
  "fail_item", // mark the item failed
  "continue", // record the failure, move on to the next step of the same item
]);
export type OnFail = z.infer<typeof OnFail>;

export const PlaybookStep = z.object({
  id: z.string().regex(/^[a-z][a-z0-9_]*$/),
  /** Short column label for the grid widget, e.g. "GSTIN". */
  title: z.string().max(24),
  /** What this step must achieve, in plain language (goes to the model). */
  goal: z.string(),
  /** Tool allow-list for this step. */
  tools: z.array(z.string()).default([]),
  /** Check ids that must pass for the step to count as done. */
  checks: z.array(z.string()).default([]),
  on_fail: OnFail.default("needs_you"),
  /** Highest risk tier this step may use; irreversible always needs approval. */
  risk: RiskTier.default("read"),
  /**
   * Steps whose results this step relies on. When a user asks for only part
   * of a playbook (task tier 2), the planner adds these automatically.
   */
  needs: z.array(z.string()).default([]),
});
export type PlaybookStep = z.infer<typeof PlaybookStep>;

export const Playbook = z.object({
  id: z.string().regex(/^[a-z][a-z0-9-]*$/),
  version: z.number().int().positive(),
  title: z.string(),
  /** When should an employee pick this playbook? (used for routing) */
  when_to_use: z.string(),
  /** Real-world grounding: O*NET task, APQC process, law, policy… */
  sources: z.array(z.string()).default([]),
  item: z.object({
    /** Noun for one row, e.g. "contractor", "payment line". */
    kind: z.string(),
    /** Plural for headings, e.g. "contractors". */
    plural: z.string(),
    /** Hint to the model on how to discover the items. */
    discover: z.string(),
  }),
  success_criteria: z.array(z.string()).min(1),
  steps: z.array(PlaybookStep).min(1),
  /** Rules the employee must always follow in this playbook. */
  rules: z.array(z.string()).default([]),
  widget: WidgetSpec.default({ type: "item_grid" }),
});
export type Playbook = z.infer<typeof Playbook>;

/** pack.yaml: declares everything a role pack's playbooks may reference. */
export const RolePackManifest = z.object({
  id: z.string().regex(/^[a-z][a-z0-9-]*$/),
  name: z.string(),
  version: z.number().int().positive(),
  company: z.string().optional(),
  grounding: z.array(z.string()).default([]),
  tools: z.array(z.object({ name: z.string(), risk: RiskTier, description: z.string() })).min(1),
  checks: z.array(z.object({ id: z.string(), kind: z.enum(["deterministic", "judged"]), description: z.string() })),
  /**
   * Scope charter (Framework Spec §10): what this role does and explicitly
   * does not do. Requests outside it are politely refused.
   */
  scope: z
    .object({ does: z.array(z.string()).default([]), does_not: z.array(z.string()).default([]) })
    .default({ does: [], does_not: [] }),
  /**
   * Risk of actions in web apps (browser clicks), by the button's label and
   * where it submits to. A click no rule matches is judged by what it does:
   * a link or a GET form is a read, a POST form a write.
   */
  ui_risks: z
    .array(
      z.object({
        label: z.string().describe("Regex on the button / link text, case-insensitive"),
        url: z.string().optional().describe("Regex on the URL it submits to or opens"),
        risk: RiskTier,
        why: z.string().optional(),
      }),
    )
    .default([]),
  /** Web apps the employee may open in its browser (keys of the company's sites). */
  apps: z.array(z.object({ key: z.string(), label: z.string(), note: z.string().optional() })).default([]),
});
export type RolePackManifest = z.infer<typeof RolePackManifest>;
