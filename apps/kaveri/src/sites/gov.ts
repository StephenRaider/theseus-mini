import { esc, statusTag, THEMES } from "../html.ts";
import type { Kaveri } from "../store.ts";
import { createSite, type Req } from "./common.ts";

/** GST Portal (simulation): public taxpayer search by GSTIN. */
export function gstSite(kaveri: Kaveri) {
  const site = createSite(kaveri, THEMES.gst([["/", "Search Taxpayer"]]));
  const { app, page } = site;

  app.get("/api/taxpayers/:gstin", async (req: Req) => {
    await kaveri.gate("gov.gstin_status", "read");
    return kaveri.gstinLookup(req.params.gstin!);
  });

  app.get("/", async (req: Req, reply) => {
    let result = "";
    if (req.query.gstin) {
      await kaveri.gate("gov.gstin_status", "read");
      try {
        const r = kaveri.gstinLookup(req.query.gstin);
        result = `<div class="card" data-gstin-status="${esc(r.status)}"><h2 style="margin-top:0">Taxpayer details</h2><dl><dt>GSTIN/UIN</dt><dd class="mono">${esc(r.gstin)}</dd><dt>Legal name of business</dt><dd>${esc(r.legalName)}</dd>
          <dt>GSTIN status</dt><dd>${statusTag(r.status)}</dd><dt>Effective date of registration</dt><dd class="mono">${esc(r.registeredOn)}</dd><dt>State code</dt><dd class="mono">${esc(r.stateCode)}</dd>
          <dt>Taxpayer type</dt><dd>Regular</dd></dl></div>`;
      } catch (e) {
        result = `<div class="flash err" role="alert">${esc((e as Error).message)}</div>`;
      }
    }
    return page(reply, "Search Taxpayer", "/", `<h1>Search Taxpayer › Search by GSTIN/UIN</h1>
      <form class="card row" method="get"><label>GSTIN/UIN of the taxpayer <input name="gstin" value="${esc(req.query.gstin)}" required size="22" maxlength="15"></label><button class="primary">Search</button></form>${result}`);
  });
  return site;
}

/** Udyam Registration (simulation): verify an MSME certificate number. */
export function udyamSite(kaveri: Kaveri) {
  const site = createSite(kaveri, THEMES.udyam([["/", "Verify Udyam Registration"]]));
  const { app, page } = site;

  app.get("/api/udyam/:number", async (req: Req) => {
    await kaveri.gate("udyam.lookup", "read");
    return kaveri.udyamLookup(req.params.number!);
  });

  app.get("/", async (req: Req, reply) => {
    let result = "";
    if (req.query.number) {
      await kaveri.gate("udyam.lookup", "read");
      try {
        const r = kaveri.udyamLookup(req.query.number);
        result = `<div class="card" data-udyam-category="${esc(r.category)}"><h2 style="margin-top:0">Registration details</h2><dl><dt>Udyam Registration Number</dt><dd class="mono">${esc(r.number)}</dd>
          <dt>Name of enterprise</dt><dd>${esc(r.enterpriseName)}</dd><dt>Type of enterprise</dt><dd><strong>${esc(r.category.toUpperCase())}</strong></dd>
          <dt>Date of classification</dt><dd class="mono">${esc(r.classifiedOn)}</dd><dt>State</dt><dd>${esc(r.state)}</dd><dt>Status</dt><dd>${statusTag(r.status)}</dd></dl></div>`;
      } catch (e) {
        result = `<div class="flash err" role="alert">${esc((e as Error).message)}</div>`;
      }
    }
    return page(reply, "Verify Udyam", "/", `<h1>Verify Udyam Registration Number</h1>
      <form class="card row" method="get"><label>Udyam Registration Number <input name="number" value="${esc(req.query.number)}" required size="26" placeholder="UDYAM-XX-00-0000000"></label><button class="primary">Verify</button></form>${result}`);
  });
  return site;
}
