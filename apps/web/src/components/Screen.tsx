/**
 * Screen tab: what the employee's browser shows right now (computer use).
 * Updated after every browser action, so you can watch it work a web app
 * and step in from the chat. Read-only by design: you steer with messages
 * and approvals, never by grabbing the mouse from the agent.
 */
import { useFrame } from "../state/frames.ts";
import { Empty } from "./Work.tsx";

export function Screen({ employeeId }: { employeeId: string }) {
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
      <img className="screen__img" src={`data:image/jpeg;base64,${frame.jpeg}`} alt={`${frame.title}: what the employee's browser shows`} />
    </div>
  );
}
