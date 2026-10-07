import type { FastifyReply } from "fastify";
import { esc, inr, statusTag, THEMES } from "../html.ts";
import { KaveriError, type Kaveri } from "../store.ts";
import { actorOf, createSite, str, type Req } from "./common.ts";

/**
 * Kaveri FinDesk: the legacy AP invoice register. It has NO API on purpose:
 * like many internal systems, the only way in is its web forms. An agent has
 * to sign in, find the form, fill it the way the system insists (DD/MM/YYYY,
 * digits-only amounts), read the error when it doesn't, and confirm a dialog
 * before posting. Sessions can expire mid-task (fault "ap.session_expired").
 */
const COOKIE = "findesk_session";

const isoToDmy = (iso: string) => iso.split("-").reverse().join("/");

function cookieOf(req: Req): string | undefined {
  const raw = String(req.headers.cookie ?? "");
  return raw
    .split(/;\s*/)
    .map((p) => p.split("="))
    .find(([k]) => k === COOKIE)?.[1];
}

export function apSite(kaveri: Kaveri) {
  const site = createSite(kaveri, THEMES.ap([["/invoices", "Invoice register"], ["/invoices/new", "Enter invoice"]]));
  const { app, page, back } = site;

  // Every page except sign-in needs a session.
  app.addHook("preHandler", async (req, reply) => {
    const path = req.url.split("?")[0]!;
    if (path === "/signin") return;
    if (!kaveri.apSessionValid(cookieOf(req as Req))) {
      const expired = !!cookieOf(req as Req);
      return reply.redirect(`/signin?next=${encodeURIComponent(req.method === "GET" ? req.url : "/invoices")}${expired ? "&expired=1" : ""}`);
    }
  });

  app.get("/signin", async (req: Req, reply) =>
    page(
      reply,
      "Sign in",
      "",
      `<div class="card" style="max-width:520px"><h1>FinDesk sign-in</h1>
      ${req.query.expired ? '<div class="flash err" role="alert">Your FinDesk session has expired. Please sign in again.</div>' : ""}
      <p>Kaveri single sign-on recognises you as the <b>Accounts Payable desk</b>.</p>
      <form method="post" action="/signin"><input type="hidden" name="next" value="${esc(req.query.next ?? "/invoices")}">
      <button class="primary">Continue to FinDesk</button></form></div>`,
    ),
  );
  app.post("/signin", async (req: Req, reply) => {
    const token = kaveri.apSignIn(actorOf(req));
    const next = str(req.body.next);
    reply.header("set-cookie", `${COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax`);
    return reply.redirect(next.startsWith("/") ? next : "/invoices");
  });

  app.get("/", async (_req, reply) => reply.redirect("/invoices"));

  app.get("/invoices", async (req: Req, reply) => {
    await kaveri.gate("findesk.list", "read");
    const rows = kaveri.listApInvoices(req.query.q);
    return page(
      reply,
      "Invoice register",
      "/invoices",
      `<h1>Invoice register <span class="muted">(${rows.length})</span></h1>
      <form class="row" method="get" action="/invoices" role="search"><input name="q" aria-label="Search invoices" placeholder="Doc no., vendor or invoice no." value="${esc(req.query.q)}" size="36"><button>Search</button>
      <a href="/invoices/new" style="margin-left:auto">+ Enter invoice</a></form>
      <div class="card" style="margin-top:12px;padding:0"><table><thead><tr><th>Doc no.</th><th>Vendor</th><th>Invoice no.</th><th>Invoice date</th><th>Due date</th><th class="right">Total</th><th>Status</th></tr></thead><tbody>
      ${
        rows
          .map(
            (i) => `<tr data-doc="${i.doc}"><td class="mono"><a href="/invoices/${i.doc}">${i.doc}</a></td><td>${esc(i.vendorName)} <span class="muted mono">${i.vendorId}</span></td>
        <td class="mono">${esc(i.number)}</td><td class="mono">${isoToDmy(i.invoiceDate)}</td><td class="mono">${isoToDmy(i.dueDate)}</td><td class="mono right">${inr(i.total)}</td><td>${statusTag(i.status)}</td></tr>`,
          )
          .join("") || '<tr><td colspan="7" class="muted">No documents match</td></tr>'
      }
      </tbody></table></div>`,
      req.query.flash,
    );
  });

  const form = (reply: FastifyReply, f: Record<string, string>, error?: string, status = 200) => {
    const vendors = kaveri.state.vendors.filter((v) => v.status === "active").sort((a, b) => a.legalName.localeCompare(b.legalName));
    const field = (name: string, label: string, hint = "", attrs = "") =>
      `<label for="f_${name}">${label}</label><div><input id="f_${name}" name="${name}" value="${esc(f[name])}" ${attrs}>${hint ? ` <span class="muted">${hint}</span>` : ""}</div>`;
    reply.status(status);
    return page(
      reply,
      "Enter invoice",
      "/invoices/new",
      `<h1>Enter supplier invoice</h1>
      ${error ? `<div class="flash err" role="alert">${esc(error)}</div>` : ""}
      <form class="card" method="post" action="/invoices" aria-label="Supplier invoice" style="display:grid;grid-template-columns:200px 1fr;gap:10px 16px;max-width:820px;align-items:center">
        <label for="f_vendorId">Vendor</label><div><select id="f_vendorId" name="vendorId" required><option value="">-- select vendor --</option>
          ${vendors.map((v) => `<option value="${v.id}"${f.vendorId === v.id ? " selected" : ""}>${esc(v.legalName)} (${v.id})</option>`).join("")}</select></div>
        ${field("number", "Supplier invoice no.", "", "required size=24")}
        ${field("invoiceDate", "Invoice date", "DD/MM/YYYY", 'size=12 placeholder="DD/MM/YYYY"')}
        ${field("dueDate", "Due date", "DD/MM/YYYY", 'size=12 placeholder="DD/MM/YYYY"')}
        ${field("taxable", "Taxable value (Rs.)", "digits only", "size=14")}
        ${field("gst", "GST amount (Rs.)", "CGST + SGST or IGST", "size=14")}
        ${field("total", "Invoice total (Rs.)", "", "size=14")}
        ${field("workOrder", "Work order / PO", "optional", "size=18")}
        <label for="f_remarks">Remarks</label><div><textarea id="f_remarks" name="remarks" rows="3" cols="60">${esc(f.remarks)}</textarea></div>
        <span></span><div class="row"><button class="primary" type="submit">Save as draft</button><a href="/invoices">Cancel</a></div>
      </form>`,
    );
  };

  app.get("/invoices/new", async (req: Req, reply) => form(reply, req.query));

  app.post("/invoices", async (req: Req, reply) => {
    const f = Object.fromEntries(Object.entries(req.body ?? {}).map(([k, v]) => [k, str(v)]));
    await kaveri.gate("findesk.save_invoice", "write");
    try {
      const inv = kaveri.saveApInvoice(f, actorOf(req));
      return back(reply, `/invoices/${inv.doc}`, `Saved as draft ${inv.doc}. Check it, then post it to the ledger.`);
    } catch (e) {
      if (e instanceof KaveriError && e.status < 500) return form(reply, f, e.message, e.status);
      throw e;
    }
  });

  app.get("/invoices/:doc", async (req: Req, reply) => {
    await kaveri.gate("findesk.get", "read");
    const i = kaveri.getApInvoice(req.params.doc!);
    return page(
      reply,
      i.doc,
      "/invoices",
      `<p><a href="/invoices">← Invoice register</a></p><div class="card"><h1>${i.doc} ${statusTag(i.status)}</h1>
      <dl><dt>Vendor</dt><dd>${esc(i.vendorName)} (${i.vendorId})</dd><dt>Supplier invoice no.</dt><dd class="mono">${esc(i.number)}</dd>
      <dt>Invoice date</dt><dd class="mono">${isoToDmy(i.invoiceDate)}</dd><dt>Due date</dt><dd class="mono">${isoToDmy(i.dueDate)}</dd>
      <dt>Taxable value</dt><dd class="mono">${inr(i.taxable)}</dd><dt>GST</dt><dd class="mono">${inr(i.gst)}</dd><dt>Invoice total</dt><dd class="mono">${inr(i.total)}</dd>
      <dt>Work order</dt><dd class="mono">${esc(i.workOrder ?? "-")}</dd><dt>Remarks</dt><dd>${esc(i.remarks ?? "-")}</dd>
      <dt>Entered by</dt><dd class="mono">${esc(i.enteredBy)} · ${esc(i.enteredAt.slice(0, 16).replace("T", " "))}</dd>
      ${i.postedBy ? `<dt>Posted by</dt><dd class="mono">${esc(i.postedBy)} · ${esc((i.postedAt ?? "").slice(0, 16).replace("T", " "))}</dd>` : ""}</dl>
      ${
        i.status === "draft"
          ? `<div class="row" style="margin-top:16px">
        <form method="post" action="/invoices/${i.doc}/post" onsubmit="return confirm('Post ${i.doc} to the ledger? It becomes a payable and can no longer be edited.')"><button class="primary">Post to ledger</button></form>
        <form method="post" action="/invoices/${i.doc}/delete"><button class="danger">Delete draft</button></form></div>`
          : ""
      }</div>`,
      req.query.flash,
    );
  });

  app.post("/invoices/:doc/post", async (req: Req, reply) => {
    await kaveri.gate("findesk.post_invoice", "write");
    const i = kaveri.postApInvoice(req.params.doc!, actorOf(req));
    return back(reply, `/invoices/${i.doc}`, `${i.doc} posted to the ledger.`);
  });
  app.post("/invoices/:doc/delete", async (req: Req, reply) => {
    await kaveri.gate("findesk.delete_draft", "write");
    kaveri.deleteApDraft(req.params.doc!, actorOf(req));
    return back(reply, "/invoices", `Draft ${req.params.doc} deleted.`);
  });

  return site;
}
