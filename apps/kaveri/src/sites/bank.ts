import { esc, inr, statusTag, THEMES } from "../html.ts";
import { KaveriError, type Kaveri } from "../store.ts";
import { actorOf, createSite, str, type Req } from "./common.ts";

/**
 * Bharat Bank · Corporate (fictional): beneficiary validation (penny-drop),
 * bank-guarantee confirmation, and bulk payment-file upload with
 * maker-checker authorisation, like a real corporate net-banking portal.
 */
export function bankSite(kaveri: Kaveri) {
  const site = createSite(kaveri, THEMES.bank([["/", "Overview"], ["/beneficiary", "Validate beneficiary"], ["/guarantees", "Bank guarantees"], ["/bulk", "Bulk payments"]]));
  const { app, page, back } = site;

  async function readUpload(req: Req): Promise<{ filename: string; csv: string }> {
    if (req.isMultipart()) {
      const file = await req.file();
      if (!file) throw new KaveriError(422, "NO_FILE", "Choose a CSV file to upload");
      return { filename: file.filename, csv: (await file.toBuffer()).toString("utf8") };
    }
    return { filename: str(req.body.filename) || "upload.csv", csv: str(req.body.csv) };
  }

  /* ------------------------------------------------------------- API */
  app.post("/api/beneficiary/validate", async (req: Req) => {
    await kaveri.gate("bank.penny_drop", "read");
    return kaveri.pennyDrop(str(req.body.accountNumber), str(req.body.ifsc));
  });
  app.post("/api/guarantees/verify", async (req: Req) => {
    await kaveri.gate("bank.verify_guarantee", "read");
    return kaveri.verifyGuarantee(str(req.body.number));
  });
  app.get("/api/payment-files", async () => kaveri.state.paymentFiles);
  app.get("/api/payment-files/:id", async (req: Req) => kaveri.getPaymentFile(req.params.id!));
  app.post("/api/payment-files", async (req: Req, reply) => {
    await kaveri.gate("bank.upload_payment_file", "write");
    const { filename, csv } = await readUpload(req);
    return reply.status(201).send(kaveri.uploadPaymentFile(filename, csv, actorOf(req)));
  });
  app.post("/api/payment-files/:id/authorise", async (req: Req) => {
    await kaveri.gate("bank.authorise_payment_file", "write");
    return kaveri.authorisePaymentFile(req.params.id!, str(req.body.approvedBy) || undefined);
  });
  app.post("/api/payment-files/:id/reject", async (req: Req) => kaveri.rejectPaymentFile(req.params.id!, actorOf(req), str(req.body.note)));

  /* ------------------------------------------------------------ HTML */
  app.get("/", async (req: Req, reply) => {
    const files = kaveri.state.paymentFiles;
    return page(reply, "Overview", "/", `<h1>Welcome, Kaveri Infra Pvt Ltd</h1>
      <div class="grid2"><div class="card"><h2 style="margin-top:0">Current account ••••4471</h2><p style="font-size:24px;margin:4px 0">${inr(48_250_000)}</p><p class="muted">Available balance as of ${esc(kaveri.state.today)} 09:00</p></div>
      <div class="card"><h2 style="margin-top:0">Bulk payment files</h2><p>${files.filter((f) => f.status === "pending_authorisation").length} awaiting authorisation · ${files.filter((f) => f.status === "authorised").length} authorised</p><a href="/bulk">Go to bulk payments →</a></div></div>
      <div class="card"><h2 style="margin-top:0">Services</h2><ul><li><a href="/beneficiary">Validate a beneficiary account</a> (name check via ₹1 credit)</li><li><a href="/guarantees">Confirm a bank guarantee</a></li><li><a href="/bulk">Upload a bulk payment file (CSV)</a></li></ul></div>`, req.query.flash);
  });

  app.get("/beneficiary", async (req: Req, reply) => {
    let result = "";
    if (req.query.accountNumber) {
      await kaveri.gate("bank.penny_drop", "read");
      const r = kaveri.pennyDrop(req.query.accountNumber, req.query.ifsc ?? "");
      result = r.ok ? `<div class="flash" role="status" data-name-at-bank="${esc(r.nameAtBank)}">Account validated. Name at bank: <strong>${esc(r.nameAtBank)}</strong></div>` : `<div class="flash err" role="alert">${esc(r.message)}</div>`;
    }
    return page(reply, "Validate beneficiary", "/beneficiary", `<h1>Beneficiary validation</h1><p class="muted">We credit ₹1 to the account and return the account holder's name as recorded by the beneficiary bank.</p>
      <form class="card row" method="get"><label>Account number <input name="accountNumber" value="${esc(req.query.accountNumber)}" required></label>
      <label>IFSC <input name="ifsc" value="${esc(req.query.ifsc)}" required size="12"></label><button class="primary">Validate</button></form>${result}`);
  });

  app.get("/guarantees", async (req: Req, reply) => {
    let result = "";
    if (req.query.number) {
      await kaveri.gate("bank.verify_guarantee", "read");
      const r = kaveri.verifyGuarantee(req.query.number);
      result = r.confirmed
        ? `<div class="flash" role="status">Confirmed by ${esc(r.issuingBank)} · ${inr(r.amount!)} · valid until ${esc(r.validUntil)}</div>`
        : `<div class="flash err" role="alert">${esc(r.message)}</div>`;
    }
    return page(reply, "Bank guarantees", "/guarantees", `<h1>Bank guarantee confirmation</h1><p class="muted">Confirms with the issuing bank whether a guarantee in your favour is genuine (SFMS confirmation, simulated).</p>
      <form class="card row" method="get"><label>Guarantee number <input name="number" value="${esc(req.query.number)}" required size="28"></label><button class="primary">Confirm</button></form>${result}`);
  });

  app.get("/bulk", async (req: Req, reply) =>
    page(reply, "Bulk payments", "/bulk", `<h1>Bulk payments</h1>
      <form class="card" method="post" action="/bulk" enctype="multipart/form-data" style="display:grid;gap:10px">
        <label>Payment file (CSV) <input type="file" name="file" accept=".csv,text/csv" required></label>
        <p class="muted mono" style="margin:0">Header: beneficiary_name,account_number,ifsc,amount,reference</p>
        <div class="row"><button class="primary">Upload for authorisation</button><span class="muted">Uploaded files must be authorised by a different user (maker-checker).</span></div></form>
      <div class="card" style="padding:0"><table><thead><tr><th>File id</th><th>Name</th><th>Uploaded by</th><th>Rows</th><th class="right">Total</th><th>Status</th></tr></thead><tbody>
      ${[...kaveri.state.paymentFiles].reverse().map((f) => `<tr><td class="mono"><a href="/bulk/${f.id}">${f.id}</a></td><td>${esc(f.filename)}</td><td class="mono">${esc(f.uploadedBy)}</td><td>${f.rows.length}${f.rows.some((r) => !r.valid) ? ` <span class="tag bad">${f.rows.filter((r) => !r.valid).length} invalid</span>` : ""}</td><td class="right mono">${inr(f.totalAmount)}</td><td>${statusTag(f.status)}</td></tr>`).join("") || '<tr><td colspan="6" class="muted">No files uploaded yet</td></tr>'}
      </tbody></table></div>`, req.query.flash));
  app.post("/bulk", async (req: Req, reply) => {
    await kaveri.gate("bank.upload_payment_file", "write");
    const { filename, csv } = await readUpload(req);
    const f = kaveri.uploadPaymentFile(filename, csv, actorOf(req));
    return back(reply, `/bulk/${f.id}`, `Uploaded ${f.rows.length} payments. Awaiting authorisation.`);
  });
  app.get("/bulk/:id", async (req: Req, reply) => {
    const f = kaveri.getPaymentFile(req.params.id!);
    return page(reply, f.id, "/bulk", `<p><a href="/bulk">← Bulk payments</a></p><div class="card"><h1>${esc(f.filename)} <span class="mono muted">${f.id}</span> ${statusTag(f.status)}</h1>
      <dl><dt>Uploaded by</dt><dd class="mono">${esc(f.uploadedBy)} · ${esc(f.uploadedAt.slice(0, 16).replace("T", " "))}</dd><dt>Payments</dt><dd>${f.rows.length} (${f.rows.filter((r) => !r.valid).length} invalid)</dd>
      <dt>Total (valid rows)</dt><dd class="mono">${inr(f.totalAmount)}</dd>${f.authorisedBy ? `<dt>Authorised by</dt><dd class="mono">${esc(f.authorisedBy)}</dd>` : ""}${f.note ? `<dt>Note</dt><dd>${esc(f.note)}</dd>` : ""}</dl>
      ${f.status === "pending_authorisation" ? `<div class="row" style="margin-top:16px"><form class="inline" method="post" action="/bulk/${f.id}/authorise"><button class="primary">Authorise</button></form>
        <form class="inline" method="post" action="/bulk/${f.id}/reject"><input name="note" placeholder="Reason" required><button class="danger">Reject</button></form></div>` : ""}</div>
      <div class="card" style="padding:0"><table><thead><tr><th>#</th><th>Beneficiary</th><th>Account</th><th>IFSC</th><th class="right">Amount</th><th>Reference</th><th>Check</th></tr></thead><tbody>
      ${f.rows.map((r) => `<tr><td>${r.row}</td><td>${esc(r.beneficiaryName)}</td><td class="mono">${esc(r.accountNumber)}</td><td class="mono">${esc(r.ifsc)}</td><td class="right mono">${inr(r.amount || 0)}</td><td class="mono">${esc(r.reference)}</td><td>${r.valid ? statusTag("cleared") : `<span class="tag bad">${esc(r.error)}</span>`}</td></tr>`).join("")}
      </tbody></table></div>`, req.query.flash);
  });
  app.post("/bulk/:id/authorise", async (req: Req, reply) => {
    await kaveri.gate("bank.authorise_payment_file", "write");
    const actor = actorOf(req);
    kaveri.authorisePaymentFile(req.params.id!, actor);
    return back(reply, `/bulk/${req.params.id}`, "File authorised. Payments will be processed in the next NEFT cycle.");
  });
  app.post("/bulk/:id/reject", async (req: Req, reply) => {
    kaveri.rejectPaymentFile(req.params.id!, actorOf(req), str(req.body.note));
    return back(reply, `/bulk/${req.params.id}`, "File rejected.");
  });

  return site;
}
