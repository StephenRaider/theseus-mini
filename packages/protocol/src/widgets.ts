import { z } from "zod";

/**
 * Widget specs (Framework Spec §2). The look lives in the UI's widget kit;
 * the agent only selects a widget type and configures it. The data comes from
 * the plan and the event log, never from the spec itself.
 */
export const WidgetSpec = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("item_grid"),
    /** Optional heading override; defaults to the playbook title. */
    title: z.string().optional(),
  }),
  z.object({ type: z.literal("checklist"), title: z.string().optional() }),
  z.object({ type: z.literal("evidence_list"), title: z.string().optional() }),
  z.object({ type: z.literal("timeline"), title: z.string().optional() }),
]);
export type WidgetSpec = z.infer<typeof WidgetSpec>;
