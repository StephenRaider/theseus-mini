/**
 * Right column: the work. Every task has a plan; the plan is drawn as a grid
 * of boxes (rows = items, columns = playbook steps) whose colour is the cell
 * state (G2). Click a row to see notes and act on it: skip, retry, hold,
 * release, move to top, or nudge (G3, G4).
 */
import { THESEUS_ID, itemStatus, summarize, type CellState, type Command, type Plan, type Task } from "@theseus/protocol";
import { memo, useCallback, useMemo, useState } from "react";
import { clock, progress, taskTitle } from "../state/selectors.ts";
import type { AppState } from "../state/store.ts";
import { Activity } from "./Activity.tsx";
import { bridge } from "../bridge.ts";
import { Files } from "./Files.tsx";
import { Screen } from "./Screen.tsx";
import { Avatar, Icon, Tag } from "./ui.tsx";

type Tab = "plan" | "screen" | "files" | "activity";

export function Work(props: {
  state: AppState;
  now: string;
  employeeId: string;
  send: (c: Command) => void;
  onNudgeItem: (employeeId: string, label: string) => void;
  onSelectEmployee: (id: string) => void;
  freshFiles: Set<string>;
}) {
  const [tab, setTab] = useState<Tab>("plan");
  const { state, employeeId } = props;

  const task = useMemo(() => {
    const emp = state.employees[employeeId];
    if (emp?.currentTaskId) return state.tasks[emp.currentTaskId];
    const ids = state.tasksByEmployee[employeeId] ?? [];
    for (let i = ids.length - 1; i >= 0; i--) if (state.plans[ids[i]!]) return state.tasks[ids[i]!];
    return undefined;
  }, [state, employeeId]);

  return (
    <section className="col col--right">
      <header className="colhead">
        <div className="tabs" role="tablist">
          {(["plan", ...(bridge()?.agent && employeeId !== THESEUS_ID ? ["screen"] : []), "files", "activity"] as Tab[]).map((t) => (
            <button key={t} role="tab" aria-selected={tab === t} className={`tab ${tab === t ? "tab--on" : ""}`} onClick={() => setTab(t)}>
              {t === "plan" ? (employeeId === THESEUS_ID ? "Overview" : "Plan") : t === "screen" ? "Screen" : t === "files" ? "Files" : "Activity"}
              {t === "files" && props.freshFiles.size ? <span className="tab__dot" /> : null}
            </button>
          ))}
        </div>
      </header>
      <div className="work">
        {tab === "plan" ? (
          employeeId === THESEUS_ID ? (
            <Overview state={state} onSelect={props.onSelectEmployee} />
          ) : task && state.plans[task.id] ? (
            <PlanView state={state} task={task} plan={state.plans[task.id]!} send={props.send} onNudgeItem={(label) => props.onNudgeItem(employeeId, label)} />
          ) : (
            <Empty title="No plan yet" text="When this employee gets a task, its plan appears here as a grid you can steer." />
          )
        ) : tab === "screen" && employeeId !== THESEUS_ID ? (
          <Screen employeeId={employeeId} />
        ) : tab === "files" ? (
          <Files fresh={props.freshFiles} />
        ) : (
          <Activity state={state} employeeId={employeeId} now={props.now} />
        )}
      </div>
    </section>
  );
}

export function Empty({ title, text }: { title: string; text: string }) {
  return (
    <div className="empty">
      <b>{title}</b>
      <span>{text}</span>
    </div>
  );
}

/* ------------------------------------------------------------------ overview (Theseus) */

function Overview({ state, onSelect }: { state: AppState; onSelect: (id: string) => void }) {
  const tasks = Object.values(state.tasks).filter((t) => state.plans[t.id]).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  if (!tasks.length) return <Empty title="Nothing running" text="Ask Theseus for something. It splits the work, hands it to employees, and every task shows up here." />;
  return (
    <div className="overview">
      <div className="section-title">All work</div>
      {tasks.map((t) => {
        const plan = state.plans[t.id]!;
        const s = summarize(plan);
        const p = progress(plan);
        const emp = state.employees[t.employeeId]!;
        return (
          <button className="taskcard" key={t.id} onClick={() => onSelect(emp.id)}>
            <div className="taskcard__top">
              <Avatar id={emp.id} name={emp.name} size={28} />
              <span className="taskcard__who">{emp.name}</span>
              <StatusTag status={t.status} />
            </div>
            <div className="taskcard__title">{taskTitle(t)}</div>
            <div className="progress">
              <div className="progress__fill" style={{ width: `${p.total ? (100 * p.done) / p.total : 0}%` }} />
            </div>
            <MiniGrid plan={plan} />
            <div className="taskcard__counts">
              {s.done ? <Tag tone="green">{s.done} done</Tag> : null}
              {s.needs_you ? <Tag tone="red">{s.needs_you} need you</Tag> : null}
              {s.held ? <Tag tone="held">{s.held} held</Tag> : null}
              {s.failed ? <Tag tone="yellow">{s.failed} failed</Tag> : null}
              <span className="taskcard__of">
                {p.done}/{p.total}
              </span>
            </div>
          </button>
        );
      })}
    </div>
  );
}

/** One square per item, coloured by item status: the whole task at a glance. */
function MiniGrid({ plan }: { plan: Plan }) {
  return (
    <div className="minigrid">
      {plan.items.map((it) => (
        <span key={it.id} className={`mini mini--${itemStatus(plan, it.id)}`} title={it.label} />
      ))}
    </div>
  );
}

const STATUS_TONE: Record<Task["status"], "accent" | "red" | "green" | "yellow" | "neutral"> = {
  understanding: "accent",
  planning: "accent",
  running: "accent",
  waiting_on_user: "red",
  verifying: "accent",
  done: "green",
  failed: "yellow",
  cancelled: "neutral",
};
const STATUS_LABEL: Record<Task["status"], string> = {
  understanding: "Understanding",
  planning: "Planning",
  running: "Running",
  waiting_on_user: "Needs you",
  verifying: "Verifying",
  done: "Done",
  failed: "Failed",
  cancelled: "Cancelled",
};

function StatusTag({ status }: { status: Task["status"] }) {
  return <Tag tone={STATUS_TONE[status]}>{STATUS_LABEL[status]}</Tag>;
}

/* ------------------------------------------------------------------ plan grid */

const CELL_GLYPH: Partial<Record<CellState, string>> = { done: "✓", failed: "✕", needs_you: "!", skipped: "–", retrying: "↻" };
const CELL_LABEL: Record<CellState, string> = {
  pending: "Pending",
  running: "Running",
  retrying: "Retrying",
  done: "Done",
  failed: "Failed",
  skipped: "Skipped",
  needs_you: "Needs you",
};

type RowFilter = "all" | "needs_you" | "held" | "failed" | "running";

function PlanView({ state, task, plan, send, onNudgeItem }: { state: AppState; task: Task; plan: Plan; send: (c: Command) => void; onNudgeItem: (label: string) => void }) {
  const [selected, setSelected] = useState<string | null>(null);
  const [filter, setFilter] = useState<RowFilter>("all");
  const toggle = useCallback((id: string) => setSelected((cur) => (cur === id ? null : id)), []);
  const s = summarize(plan);
  const p = progress(plan);
  const emp = state.employees[task.employeeId];
  const paused = emp?.status === "paused";
  const open = task.status !== "done" && task.status !== "cancelled";

  const rows = plan.items.filter((it) => {
    if (filter === "all") return true;
    const st = itemStatus(plan, it.id);
    return filter === "running" ? st === "running" : st === filter;
  });

  const sel = selected ? plan.items.find((i) => i.id === selected) : undefined;

  return (
    <div className="planview">
      <div className="planhead">
        <div className="planhead__row">
          <div className="planhead__title">{taskTitle(task)}</div>
          <StatusTag status={task.status} />
        </div>
        <div className="planhead__meta">
          <span className="mono">{task.playbookId}</span>
          <span>·</span>
          <span>started {clock(task.createdAt)}</span>
          {open ? (
            <button className="btn btn--small" onClick={() => send({ type: "task_control", taskId: task.id, action: paused ? "resume" : "pause" })}>
              <Icon name={paused ? "play" : "pause"} size={14} /> {paused ? "Resume" : "Pause"}
            </button>
          ) : null}
        </div>
        <div className="progress">
          <div className="progress__fill" style={{ width: `${p.total ? (100 * p.done) / p.total : 0}%` }} />
        </div>
        <div className="planhead__counts">
          <span className="progress__text">
            {p.done}/{p.total} items
          </span>
          <CountFilter on={filter === "all"} onClick={() => setFilter("all")} label="All" />
          <CountFilter on={filter === "needs_you"} onClick={() => setFilter("needs_you")} label="Need you" n={s.needs_you} tone="red" />
          <CountFilter on={filter === "running"} onClick={() => setFilter("running")} label="Running" n={s.running} tone="accent" />
          <CountFilter on={filter === "held"} onClick={() => setFilter("held")} label="Held" n={s.held} tone="held" />
          <CountFilter on={filter === "failed"} onClick={() => setFilter("failed")} label="Failed" n={s.failed} tone="yellow" />
        </div>
      </div>

      <div className="grid" style={{ ["--steps" as string]: plan.steps.length }}>
        <div className="grid__head">
          <span className="grid__label" />
          {plan.steps.map((st) => (
            <span key={st.id} className="grid__step" title={st.title}>
              {st.title}
            </span>
          ))}
        </div>
        <div className="grid__body">
          {rows.map((it) => (
            <Row key={it.id} plan={plan} itemId={it.id} selected={selected === it.id} onToggle={toggle} />
          ))}
          {rows.length === 0 ? <div className="grid__empty">No items match this filter.</div> : null}
        </div>
      </div>

      <Legend />

      {sel ? (
        <ItemDetail
          plan={plan}
          itemId={sel.id}
          onClose={() => setSelected(null)}
          act={(action) => send({ type: "cell_action", taskId: task.id, itemId: sel.id, action })}
          toTop={() => send({ type: "reorder_items", taskId: task.id, itemIds: [sel.id, ...plan.items.map((i) => i.id).filter((i) => i !== sel.id)] })}
          nudge={() => onNudgeItem(sel.label)}
        />
      ) : null}
    </div>
  );
}

function CountFilter({ on, onClick, label, n, tone }: { on: boolean; onClick: () => void; label: string; n?: number; tone?: string }) {
  if (n === 0) return null;
  return (
    <button className={`countf ${on ? "countf--on" : ""} ${tone ? `countf--${tone}` : ""}`} onClick={onClick}>
      {label}
      {n !== undefined ? <b>{n}</b> : null}
    </button>
  );
}

/** A row's visible content as a string; rows re-render only when it changes. */
function rowSig(plan: Plan, itemId: string): string {
  const it = plan.items.find((i) => i.id === itemId);
  const cells = plan.cells[itemId] ?? {};
  return `${it?.held}|${it?.label}|${plan.steps.map((st) => `${cells[st.id]?.state}:${cells[st.id]?.note ?? ""}`).join(",")}`;
}

const Row = memo(
  function Row({ plan, itemId, selected, onToggle }: { plan: Plan; itemId: string; selected: boolean; onToggle: (id: string) => void }) {
    const it = plan.items.find((i) => i.id === itemId)!;
    const st = itemStatus(plan, itemId);
    const [id, ...rest] = it.label.split(" · ");
    return (
      <button className={`grid__row grid__row--${st} ${selected ? "grid__row--on" : ""}`} onClick={() => onToggle(itemId)} title={it.held ? `Held: ${it.holdReason}` : it.label}>
        <span className="grid__label">
          <span className="grid__id mono">{rest.length ? id : ""}</span>
          <span className="grid__name">{rest.length ? rest.join(" · ") : it.label}</span>
          {it.held ? <span className="grid__held">HELD</span> : null}
        </span>
        {plan.steps.map((step) => {
          const c = plan.cells[itemId]![step.id]!;
          return (
            <span key={step.id} className={`cell cell--${c.state}`} title={`${step.title}: ${CELL_LABEL[c.state]}${c.note ? `\n${c.note}` : ""}`}>
              {CELL_GLYPH[c.state] ?? ""}
            </span>
          );
        })}
      </button>
    );
  },
  (a, b) => a.selected === b.selected && rowSig(a.plan, a.itemId) === rowSig(b.plan, b.itemId),
);

function Legend() {
  const states: CellState[] = ["pending", "running", "retrying", "done", "needs_you", "failed", "skipped"];
  return (
    <div className="legend">
      {states.map((s) => (
        <span key={s} className="legend__item">
          <span className={`cell cell--${s} cell--legend`}>{CELL_GLYPH[s] ?? ""}</span>
          {CELL_LABEL[s]}
        </span>
      ))}
      <span className="legend__item">
        <span className="legend__held" />
        Held
      </span>
    </div>
  );
}

function ItemDetail(props: { plan: Plan; itemId: string; onClose: () => void; act: (a: "skip" | "retry" | "hold" | "release") => void; toTop: () => void; nudge: () => void }) {
  const { plan, itemId } = props;
  const it = plan.items.find((i) => i.id === itemId)!;
  const st = itemStatus(plan, itemId);
  const finished = st === "done" || st === "skipped";
  return (
    <div className="detail">
      <div className="detail__head">
        <div>
          <div className="detail__title">{it.label}</div>
          {it.ref ? <div className="detail__ref mono">{it.ref}</div> : null}
        </div>
        <button className="iconbtn" onClick={props.onClose} title="Close">
          <Icon name="x" size={16} />
        </button>
      </div>
      {it.held ? <div className="detail__banner detail__banner--held">Held · {it.holdReason}</div> : null}
      {it.skipReason ? <div className="detail__banner">Skipped · {it.skipReason}</div> : null}
      <ol className="detail__steps">
        {plan.steps.map((step) => {
          const c = plan.cells[itemId]![step.id]!;
          return (
            <li key={step.id}>
              <span className={`cell cell--${c.state} cell--legend`}>{CELL_GLYPH[c.state] ?? ""}</span>
              <span className="detail__step">{step.title}</span>
              <span className="detail__note">
                {c.note ?? CELL_LABEL[c.state]}
                {c.attempts > 1 ? ` · ${c.attempts} attempts` : ""}
              </span>
              <span className="detail__at">{c.updatedAt ? clock(c.updatedAt) : ""}</span>
            </li>
          );
        })}
      </ol>
      <div className="detail__actions">
        {it.held ? (
          <button className="btn btn--small" onClick={() => props.act("release")}>
            <Icon name="play" size={14} /> Release
          </button>
        ) : (
          <button className="btn btn--small" onClick={() => props.act("hold")} disabled={finished}>
            <Icon name="hold" size={14} /> Hold
          </button>
        )}
        <button className="btn btn--small" onClick={() => props.act("skip")} disabled={finished}>
          <Icon name="skip" size={14} /> Skip
        </button>
        <button className="btn btn--small" onClick={() => props.act("retry")} disabled={st === "done" || st === "pending" || st === "running"}>
          <Icon name="retry" size={14} /> Retry
        </button>
        <button className="btn btn--small" onClick={props.toTop} disabled={finished}>
          <Icon name="top" size={14} /> Move to top
        </button>
        <button className="btn btn--small btn--accent" onClick={props.nudge}>
          <Icon name="chat" size={14} /> Nudge about this
        </button>
      </div>
    </div>
  );
}
