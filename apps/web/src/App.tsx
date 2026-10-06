import { GREEK_NAMES, THESEUS_ID, nextEmployeeName, type Command, type EmployeeNaming } from "@theseus/protocol";
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { bridge } from "./bridge.ts";
import { Chat } from "./components/Chat.tsx";
import { Sidebar } from "./components/Sidebar.tsx";
import { Icon } from "./components/ui.tsx";
import { Work } from "./components/Work.tsx";
import { LiveEngine } from "./live/engine.ts";
import { ReplayEngine } from "./replay/engine.ts";
import { kaveriDemo } from "./replay/kaveri-demo.ts";
import { badges, clock } from "./state/selectors.ts";

/** 1 real second = 12 simulated seconds at 1×. */
const SIM_RATE = 12;
const TICK_MS = 100;
const SPEEDS = [1, 3, 10];

const store = {
  get<T>(key: string, fallback: T): T {
    try {
      const v = localStorage.getItem(`theseus.${key}`);
      return v == null ? fallback : (JSON.parse(v) as T);
    } catch {
      return fallback;
    }
  },
  set(key: string, v: unknown) {
    try {
      localStorage.setItem(`theseus.${key}`, JSON.stringify(v));
    } catch {
      /* private mode etc. */
    }
  },
};

type Engine = LiveEngine | ReplayEngine;

/** Desktop app → the real employees (live or demo model). Plain browser → the scripted replay. */
function makeEngine(): Engine {
  const b = bridge();
  if (b?.agent) return new LiveEngine(b.agent);
  return new ReplayEngine(kaveriDemo(), b ? { writeNew: (root, rel, text) => b.writeNew(root, rel, text) } : undefined);
}

export function App() {
  const [engine, setEngine] = useState(makeEngine);
  const snap = useSyncExternalStore(
    useCallback((fn) => engine.subscribe(fn), [engine]),
    () => engine.state,
  );
  // Live-engine status (mode, model, errors) changes without a new state object.
  const status = useSyncExternalStore(
    useCallback((fn) => engine.subscribe(fn), [engine]),
    () => (engine.kind === "live" ? `${engine.info?.mode ?? ""}|${engine.info?.model ?? ""}|${engine.error ?? ""}|${engine.connecting}` : "replay"),
  );
  // The clock moves even when no event fires; re-read it on every tick.
  const [now, setNow] = useState(engine.now);

  const [selected, setSelected] = useState<string>(THESEUS_ID);
  const [seen, setSeen] = useState<Record<string, number>>({});
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [playing, setPlaying] = useState(true);
  const [speed, setSpeed] = useState<number>(() => store.get("speed", 1));
  const [theme, setTheme] = useState<"dark" | "light">(() => store.get("theme", "dark"));
  const [naming, setNaming] = useState<EmployeeNaming>(() => store.get("naming", "numbered"));
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const [fresh, setFresh] = useState<Set<string>>(new Set());

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    store.set("theme", theme);
  }, [theme]);
  useEffect(() => store.set("speed", speed), [speed]);
  useEffect(() => store.set("naming", naming), [naming]);

  // Simulated time (replay) or the real clock (live).
  useEffect(() => {
    if (engine.kind === "live") {
      setNow(engine.now);
      const id = setInterval(() => setNow(engine.now), 15_000);
      return () => clearInterval(id);
    }
    if (!playing) return;
    const id = setInterval(() => {
      engine.advance(TICK_MS * SIM_RATE * speed);
      setNow(engine.now);
    }, TICK_MS);
    return () => clearInterval(id);
  }, [engine, playing, speed]);
  useEffect(() => {
    if (engine.kind !== "live") return;
    engine.start();
    return () => engine.dispose();
  }, [engine]);
  // Live: keep "now" fresh whenever something happens, so new bubbles never look "in the future".
  useEffect(() => {
    if (engine.kind === "live") setNow(engine.now);
  }, [engine, snap]);

  // The open chat counts as read.
  const openCount = snap.messages[selected]?.length ?? 0;
  useEffect(() => {
    setSeen((s) => (s[selected] === openCount ? s : { ...s, [selected]: openCount }));
  }, [selected, openCount]);

  // Toasts from anywhere (bridge errors etc.).
  useEffect(() => {
    const on = (e: Event) => {
      setToast(String((e as CustomEvent).detail));
      setTimeout(() => setToast(null), 4000);
    };
    window.addEventListener("theseus:toast", on);
    return () => window.removeEventListener("theseus:toast", on);
  }, []);

  // Highlight files that change while the app is open.
  useEffect(() => {
    const b = bridge();
    if (!b) return;
    return b.onFilesChanged((c) => {
      const key = `${c.rootId}:${c.rel.replace(/\\/g, "/")}`;
      setFresh((cur) => new Set(cur).add(key));
      setTimeout(() => setFresh((cur) => {
        const n = new Set(cur);
        n.delete(key);
        return n;
      }), 60_000);
    });
  }, []);

  // Desktop notification when someone starts waiting for you and the window isn't focused.
  const needsTotal = useMemo(() => snap.employeeOrder.reduce((a, id) => a + badges(snap, id, 0).needsYou, 0), [snap]);
  const prevNeeds = useRef(needsTotal);
  useEffect(() => {
    if (needsTotal > prevNeeds.current && bridge() && document.visibilityState !== "visible" && "Notification" in window) {
      new Notification("Theseus: needs you", { body: `${needsTotal} decision${needsTotal === 1 ? "" : "s"} waiting` });
    }
    prevNeeds.current = needsTotal;
  }, [needsTotal]);

  const send = useCallback((c: Command) => engine.send(c), [engine]);

  const restart = (mode?: "live" | "demo") => {
    if (engine.kind === "live") engine.restart(mode ?? engine.info?.mode);
    else setEngine(makeEngine());
    setSelected(THESEUS_ID);
    setSeen({});
    setDrafts({});
    setPlaying(true);
  };

  const newEmployee = () => {
    const names = Object.values(snap.employees).map((e) => e.name);
    const name = nextEmployeeName(naming, names);
    engine.send({ type: "create_employee", name, rolePack: "vendor-integrity" });
    // Replay answers synchronously; live answers with an event a moment later.
    if (engine.kind === "replay") setSelected(engine.state.employeeOrder.at(-1)!);
  };

  const nudgeItem = (employeeId: string, label: string) => {
    setSelected(employeeId);
    setDrafts((d) => ({ ...d, [employeeId]: `About ${label}: ` }));
  };

  const liveInfo = engine.kind === "live" ? engine.info : null;
  const footer =
    engine.kind === "live" ? (
      <div className="replay">
        <div className="replay__clock" title={liveInfo?.note ?? ""}>
          <span className={`replay__dot ${liveInfo?.mode === "live" ? "replay__dot--live" : ""}`} data-on={!engine.connecting && !engine.error} />
          <span>
            {engine.connecting ? (
              <b>Starting…</b>
            ) : engine.error && !liveInfo ? (
              <b>Agent stopped</b>
            ) : liveInfo?.mode === "live" ? (
              <>
                <b>Live</b> {liveInfo.model.replace(/^gemini:/, "")} · {snap.modelCalls} call{snap.modelCalls === 1 ? "" : "s"}
              </>
            ) : (
              <>
                <b>Demo</b> scripted model
              </>
            )}
          </span>
        </div>
        <div className="replay__controls">
          <button className="btn btn--small" title={liveInfo?.mode === "live" ? "Switch to the scripted demo model (no quota)" : "Switch to the live model (needs GEMINI_API_KEY)"} onClick={() => restart(liveInfo?.mode === "live" ? "demo" : "live")} disabled={engine.connecting}>
            {liveInfo?.mode === "live" ? "Use demo" : "Go live"}
          </button>
          <button className="iconbtn" title="Fresh company world (resets every system and the workspace)" onClick={() => restart()} disabled={engine.connecting}>
            <Icon name="restart" size={16} />
          </button>
        </div>
      </div>
    ) : (
    <div className="replay">
      <div className="replay__clock">
        <span className="replay__dot" data-on={playing} />
        <span>
          <b>Replay</b> {clock(now)} · {new Intl.DateTimeFormat("en-GB", { weekday: "short", day: "numeric", month: "short" }).format(new Date(now))}
        </span>
      </div>
      <div className="replay__controls">
        <button className="iconbtn" title={playing ? "Pause time" : "Resume time"} onClick={() => setPlaying((p) => !p)}>
          <Icon name={playing ? "pause" : "play"} size={16} />
        </button>
        {SPEEDS.map((s) => (
          <button key={s} className={`speed ${speed === s ? "speed--on" : ""}`} onClick={() => setSpeed(s)}>
            {s}×
          </button>
        ))}
        <button className="iconbtn" title="Restart the demo" onClick={() => restart()}>
          <Icon name="restart" size={16} />
        </button>
      </div>
    </div>
  );
  void status;

  return (
    <div className="app">
      <Sidebar
        state={snap}
        now={now}
        seen={seen}
        selected={selected}
        onSelect={setSelected}
        onNewEmployee={newEmployee}
        onSettings={() => setSettingsOpen(true)}
        footer={footer}
      />
      <Chat
        key={selected}
        state={snap}
        now={now}
        threadId={selected}
        send={send}
        suggestions={selected === THESEUS_ID && !engine.hasStarted ? (engine.kind === "live" ? (liveInfo?.suggestions ?? []) : [kaveriDemo().request]) : []}
        draft={drafts[selected] ?? ""}
        setDraft={(v) => setDrafts((d) => ({ ...d, [selected]: v }))}
      />
      <Work state={snap} now={now} employeeId={selected} send={send} onNudgeItem={nudgeItem} onSelectEmployee={setSelected} freshFiles={fresh} />

      {settingsOpen ? (
        <div className="modal" onClick={() => setSettingsOpen(false)}>
          <div className="modal__card" onClick={(e) => e.stopPropagation()}>
            <div className="modal__head">
              <b>Settings</b>
              <button className="iconbtn" onClick={() => setSettingsOpen(false)}>
                <Icon name="x" size={16} />
              </button>
            </div>
            <label className="setting">
              <span>
                <b>Theme</b>
                <small>Dark is the default</small>
              </span>
              <div className="seg">
                {(["dark", "light"] as const).map((t) => (
                  <button key={t} className={theme === t ? "seg--on" : ""} onClick={() => setTheme(t)}>
                    <Icon name={t === "dark" ? "moon" : "sun"} size={14} /> {t === "dark" ? "Dark" : "Light"}
                  </button>
                ))}
              </div>
            </label>
            <label className="setting">
              <span>
                <b>New employee names</b>
                <small>{naming === "greek" ? `Random from ${GREEK_NAMES.length} Greek names` : "Employee 1, Employee 2, …"}</small>
              </span>
              <div className="seg">
                <button className={naming === "numbered" ? "seg--on" : ""} onClick={() => setNaming("numbered")}>
                  Numbered
                </button>
                <button className={naming === "greek" ? "seg--on" : ""} onClick={() => setNaming("greek")}>
                  Greek
                </button>
              </div>
            </label>
            <div className="setting setting--note">
              <span>
                <b>Badges in the list</b>
                <small>
                  <span className="badge badge--red">2</span> decisions waiting for you · <span className="badge badge--yellow">1</span> trouble being handled (failed, retrying, paused) · <span className="badge badge--green">3</span> unread
                </small>
              </span>
            </div>
            <div className="setting setting--note">
              <span>
                <b>Running in</b>
                <small>
                  {bridge() ? `Desktop app (${bridge()!.platform})` : "Browser: open the desktop app (pnpm app) for local files"}
                  {engine.kind === "live" && liveInfo
                    ? ` · ${liveInfo.mode === "live" ? `live model ${liveInfo.model.replace(/^gemini:/, "")}` : "demo (scripted) model"}${liveInfo.note ? ` (${liveInfo.note})` : ""} · company date ${liveInfo.today}`
                    : " · scripted replay"}
                </small>
              </span>
            </div>
          </div>
        </div>
      ) : null}

      {toast ? <div className="toast">{toast}</div> : null}
    </div>
  );
}
