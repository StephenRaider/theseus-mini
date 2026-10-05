import { esc, inr, statusTag, THEMES } from "../html.ts";
import { TRAPS } from "../seed/scenario.ts";
import type { FaultConfig, Kaveri } from "../store.ts";
import { createSite, PORTS, siteUrl, str, type Req, type SiteKey } from "./common.ts";

const SITE_INFO: Record<Exclude<SiteKey, "control">, { name: string; what: string }> = {
  mail: { name: "Kaveri Mail", what: "AP inbox · 50 emails · drafts & attachments" },
  erp: { name: "Kaveri ERP", what: "60 vendors · batch PB-2026-W41 (65 lines) · Excel export · HR & debarment" },
  bank: { name: "Bharat Bank · Corporate", what: "Penny-drop · guarantee confirmation · bulk payment upload (maker-checker)" },
  gst: { name: "GST Portal", what: "GSTIN status & legal name" },
  udyam: { name: "Udyam Registration", what: "MSME category verification" },
  eproc: { name: "Kaveri eProcure", what: "Tender T-2026-14 · bidder documents · EMD guarantees" },
};

/**
 * Theseus Control Room (evaluator view, hidden from agents): links to every
 * site, world reset (also regenerates the local workspace), fault injection,
 * planted traps (ground truth), payment files and the audit log.
 */
export function controlSite(kaveri: Kaveri, opts: { workspaceDir?: string | false } = {}) {
  const site = createSite(kaveri, THEMES.control([["/", "Overview"], ["/traps", "Ground truth"], ["/audit", "Audit log"]]));
  const { app, page, back } = site;

  /* ---------------------------------------------------------- admin API */
  app.post("/__admin/reset", async (req: Req) => {
    await kaveri.reset((req.body?.faults as Partial<FaultConfig>) ?? {});
    return { ok: true, today: kaveri.state.today, workspace: opts.workspaceDir || null };
  });
  app.get("/__admin/faults", async () => kaveri.faults);
  app.post("/__admin/faults", async (req: Req) => {
    kaveri.setFaults(req.body as Partial<FaultConfig>);
    return kaveri.faults;
  });
  app.get("/__admin/state", async () => kaveri.state);
  app.get("/__admin/traps", async () => TRAPS);
  app.get("/__admin/sites", async () => Object.fromEntries(Object.keys(PORTS).map((k) => [k, siteUrl(k as SiteKey)])));

  /* --------------------------------------------------------------- HTML */
  app.get("/", async (req: Req, reply) => {
    const f = kaveri.faults;
    const s = kaveri.state;
    return page(reply, "Overview", "/", `
      <h1>Kaveri Infra world <span class="tag warn">scenario date ${esc(s.today)}</span></h1>
      <div class="card" style="padding:0"><table><thead><tr><th>Site</th><th>Address</th><th>What's there</th></tr></thead><tbody>
      ${Object.entries(SITE_INFO).map(([k, i]) => `<tr><td>${esc(i.name)}</td><td class="mono"><a href="${siteUrl(k as SiteKey)}" target="_blank">${siteUrl(k as SiteKey)}</a></td><td class="muted">${esc(i.what)}</td></tr>`).join("")}
      <tr><td>Local workspace</td><td class="mono" colspan="2">${opts.workspaceDir ? esc(opts.workspaceDir) : '<span class="muted">not generated (tests)</span>'}</td></tr>
      </tbody></table></div>
      <div class="grid2">
        <div class="card"><h2 style="margin-top:0">Reset</h2><p class="muted">Restores every site to the seed scenario${opts.workspaceDir ? " and regenerates the workspace folder (Excel register, policy PDF, templates)" : ""}.</p>
          <form method="post" action="/reset"><button class="danger">Reset world</button></form></div>
        <div class="card"><h2 style="margin-top:0">Fault injection</h2><form method="post" action="/faults" style="display:grid;gap:8px">
          <label>Random failure rate on writes (0–1) <input name="failRate" type="number" step="0.05" min="0" max="1" value="${f.failRate}" style="width:90px"></label>
          <label>Added latency (ms) <input name="latencyMs" type="number" min="0" value="${f.latencyMs}" style="width:90px"></label>
          <label>Fail the next <input name="failCount" type="number" min="1" value="1" style="width:60px"> call(s) of <input name="failOp" placeholder="e.g. payments.hold_line" size="24"></label>
          <div class="row"><button class="primary">Apply</button><span class="mono muted">failNext: ${esc(JSON.stringify(f.failNext))}</span></div></form></div>
      </div>
      <div class="grid2">
        <div class="card"><h2 style="margin-top:0">Batch PB-2026-W41</h2>${(() => {
          const b = s.batches[0]!;
          const c = b.lines.reduce<Record<string, number>>((a, l) => ((a[l.status] = (a[l.status] ?? 0) + 1), a), {});
          return `<p>${Object.entries(c).map(([k, n]) => `${statusTag(k)} ${n}`).join(" &nbsp; ")}</p>`;
        })()}</div>
        <div class="card"><h2 style="margin-top:0">Bank payment files</h2>${s.paymentFiles.length ? s.paymentFiles.map((pf) => `<p class="mono">${pf.id} · ${esc(pf.filename)} · ${pf.rows.length} rows · ${inr(pf.totalAmount)} ${statusTag(pf.status)}</p>`).join("") : '<p class="muted">None yet</p>'}</div>
      </div>`, req.query.flash);
  });
  app.post("/reset", async (_req, reply) => {
    await kaveri.reset();
    return back(reply, "/", "World reset to the seed scenario.");
  });
  app.post("/faults", async (req: Req, reply) => {
    const failNext = { ...kaveri.faults.failNext };
    if (str(req.body.failOp)) failNext[str(req.body.failOp)] = Number(req.body.failCount ?? 1);
    kaveri.setFaults({ failRate: Number(req.body.failRate ?? 0), latencyMs: Number(req.body.latencyMs ?? 0), failNext });
    return back(reply, "/", "Faults updated.");
  });
  app.get("/traps", async (_req, reply) =>
    page(reply, "Ground truth", "/traps", `<h1>Planted traps <span class="muted">(${TRAPS.length})</span></h1><div class="card" style="padding:0"><table><thead><tr><th>Id</th><th>Where</th><th>Expected behaviour</th><th>Real-world source</th></tr></thead><tbody>
      ${TRAPS.map((t) => `<tr><td class="mono">${t.id}</td><td>${esc(t.where)}</td><td>${esc(t.expect)}</td><td class="muted">${esc(t.source)}</td></tr>`).join("")}</tbody></table></div>`));
  app.get("/audit", async (_req, reply) =>
    page(reply, "Audit log", "/audit", `<h1>Audit log <span class="muted">(${kaveri.state.auditLog.length})</span></h1><div class="card" style="padding:0"><table><thead><tr><th>When</th><th>Actor</th><th>Action</th><th>Detail</th></tr></thead><tbody>
      ${[...kaveri.state.auditLog].reverse().map((a) => `<tr><td class="mono">${esc(a.at.slice(11, 19))}</td><td class="mono">${esc(a.actor)}</td><td>${esc(a.action)}</td><td>${esc(a.detail)}</td></tr>`).join("") || '<tr><td colspan="4" class="muted">Nothing yet</td></tr>'}</tbody></table></div>`));

  return site;
}
