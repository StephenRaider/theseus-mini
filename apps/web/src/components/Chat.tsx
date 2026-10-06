/**
 * Middle column: one conversation per employee. Messaging feel (G1): day
 * separators, a time on every bubble, approval cards inline at the moment
 * they were raised. A message to a working employee is a nudge (G3).
 */
import { THESEUS_ID, type Approval, type Attachment, type Command, type Message } from "@theseus/protocol";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { attachmentRef, bridge, mimeOf } from "../bridge.ts";
import { clock, currentTask, dayLabel, progress, sameDay, taskTitle } from "../state/selectors.ts";
import type { AppState } from "../state/store.ts";
import { Avatar, FileCard, Icon, Tag, alertish } from "./ui.tsx";

type Entry = { kind: "msg"; ts: string; m: Message; nudge?: boolean } | { kind: "approval"; ts: string; a: Approval };

export function Chat(props: {
  state: AppState;
  now: string;
  threadId: string;
  send: (c: Command) => void;
  suggestion?: string;
  draft: string;
  setDraft: (s: string) => void;
}) {
  const { state, now, threadId, send } = props;
  const emp = state.employees[threadId];
  const [pending, setPending] = useState<Attachment[]>([]);
  const [dragging, setDragging] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const scroller = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLTextAreaElement>(null);
  const b = bridge();

  const entries = useMemo<Entry[]>(() => {
    const msgs = state.messages[threadId] ?? [];
    const nudgeKeys = new Set(Object.values(state.nudges).filter((n) => n.employeeId === threadId).map((n) => n.text));
    const out: Entry[] = msgs.map((m) => ({ kind: "msg", ts: m.ts, m, nudge: m.from === "user" && nudgeKeys.has(m.text) }));
    for (const e of state.log) {
      if (e.type !== "approval.requested") continue;
      if (state.tasks[e.payload.taskId]?.employeeId !== threadId) continue;
      out.push({ kind: "approval", ts: e.ts, a: state.approvals[e.payload.id]! });
    }
    return out.sort((x, y) => x.ts.localeCompare(y.ts));
  }, [state, threadId]);

  // Stick to the bottom like a messenger, unless the user scrolled up.
  const atBottom = useRef(true);
  useLayoutEffect(() => {
    const el = scroller.current;
    if (el && atBottom.current) el.scrollTop = el.scrollHeight;
  }, [entries.length, threadId]);
  useEffect(() => {
    atBottom.current = true;
    setPending([]);
    input.current?.focus();
  }, [threadId]);

  if (!emp) return <main className="col col--mid" />;

  const task = currentTask(state, threadId);
  const working = emp.status === "working" || emp.status === "waiting_on_user" || emp.status === "paused";
  const p = progress(task ? state.plans[task.id] : undefined);
  const subtitle =
    threadId === THESEUS_ID
      ? `Manager · ${state.employeeOrder.length - 1} employee${state.employeeOrder.length === 2 ? "" : "s"}`
      : working && task
        ? `${emp.status === "waiting_on_user" ? "waiting for you" : emp.status === "paused" ? "paused" : "working"} · ${taskTitle(task)}${p.total ? ` · ${p.done}/${p.total}` : ""}`
        : (emp.scope ?? "idle");

  const doSend = (text: string) => {
    const t = text.trim();
    if (!t && pending.length === 0) return;
    send({ type: "send_message", threadId, text: t || "(attachment)", attachments: pending });
    props.setDraft("");
    setPending([]);
    atBottom.current = true;
  };

  const addFiles = (list: { rootId: string; rel: string; name: string }[]) =>
    setPending((cur) => [...cur, ...list.map((f) => ({ name: f.name, mime: mimeOf(f.name), ref: attachmentRef(f.rootId, f.rel) }))]);

  const pick = async () => {
    if (!b) return alertish("Attaching files works in the desktop app");
    try {
      addFiles(await b.pickAttachments());
    } catch (e) {
      alertish(e);
    }
  };

  const onDrop = async (e: React.DragEvent) => {
    e.preventDefault();
    setDragging(false);
    if (!b) return alertish("Dropping files works in the desktop app");
    try {
      addFiles(await b.importDropped([...e.dataTransfer.files]));
    } catch (err) {
      alertish(err);
    }
  };

  return (
    <main
      className="col col--mid"
      onDragOver={(e) => {
        if (e.dataTransfer.types.includes("Files")) {
          e.preventDefault();
          setDragging(true);
        }
      }}
      onDragLeave={(e) => {
        if (e.currentTarget === e.target) setDragging(false);
      }}
      onDrop={onDrop}
    >
      <header className="colhead chathead">
        <Avatar id={emp.id} name={emp.name} size={38} status={emp.status} />
        <div className="chathead__text">
          {renaming ? (
            <input
              className="rename"
              autoFocus
              defaultValue={emp.name}
              onBlur={(e) => {
                const v = e.target.value.trim();
                if (v && v !== emp.name) send({ type: "rename_employee", employeeId: emp.id, name: v });
                setRenaming(false);
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter") (e.target as HTMLInputElement).blur();
                if (e.key === "Escape") setRenaming(false);
              }}
            />
          ) : (
            <button className="chathead__name" onClick={() => setRenaming(true)} title="Rename">
              {emp.name}
              <Icon name="edit" size={14} />
            </button>
          )}
          <span className={`chathead__sub ${emp.status === "waiting_on_user" ? "chathead__sub--waiting" : working ? "chathead__sub--working" : ""}`}>{subtitle}</span>
        </div>
      </header>

      <div
        className="messages"
        ref={scroller}
        onScroll={(e) => {
          const el = e.currentTarget;
          atBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
        }}
      >
        <div className="messages__inner">
          {entries.map((en, i) => {
            const prev = entries[i - 1];
            const sep = !prev || !sameDay(prev.ts, en.ts) ? <div className="daysep" key={`d${i}`}><span>{dayLabel(en.ts, now)}</span></div> : null;
            return (
              <div key={en.kind === "msg" ? en.m.id : en.a.id}>
                {sep}
                {en.kind === "msg" ? (
                  <Bubble m={en.m} threadId={threadId} nudge={en.nudge} grouped={!sep && prev?.kind === "msg" && prev.m.from === en.m.from} />
                ) : (
                  <ApprovalCard a={en.a} ts={en.ts} state={state} send={send} />
                )}
              </div>
            );
          })}
        </div>
      </div>

      <footer className="composer">
        {props.suggestion ? (
          <button className="suggestion" onClick={() => doSend(props.suggestion!)}>
            <Icon name="play" size={14} />
            <span>
              <b>Try the demo:</b> {props.suggestion}
            </span>
          </button>
        ) : null}
        {working && threadId !== THESEUS_ID ? (
          <div className="composer__hint">
            <Icon name="bolt" size={14} />
            <span>
              {emp.name} is working, so your message is a <b>nudge</b>: it's picked up at the next step. For example “Hold everything to Shree Ganesh” or “Skip bidder B”.
            </span>
          </div>
        ) : null}
        {pending.length ? (
          <div className="composer__files">
            {pending.map((a, i) => (
              <span className="pendingfile" key={a.ref}>
                {a.name}
                <button className="iconbtn iconbtn--tiny" onClick={() => setPending((cur) => cur.filter((_, j) => j !== i))} title="Remove">
                  <Icon name="x" size={12} />
                </button>
              </span>
            ))}
          </div>
        ) : null}
        <div className="composer__row">
          <button className="iconbtn" title={b ? "Attach files" : "Attach files (desktop app)"} onClick={pick}>
            <Icon name="clip" />
          </button>
          <textarea
            ref={input}
            rows={1}
            value={props.draft}
            placeholder={threadId === THESEUS_ID ? "Message Theseus" : `Message ${emp.name}`}
            onChange={(e) => props.setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                doSend(props.draft);
              }
            }}
          />
          <button className="sendbtn" title="Send" onClick={() => doSend(props.draft)} disabled={!props.draft.trim() && !pending.length}>
            <Icon name="send" />
          </button>
        </div>
      </footer>

      {dragging ? (
        <div className="dropzone">
          <div>
            <Icon name="clip" size={28} />
            <b>Drop to attach</b>
            <span>Files are copied into the workspace's Attachments folder</span>
          </div>
        </div>
      ) : null}
    </main>
  );
}

function Bubble({ m, threadId, nudge, grouped }: { m: Message; threadId: string; nudge?: boolean; grouped: boolean }) {
  const mine = m.from === "user";
  const fromTheseus = m.from === "theseus" && threadId !== THESEUS_ID;
  return (
    <div className={`bubble-row ${mine ? "bubble-row--me" : ""} ${grouped ? "bubble-row--grouped" : ""}`}>
      <div className={`bubble ${mine ? "bubble--me" : ""} ${fromTheseus ? "bubble--theseus" : ""}`}>
        {fromTheseus ? <span className="bubble__from">Theseus · assigned a task</span> : null}
        {nudge ? <Tag tone="accent">Nudge</Tag> : null}
        {m.text && m.text !== "(attachment)" ? <div className="bubble__text">{m.text}</div> : null}
        {m.attachments.length ? (
          <div className="bubble__files">
            {m.attachments.map((a) => (
              <FileCard key={a.ref} att={a} />
            ))}
          </div>
        ) : null}
        <span className="bubble__meta">
          {clock(m.ts)}
          {mine ? <Icon name="dcheck" size={15} className="bubble__tick" /> : null}
        </span>
      </div>
    </div>
  );
}

function ApprovalCard({ a, ts, state, send }: { a: Approval; ts: string; state: AppState; send: (c: Command) => void }) {
  const plan = state.plans[a.taskId];
  const item = plan?.items.find((i) => i.id === a.itemId);
  const resolved = a.status !== "pending";
  return (
    <div className={`approval approval--${a.status}`}>
      <div className="approval__head">
        <span className="approval__dot" />
        <span className="approval__kicker">{resolved ? "Decided" : a.humanTask ? "Needs you to act" : "Needs your approval"}</span>
        {item ? <span className="approval__item">{item.label}</span> : null}
        <span className="approval__time">{clock(ts)}</span>
      </div>
      <div className="approval__title">{a.title}</div>
      <div className="approval__reason">{a.reason}</div>
      {a.humanTask ? (
        <div className="approval__task">
          <b>You need to:</b> {a.humanTask}
        </div>
      ) : null}
      {a.diff.length ? (
        <table className="approval__diff">
          <tbody>
            {a.diff.map((d) => (
              <tr key={d.field}>
                <td>{d.field}</td>
                <td className="mono strike">{String(d.before)}</td>
                <td>→</td>
                <td className="mono">{String(d.after)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : null}
      {a.toolCall ? <div className="approval__tool mono">runs: {a.toolCall.tool}</div> : null}
      {resolved ? (
        <div className={`approval__resolved approval__resolved--${a.status}`}>
          <Icon name={a.status === "approved" ? "check" : "x"} size={14} />
          {a.status === "approved" ? "Approved" : "Rejected"} by {a.decidedBy === "user" ? "you" : a.decidedBy}
          {a.comment ? ` · ${a.comment}` : ""}
        </div>
      ) : (
        <div className="approval__actions">
          <button className="btn btn--primary" onClick={() => send({ type: "resolve_approval", approvalId: a.id, decision: "approved" })}>
            {a.humanTask ? "Done, it checks out" : "Approve"}
          </button>
          <button className="btn" onClick={() => send({ type: "resolve_approval", approvalId: a.id, decision: "rejected" })}>
            {a.humanTask ? "It doesn't check out" : "Reject"}
          </button>
        </div>
      )}
    </div>
  );
}
