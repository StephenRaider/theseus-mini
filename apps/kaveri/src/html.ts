/**
 * Server-rendered HTML shared by all Kaveri sites. Each site passes a Theme so
 * that Mail, ERP, the bank and the government portals look like DIFFERENT
 * systems (as they would in a real company). Plain HTML with real labels,
 * forms and stable ids, so a browser agent can operate it like a person.
 * Every site is marked "simulation": all organisations and data are fictional.
 */

export const esc = (v: unknown) =>
  String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

export const inr = (n: number) => `₹${n.toLocaleString("en-IN")}`;

export interface Theme {
  key: string;
  /** Product name shown in the header, e.g. "Bharat Bank · Corporate". */
  name: string;
  /** Short line under the name. */
  tagline: string;
  /** Single glyph used as a logo mark. */
  mark: string;
  nav: ReadonlyArray<readonly [href: string, label: string]>;
  /** CSS variables for this site. */
  vars: Record<string, string>;
  /** Header style: dark bar or coloured band. */
  header: "dark" | "band";
  /** Right side of the header, e.g. logged-in user. */
  user: string;
  font?: string;
}

const BASE_CSS = `
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--text);font:400 14px/1.5 var(--font)}
a{color:var(--accent);text-decoration:none}a:hover{text-decoration:underline}
header.site{display:flex;gap:6px;align-items:center;padding:10px 24px;background:var(--head-bg);color:var(--head-text);border-bottom:1px solid var(--border);position:sticky;top:0;z-index:5}
header.site .mark{width:28px;height:28px;border-radius:6px;display:grid;place-items:center;background:var(--accent);color:var(--on-accent);font-weight:700;margin-right:8px}
header.site .brand{display:flex;flex-direction:column;margin-right:20px;line-height:1.15}header.site .brand b{font-weight:600}header.site .brand small{opacity:.75;font-size:11px}
header.site nav a{color:var(--head-text);opacity:.8;padding:6px 10px;border-radius:8px;font-weight:500}
header.site nav a.on{opacity:1;background:var(--head-hover);box-shadow:inset 0 -2px 0 var(--accent)}
header.site .user{margin-left:auto;opacity:.8;font-size:13px}
.sim{background:var(--warn);color:#111;font-size:11px;text-transform:uppercase;letter-spacing:.5px;text-align:center;padding:2px}
main{max-width:1320px;margin:0 auto;padding:24px}h1{font-size:18px;font-weight:600;margin:0 0 16px}h2{font-size:14px;font-weight:600;margin:24px 0 8px}
.card{background:var(--surface);border:1px solid var(--border);border-radius:var(--radius);padding:16px;margin-bottom:16px}
table{width:100%;border-collapse:collapse}th,td{text-align:left;padding:8px 10px;border-bottom:1px solid var(--border);vertical-align:top}
th{font-size:11px;text-transform:uppercase;letter-spacing:.5px;color:var(--muted);font-weight:500}tr:hover td{background:var(--item)}
.mono{font-family:"JetBrains Mono",ui-monospace,monospace;font-size:12px;white-space:nowrap}.muted{color:var(--muted)}.right{text-align:right}
.tag{display:inline-block;font-size:11px;text-transform:uppercase;letter-spacing:.5px;padding:2px 8px;border-radius:4px;border:1px solid var(--border);background:var(--item)}
.tag.ok{border-color:var(--ok);color:var(--ok)}.tag.bad{border-color:var(--bad);color:var(--bad)}.tag.warn{border-color:var(--warn);color:var(--warn-text)}.tag.acc{border-color:var(--accent);color:var(--accent)}
input,select,textarea{background:var(--input-bg);color:var(--text);border:1px solid var(--border);border-radius:6px;padding:8px 12px;font:inherit}
input:focus,select:focus,textarea:focus{outline:none;border-color:var(--accent)}
button{background:var(--item);color:var(--text);border:1px solid var(--border);border-radius:8px;padding:7px 14px;font:500 14px var(--font);cursor:pointer}
button:hover{background:var(--hover)}button.primary{border:2px solid var(--accent)}button.danger{border-color:var(--bad)}
form.inline{display:inline-flex;gap:6px;align-items:center}.row{display:flex;gap:12px;flex-wrap:wrap;align-items:center}
.flash{border:1px solid var(--accent);background:var(--item);border-radius:8px;padding:10px 14px;margin-bottom:16px}
.err{border-color:var(--bad)}pre{white-space:pre-wrap;font:inherit;margin:0}
dl{display:grid;grid-template-columns:220px 1fr;gap:6px 16px;margin:0}dt{color:var(--muted)}dd{margin:0}
.unread td{font-weight:600}.grid2{display:grid;grid-template-columns:1fr 1fr;gap:16px}
footer{max-width:1320px;margin:0 auto;padding:12px 24px 32px;color:var(--muted);font-size:11px}
::-webkit-scrollbar{width:6px;height:6px}::-webkit-scrollbar-track{background:transparent}::-webkit-scrollbar-thumb{background:var(--border);border-radius:3px}
`;

export function layout(theme: Theme, title: string, active: string, body: string, flash?: string): string {
  const vars = Object.entries(theme.vars).map(([k, v]) => `--${k}:${v}`).join(";");
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)} · ${esc(theme.name)}</title>
<link rel="preconnect" href="https://fonts.googleapis.com"><link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500&family=Noto+Sans:wght@400;600&display=swap" rel="stylesheet">
<style>:root{${vars};--font:${theme.font ?? "Inter,system-ui,sans-serif"}}${BASE_CSS}</style></head>
<body data-site="${theme.key}">
<div class="sim">Simulation · fictional organisation and data · Theseus Mini test environment</div>
<header class="site"><span class="mark" aria-hidden="true">${esc(theme.mark)}</span><span class="brand"><b>${esc(theme.name)}</b><small>${esc(theme.tagline)}</small></span>
<nav>${theme.nav.map(([href, label]) => `<a href="${href}"${active && href.startsWith(active) ? ' class="on"' : ""}>${esc(label)}</a>`).join("")}</nav>
<span class="user">${esc(theme.user)}</span></header>
<main>${flash ? `<div class="flash" role="status">${esc(flash)}</div>` : ""}${body}</main>
<footer>${esc(theme.name)} · simulated system for agent evaluation · all names, numbers and documents are fictional</footer></body></html>`;
}

export const statusTag = (s: string) => {
  const cls = (
    {
      active: "ok", Active: "ok", cleared: "ok", released: "ok", authorised: "ok", awarded: "ok",
      pending: "acc", draft: "acc", evaluation: "acc", pending_authorisation: "warn",
      corrected: "warn", held: "bad", inactive: "bad", blocked: "bad", rejected: "bad", Cancelled: "bad",
    } as Record<string, string>
  )[s] ?? "";
  return `<span class="tag ${cls}">${esc(s.replace(/_/g, " "))}</span>`;
};

export function errorPage(theme: Theme, status: number, code: string, message: string) {
  return layout(theme, `Error ${status}`, "", `<div class="card flash err" role="alert"><strong>${esc(code)}</strong>: ${esc(message)}</div><a href="javascript:history.back()">← Back</a>`);
}

/* ------------------------------------------------------------- themes */

const DARK = {
  bg: "#0F0F0F", surface: "#1A1A1A", text: "#FFFFFF", muted: "#AAAAAA", border: "rgba(255,255,255,.1)",
  item: "rgba(255,255,255,.05)", hover: "rgba(255,255,255,.1)", "input-bg": "transparent",
  ok: "#4caf50", bad: "#ff5555", warn: "#FFB020", "warn-text": "#FFB020", "head-bg": "#141414", "head-text": "#FFFFFF",
  "head-hover": "rgba(255,255,255,.08)", radius: "12px", "on-accent": "#0F0F0F",
};
const LIGHT = {
  bg: "#F4F5F7", surface: "#FFFFFF", text: "#1B1F24", muted: "#5F6B7A", border: "rgba(0,0,0,.12)",
  item: "rgba(0,0,0,.03)", hover: "rgba(0,0,0,.07)", "input-bg": "#FFFFFF",
  ok: "#2E7D32", bad: "#C62828", warn: "#F2B705", "warn-text": "#8A6400", "head-hover": "rgba(255,255,255,.15)", radius: "8px", "on-accent": "#FFFFFF",
};

export const THEMES = {
  control: (nav: Theme["nav"]): Theme => ({
    key: "control", name: "Theseus Control Room", tagline: "Kaveri world · resets · faults · ground truth", mark: "Θ", nav, header: "dark",
    user: "Evaluator view (hidden from agents)", vars: { ...DARK, accent: "#FFB020", "on-accent": "#111" },
  }),
  mail: (nav: Theme["nav"]): Theme => ({
    key: "mail", name: "Kaveri Mail", tagline: "Accounts Payable mailbox", mark: "✉", nav, header: "band",
    user: "ap@kaveriinfra.example", vars: { ...LIGHT, accent: "#2563EB", "head-bg": "#1E3A8A", "head-text": "#FFFFFF" },
  }),
  erp: (nav: Theme["nav"]): Theme => ({
    key: "erp", name: "Kaveri ERP", tagline: "Vendor master · Payments", mark: "K", nav, header: "dark",
    user: "Accounts Payable desk", vars: { ...DARK, accent: "#00D2D3" },
  }),
  bank: (nav: Theme["nav"]): Theme => ({
    key: "bank", name: "Bharat Bank · Corporate", tagline: "Kaveri Infra Pvt Ltd · Current A/c ••••4471", mark: "₹", nav, header: "band",
    user: "Corporate user: AP maker", font: "'Noto Sans',system-ui,sans-serif",
    vars: { ...LIGHT, accent: "#0B6E4F", "head-bg": "#0B4D3B", "head-text": "#F6E7B0", bg: "#F3F1EA" },
  }),
  gst: (nav: Theme["nav"]): Theme => ({
    key: "gst", name: "GST Portal", tagline: "Goods and Services Tax · taxpayer search (simulation)", mark: "G", nav, header: "band",
    user: "Public search", font: "'Noto Sans',system-ui,sans-serif",
    vars: { ...LIGHT, accent: "#1F3A68", "head-bg": "#1F3A68", "head-text": "#FFFFFF", radius: "4px" },
  }),
  udyam: (nav: Theme["nav"]): Theme => ({
    key: "udyam", name: "Udyam Registration", tagline: "MSME certificate verification (simulation)", mark: "U", nav, header: "band",
    user: "Public verification", font: "'Noto Sans',system-ui,sans-serif",
    vars: { ...LIGHT, accent: "#7A1F2B", "head-bg": "#7A1F2B", "head-text": "#FFFFFF", radius: "4px" },
  }),
  eproc: (nav: Theme["nav"]): Theme => ({
    key: "eproc", name: "Kaveri eProcure", tagline: "Tenders · bids · bidder documents", mark: "e", nav, header: "band",
    user: "Procurement (read access: AP)", vars: { ...LIGHT, accent: "#C25E00", "head-bg": "#2B2F36", "head-text": "#FFD9B0" },
  }),
};
