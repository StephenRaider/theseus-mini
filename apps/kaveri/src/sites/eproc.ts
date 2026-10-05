import { getDocument } from "../docs/pdf.ts";
import { esc, inr, statusTag, THEMES } from "../html.ts";
import { KaveriError, type Kaveri } from "../store.ts";
import { createSite, sendFile, type Req } from "./common.ts";

/** Kaveri eProcure: tenders, qualified bidders, bid documents and bid-security guarantees. */
export function eprocSite(kaveri: Kaveri) {
  const site = createSite(kaveri, THEMES.eproc([["/", "Tenders"]]));
  const { app, page } = site;

  async function docBytes(tenderId: string, name: string) {
    const pdf = await getDocument(kaveri.tenderDocKey(tenderId, name));
    if (!pdf) throw new KaveriError(404, "NOT_FOUND", "Document missing");
    return pdf;
  }

  app.get("/api/tenders", async () => {
    await kaveri.gate("eproc.list_tenders", "read");
    return kaveri.listTenders();
  });
  app.get("/api/tenders/:id", async (req: Req) => {
    await kaveri.gate("eproc.get_tender", "read");
    return kaveri.getTender(req.params.id!);
  });
  app.get("/api/tenders/:id/documents/:name", async (req: Req, reply) => {
    await kaveri.gate("eproc.download_document", "read");
    return sendFile(reply, req.params.name!, "application/pdf", await docBytes(req.params.id!, req.params.name!));
  });

  app.get("/", async (_req: Req, reply) => {
    await kaveri.gate("eproc.list_tenders", "read");
    return page(reply, "Tenders", "/", `<h1>Tenders</h1><div class="card" style="padding:0"><table><thead><tr><th>Tender id</th><th>Title</th><th>Published</th><th class="right">Estimate</th><th>Status</th></tr></thead><tbody>
      ${kaveri.state.tenders.map((t) => `<tr><td class="mono"><a href="/tenders/${t.id}">${t.id}</a></td><td>${esc(t.title)}</td><td class="mono">${esc(t.publishedOn ?? "—")}</td><td class="right mono">${t.estimatedValue ? inr(t.estimatedValue) : "—"}</td><td>${statusTag(t.status)}</td></tr>`).join("")}
      </tbody></table></div>`);
  });

  app.get("/tenders/:id", async (req: Req, reply) => {
    await kaveri.gate("eproc.get_tender", "read");
    const t = kaveri.getTender(req.params.id!);
    const bidders = t.bidders ?? t.qualifiedBidders.map((n) => ({ legalName: n, bidAmount: 0, documents: {} as Record<string, string>, emdGuarantee: undefined }));
    return page(reply, t.id, "/", `<p><a href="/">← Tenders</a></p><div class="card"><h1>${esc(t.title)} <span class="mono muted">${t.id}</span> ${statusTag(t.status)}</h1>
      <dl><dt>Published</dt><dd class="mono">${esc(t.publishedOn ?? "—")}</dd><dt>Estimated value</dt><dd class="mono">${t.estimatedValue ? inr(t.estimatedValue) : "—"}</dd><dt>Stage</dt><dd>${t.status === "evaluation" ? "Technical evaluation complete · vendor registration pending" : "Awarded"}</dd></dl></div>
      <h2>Qualified bidders</h2><div class="card" style="padding:0"><table><thead><tr><th>Bidder</th><th class="right">Quoted</th><th>Bid security (EMD) guarantee</th><th>Documents</th></tr></thead><tbody>
      ${bidders.map((b) => `<tr><td>${esc(b.legalName)}</td><td class="right mono">${b.bidAmount ? inr(b.bidAmount) : "—"}</td><td class="mono">${esc(b.emdGuarantee ?? "—")}</td>
        <td>${Object.keys(b.documents).map((n) => `<a href="/tenders/${t.id}/documents/${encodeURIComponent(n)}" target="_blank" download="${esc(n)}">${esc(n)}</a>`).join("<br>") || '<span class="muted">—</span>'}</td></tr>`).join("")}
      </tbody></table></div>`);
  });
  app.get("/tenders/:id/documents/:name", async (req: Req, reply) => {
    await kaveri.gate("eproc.download_document", "read");
    return sendFile(reply, req.params.name!, "application/pdf", await docBytes(req.params.id!, req.params.name!));
  });

  return site;
}
