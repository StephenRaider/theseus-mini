/** What an employee remembers between tasks: visible, removable, and you can add a note. */
import type { Command } from "@theseus/protocol";
import { useMemo, useState } from "react";
import { clock } from "../state/selectors.ts";
import type { AppState } from "../state/store.ts";
import { memoriesOf } from "../state/trust.ts";
import { Icon } from "./ui.tsx";

export function Memory({ state, employeeId, send }: { state: AppState; employeeId: string; send: (c: Command) => void }) {
  const items = useMemo(() => memoriesOf(state, employeeId), [state, employeeId]);
  const [note, setNote] = useState("");
  const add = () => {
    const text = note.trim();
    if (!text) return;
    send({ type: "add_memory", employeeId, text });
    setNote("");
  };
  return (
    <div className="memory">
      <div className="section-title">What I remember</div>
      {items.length ? (
        <ul className="memory__list">
          {items.map((m) => (
            <li key={m.id} className="memory__item">
              <span className="memory__text">{m.text}</span>
              <span className="memory__time">{clock(m.at)}</span>
              <button className="btn btn--small" onClick={() => send({ type: "forget_memory", memoryId: m.id })} title="Forget this">
                Forget
              </button>
            </li>
          ))}
        </ul>
      ) : (
        <div className="working__none">Nothing yet. Notes you add, and things I learn from your corrections, appear here.</div>
      )}
      <div className="memory__add">
        <input
          value={note}
          placeholder="Add a note"
          aria-label="Add a note"
          onChange={(e) => setNote(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") add();
          }}
        />
        <button className="iconbtn" title="Add note" onClick={add} disabled={!note.trim()}>
          <Icon name="plus" />
        </button>
      </div>
    </div>
  );
}
