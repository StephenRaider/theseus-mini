import { batchToXlsx } from "../exports.ts";
import { esc, inr, statusTag, THEMES } from "../html.ts";
import type { Kaveri } from "../store.ts";
import { actorOf, createSite, sendFile, str, type Req } from "./common.ts";

/** Kaveri ERP: vendor master (maker-checker), payment batches (+ Excel export), HR & debarment lists. */
export function erpSite(kaveri: Kaveri) {
  const site = createSite(kaveri, THEMES.erp([["/vendors", "Vendors"], ["/payments", "Payments"], ["/hr", "HR & Lists"]]));
  const { app, page, back } = site;

  /* ------------------------------------------------------------- API */
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
    return reply.status(201).send(kaveri.createPendingVendor(req.body as never, actorOf(req)));
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
  app.get("/api/hr/employees", async (req: Req) => {
    await kaveri.gate("hr.search_employees", "read");
    return kaveri.searchEmployees(req.query.q);
  });
  app.get("/api/lists/debarment", async (req: Req) => {
    await kaveri.gate("lists.check_debarment", "read");
    return kaveri.searchDebarment(req.query.q);
  });
  app.get("/api/payments/batches", async () => kaveri.state.batches.map(({ lines, ...b }) => ({ ...b, lines: lines.length })));
  app.get("/api/payments/batches/:id", async (req: Req) => {
    await kaveri.gate("payments.get_batch", "read");
    return kaveri.getBatch(req.params.id!);
  });
  app.get("/api/payments/batches/:id/export.xlsx", async (req: Req, reply) => {
    await kaveri.gate("payments.export", "read");
    return sendFile(reply, `${req.params.id}.xlsx`, "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", await batchToXlsx(kaveri, req.params.id!));
  });
  app.get("/api/payments/paid", async (req: Req) => {
    await kaveri.gate("payments.get_batch", "read");
    return kaveri.paidBills(req.query.vendorId);
  });
  for (const [action, op] of [["hold", "payments.hold_line"], ["clear", "payments.clear_line"], ["correct", "payments.correct_line"]] as const) {
    app.post(`/api/payments/batches/:id/lines/:lineId/${action}`, async (req: Req) => {
      await kaveri.gate(op, "write");
      const { id, lineId } = req.params as { id: string; lineId: string };
      if (action === "hold") return kaveri.holdLine(id, lineId, str(req.body.reason), actorOf(req));
      if (action === "clear") return kaveri.clearLine(id, lineId, actorOf(req), str(req.body.note) || undefined);
      return kaveri.correctLine(id, lineId, { tds: Number(req.body.tds), reason: str(req.body.reason) }, actorOf(req));
    });
  }
  app.post("/api/payments/batches/:id/release", async (req: Req) => {
    await kaveri.gate("payments.release_batch", "write");
    return kaveri.releaseBatch(req.params.id!, str(req.body.approvedBy) || undefined);
  });

  /* ------------------------------------------------------------ HTML */
  app.get("/", async (_req, reply) => reply.redirect("/vendors"));

  app.get("/vendors", async (req: Req, reply) => {
    await kaveri.gate("vendor.search", "read");
    const rows = kaveri.searchVendors(req.query.q);
    return page(reply, "Vendors", "/vendors", `
      <h1>Vendor master <span class="muted">(${rows.length})</span></h1><form class="row" method="get" role="search"><input name="q" aria-label="Search vendors" placeholder="Name, PAN, GSTIN, id" value="${esc(req.query.q)}" size="32"><button>Search</button></form>
      <div class="card" style="margin-top:16px;padding:0"><table><thead><tr><th>Id</th><th>Legal name</th><th>PAN</th><th>GSTIN</th><th>MSME</th><th>Status</th><th>Payments</th></tr></thead><tbody>
      ${rows.map((v) => `<tr data-vendor-id="${v.id}"><td class="mono"><a href="/vendors/${v.id}">${v.id}</a></td><td>${esc(v.legalName)}</td><td class="mono">${esc(v.pan)}</td>
        <td class="mono">${esc(v.gstin ?? "—")}</td><td>${esc(v.udyam?.category ?? "—")}</td><td>${statusTag(v.status)}</td><td>${v.paymentsOnHold ? statusTag("held") : '<span class="muted">open</span>'}</td></tr>`).join("")}
      </tbody></table></div>`, req.query.flash);
  });

  app.get("/vendors/:id", async (req: Req, reply) => {
    await kaveri.gate("vendor.get", "read");
    const v = kaveri.getVendor(req.params.id!);
    return page(reply, v.legalName, "/vendors", `
      <p><a href="/vendors">← Vendors</a></p><div class="card"><h1>${esc(v.legalName)} <span class="mono muted">${v.id}</span> ${statusTag(v.status)} ${v.paymentsOnHold ? statusTag("held") : ""}</h1>
      <dl><dt>Trade name</dt><dd>${esc(v.tradeName ?? "—")}</dd><dt>PAN</dt><dd class="mono">${esc(v.pan ?? "—")}</dd><dt>GSTIN</dt><dd class="mono">${esc(v.gstin ?? "—")}</dd>
      <dt>Address</dt><dd>${esc(v.address)}</dd><dt>Email</dt><dd class="mono">${esc(v.email)}</dd><dt>Phone (on record)</dt><dd class="mono">${esc(v.phone)}</dd>
      <dt>Bank</dt><dd class="mono">${esc(v.bank.accountNumber)} · ${esc(v.bank.ifsc)} · ${esc(v.bank.holderName)}</dd>
      <dt>Udyam</dt><dd>${v.udyam ? `${esc(v.udyam.number)} (${esc(v.udyam.category)})` : "—"}</dd><dt>Agreed credit days</dt><dd>${esc(v.agreedCreditDays ?? "—")}</dd>
      <dt>Created / approved</dt><dd class="mono">${esc(v.createdBy)} · ${esc(v.approvedBy ?? "—")}</dd>${v.holdReason ? `<dt>Hold reason</dt><dd>${esc(v.holdReason)}</dd>` : ""}</dl>
      <div class="row" style="margin-top:16px">${v.paymentsOnHold
        ? `<form class="inline" method="post" action="/vendors/${v.id}/release"><button>Release payments</button></form>`
        : `<form class="inline" method="post" action="/vendors/${v.id}/hold"><input name="reason" aria-label="Hold reason" placeholder="Reason for hold" required size="40"><button class="danger">Hold all payments</button></form>`}</div></div>
      <h2>Change history</h2><div class="card" style="padding:0"><table><thead><tr><th>When</th><th>By</th><th>Field</th><th>Before → After</th><th>Source</th></tr></thead><tbody>
      ${v.history.map((h) => `<tr><td class="mono">${esc(h.at.slice(0, 16).replace("T", " "))}</td><td class="mono">${esc(h.by)}</td><td>${esc(h.field)}</td>
        <td class="mono" style="white-space:normal">${esc(JSON.stringify(h.before))} → ${esc(JSON.stringify(h.after))}</td><td>${esc(h.source ?? "")}</td></tr>`).join("") || '<tr><td colspan="5" class="muted">No changes</td></tr>'}
      </tbody></table></div>`, req.query.flash);
  });
  app.post("/vendors/:id/hold", async (req: Req, reply) => {
    await kaveri.gate("vendor.hold_payments", "write");
    kaveri.holdVendorPayments(req.params.id!, str(req.body.reason), actorOf(req));
    return back(reply, `/vendors/${req.params.id}`, "Payments to this vendor are on hold.");
  });
  app.post("/vendors/:id/release", async (req: Req, reply) => {
    await kaveri.gate("vendor.release_payments", "write");
    kaveri.releaseVendorPayments(req.params.id!, actorOf(req));
    return back(reply, `/vendors/${req.params.id}`, "Payments released.");
  });

  app.get("/payments", async (_req, reply) =>
    page(reply, "Payments", "/payments", `<h1>Payment batches</h1><div class="card" style="padding:0"><table><thead><tr><th>Batch</th><th>Title</th><th>Scheduled</th><th>Lines</th><th>Status</th></tr></thead><tbody>
      ${kaveri.state.batches.map((b) => `<tr><td class="mono"><a href="/payments/${b.id}">${b.id}</a></td><td>${esc(b.title)}</td><td class="mono">${esc(b.scheduledFor)}</td><td>${b.lines.length}</td><td>${statusTag(b.status)}</td></tr>`).join("")}</tbody></table></div>`));

  app.get("/payments/:id", async (req: Req, reply) => {
    await kaveri.gate("payments.get_batch", "read");
    const b = kaveri.getBatch(req.params.id!);
    const name = (id: string) => kaveri.state.vendors.find((v) => v.id === id)?.legalName ?? id;
    const total = b.lines.reduce((s, l) => s + l.net, 0);
    const counts = b.lines.reduce<Record<string, number>>((a, l) => ((a[l.status] = (a[l.status] ?? 0) + 1), a), {});
    return page(reply, b.id, "/payments", `
      <h1>${esc(b.title)} <span class="mono muted">${b.id}</span> ${statusTag(b.status)}</h1>
      <div class="row"><span class="muted">Scheduled for ${esc(b.scheduledFor)} · ${b.lines.length} lines · net ${inr(total)} · ${Object.entries(counts).map(([k, n]) => `${n} ${k}`).join(" · ")}</span>
        <a href="/payments/${b.id}/export.xlsx" download="${b.id}.xlsx"><button class="primary">Export to Excel</button></a></div>
      <div class="card" style="margin-top:16px;padding:0"><table><thead><tr><th>Line</th><th>Vendor</th><th>Bill</th><th>Accepted</th><th class="right">Gross</th><th class="right">TDS</th><th class="right">Net</th><th>Pay to</th><th>Status</th><th></th></tr></thead><tbody>
      ${b.lines.map((l) => `<tr data-line-id="${l.id}"><td class="mono">${l.id}</td><td><a href="/vendors/${l.vendorId}">${esc(name(l.vendorId))}</a><div class="muted">${esc(l.description)}</div></td>
        <td class="mono">${esc(l.billNumber)}</td><td class="mono">${esc(l.acceptedOn)}</td><td class="right mono">${inr(l.gross)}</td>
        <td class="right mono">${inr(l.tds)}<div class="muted">${(l.tdsRate * 100).toFixed(1)}%</div></td><td class="right mono">${inr(l.net)}</td>
        <td class="mono">${esc(l.payTo.accountNumber)}<div class="muted">${esc(l.payTo.ifsc)}</div></td><td>${statusTag(l.status)}${l.note ? `<div class="muted">${esc(l.note)}</div>` : ""}</td>
        <td>${b.status === "draft" ? `<form class="inline" method="post" action="/payments/${b.id}/lines/${l.id}/hold"><input name="reason" aria-label="Hold reason for ${l.id}" placeholder="Reason" required style="width:110px"><button class="danger">Hold</button></form>
          <form class="inline" method="post" action="/payments/${b.id}/lines/${l.id}/clear"><button>Clear</button></form>` : ""}</td></tr>`).join("")}
      </tbody></table></div>`, req.query.flash);
  });
  app.get("/payments/:id/export.xlsx", async (req: Req, reply) => {
    await kaveri.gate("payments.export", "read");
    return sendFile(reply, `${req.params.id}.xlsx`, "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", await batchToXlsx(kaveri, req.params.id!));
  });
  app.post("/payments/:id/lines/:lineId/hold", async (req: Req, reply) => {
    await kaveri.gate("payments.hold_line", "write");
    kaveri.holdLine(req.params.id!, req.params.lineId!, str(req.body.reason), actorOf(req));
    return back(reply, `/payments/${req.params.id}`, `${req.params.lineId} held.`);
  });
  app.post("/payments/:id/lines/:lineId/clear", async (req: Req, reply) => {
    await kaveri.gate("payments.clear_line", "write");
    kaveri.clearLine(req.params.id!, req.params.lineId!, actorOf(req));
    return back(reply, `/payments/${req.params.id}`, `${req.params.lineId} cleared.`);
  });

  app.get("/hr", async (_req: Req, reply) => {
    await kaveri.gate("hr.search_employees", "read");
    return page(reply, "HR & Lists", "/hr", `<div class="grid2"><div><h1>Employees <span class="muted">(${kaveri.state.employees.length})</span></h1><div class="card" style="padding:0"><table><thead><tr><th>Id</th><th>Name</th><th>Department</th><th>Address</th><th>Bank a/c</th></tr></thead><tbody>
      ${kaveri.searchEmployees().map((e) => `<tr><td class="mono">${e.id}</td><td>${esc(e.name)}</td><td>${esc(e.department)}</td><td>${esc(e.address)}</td><td class="mono">${esc(e.bankAccount)}</td></tr>`).join("")}</tbody></table></div></div>
      <div><h1>Debarment register <span class="muted">(${kaveri.state.debarment.length})</span></h1><div class="card" style="padding:0"><table><thead><tr><th>Name</th><th>PAN</th><th>Reason</th><th>Until</th></tr></thead><tbody>
      ${kaveri.searchDebarment().map((d) => `<tr><td>${esc(d.name)}</td><td class="mono">${esc(d.pan)}</td><td>${esc(d.reason)}</td><td class="mono">${esc(d.until)}</td></tr>`).join("")}</tbody></table></div></div></div>`);
  });

  return site;
}
