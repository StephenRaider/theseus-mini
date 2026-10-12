/**
 * "Why did that case fail?": prints the story of a failed case from its saved event log: what the
 * employee said, what it asked, which approvals were raised and how they were decided, errors from tools,
 * and how the task ended. Reads the newest run's folder in .theseus/live-check/.
 *
 *   pnpm live:why operate-post          the last 30 notable events of that case
 *   pnpm live:why operate-post --all    every notable event
 *   pnpm live:why                       list the failed cases that have a saved log
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { REPO_ROOT } from "@theseus/server";

interface Ev {
  seq: number;
  ts: string;
  type: string;
  payload: Record<string, any>;
}

const clip = (s: string, n = 320) => (s.length > n ? `${s.slice(0, n)}…` : s).replace(/\s+/g, " ");

/** The notable events of a case as readable lines (exported so it can be tested). */
export function summarizeEvents(jsonl: string): string[] {
  const out: string[] = [];
  for (const line of jsonl.split("\n")) {
    if (!line.trim()) continue;
    const e = JSON.parse(line) as Ev;
    const p = e.payload;
    const at = e.ts.slice(11, 19);
    const row = (kind: string, text: string) => out.push(`${at} ${kind.padEnd(10)} ${clip(text)}`);
    switch (e.type) {
      case "message.posted":
        row(p.from === "user" ? "YOU" : p.from === "theseus" ? "theseus" : "EMPLOYEE", p.text);
        break;
      case "approval.requested":
        row("APPROVAL?", `${p.title} [${p.risk}]`);
        break;
      case "approval.resolved":
        row("decided", `${p.status} by ${p.decidedBy}`);
        break;
      case "question.asked":
        row("QUESTION", `${p.text}${p.blocking ? " (blocking)" : ` (default: ${p.default ?? "none"})`}`);
        break;
      case "question.answered":
        row("answered", `${p.answer}${p.usedDefault ? " (default used)" : ""}`);
        break;
      case "constraint.added":
        row("INSTRUCTION", p.text);
        break;
      case "tool.completed":
        if (!p.ok) row("tool error", `${p.error?.class}: ${p.error?.message}`);
        break;
      case "task.status_changed":
        row("TASK", `${p.status}${p.reason ? ` (${p.reason})` : ""}`);
        break;
      case "plan.patched":
        if (p.patch?.op === "set_cell" && ["needs_you", "failed"].includes(p.patch.state)) row(p.patch.state === "failed" ? "FAILED" : "NEEDS YOU", `${p.patch.itemId}/${p.patch.stepId}: ${p.patch.note ?? ""}`);
        if (p.patch?.op === "hold_item") row("HELD", `${p.patch.itemId}: ${p.patch.reason}`);
        break;
      case "model.called":
        if (!p.ok) row("model error", p.error ?? "");
        break;
      default:
        break;
    }
  }
  return out;
}

if (process.argv[1]?.endsWith("why.ts")) {
  const root = join(REPO_ROOT, ".theseus/live-check");
  const dirs = existsSync(root) ? readdirSync(root, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name).sort().reverse() : [];
  const wanted = process.argv[2] && !process.argv[2].startsWith("--") ? process.argv[2] : undefined;
  if (!wanted) {
    console.log("Failed cases with a saved log (newest run first):");
    for (const d of dirs) for (const f of readdirSync(join(root, d)).filter((x) => x.endsWith(".events.jsonl"))) console.log(`  ${f.replace(".events.jsonl", "").padEnd(18)} (${d})`);
    if (!dirs.length) console.log("  none yet: only failed cases leave a log.");
    process.exit(0);
  }
  const dir = dirs.find((d) => existsSync(join(root, d, `${wanted}.events.jsonl`)));
  if (!dir) {
    console.error(`No saved log for "${wanted}". Run "pnpm live:why" to list them.`);
    process.exit(1);
  }
  const lines = summarizeEvents(readFileSync(join(root, dir, `${wanted}.events.jsonl`), "utf8"));
  const shown = process.argv.includes("--all") ? lines : lines.slice(-30);
  console.log(`Case ${wanted} (run ${dir}): ${lines.length} notable events${shown.length < lines.length ? `, showing the last ${shown.length}` : ""}\n`);
  console.log(shown.join("\n"));
}
