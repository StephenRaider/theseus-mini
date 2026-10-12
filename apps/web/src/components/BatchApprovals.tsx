/** Approve (or reject) several look-alike approvals at once. Single approvals keep their own cards in the chat. */
import type { Command } from "@theseus/protocol";
import { useMemo, useState } from "react";
import { pendingApprovals } from "../state/selectors.ts";
import type { AppState } from "../state/store.ts";
import { groupApprovals, toggleAll } from "../state/trust.ts";

export function BatchApprovals({ state, employeeId, send }: { state: AppState; employeeId: string; send: (c: Command) => void }) {
  const groups = useMemo(() => groupApprovals(pendingApprovals(state, employeeId)), [state, employeeId]);
  const [sel, setSel] = useState<ReadonlySet<string>>(new Set());
  if (!groups.length) return null;
  const decide = (ids: string[], decision: "approved" | "rejected") => {
    send({ type: "resolve_approvals", approvalIds: ids, decision });
    setSel((cur) => new Set([...cur].filter((id) => !ids.includes(id))));
  };
  return (
    <div className="batch">
      {groups.map((g) => {
        const ids = g.approvals.map((a) => a.id);
        const chosen = ids.filter((id) => sel.has(id));
        const all = chosen.length === ids.length;
        return (
          <div className="batch__group" key={g.key}>
            <div className="batch__head">
              <b>{g.label}</b>
              <span className="batch__count">{ids.length} waiting</span>
              {g.tool ? <span className="mono batch__tool">{g.tool}</span> : null}
              <button className="btn btn--small" onClick={() => setSel(toggleAll(sel, ids))}>
                {all ? "Clear" : "Select all in group"}
              </button>
            </div>
            <ul className="batch__list">
              {g.approvals.map((a) => (
                <li key={a.id}>
                  <label>
                    <input type="checkbox" checked={sel.has(a.id)} onChange={() => setSel(toggleAll(sel, [a.id]))} />
                    <span>{a.title}</span>
                  </label>
                </li>
              ))}
            </ul>
            <div className="batch__actions">
              <button className="btn btn--primary btn--small" disabled={!chosen.length} onClick={() => decide(chosen, "approved")}>
                Approve {chosen.length}
              </button>
              <button className="btn btn--small" disabled={!chosen.length} onClick={() => decide(chosen, "rejected")}>
                Reject {chosen.length}
              </button>
            </div>
          </div>
        );
      })}
    </div>
  );
}
