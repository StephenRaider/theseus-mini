import { z } from "zod";

/**
 * Conversation lane, step 1: triage (Framework Spec §11). Every message that
 * arrives while an employee works is sorted into one kind. Plain rules first
 * (fast, free, predictable); the model is asked only when the rules can't tell.
 */
export const TRIAGE_KINDS = ["question", "steer", "info", "new_task", "stop", "pause", "resume", "unclear"] as const;
export type TriageKind = (typeof TRIAGE_KINDS)[number];
export const STEER_ACTIONS = ["hold", "skip", "prioritise", "release"] as const;
export type SteerAction = (typeof STEER_ACTIONS)[number];

export interface Triage {
  kind: TriageKind;
  action?: SteerAction;
  /** The words naming what the steer is about ("Shree Ganesh Constructions"). */
  target?: string;
  by: "rules" | "model";
}

/** What the model returns when the rules can't classify a message. */
export const ModelTriage = z.object({
  kind: z.enum(TRIAGE_KINDS),
  action: z.enum(STEER_ACTIONS).optional().describe("Only for kind=steer"),
  target: z.string().optional().describe("For steer: the exact words naming the vendor/line/bidder/item"),
  answer: z.string().optional().describe("For question: a short answer using ONLY the status snapshot"),
});
export type ModelTriage = z.infer<typeof ModelTriage>;

/** Cut a captured target down to the name: "Shree Ganesh, it's under dispute." → "Shree Ganesh". */
export function cleanTarget(t: string): string {
  return t
    .split(/\s*(?:[,;:(]|\.(?:\s|$)|\s[-–—]\s|\bbecause\b|\bsince\b|\bas\s+(?:it|they|he|she)\b|\buntil\b|\bfor now\b|\bit'?s\b|\bthey'?re\b)/i)[0]!
    .replace(/^(?:everything|anything|all|any|the|payments?|lines?|bills?|items?)\s+(?:to|for|of|from|on)\s+/i, "")
    .replace(/^(?:to|for|of|from|on|the)\s+/i, "")
    .replace(/[.!?]+$/, "")
    .trim();
}

export function triageByRules(text: string, ctx: { openQuestions: number }): Triage | null {
  const t = text.trim();
  const rule = (kind: TriageKind, action?: SteerAction, target?: string): Triage => ({
    kind,
    by: "rules",
    ...(action ? { action } : {}),
    ...(target ? { target: cleanTarget(target) } : {}),
  });

  if (/^(?:please\s+)?(?:pause|hold on|wait(?: a (?:sec|second|minute|moment))?|stop for now)\b[\s.!]*$/i.test(t)) return rule("pause");
  if (/^(?:please\s+)?(?:resume|continue|carry on|go on|unpause|keep going)\b/i.test(t)) return rule("resume");
  if (/^(?:please\s+)?(?:stop|cancel|abort)\b/i.test(t) && !/\bpay(?:ing|ments?)?\b/i.test(t)) return rule("stop");

  let m: RegExpExecArray | null;
  if ((m = /\b(?:don'?t|do not|never|stop)\s+(?:pay|paying|releasing)\b(?:\s+(?:anything|anyone|money))?\s+(.+)/i.exec(t))) return rule("steer", "hold", m[1]);
  if ((m = /\b(?:hold|freeze|block)\b(?:\s+(?:all|any|every(?:thing)?|the))?(?:\s+(?:payments?|lines?|bills?|items?))?\s+(.+)/i.exec(t))) return rule("steer", "hold", m[1]);
  if ((m = /\bskip\b\s+(.+)/i.exec(t))) return rule("steer", "skip", m[1]);
  if ((m = /\b(?:release|unhold|un-hold|lift the hold on|resume payments? to)\s+(.+)/i.exec(t))) return rule("steer", "release", m[1]);
  if ((m = /\b(?:prioriti[sz]e|move)\s+(.+?)(?:\s+to\s+(?:the\s+)?top)?$/i.exec(t)) || (m = /\bdo\s+(.+?)\s+first\b/i.exec(t)))
    return rule("steer", "prioritise", m[1]);

  if (/\?\s*$/.test(t) || /^(?:what|why|how|which|when|where|who|is|are|did|does|do|can|could|has|have|status|show me)\b/i.test(t)) return rule("question");
  if (ctx.openQuestions > 0) return rule("info");
  return null;
}
