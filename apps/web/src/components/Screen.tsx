/**
 * Screen tab: what the employee's browser shows right now (computer use).
 * Updated after every browser action, so you can watch it work a web app
 * and step in from the chat. Read-only by design: you steer with messages
 * and approvals, never by grabbing the mouse from the agent.
 */
import { useFrame } from "../state/frames.ts";
import { Empty } from "./Work.tsx";

export function Screen({ employeeId, action }: { employeeId: string; action?: string | undefined }) {
  const frame = useFrame(employeeId);
  if (!frame)
    return <Empty title="No browser yet" text="When this employee opens one of the company's web apps (like FinDesk), its screen shows up here, live, after every click." />;
  return (
    <div className="screen">
      <div className="screen__bar">
        <span className="screen__dot" aria-hidden="true" />
        <span className="screen__url mono" title={frame.url}>
          {frame.url}
        </span>
        <span className="screen__time">{new Date(frame.ts).toLocaleTimeString()}</span>
      </div>
      {action ? (
        <div className="screen__action" role="status">
          <span className="screen__pulse" aria-hidden="true" />
          {action}
        </div>
      ) : null}
      <img className="screen__img" src={`data:image/jpeg;base64,${frame.jpeg}`} alt={`${frame.title}: what the employee's browser shows`} />
    </div>
  );
}

/** A small live view above the plan: the browser is visible without leaving the plan. Click to enlarge. */
export function LiveStrip({ employeeId, action, live, onOpen }: { employeeId: string; action?: string | undefined; live: boolean; onOpen: () => void }) {
  const frame = useFrame(employeeId);
  if (!frame) return null;
  return (
    <button type="button" className="livestrip" onClick={onOpen} title="Open the full browser view">
      <img className="livestrip__img" src={`data:image/jpeg;base64,${frame.jpeg}`} alt="" />
      <span className="livestrip__text">
        <span className="livestrip__state">{live ? "Browsing now" : "Last browser view"}</span>
        <span className="livestrip__action">{action ?? frame.title}</span>
        <span className="livestrip__url mono">{frame.url}</span>
      </span>
    </button>
  );
}
