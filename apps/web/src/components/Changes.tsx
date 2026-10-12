/**
 * Changes made (with Undo) and the rehearsal Preview panel. Everything shown
 * is derived from effect.* and rehearsal.* events.
 */
import type { Command, Task } from "@theseus/protocol";
import { useMemo } from "react";
import { clock } from "../state/selectors.ts";
import type { AppState } from "../state/store.ts";
import { canUndo, effectsOfTask, groupPreviews, isUndone, undoableCount } from "../state/trust.ts";
import { Tag } from "./ui.tsx";
import { Empty } from "./Work.tsx";

export function Changes({ state, task, send }: { state: AppState; task: Task; send: (c: Command) => void }) {
  const effects = useMemo(() => effectsOfTask(state, task.id), [state, task.id]);
  const left = undoableCount(effects);
  const outcome = state.rehearsals[task.id];
  const hasPreview = (state.previews[task.id] ?? []).length > 0;
  if (!effects.length && !outcome && !hasPreview && task.rehearsal !== "preview") return <Empty title="No changes made" text="Anything this employee changes in your files or systems is listed here, with a way to take it back when that is possible." />;
  return (
    <div className="changes">
      <PreviewPanel state={state} task={task} send={send} />
      {effects.length ? (
        <>
          <div className="changes__head">
            <div className="section-title">Changes made</div>
            <button className="btn btn--small" disabled={left === 0} onClick={() => send({ type: "undo_task", taskId: task.id })} title={left ? `${left} change${left === 1 ? "" : "s"} can be taken back` : "Nothing left that can be undone"}>
              Undo everything this task did
            </button>
          </div>
          <ul className="effects">
            {effects.map((f) => (
              <li key={f.id} className={`effect ${isUndone(f) ? "effect--undone" : ""}`}>
                <div className="effect__main">
                  <span className="effect__summary">{f.summary}</span>
                  <span className="effect__time">{clock(f.at)}</span>
                </div>
                <div className="effect__side">
                  {isUndone(f) ? <Tag tone="green">undone</Tag> : null}
                  {f.undone && !f.undone.ok ? <Tag tone="red">undo failed</Tag> : null}
                  {canUndo(f) ? (
                    <button className="btn btn--small" onClick={() => send({ type: "undo_effect", effectId: f.id })}>
                      Undo
                    </button>
                  ) : !f.undo ? (
                    <span className="effect__no">cannot be undone</span>
                  ) : null}
                </div>
                {f.undone ? <div className={`effect__detail ${f.undone.ok ? "" : "effect__detail--bad"}`}>{f.undone.detail}</div> : null}
              </li>
            ))}
          </ul>
        </>
      ) : null}
    </div>
  );
}

/** Rehearsal: what would change, grouped by tool, with Apply / Discard. After the decision, the outcome. */
export function PreviewPanel({ state, task, send }: { state: AppState; task: Task; send: (c: Command) => void }) {
  const rows = state.previews[task.id] ?? [];
  const groups = useMemo(() => groupPreviews(rows), [rows]);
  const outcome = state.rehearsals[task.id];

  if (outcome)
    return (
      <div className={`preview preview--${outcome.decision}`}>
        <b>{outcome.decision === "applied" ? "Rehearsal applied" : "Rehearsal discarded"}</b>
        <span>
          {outcome.decision === "applied" ? `${outcome.applied} change${outcome.applied === 1 ? "" : "s"} made${outcome.failed ? `, ${outcome.failed} failed` : ""}.` : "Nothing was changed."} {clock(outcome.at)}
        </span>
      </div>
    );
  if (task.rehearsal !== "preview") return null;
  return (
    <div className="preview" role="region" aria-label="Preview of changes">
      <div className="preview__head">
        <div>
          <b>Preview</b>
          <span className="preview__sub"> Nothing has been changed yet{rows.length ? `: ${rows.length} change${rows.length === 1 ? "" : "s"} would be made` : ""}.</span>
        </div>
        <div className="preview__actions">
          <button className="btn btn--primary btn--small" disabled={!rows.length} onClick={() => send({ type: "resolve_rehearsal", taskId: task.id, decision: "apply" })}>
            Apply
          </button>
          <button className="btn btn--small" onClick={() => send({ type: "resolve_rehearsal", taskId: task.id, decision: "discard" })}>
            Discard
          </button>
        </div>
      </div>
      {groups.length ? (
        groups.map((g) => (
          <details key={g.tool} className="preview__group" open={groups.length === 1}>
            <summary>{g.headline}</summary>
            <ul>
              {g.rows.map((r) => (
                <li key={r.id}>{r.summary}</li>
              ))}
            </ul>
          </details>
        ))
      ) : (
        <div className="working__none">Nothing to preview yet. Rows appear as the employee works through the rehearsal.</div>
      )}
    </div>
  );
}
