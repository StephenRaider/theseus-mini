/**
 * Left column, modelled on WhatsApp's chat list:
 *   [avatar]  Name ........................ 10:42
 *             what they're doing / last chat   (●2)(●1)(●3)
 * Badges: red = decisions waiting for you · yellow = trouble being handled
 * (failed items, retries, paused) · green = unread messages.
 */
import { THESEUS_ID } from "@theseus/protocol";
import { useMemo, useState } from "react";
import { badges, listTime, sidebarPreview, sortedEmployees, type Preview } from "../state/selectors.ts";
import type { AppState } from "../state/store.ts";
import { Avatar, CountBadge, Icon } from "./ui.tsx";

type Filter = "all" | "needs" | "working" | "unread";

export function Sidebar(props: {
  state: AppState;
  now: string;
  seen: Record<string, number>;
  selected: string;
  onSelect: (id: string) => void;
  onNewEmployee: () => void;
  onSettings: () => void;
  footer: React.ReactNode;
}) {
  const { state, now, seen, selected } = props;
  const [filter, setFilter] = useState<Filter>("all");
  const [query, setQuery] = useState("");

  const rows = useMemo(() => {
    return sortedEmployees(state, seen).map((id) => {
      const emp = state.employees[id]!;
      const preview = sidebarPreview(state, id, now);
      const b = badges(state, id, seen[id] ?? 0);
      const at = state.lastActivity[id] ?? emp.createdAt;
      return { id, emp, preview, b, at };
    });
  }, [state, now, seen]);

  const counts = {
    needs: rows.filter((r) => r.b.needsYou > 0).length,
    working: rows.filter((r) => r.preview.kind === "working" || r.preview.kind === "waiting").length,
    unread: rows.filter((r) => r.b.unread > 0).length,
  };

  const q = query.trim().toLowerCase();
  const visible = rows.filter((r) => {
    if (filter === "needs" && r.b.needsYou === 0) return false;
    if (filter === "working" && r.preview.kind !== "working" && r.preview.kind !== "waiting") return false;
    if (filter === "unread" && r.b.unread === 0) return false;
    if (!q) return true;
    return r.emp.name.toLowerCase().includes(q) || r.preview.text.toLowerCase().includes(q) || (r.emp.scope ?? "").toLowerCase().includes(q);
  });

  return (
    <aside className="col col--left">
      <header className="colhead">
        <div className="brand">
          <span className="brand__mark">Θ</span>
          <span className="brand__name">Theseus</span>
        </div>
        <div className="colhead__actions">
          <button className="iconbtn" title="New employee" onClick={props.onNewEmployee}>
            <Icon name="plus" />
          </button>
          <button className="iconbtn" title="Settings" onClick={props.onSettings}>
            <Icon name="gear" />
          </button>
        </div>
      </header>

      <div className="search">
        <Icon name="search" size={16} />
        <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search employees or chats" />
      </div>

      <div className="chips" role="tablist">
        <FilterChip on={filter === "all"} onClick={() => setFilter("all")}>
          All
        </FilterChip>
        <FilterChip on={filter === "needs"} onClick={() => setFilter("needs")} dot="red" n={counts.needs}>
          Needs you
        </FilterChip>
        <FilterChip on={filter === "working"} onClick={() => setFilter("working")} n={counts.working}>
          Working
        </FilterChip>
        <FilterChip on={filter === "unread"} onClick={() => setFilter("unread")} dot="green" n={counts.unread}>
          Unread
        </FilterChip>
      </div>

      <ul className="chatlist">
        {visible.map((r) => (
          <li key={r.id}>
            <button className={`chatrow ${selected === r.id ? "chatrow--on" : ""}`} onClick={() => props.onSelect(r.id)}>
              <Avatar id={r.id} name={r.emp.name} status={r.emp.status} />
              <span className="chatrow__main">
                <span className="chatrow__top">
                  <span className="chatrow__name">
                    {r.emp.name}
                    {r.id === THESEUS_ID ? <span className="chatrow__role">manager</span> : null}
                  </span>
                  <span className={`chatrow__time ${r.b.unread ? "chatrow__time--unread" : ""}`}>{listTime(r.at, now)}</span>
                </span>
                <span className="chatrow__bottom">
                  <PreviewLine p={r.preview} />
                  <span className="chatrow__badges">
                    <CountBadge n={r.b.needsYou} tone="red" title={`${r.b.needsYou} decision${r.b.needsYou === 1 ? "" : "s"} waiting for you`} />
                    <CountBadge n={r.b.warnings} tone="yellow" title={`${r.b.warnings} heads-up: failed, retrying or paused`} />
                    <CountBadge n={r.b.unread} tone="green" title={`${r.b.unread} unread message${r.b.unread === 1 ? "" : "s"}`} />
                  </span>
                </span>
              </span>
            </button>
          </li>
        ))}
        {visible.length === 0 ? <li className="chatlist__empty">Nobody here{filter !== "all" ? " for this filter" : ""}.</li> : null}
      </ul>

      {props.footer}
    </aside>
  );
}

function FilterChip(props: { on: boolean; onClick: () => void; children: React.ReactNode; n?: number; dot?: "red" | "green" }) {
  return (
    <button className={`chip ${props.on ? "chip--on" : ""}`} onClick={props.onClick} role="tab" aria-selected={props.on}>
      {props.dot && props.n ? <span className={`chip__dot chip__dot--${props.dot}`} /> : null}
      {props.children}
      {props.n ? <span className="chip__n">{props.n}</span> : null}
    </button>
  );
}

function PreviewLine({ p }: { p: Preview }) {
  switch (p.kind) {
    case "working":
      return (
        <span className="preview preview--working">
          <span className="typing" aria-hidden>
            <i />
            <i />
            <i />
          </span>
          <span className="preview__text">{p.text}</span>
          {p.progress ? <span className="preview__prog">{p.progress}</span> : null}
        </span>
      );
    case "waiting":
      return (
        <span className="preview preview--waiting">
          <span className="preview__label">Needs you</span>
          <span className="preview__text">{p.text}</span>
        </span>
      );
    case "completed":
      return (
        <span className="preview preview--completed">
          <Icon name="dcheck" size={16} />
          <span className="preview__label">Completed</span>
          <span className="preview__text">{p.text}</span>
        </span>
      );
    case "message":
      return (
        <span className="preview">
          {p.prefix === "You: " ? <Icon name="dcheck" size={16} className="preview__tick" /> : null}
          {p.prefix && p.prefix !== "You: " ? <span className="preview__from">{p.prefix}</span> : null}
          {p.hasAttachment ? <Icon name="clip" size={14} className="preview__clip" /> : null}
          <span className="preview__text">{p.text}</span>
        </span>
      );
    default:
      return <span className="preview preview--empty">{p.text}</span>;
  }
}
