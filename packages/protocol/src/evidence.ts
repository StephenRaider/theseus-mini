import { z } from "zod";
import { Id, Timestamp } from "./common.ts";

/** What backs a claim. The verifier and the final report cite evidence by id. */
export const EvidenceKind = z.enum(["document", "record", "api_response", "screenshot", "email", "text"]);
export type EvidenceKind = z.infer<typeof EvidenceKind>;

export const Evidence = z.object({
  id: Id,
  kind: EvidenceKind,
  /** One-line human summary, e.g. "GST certificate p.1: legal name SHREE GANESH CONSTRUCTIONS". */
  summary: z.string(),
  /** Where it came from: mail message id + attachment, ERP record path, API URL, file path… */
  source: z.string(),
  /** Optional pointer to stored content (screenshot file, JSON blob, excerpt). */
  ref: z.string().optional(),
  /** Optional extracted fields this evidence supports. */
  fields: z.record(z.string(), z.unknown()).optional(),
  capturedAt: Timestamp,
});
export type Evidence = z.infer<typeof Evidence>;
