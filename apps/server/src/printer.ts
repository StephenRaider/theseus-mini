import type { Kernel } from "@theseus/core";
import type { TheseusEvent } from "@theseus/protocol";

/**
 * Turns the event log into a readable terminal trace. Shows what a person
 * supervising would want: messages, what the employee looked at, holds,
 * problems, approvals, questions, retries and model calls. Routine "cell done"
 * events are summarised, not printed one by one.
 */
const c = {
  dim: (s: string) => `\x1b[2m${s}\x1b[0m`,
  cyan: (s: string) => `\x1b[36m${s}\x1b[0m`,
  yellow: (s: string) => `\x1b[33m${s}\x1b[0m`,
  red: (s: string) => `\x1b[31m${s}\x1b[0m`,
  green: (s: string) => `\x1b[32m${s}\x1b[0m`,
  bold: (s: string) => `\x1b[1m${s}\x1b[0m`,
};

export function attachPrinter(kernel: Kernel, out: (line: string) => void = (l) => console.log(l)) {
  const time = (e: TheseusEvent) => c.dim(e.ts.slice(11, 19));
  const label = (taskId: string, itemId: string) => kernel.runs.get(taskId)?.plan?.items.find((i) => i.id === itemId)?.label ?? itemId;
  let done = 0;
  // Hands-on (operate) runs: print every thought and action, like watching over a shoulder.
  const operating = (taskId?: string) => !!taskId && kernel.runs.get(taskId)?.plan?.playbookId === "operate";
  return kernel.log.subscribe((e) => {
    switch (e.type) {
      case "message.posted": {
        const who = e.payload.from === "user" ? c.bold("You") : c.cyan(kernel.employees.get(e.payload.threadId)?.employee.name ?? "Employee");
        out(`${time(e)} ${who}: ${e.payload.text.replace(/\n/g, "\n         ")}`);
        break;
      }
      case "orient.completed":
        if (e.payload.found.length) out(`${time(e)} ${c.dim("looked at:")} ${e.payload.found.map((f) => `${f.label} ${c.dim(`(${f.why ?? f.kind})`)}`).join("; ")}`);
        break;
      case "plan.patched": {
        const p = e.payload.patch;
        if (p.op === "hold_item") out(`${time(e)} ${c.yellow("⏸ held")} ${label(e.payload.taskId, p.itemId)}: ${p.reason}`);
        if (p.op === "skip_item") out(`${time(e)} ${c.dim("⤼ skipped")} ${label(e.payload.taskId, p.itemId)}: ${p.reason}`);
        if (p.op === "set_cell") {
          if (p.state === "done") done++;
          if (p.state === "failed") out(`${time(e)} ${c.red("✗ failed")} ${label(e.payload.taskId, p.itemId)} · ${p.stepId}: ${p.note ?? ""}`);
          if (p.state === "needs_you") out(`${time(e)} ${c.yellow("● needs you")} ${label(e.payload.taskId, p.itemId)} · ${p.stepId}: ${p.note ?? ""}`);
          if (p.state === "running" && p.note && p.stepId === "work" && operating(e.payload.taskId)) out(`${time(e)} ${c.dim("💭")} ${p.note}`);
          if (p.state === "done" && p.stepId === "check" && operating(e.payload.taskId)) out(`${time(e)} ${c.green("✓")} ${label(e.payload.taskId, p.itemId)} ${c.dim(p.note ?? "")}`);
          if (p.state === "retrying") out(`${time(e)} ${c.yellow("↻ retrying")} ${label(e.payload.taskId, p.itemId)} · ${p.stepId}: ${p.note ?? ""}`);
          if (p.state === "done" && p.note?.startsWith("Corrected")) out(`${time(e)} ${c.green("✎")} ${label(e.payload.taskId, p.itemId)}: ${p.note}`);
          if (p.state === "done" && p.note?.startsWith("⚑")) out(`${time(e)} ${c.yellow("⚑")} ${label(e.payload.taskId, p.itemId)}: ${p.note.slice(2)}`);
          if (p.state === "done" && p.note?.startsWith("⚠")) out(`${time(e)} ${c.yellow("⚠")} ${label(e.payload.taskId, p.itemId)}: ${p.note.slice(2)}`);
        }
        break;
      }
      case "approval.requested":
        out(
          `${time(e)} ${c.yellow(c.bold(`▶ APPROVAL ${e.payload.id}`))} ${e.payload.title}\n         ${e.payload.reason}${e.payload.humanTask ? `\n         You need to: ${e.payload.humanTask}` : ""}${e.payload.toolCall ? c.dim(`\n         runs: ${e.payload.toolCall.tool} ${JSON.stringify(e.payload.toolCall.input)}`) : ""}\n         ${c.dim(`type: approve ${e.payload.id} | reject ${e.payload.id}`)}`,
        );
        break;
      case "approval.resolved":
        out(`${time(e)} ${e.payload.status === "approved" ? c.green("✓ approved") : c.red("✗ rejected")} ${e.payload.approvalId} by ${e.payload.decidedBy}`);
        break;
      case "question.asked":
        out(`${time(e)} ${c.yellow(`? ${e.payload.questionId}`)} ${e.payload.text}${e.payload.default ? c.dim(` (assuming "${e.payload.default}" unless you say otherwise)`) : ""}`);
        break;
      case "constraint.added":
        out(`${time(e)} ${c.yellow("⛨ standing instruction")} "${e.payload.text}"${readableSubjects(e.payload.subjects, kernel)}`);
        break;
      case "nudge.triaged":
        out(`${time(e)} ${c.dim(`message understood as: ${e.payload.kind}${e.payload.detail ? ` (${e.payload.detail})` : ""} [${e.payload.by}]`)}`);
        break;
      case "tool.called":
        if (operating(e.payload.taskId)) {
          const input = Object.entries((e.payload.input ?? {}) as Record<string, unknown>)
            .filter(([k]) => k !== "expect")
            .map(([k, v]) => `${k}=${JSON.stringify(v)}`)
            .join(" ");
          out(`${time(e)}   ${c.cyan("→")} ${e.payload.tool} ${c.dim(input.slice(0, 140))}`);
        }
        break;
      case "evidence.added":
        if (e.payload.kind === "screenshot") out(`${time(e)}   ${c.dim(`📷 ${e.payload.ref}`)}`);
        if (e.payload.kind === "text" && operating(e.taskId)) out(`${time(e)}   ${c.dim(`🧠 remembered ${e.payload.summary}`)}`);
        break;
      case "tool.completed":
        if (!e.payload.ok && e.payload.error?.class === "policy_violation")
          out(/needs your approval/.test(e.payload.error.message) ? `${time(e)} ${c.yellow("⏸ asks first")} ${e.payload.error.message}` : `${time(e)} ${c.red("⛔ blocked")} ${e.payload.error.message}`);
        break;
      case "model.called":
        out(`${time(e)} ${c.dim(`model: ${e.payload.purpose} ${e.payload.ok ? "ok" : `FAILED (${e.payload.error})`}${e.payload.cached ? " (cached)" : ""} ${(e.payload.durationMs / 1000).toFixed(1)}s`)}`);
        break;
      case "task.status_changed":
        if (["done", "failed", "cancelled"].includes(e.payload.status)) out(`${time(e)} ${c.bold(`task ${e.payload.status}`)}${e.payload.reason ? ` (${e.payload.reason})` : ""} ${c.dim(`· ${done} steps completed`)}`);
        break;
      default:
        break;
    }
  });
}

/** "vendor:V-105" → "Malnad Transport Co (V-105)"; internal name keys are dropped. */
function readableSubjects(subjects: string[], kernel: Kernel): string {
  const shown = subjects
    .filter((x) => x.startsWith("vendor:") || x.startsWith("line:"))
    .map((x) => {
      const id = x.slice(x.indexOf(":") + 1);
      const name = (kernel.pack as { directory?: { vendors: Map<string, { legalName: string }> } }).directory?.vendors.get(id)?.legalName;
      return name ? `${name} (${id})` : id;
    });
  return shown.length ? ` → protects ${shown.join(", ")}` : "";
}
