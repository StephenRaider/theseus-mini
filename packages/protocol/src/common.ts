import { z } from "zod";

/** ISO-8601 timestamp string, always UTC (e.g. 2026-10-06T09:30:00.000Z). */
export const Timestamp = z.iso.datetime();
export type Timestamp = z.infer<typeof Timestamp>;

/** Prefixed ids keep logs readable: emp_…, task_…, evt_… */
export const Id = z.string().min(3);
export type Id = z.infer<typeof Id>;

/** Who did something. Every event and plan edit carries one. */
export const Actor = z.union([
  z.literal("user"),
  z.literal("theseus"),
  z.literal("system"),
  z.templateLiteral(["employee:", z.string()]),
]);
export type Actor = z.infer<typeof Actor>;

/**
 * Risk tiers (Framework Spec §3).
 * read: runs automatically · write: runs automatically, logged, reversible ·
 * irreversible: pauses for human approval.
 */
export const RiskTier = z.enum(["read", "write", "irreversible"]);
export type RiskTier = z.infer<typeof RiskTier>;
