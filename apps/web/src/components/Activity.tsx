/**
 * Activity: the readable trail of what happened, newest first, every line
 * timestamped (G1). Built from the same event log as everything else.
 */
import type { TheseusEvent } from "@theseus/protocol";
import { useMemo } from "react";
import { clock, dayLabel, sameDay } from "../state/selectors.ts";
import type { AppState } from "../state/store.ts";
import { Empty } from "./Work.tsx";

type Line = { id: string; ts: string; tone: "accent" | "red" | "green" | "yellow" | "held" | "neutral"; text: string; who: string };

export function Activity({ state, employeeId, now }: { state: AppState; employeeId: string; now: string }) {
  const lines = useMemo(() => {
    const out: Line[] = [];
    const label = (taskId: string, itemId: string) => state.plans[taskId]?.items.find((i) => i.id === itemId)?.label ?? itemId;
    const who = (e: TheseusEvent) => (e.actor === "user" ? "You" : e.actor === "theseus" ? "Theseus" : e.actor === "system" ? "System" : (state.employees[e.actor.slice(9)]?.name ?? e.actor));
    for (const e of state.log) {
      const emp = e.employeeId ?? (e.taskId ? state.tasks[e.taskId]?.employeeId : undefined);
      if (emp !== employeeId && !(e.type === "message.posted" && e.payload.threadId === employeeId)) continue;
      const add = (tone: Line["tone"], text: string) => out.push({ id: e.id, ts: e.ts, tone, text, who: who(e) });
      switch (e.type) {
        case "task.created":
          add("accent", `Task assigned: ${e.payload.goal ?? e.payload.request}`);
          break;
        case "task.status_changed":
          add(e.payload.status === "done" ? "green" : e.payload.status === "waiting_on_user" ? "red" : "neutral", `Task ${e.payload.status.replace(/_/g, " ")}${e.payload.reason ? `: ${e.payload.reason}` : ""}`);
          break;
        case "plan.patched": {
          const p = e.payload.patch;
          const t = e.payload.taskId;
          if (p.op === "hold_item") add("held", `Held ${label(t, p.itemId)}: ${p.reason}`);
          else if (p.op === "release_item") add("accent", `Released ${label(t, p.itemId)}`);
          else if (p.op === "skip_item") add("neutral", `Skipped ${label(t, p.itemId)}: ${p.reason}`);
          else if (p.op === "retry_item") add("accent", `Retry ${label(t, p.itemId)}`);
          else if (p.op === "reorder") add("neutral", `Reordered: ${label(t, p.itemIds[0]!)} first`);
          else if (p.op === "add_items") add("neutral", `Plan: ${p.items.length} items`);
          else if (p.op === "set_cell" && (p.state === "retrying" || p.state === "failed")) add("yellow", `${label(t, p.itemId)} · ${p.stepId}: ${p.note ?? p.state}`);
          else if (p.op === "set_cell" && p.state === "done" && p.note && !p.note.startsWith("Cleared")) add("green", `${label(t, p.itemId)} · ${p.stepId}: ${p.note}`);
          break;
        }
        case "approval.requested":
          add("red", `Asked you: ${e.payload.title}`);
          break;
        case "approval.resolved":
          add(e.payload.status === "approved" ? "green" : "neutral", `${e.payload.status === "approved" ? "Approved" : "Rejected"}: ${state.approvals[e.payload.approvalId]?.title ?? ""}`);
          break;
        case "nudge.received":
          add("accent", `Nudge: “${e.payload.text}”`);
          break;
        case "nudge.acknowledged":
          add("accent", `Acknowledged: ${e.payload.response}`);
          break;
        case "verification.completed":
          add("green", `Verifier: ${e.payload.results.filter((r) => r.verdict === "pass").length}/${e.payload.results.length} criteria pass`);
          break;
        case "message.posted":
          if (e.payload.attachments.length) add("neutral", `Files: ${e.payload.attachments.map((a) => a.name).join(", ")}`);
          break;
        default:
          break;
      }
    }
    return out.reverse().slice(0, 400);
  }, [state, employeeId]);

  if (!lines.length) return <Empty title="No activity yet" text="Everything this employee does shows up here with a timestamp." />;
  return (
    <ol className="activity">
      {lines.map((l, i) => (
        <li key={`${l.id}-${i}`}>
          {i === 0 || !sameDay(lines[i - 1]!.ts, l.ts) ? <div className="activity__day">{dayLabel(l.ts, now)}</div> : null}
          <div className="activity__line">
            <span className="activity__time mono">{clock(l.ts)}</span>
            <span className={`activity__dot activity__dot--${l.tone}`} />
            <span className="activity__text">
              <b>{l.who}</b> {l.text}
            </span>
          </div>
        </li>
      ))}
    </ol>
  );
}
