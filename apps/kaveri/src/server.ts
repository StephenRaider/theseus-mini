import formbody from "@fastify/formbody";
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";
import { getDocument } from "./docs/pdf.ts";
import { errorPage, esc, inr, layout, statusTag } from "./html.ts";
import { TRAPS } from "./seed/scenario.ts";
import { Kaveri, KaveriError, type FaultConfig } from "./store.ts";

type Body = Record<string, unknown>;
type Req = FastifyRequest<{ Params: Record<string, string>; Querystring: Record<string, string>; Body: Body }>;

/** Who is acting: agents send `x-actor: agent:emp_1`; the web UI acts as `user:web`. */
const actorOf = (req: FastifyRequest) => String(req.headers["x-actor"] ?? "user:web");
const str = (v: unknown) => (typeof v === "string" ? v : v == null ? "" : String(v));

export function buildServer(kaveri = new Kaveri()): FastifyInstance {
  const app = Fastify({ logger: false });
  app.register(formbody);

  app.setErrorHandler((err: Error & { statusCode?: number }, req, reply) => {
    const e = err instanceof KaveriError ? err : new KaveriError(err.statusCode ?? 500, err.statusCode && err.statusCode < 500 ? "BAD_REQUEST" : "INTERNAL", err.message);
    if (req.url.startsWith("/api") || req.url.startsWith("/__admin"))
      return reply.status(e.status).send({ error: { code: e.code, message: e.message } });
    return reply.status(e.status).type("text/html").send(errorPage(e.status, e.code, e.message));
  });

  const html = (reply: FastifyReply, page: string) => reply.type("text/html").send(page);
  const back = (reply: FastifyReply, to: string, flash: string) => reply.redirect(`${to}${to.includes("?") ? "&" : "?"}flash=${encodeURIComponent(flash)}`);

  /* =============================================================== API */

  // ---- mail
  app.get("/api/mail", async (req: Req) => {
    await kaveri.gate("mail.search", "read");
    return kaveri.listMail({ folder: req.query.folder, q: req.query.q });
  });
  app.get("/api/mail/:id", async (req: Req) => {
    await kaveri.gate("mail.read", "read");
    return kaveri.getMail(req.params.id!);
  });
  app.get("/api/mail/:id/attachments/:name", async (req: Req, reply) => {
    await kaveri.gate("mail.download_attachment", "read");
    const key = kaveri.attachmentKey(req.params.id!, req.params.name!);
    const pdf = await getDocument(key);
    if (!pdf) throw new KaveriError(404, "NOT_FOUND", "Document missing");
    return reply.type("application/pdf").header("content-disposition", `inline; filename="${req.params.name}"`).send(Buffer.from(pdf));
  });
  app.post("/api/mail/drafts", async (req: Req) => {
    await kaveri.gate("mail.draft_reply", "write");
    return kaveri.saveDraft({ to: str(req.body.to), subject: str(req.body.subject), body: str(req.body.body) }, actorOf(req));
  });
  app.post("/api/mail/:id/send", async (req: Req) => {
    await kaveri.gate("mail.send", "write");
    return kaveri.sendDraft(req.params.id!, str(req.body.approvedBy) || undefined);
  });

  // ---- vendors
  app.get("/api/vendors", async (req: Req) => {
    await kaveri.gate("vendor.search", "read");
    return kaveri.searchVendors(req.query.q);
  });
  app.get("/api/vendors/:id", async (req: Req) => {
    await kaveri.gate("vendor.get", "read");
    return kaveri.getVendor(req.params.id!);
  });
  app.post("/api/vendors", async (req: Req, reply) => {
    await kaveri.gate("vendor.create_pending", "write");
    const v = kaveri.createPendingVendor(req.body as never, actorOf(req));
    return reply.status(201).send(v);
  });
  app.patch("/api/vendors/:id", async (req: Req) => {
    await kaveri.gate("vendor.update_pending", "write");
    return kaveri.updatePendingVendor(req.params.id!, req.body as never, actorOf(req));
  });
  app.post("/api/vendors/:id/activate", async (req: Req) => {
    await kaveri.gate("vendor.activate", "write");
    return kaveri.activateVendor(req.params.id!, str(req.body.approvedBy) || undefined);
  });
  app.post("/api/vendors/:id/hold", async (req: Req) => {
    await kaveri.gate("vendor.hold_payments", "write");
    return kaveri.holdVendorPayments(req.params.id!, str(req.body.reason), actorOf(req));
  });
  app.post("/api/vendors/:id/release", async (req: Req) => {
    await kaveri.gate("vendor.release_payments", "write");
    return kaveri.releaseVendorPayments(req.params.id!, actorOf(req));
  });
  app.post("/api/vendors/:id/bank", async (req: Req) => {
    await kaveri.gate("vendor.change_bank", "write");
    return kaveri.changeVendorBank(req.params.id!, req.body.bank as never, {
      approvedBy: str(req.body.approvedBy) || undefined,
      callbackRef: str(req.body.callbackRef) || undefined,
      source: str(req.body.source) || undefined,
    });
  });

  // ---- government, bank, HR, lists, tenders
  app.get("/api/gov/gstin/:gstin", async (req: Req) => {
    await kaveri.gate("gov.gstin_status", "read");
    return kaveri.gstinLookup(req.params.gstin!);
  });
  app.post("/api/bank/penny-drop", async (req: Req) => {
    await kaveri.gate("bank.penny_drop", "read");
    return kaveri.pennyDrop(str(req.body.accountNumber), str(req.body.ifsc));
  });
  app.post("/api/bank/guarantees/verify", async (req: Req) => {
    await kaveri.gate("bank.verify_guarantee", "read");
    return kaveri.verifyGuarantee(str(req.body.number));
  });
  app.get("/api/hr/employees", async (req: Req) => {
    await kaveri.gate("hr.search_employees", "read");
    return kaveri.searchEmployees(req.query.q);
  });
  app.get("/api/lists/debarment", async (req: Req) => {
    await kaveri.gate("lists.check_debarment", "read");
    return kaveri.searchDebarment(req.query.q);
  });
  app.get("/api/tenders", async () => kaveri.state.tenders);

  // ---- payments
  app.get("/api/payments/batches/:id", async (req: Req) => {
    await kaveri.gate("payments.get_batch", "read");
    return kaveri.getBatch(req.params.id!);
  });
  app.get("/api/payments/paid", async (req: Req) => {
    await kaveri.gate("payments.get_batch", "read");
    return kaveri.paidBills(req.query.vendorId);
  });
  app.post("/api/payments/batches/:id/lines/:lineId/hold", async (req: Req) => {
    await kaveri.gate("payments.hold_line", "write");
    return kaveri.holdLine(req.params.id!, req.params.lineId!, str(req.body.reason), actorOf(req));
  });
  app.post("/api/payments/batches/:id/lines/:lineId/clear", async (req: Req) => {
    await kaveri.gate("payments.clear_line", "write");
    return kaveri.clearLine(req.params.id!, req.params.lineId!, actorOf(req), str(req.body.note) || undefined);
  });
  app.post("/api/payments/batches/:id/lines/:lineId/correct", async (req: Req) => {
    await kaveri.gate("payments.correct_line", "write");
    return kaveri.correctLine(req.params.id!, req.params.lineId!, { tds: Number(req.body.tds), reason: str(req.body.reason) }, actorOf(req));
  });
  app.post("/api/payments/batches/:id/release", async (req: Req) => {
    await kaveri.gate("payments.release_batch", "write");
    return kaveri.releaseBatch(req.params.id!, str(req.body.approvedBy) || undefined);
  });

  /* ============================================================ ADMIN */
  // Ground truth + controls for evals and demos. Not visible to the agent's tools.

  app.post("/__admin/reset", async (req: Req) => {
    kaveri.reset((req.body?.faults as Partial<FaultConfig>) ?? {});
    return { ok: true, today: kaveri.state.today };
  });
  app.get("/__admin/faults", async () => kaveri.faults);
  app.post("/__admin/faults", async (req: Req) => {
    kaveri.setFaults(req.body as Partial<FaultConfig>);
    return kaveri.faults;
  });
  app.get("/__admin/state", async () => kaveri.state);
  app.get("/__admin/traps", async () => TRAPS);

  /* ============================================================= HTML */

  app.get("/", async (_req, reply) => reply.redirect("/mail"));

  app.get("/mail", async (req: Req, reply) => {
    await kaveri.gate("mail.search", "read");
    const folder = req.query.folder ?? "inbox";
    const rows = kaveri.listMail({ folder, q: req.query.q });
    return html(reply, layout("Mail", "/mail", `
      <h1>Mail · ${esc(folder)}</h1>
      <form class="row" method="get" action="/mail" role="search"><input type="hidden" name="folder" value="${esc(folder)}">
        <input name="q" aria-label="Search mail" placeholder="Search mail" value="${esc(req.query.q)}"><button>Search</button>
        <span class="muted">Folders:</span> ${["inbox", "drafts", "sent"].map((f) => `<a href="/mail?folder=${f}">${f}</a>`).join(" · ")}</form>
      <div class="card" style="margin-top:16px"><table><thead><tr><th>From</th><th>Subject</th><th>📎</th><th>Received</th></tr></thead><tbody>
      ${rows.map((m) => `<tr class="${m.read ? "" : "unread"}" data-mail-id="${m.id}"><td>${esc(m.fromName)}<div class="muted mono">${esc(m.from)}</div></td>
        <td><a href="/mail/${m.id}">${esc(m.subject)}</a></td><td>${m.attachments.length || ""}</td><td class="mono">${esc(m.receivedAt.slice(0, 16).replace("T", " "))}</td></tr>`).join("")}
      </tbody></table></div>`, req.query.flash));
  });

  app.get("/mail/:id", async (req: Req, reply) => {
    await kaveri.gate("mail.read", "read");
    const m = kaveri.getMail(req.params.id!);
    return html(reply, layout(m.subject, "/mail", `
      <p><a href="/mail">← Inbox</a></p><div class="card"><h1>${esc(m.subject)}</h1>
      <dl><dt>From</dt><dd>${esc(m.fromName)} &lt;<span class="mono">${esc(m.from)}</span>&gt;</dd><dt>To</dt><dd class="mono">${esc(m.to)}</dd>
      <dt>Received</dt><dd class="mono">${esc(m.receivedAt)}</dd><dt>Message id</dt><dd class="mono">${m.id}</dd></dl>
      <hr style="border:0;border-top:1px solid var(--border);margin:16px 0"><pre>${esc(m.body)}</pre>
      ${m.attachments.length ? `<h2>Attachments</h2><ul>${m.attachments.map((a) => `<li><a href="/api/mail/${m.id}/attachments/${encodeURIComponent(a.name)}" target="_blank">${esc(a.name)}</a></li>`).join("")}</ul>` : ""}
      </div>`));
  });

  app.get("/erp/vendors", async (req: Req, reply) => {
    await kaveri.gate("vendor.search", "read");
    const rows = kaveri.searchVendors(req.query.q);
    return html(reply, layout("Vendors", "/erp/vendors", `
      <h1>Vendor master</h1><form class="row" method="get" role="search"><input name="q" aria-label="Search vendors" placeholder="Name, PAN, GSTIN, id" value="${esc(req.query.q)}"><button>Search</button></form>
      <div class="card" style="margin-top:16px"><table><thead><tr><th>Id</th><th>Legal name</th><th>PAN</th><th>GSTIN</th><th>MSME</th><th>Status</th><th>Payments</th></tr></thead><tbody>
      ${rows.map((v) => `<tr data-vendor-id="${v.id}"><td class="mono"><a href="/erp/vendors/${v.id}">${v.id}</a></td><td>${esc(v.legalName)}</td><td class="mono">${esc(v.pan)}</td>
        <td class="mono">${esc(v.gstin ?? "—")}</td><td>${esc(v.udyam?.category ?? "—")}</td><td>${statusTag(v.status)}</td><td>${v.paymentsOnHold ? statusTag("held") : '<span class="muted">open</span>'}</td></tr>`).join("")}
      </tbody></table></div>`, req.query.flash));
  });

  app.get("/erp/vendors/:id", async (req: Req, reply) => {
    await kaveri.gate("vendor.get", "read");
    const v = kaveri.getVendor(req.params.id!);
    return html(reply, layout(v.legalName, "/erp/vendors", `
      <p><a href="/erp/vendors">← Vendors</a></p><div class="card"><h1>${esc(v.legalName)} <span class="mono muted">${v.id}</span> ${statusTag(v.status)} ${v.paymentsOnHold ? statusTag("held") : ""}</h1>
      <dl><dt>Trade name</dt><dd>${esc(v.tradeName ?? "—")}</dd><dt>PAN</dt><dd class="mono">${esc(v.pan ?? "—")}</dd><dt>GSTIN</dt><dd class="mono">${esc(v.gstin ?? "—")}</dd>
      <dt>Address</dt><dd>${esc(v.address)}</dd><dt>Email</dt><dd class="mono">${esc(v.email)}</dd><dt>Phone (on record)</dt><dd class="mono">${esc(v.phone)}</dd>
      <dt>Bank</dt><dd class="mono">${esc(v.bank.accountNumber)} · ${esc(v.bank.ifsc)} · ${esc(v.bank.holderName)}</dd>
      <dt>Udyam</dt><dd>${v.udyam ? `${esc(v.udyam.number)} (${esc(v.udyam.category)})` : "—"}</dd><dt>Agreed credit days</dt><dd>${esc(v.agreedCreditDays ?? "—")}</dd>
      <dt>Created / approved</dt><dd class="mono">${esc(v.createdBy)} · ${esc(v.approvedBy ?? "—")}</dd>${v.holdReason ? `<dt>Hold reason</dt><dd>${esc(v.holdReason)}</dd>` : ""}</dl>
      <div class="row" style="margin-top:16px">${v.paymentsOnHold
        ? `<form class="inline" method="post" action="/erp/vendors/${v.id}/release"><button>Release payments</button></form>`
        : `<form class="inline" method="post" action="/erp/vendors/${v.id}/hold"><input name="reason" aria-label="Hold reason" placeholder="Reason for hold" required><button class="danger">Hold all payments</button></form>`}</div></div>
      <h2>Change history</h2><div class="card"><table><thead><tr><th>When</th><th>By</th><th>Field</th><th>Before → After</th><th>Source</th></tr></thead><tbody>
      ${v.history.map((h) => `<tr><td class="mono">${esc(h.at.slice(0, 16).replace("T", " "))}</td><td class="mono">${esc(h.by)}</td><td>${esc(h.field)}</td>
        <td class="mono">${esc(JSON.stringify(h.before))} → ${esc(JSON.stringify(h.after))}</td><td>${esc(h.source ?? "")}</td></tr>`).join("") || '<tr><td colspan="5" class="muted">No changes</td></tr>'}
      </tbody></table></div>`, req.query.flash));
  });
  app.post("/erp/vendors/:id/hold", async (req: Req, reply) => {
    await kaveri.gate("vendor.hold_payments", "write");
    kaveri.holdVendorPayments(req.params.id!, str(req.body.reason), actorOf(req));
    return back(reply, `/erp/vendors/${req.params.id}`, "Payments to this vendor are on hold.");
  });
  app.post("/erp/vendors/:id/release", async (req: Req, reply) => {
    await kaveri.gate("vendor.release_payments", "write");
    kaveri.releaseVendorPayments(req.params.id!, actorOf(req));
    return back(reply, `/erp/vendors/${req.params.id}`, "Payments released.");
  });

  app.get("/erp/payments/:id", async (req: Req, reply) => {
    await kaveri.gate("payments.get_batch", "read");
    const b = kaveri.getBatch(req.params.id!);
    const name = (id: string) => kaveri.state.vendors.find((v) => v.id === id)?.legalName ?? id;
    const total = b.lines.reduce((s, l) => s + l.net, 0);
    return html(reply, layout(b.id, "/erp/payments", `
      <h1>${esc(b.title)} <span class="mono muted">${b.id}</span> ${statusTag(b.status)}</h1>
      <p class="muted">Scheduled for ${esc(b.scheduledFor)} · ${b.lines.length} lines · net ${inr(total)}</p>
      <div class="card"><table><thead><tr><th>Line</th><th>Vendor</th><th>Bill</th><th>Accepted</th><th class="right">Gross</th><th class="right">TDS</th><th class="right">Net</th><th>Pay to</th><th>Status</th><th></th></tr></thead><tbody>
      ${b.lines.map((l) => `<tr data-line-id="${l.id}"><td class="mono">${l.id}</td><td><a href="/erp/vendors/${l.vendorId}">${esc(name(l.vendorId))}</a><div class="muted">${esc(l.description)}</div></td>
        <td class="mono">${esc(l.billNumber)}</td><td class="mono">${esc(l.acceptedOn)}</td><td class="right mono">${inr(l.gross)}</td>
        <td class="right mono">${inr(l.tds)}<div class="muted">${(l.tdsRate * 100).toFixed(1)}%</div></td><td class="right mono">${inr(l.net)}</td>
        <td class="mono">${esc(l.payTo.accountNumber)}<div class="muted">${esc(l.payTo.ifsc)}</div></td><td>${statusTag(l.status)}${l.note ? `<div class="muted">${esc(l.note)}</div>` : ""}</td>
        <td>${b.status === "draft" ? `<form class="inline" method="post" action="/erp/payments/${b.id}/lines/${l.id}/hold"><input name="reason" aria-label="Hold reason for ${l.id}" placeholder="Reason" required style="width:110px"><button class="danger">Hold</button></form>
          <form class="inline" method="post" action="/erp/payments/${b.id}/lines/${l.id}/clear"><button>Clear</button></form>` : ""}</td></tr>`).join("")}
      </tbody></table></div>`, req.query.flash));
  });
  app.post("/erp/payments/:id/lines/:lineId/hold", async (req: Req, reply) => {
    await kaveri.gate("payments.hold_line", "write");
    kaveri.holdLine(req.params.id!, req.params.lineId!, str(req.body.reason), actorOf(req));
    return back(reply, `/erp/payments/${req.params.id}`, `${req.params.lineId} held.`);
  });
  app.post("/erp/payments/:id/lines/:lineId/clear", async (req: Req, reply) => {
    await kaveri.gate("payments.clear_line", "write");
    kaveri.clearLine(req.params.id!, req.params.lineId!, actorOf(req));
    return back(reply, `/erp/payments/${req.params.id}`, `${req.params.lineId} cleared.`);
  });

  app.get("/gst", async (req: Req, reply) => {
    let result = "";
    if (req.query.gstin) {
      await kaveri.gate("gov.gstin_status", "read");
      try {
        const r = kaveri.gstinLookup(req.query.gstin);
        result = `<div class="card"><dl><dt>GSTIN</dt><dd class="mono">${esc(r.gstin)}</dd><dt>Legal name</dt><dd>${esc(r.legalName)}</dd>
          <dt>Status</dt><dd>${statusTag(r.status)}</dd><dt>Registered on</dt><dd class="mono">${esc(r.registeredOn)}</dd><dt>State code</dt><dd class="mono">${esc(r.stateCode)}</dd></dl></div>`;
      } catch (e) {
        result = `<div class="flash err" role="alert">${esc((e as Error).message)}</div>`;
      }
    }
    return html(reply, layout("GST Portal", "/gst", `<h1>GST Portal · Search taxpayer</h1>
      <form class="row card" method="get"><input name="gstin" aria-label="GSTIN" placeholder="15-character GSTIN" value="${esc(req.query.gstin)}" size="20"><button class="primary">Search</button></form>${result}`));
  });

  app.get("/bank", async (req: Req, reply) => {
    let result = "";
    if (req.query.accountNumber) {
      await kaveri.gate("bank.penny_drop", "read");
      const r = kaveri.pennyDrop(req.query.accountNumber, req.query.ifsc ?? "");
      result = r.ok ? `<div class="flash" role="status">Name at bank: <strong>${esc(r.nameAtBank)}</strong></div>` : `<div class="flash err" role="alert">${esc(r.message)}</div>`;
    }
    if (req.query.bg) {
      await kaveri.gate("bank.verify_guarantee", "read");
      const r = kaveri.verifyGuarantee(req.query.bg);
      result += r.confirmed ? `<div class="flash" role="status">Guarantee confirmed by ${esc(r.issuingBank)} · ${inr(r.amount!)} · valid until ${esc(r.validUntil)}</div>` : `<div class="flash err" role="alert">${esc(r.message)}</div>`;
    }
    return html(reply, layout("Bank", "/bank", `<h1>Corporate banking</h1>
      <div class="card"><h2 style="margin-top:0">Beneficiary validation (penny-drop)</h2><form class="row" method="get"><input name="accountNumber" aria-label="Account number" placeholder="Account number">
      <input name="ifsc" aria-label="IFSC" placeholder="IFSC"><button class="primary">Validate</button></form></div>
      <div class="card"><h2 style="margin-top:0">Bank guarantee confirmation</h2><form class="row" method="get"><input name="bg" aria-label="Guarantee number" placeholder="Guarantee number" size="28"><button class="primary">Confirm</button></form></div>${result}`));
  });

  app.get("/hr", async (_req: Req, reply) => {
    await kaveri.gate("hr.search_employees", "read");
    return html(reply, layout("HR & Lists", "/hr", `<h1>Employees</h1><div class="card"><table><thead><tr><th>Id</th><th>Name</th><th>Department</th><th>Address</th><th>Bank a/c</th></tr></thead><tbody>
      ${kaveri.searchEmployees().map((e) => `<tr><td class="mono">${e.id}</td><td>${esc(e.name)}</td><td>${esc(e.department)}</td><td>${esc(e.address)}</td><td class="mono">${esc(e.bankAccount)}</td></tr>`).join("")}</tbody></table></div>
      <h1>Debarment register</h1><div class="card"><table><thead><tr><th>Name</th><th>PAN</th><th>Reason</th><th>Until</th></tr></thead><tbody>
      ${kaveri.searchDebarment().map((d) => `<tr><td>${esc(d.name)}</td><td class="mono">${esc(d.pan)}</td><td>${esc(d.reason)}</td><td class="mono">${esc(d.until)}</td></tr>`).join("")}</tbody></table></div>`));
  });

  app.get("/admin", async (req: Req, reply) => {
    const f = kaveri.faults;
    return html(reply, layout("Admin", "/admin", `<h1>Environment admin <span class="tag warn">not visible to the agent</span></h1>
      <div class="card row"><form class="inline" method="post" action="/admin/reset"><button class="danger">Reset world to seed</button></form>
        <span class="muted">Scenario date: <span class="mono">${esc(kaveri.state.today)}</span> · ${kaveri.state.auditLog.length} audit entries</span></div>
      <div class="card"><h2 style="margin-top:0">Fault injection</h2><form method="post" action="/admin/faults" class="row">
        <label>Fail rate (writes) <input name="failRate" type="number" step="0.05" min="0" max="1" value="${f.failRate}" style="width:90px"></label>
        <label>Latency ms <input name="latencyMs" type="number" min="0" value="${f.latencyMs}" style="width:90px"></label>
        <label>Fail next <input name="failOp" placeholder="e.g. payments.hold_line" style="width:220px"></label><input name="failCount" type="number" min="1" value="1" style="width:70px">
        <button class="primary">Apply</button></form><p class="muted mono">failNext: ${esc(JSON.stringify(f.failNext))}</p></div>
      <h2>Planted traps (ground truth)</h2><div class="card"><table><thead><tr><th>Id</th><th>Where</th><th>Expected behaviour</th><th>Real-world source</th></tr></thead><tbody>
      ${TRAPS.map((t) => `<tr><td class="mono">${t.id}</td><td>${esc(t.where)}</td><td>${esc(t.expect)}</td><td class="muted">${esc(t.source)}</td></tr>`).join("")}</tbody></table></div>
      <h2>Audit log</h2><div class="card"><table><thead><tr><th>When</th><th>Actor</th><th>Action</th><th>Detail</th></tr></thead><tbody>
      ${[...kaveri.state.auditLog].reverse().map((a) => `<tr><td class="mono">${esc(a.at.slice(11, 19))}</td><td class="mono">${esc(a.actor)}</td><td>${esc(a.action)}</td><td>${esc(a.detail)}</td></tr>`).join("") || '<tr><td colspan="4" class="muted">Nothing yet</td></tr>'}</tbody></table></div>`, req.query.flash));
  });
  app.post("/admin/reset", async (_req, reply) => {
    kaveri.reset();
    return back(reply, "/admin", "World reset to the seed scenario.");
  });
  app.post("/admin/faults", async (req: Req, reply) => {
    const failNext = { ...kaveri.faults.failNext };
    if (str(req.body.failOp)) failNext[str(req.body.failOp)] = Number(req.body.failCount ?? 1);
    kaveri.setFaults({ failRate: Number(req.body.failRate ?? 0), latencyMs: Number(req.body.latencyMs ?? 0), failNext });
    return back(reply, "/admin", "Faults updated.");
  });

  return app;
}
