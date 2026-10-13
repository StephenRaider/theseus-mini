/**
 * The short, human version of a finished task's report. The long report (every fact with where it was seen,
 * every change, the verifier's detail) is kept for debugging; people get this: what happened, whether it was
 * checked, what changed, what is still open. Pure text work, no model call.
 */
export interface ShortReplyInput {
  /** The employee's full report. */
  report: string;
  /** Verifier results: criterion, verdict. */
  verdicts: { criterion: string; verdict: "pass" | "fail" | "uncertain"; detail?: string }[];
  /** How many changes it made to the outside world (files moved, documents created). */
  changes: number;
  /** Plan items not finished. */
  open: number;
  /** A rehearsal: nothing was changed. */
  rehearsal?: { previews: number };
}

const SECTION = /\n+(?:What I found|What I changed|Still open|Evidence|Verifier|REHEARSAL)\b/;

/** First paragraph of the report, at most about 3 sentences / 420 characters, cut at a sentence end. */
export function leadParagraph(report: string, max = 420): string {
  const first = report.split(SECTION)[0]!.split(/\n\s*\n/)[0]!.trim().replace(/\s+/g, " ");
  if (first.length <= max) return first;
  const sentences = first.match(/[^.!?]+[.!?]+(?:\s|$)/g) ?? [first];
  let out = "";
  for (const s of sentences) {
    if ((out + s).length > max && out) break;
    out += s;
    if (out.split(/[.!?]\s/).length > 3) break;
  }
  out = out.trim() || first.slice(0, max);
  return out.length < first.length && !/[.!?]$/.test(out) ? `${out.slice(0, max - 1).trimEnd()}…` : out;
}

export function shortReply(i: ShortReplyInput): string {
  const lines = [leadParagraph(i.report)];
  if (i.rehearsal) {
    lines.push(i.rehearsal.previews ? `Nothing has been changed yet. ${i.rehearsal.previews} change${i.rehearsal.previews === 1 ? " is" : "s are"} ready: apply them or discard.` : "Nothing needed changing.");
  } else {
    const bad = i.verdicts.filter((v) => v.verdict !== "pass");
    if (!i.verdicts.length) lines.push("");
    else if (!bad.length) lines.push(`✓ Checked again from the sources: all ${i.verdicts.length} checks passed.`);
    else lines.push(`⚠ Not fully confirmed: ${bad.slice(0, 2).map((v) => v.criterion.replace(/\s+/g, " ").slice(0, 90)).join("; ")}${bad.length > 2 ? ` (+${bad.length - 2} more)` : ""}.`);
    if (i.changes) lines.push(`${i.changes} change${i.changes === 1 ? "" : "s"} made. You can undo any of them in the Changes tab.`);
    if (i.open) lines.push(`${i.open} item${i.open === 1 ? " is" : "s are"} still open.`);
  }
  return lines.filter(Boolean).join("\n");
}
