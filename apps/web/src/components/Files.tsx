/**
 * Files panel: the granted folders, live. When an employee writes a file it
 * appears here (highlighted as new); click to open it in Excel / Word / your
 * PDF viewer. Only folders you granted are visible to the app or to agents.
 */
import { useCallback, useEffect, useState } from "react";
import { bridge, type BridgeEntry, type BridgeRoot } from "../bridge.ts";
import { Icon, alertish, fileKind } from "./ui.tsx";
import { Empty } from "./Work.tsx";

export function Files({ fresh }: { fresh: Set<string> }) {
  const b = bridge();
  const [roots, setRoots] = useState<BridgeRoot[]>([]);
  const [trees, setTrees] = useState<Record<string, BridgeEntry[] | string>>({});
  const [closed, setClosed] = useState<Set<string>>(new Set());

  const load = useCallback(async () => {
    if (!b) return;
    const rs = await b.roots();
    setRoots(rs);
    const next: Record<string, BridgeEntry[] | string> = {};
    for (const r of rs) {
      try {
        next[r.id] = await b.walk(r.id);
      } catch (e) {
        next[r.id] = e instanceof Error ? e.message : String(e);
      }
    }
    setTrees(next);
  }, [b]);

  useEffect(() => {
    if (!b) return;
    void load();
    let t: ReturnType<typeof setTimeout> | undefined;
    const off = b.onFilesChanged(() => {
      clearTimeout(t);
      t = setTimeout(() => void load(), 250);
    });
    return () => {
      off();
      clearTimeout(t);
    };
  }, [b, load]);

  if (!b)
    return (
      <Empty
        title="Files live in the desktop app"
        text="In the Theseus desktop app this panel shows your granted folders (the workspace by default), updates live as employees write files, and opens them in Excel or Word. Run: pnpm app"
      />
    );

  const toggle = (key: string) =>
    setClosed((cur) => {
      const n = new Set(cur);
      if (n.has(key)) n.delete(key);
      else n.add(key);
      return n;
    });

  return (
    <div className="files">
      <div className="files__bar">
        <span className="section-title">Granted folders</span>
        <button
          className="btn btn--small"
          onClick={async () => {
            try {
              if (await b.grantFolder()) await load();
            } catch (e) {
              alertish(e);
            }
          }}
        >
          <Icon name="plus" size={14} /> Grant a folder
        </button>
      </div>
      {roots.map((r) => {
        const tree = trees[r.id];
        return (
          <div className="root" key={r.id}>
            <div className="root__head">
              <Icon name="folder" size={16} />
              <span className="root__label">{r.label}</span>
              <span className="root__path mono" title={r.path}>
                {r.path}
              </span>
              <button className="iconbtn iconbtn--tiny" title="Show in folder" onClick={() => b.reveal(r.id, "").catch(alertish)}>
                <Icon name="open" size={14} />
              </button>
              {r.id !== "workspace" ? (
                <button
                  className="iconbtn iconbtn--tiny"
                  title="Remove access"
                  onClick={async () => {
                    await b.revokeFolder(r.id);
                    await load();
                  }}
                >
                  <Icon name="x" size={14} />
                </button>
              ) : null}
            </div>
            {typeof tree === "string" ? (
              <div className="root__error">{tree.includes("not found") ? "Folder not found. Run pnpm world:reset to create the workspace." : tree}</div>
            ) : tree ? (
              <ul className="tree">
                {tree
                  .filter((e) => {
                    // hide children of collapsed folders
                    const parts = e.rel.split("/");
                    for (let i = 1; i < parts.length; i++) if (closed.has(`${r.id}:${parts.slice(0, i).join("/")}`)) return false;
                    return true;
                  })
                  .map((e) => {
                    const depth = e.rel.split("/").length - 1;
                    const key = `${r.id}:${e.rel}`;
                    const isNew = fresh.has(key);
                    if (e.kind === "dir")
                      return (
                        <li key={key}>
                          <button className="tree__row tree__row--dir" style={{ paddingLeft: 8 + depth * 16 }} onClick={() => toggle(key)}>
                            <span className={`tree__caret ${closed.has(key) ? "" : "tree__caret--open"}`}>▸</span>
                            <Icon name="folder" size={15} />
                            {e.name}
                          </button>
                        </li>
                      );
                    const k = fileKind(e.name);
                    return (
                      <li key={key}>
                        <div className={`tree__row ${isNew ? "tree__row--new" : ""}`} style={{ paddingLeft: 24 + depth * 16 }}>
                          <span className={`tree__kind filecard__kind--${k.tone}`}>{k.label}</span>
                          <button className="tree__name" onClick={() => b.open(r.id, e.rel).catch(alertish)} title={`Open ${e.rel}`}>
                            {e.name}
                          </button>
                          {isNew ? <span className="tree__new">new</span> : null}
                          <span className="tree__size">{size(e.size)}</span>
                          <button className="iconbtn iconbtn--tiny tree__reveal" title="Show in folder" onClick={() => b.reveal(r.id, e.rel).catch(alertish)}>
                            <Icon name="folder" size={13} />
                          </button>
                        </div>
                      </li>
                    );
                  })}
                {tree.length === 0 ? <li className="tree__empty">Empty folder</li> : null}
              </ul>
            ) : (
              <div className="root__error">Loading…</div>
            )}
          </div>
        );
      })}
      <p className="files__note">Employees can read and create files only inside these folders. Overwriting, moving or deleting a file always asks you first.</p>
    </div>
  );
}

function size(n: number) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}
