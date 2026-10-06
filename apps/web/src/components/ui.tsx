import { THESEUS_ID, type Attachment } from "@theseus/protocol";
import type { ReactNode } from "react";
import { bridge, parseRef } from "../bridge.ts";
import { initials } from "../state/selectors.ts";

/* ------------------------------------------------------------------ icons (inline, 20×20 viewBox) */

const PATHS: Record<string, string> = {
  plus: "M10 4v12M4 10h12",
  gear: "M10 7a3 3 0 1 0 0 6 3 3 0 0 0 0-6Zm7 3-1.6-.9.2-1.8-1.7-.9-1.1-1.4-1.8.3L10 3l-1 1.3-1.8-.3-1.1 1.4-1.7.9.2 1.8L3 10l1.6.9-.2 1.8 1.7.9 1.1 1.4 1.8-.3L10 17l1-1.3 1.8.3 1.1-1.4 1.7-.9-.2-1.8Z",
  search: "M9 15a6 6 0 1 0 0-12 6 6 0 0 0 0 12Zm4.5-1.5L17 17",
  send: "M3 10 17 3l-4 14-3-6-7-1Zm7 1 7-8",
  clip: "M14.5 9.5 9 15a3.5 3.5 0 0 1-5-5l6.5-6.5a2.3 2.3 0 0 1 3.3 3.3L7.5 13a1.2 1.2 0 0 1-1.7-1.7L11.5 5.6",
  check: "M4 10.5 8 14l8-8",
  dcheck: "M2 10.5 6 14l8-8M9 13l1 1 8-8",
  play: "M6 4v12l10-6Z",
  pause: "M6 4h3v12H6zM11 4h3v12h-3z",
  restart: "M4 10a6 6 0 1 0 2-4.5M4 3v3.5h3.5",
  folder: "M2.5 5.5a1 1 0 0 1 1-1h4l1.5 2h7.5a1 1 0 0 1 1 1v7a1 1 0 0 1-1 1h-13a1 1 0 0 1-1-1Z",
  open: "M11 3h6v6M17 3l-8 8M14 11v5H4V6h5",
  sun: "M10 6.5a3.5 3.5 0 1 0 0 7 3.5 3.5 0 0 0 0-7ZM10 1.5v2M10 16.5v2M1.5 10h2M16.5 10h2M4 4l1.4 1.4M14.6 14.6 16 16M4 16l1.4-1.4M14.6 5.4 16 4",
  moon: "M16 12.5A7 7 0 0 1 7.5 4 6.5 6.5 0 1 0 16 12.5Z",
  x: "M5 5l10 10M15 5 5 15",
  edit: "M4 16h3l9-9-3-3-9 9Zm8-11 3 3",
  bolt: "M11 2 4 11h5l-1 7 7-9h-5Z",
  skip: "M5 5l7 5-7 5ZM14 5v10",
  retry: "M4 10a6 6 0 1 0 2-4.5M4 3v3.5h3.5",
  hold: "M7 5v10M13 5v10",
  top: "M10 16V5M5 9l5-5 5 5M4 3h12",
  chat: "M3 5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2v7a2 2 0 0 1-2 2H8l-4 3v-3.2A2 2 0 0 1 3 12Z",
  dots: "M5 10h.01M10 10h.01M15 10h.01",
};

export function Icon({ name, size = 18, className }: { name: keyof typeof PATHS | string; size?: number; className?: string }) {
  return (
    <svg className={className} width={size} height={size} viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d={PATHS[name] ?? ""} />
    </svg>
  );
}

/* ------------------------------------------------------------------ avatar */

const HUES = [186, 152, 262, 32, 330, 210, 98, 12];

export function Avatar({ id, name, size = 44, status }: { id: string; name: string; size?: number; status?: string }) {
  const isTheseus = id === THESEUS_ID;
  let h = 0;
  for (const ch of id) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  const hue = HUES[h % HUES.length]!;
  return (
    <span
      className={`avatar ${isTheseus ? "avatar--theseus" : ""}`}
      style={{ width: size, height: size, fontSize: size * 0.36, ...(isTheseus ? {} : { background: `hsl(${hue} 45% 32%)` }) }}
    >
      {isTheseus ? "Θ" : initials(name)}
      {status && status !== "idle" ? <span className={`avatar__status avatar__status--${status}`} /> : null}
    </span>
  );
}

/* ------------------------------------------------------------------ badges */

export function CountBadge({ n, tone, title }: { n: number; tone: "red" | "yellow" | "green"; title: string }) {
  if (n <= 0) return null;
  return (
    <span className={`badge badge--${tone}`} title={title}>
      {n > 99 ? "99+" : n}
    </span>
  );
}

export function Tag({ children, tone = "neutral" }: { children: ReactNode; tone?: "neutral" | "accent" | "red" | "yellow" | "green" | "held" }) {
  return <span className={`tag tag--${tone}`}>{children}</span>;
}

/* ------------------------------------------------------------------ files */

export function fileKind(name: string): { label: string; tone: string } {
  const ext = name.toLowerCase().split(".").pop() ?? "";
  if (ext === "pdf") return { label: "PDF", tone: "pdf" };
  if (ext === "xlsx" || ext === "xls") return { label: "XLSX", tone: "xlsx" };
  if (ext === "csv") return { label: "CSV", tone: "xlsx" };
  if (ext === "docx" || ext === "doc") return { label: "DOCX", tone: "docx" };
  return { label: ext.slice(0, 4).toUpperCase() || "FILE", tone: "other" };
}

export function FileCard({ att }: { att: Attachment }) {
  const b = bridge();
  const ref = parseRef(att.ref);
  const k = fileKind(att.name);
  const open = () => ref && b?.open(ref.rootId, ref.rel).catch((e: unknown) => alertish(e));
  const reveal = () => ref && b?.reveal(ref.rootId, ref.rel).catch((e: unknown) => alertish(e));
  return (
    <div className="filecard" title={ref ? ref.rel : att.name}>
      <span className={`filecard__kind filecard__kind--${k.tone}`}>{k.label}</span>
      <span className="filecard__body">
        <span className="filecard__name">{att.name}</span>
        <span className="filecard__path">{ref ? ref.rel.split("/").slice(0, -1).join(" / ") || "workspace" : ""}</span>
      </span>
      {b ? (
        <span className="filecard__actions">
          <button className="iconbtn" onClick={open} title="Open">
            <Icon name="open" size={16} />
          </button>
          <button className="iconbtn" onClick={reveal} title="Show in folder">
            <Icon name="folder" size={16} />
          </button>
        </span>
      ) : (
        <span className="filecard__hint" title="Opening files works in the desktop app">
          desktop app
        </span>
      )}
    </div>
  );
}

/** Errors from the bridge surface as a small toast (see App). */
export function alertish(e: unknown) {
  window.dispatchEvent(new CustomEvent("theseus:toast", { detail: e instanceof Error ? e.message : String(e) }));
}
