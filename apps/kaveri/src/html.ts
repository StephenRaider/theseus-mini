/**
 * Server-rendered HTML for the Kaveri apps. Plain HTML on purpose: real
 * labels, real forms and stable ids, so a browser agent can operate it the
 * same way a person would. Visual style follows the project's widget guide
 * (Inter, dark default, turquoise accent), toned down to look like an
 * internal company tool.
 */

export const esc = (v: unknown) =>
  String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

export const inr = (n: number) => `₹${n.toLocaleString("en-IN")}`;

const NAV = [
  ["/mail", "Mail"],
  ["/erp/vendors", "Vendors"],
  ["/erp/payments/PB-2026-W41", "Payments"],
  ["/gst", "GST Portal"],
  ["/bank", "Bank"],
  ["/hr", "HR & Lists"],
  ["/admin", "Admin"],
] as const;

export function layout(title: string, active: string, body: string, flash?: string): string {
  return `<!doctype html>
<html lang="en" data-theme="dark"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)} · Kaveri Infra</title>
<link rel="preconnect" href="https://fonts.googleapis.com"><link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600&family=JetBrains+Mono:wght@400;500&display=swap" rel="stylesheet">
<style>
:root{--bg:#0F0F0F;--surface:#141414;--surface2:#1A1A1A;--text:#FFF;--muted:#AAA;--accent:#00D2D3;--border:rgba(255,255,255,.1);--item:rgba(255,255,255,.05);--hover:rgba(255,255,255,.1);--ok:#4caf50;--bad:#ff5555;--warn:#FFB020}
[data-theme=light]{--bg:#F0F0F0;--surface:#FAFAFA;--surface2:#FFF;--text:#111;--muted:#555;--accent:#00A8FF;--border:rgba(0,0,0,.1);--item:rgba(0,0,0,.03);--hover:rgba(0,0,0,.08)}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--text);font:400 14px/1.5 Inter,system-ui,sans-serif}
a{color:var(--accent);text-decoration:none}a:hover{text-decoration:underline}
header{display:flex;gap:4px;align-items:center;padding:10px 20px;background:var(--surface);border-bottom:1px solid var(--border);position:sticky;top:0}
header .brand{font-weight:600;margin-right:16px}header nav a{color:var(--muted);padding:6px 10px;border-radius:8px;font-weight:500}
header nav a.on{color:var(--text);background:var(--item);box-shadow:inset 0 -2px 0 var(--accent)}
main{max-width:1320px;margin:0 auto;padding:24px 20px}h1{font-size:18px;font-weight:600;margin:0 0 16px}h2{font-size:14px;font-weight:600;margin:24px 0 8px}
.card{background:var(--surface2);border:1px solid var(--border);border-radius:12px;padding:16px;margin-bottom:16px}
table{width:100%;border-collapse:collapse}th,td{text-align:left;padding:8px 10px;border-bottom:1px solid var(--border);vertical-align:top}
th{font-size:11px;text-transform:uppercase;letter-spacing:.5px;color:var(--muted);font-weight:500}tr:hover td{background:var(--item)}
.mono{font-family:"JetBrains Mono",monospace;font-size:12px;white-space:nowrap}.muted{color:var(--muted)}.right{text-align:right}
.tag{display:inline-block;font-size:11px;text-transform:uppercase;letter-spacing:.5px;padding:2px 8px;border-radius:4px;border:1px solid var(--border);background:var(--item)}
.tag.ok{border-color:var(--ok);color:var(--ok)}.tag.bad{border-color:var(--bad);color:var(--bad)}.tag.warn{border-color:var(--warn);color:var(--warn)}.tag.acc{border-color:var(--accent);color:var(--accent)}
input,select,textarea{background:transparent;color:var(--text);border:1px solid var(--border);border-radius:6px;padding:8px 12px;font:inherit}
input:focus,select:focus,textarea:focus{outline:none;border-color:var(--accent)}
button{background:var(--item);color:var(--text);border:1px solid var(--border);border-radius:8px;padding:7px 14px;font:500 14px Inter,sans-serif;cursor:pointer}
button:hover{background:var(--hover)}button.primary{border:2px solid var(--accent)}button.danger{border-color:var(--bad)}
form.inline{display:inline-flex;gap:6px;align-items:center}.row{display:flex;gap:12px;flex-wrap:wrap;align-items:center}
.flash{border:1px solid var(--accent);background:rgba(0,210,211,.08);border-radius:8px;padding:10px 14px;margin-bottom:16px}
.err{border-color:var(--bad);background:rgba(255,85,85,.08)}pre{white-space:pre-wrap;font:inherit;margin:0}
dl{display:grid;grid-template-columns:200px 1fr;gap:6px 16px;margin:0}dt{color:var(--muted)}dd{margin:0}
.unread td{font-weight:600}
::-webkit-scrollbar{width:6px;height:6px}::-webkit-scrollbar-track{background:transparent}::-webkit-scrollbar-thumb{background:var(--border);border-radius:3px}
</style></head><body>
<header><span class="brand">Kaveri Infra</span><nav>${NAV.map(([href, label]) => `<a href="${href}"${href.startsWith(active) ? ' class="on"' : ""}>${label}</a>`).join("")}</nav>
<span style="margin-left:auto" class="muted">Accounts Payable · ap@kaveriinfra.example</span></header>
<main>${flash ? `<div class="flash" role="status">${esc(flash)}</div>` : ""}${body}</main></body></html>`;
}

export const statusTag = (s: string) => {
  const cls = ({ active: "ok", cleared: "ok", Active: "ok", pending: "acc", corrected: "warn", held: "bad", inactive: "bad", blocked: "bad", released: "ok", draft: "acc" } as Record<string, string>)[s] ?? "";
  return `<span class="tag ${cls}">${esc(s)}</span>`;
};

export function errorPage(status: number, code: string, message: string) {
  return layout(`Error ${status}`, "", `<div class="card flash err" role="alert"><strong>${esc(code)}</strong>: ${esc(message)}</div><a href="javascript:history.back()">← Back</a>`);
}
