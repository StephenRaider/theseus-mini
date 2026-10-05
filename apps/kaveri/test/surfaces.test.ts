import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Docxtemplater from "docxtemplater";
import ExcelJS from "exceljs";
import PizZip from "pizzip";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { buildSites, EMPANELMENT_TAGS, generateWorkspace, initialState, Kaveri, MARKER, REGISTER_COLUMNS, WORKSPACE_FILES } from "../src/index.ts";

const agent = { "x-actor": "agent:emp_2" };
let kaveri: Kaveri;
let sites: ReturnType<typeof buildSites>;
beforeEach(() => {
  kaveri = new Kaveri();
  sites = buildSites(kaveri, { workspaceDir: false });
});

describe("ERP: Excel export", () => {
  it("exports the 65-line batch as a real .xlsx", async () => {
    const r = await sites.erp.app.inject({ url: "/api/payments/batches/PB-2026-W41/export.xlsx" });
    expect(r.statusCode).toBe(200);
    expect(r.headers["content-type"]).toContain("spreadsheetml");
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(r.rawPayload as unknown as ArrayBuffer);
    const ws = wb.getWorksheet("PB-2026-W41")!;
    expect(ws.rowCount).toBe(66); // header + 65
    expect(ws.getRow(1).getCell(1).value).toBe("Line");
    const pl05 = ws.getRows(2, 65)!.find((row) => row.getCell(1).value === "PL-05")!;
    expect(pl05.getCell(11).value).toBe(3120); // TDS column, the planted 2% error
  });
});

describe("Bank: bulk payment file (maker-checker)", () => {
  const csv = [
    "beneficiary_name,account_number,ifsc,amount,reference",
    "HOYSALA STEEL FABRICATORS PVT LTD,917020045561203,UTIB0000501,404250,PB-2026-W41/PL-01",
    "TUNGA ELECTRICALS,0896102000033,CNRB0000534,182280,PB-2026-W41/PL-02",
  ].join("\n");

  it("agent uploads (maker); only a different human can authorise (checker)", async () => {
    const up = await sites.bank.app.inject({ method: "POST", url: "/api/payment-files", headers: agent, payload: { filename: "PB-2026-W41_bank_upload.csv", csv } });
    expect(up.statusCode).toBe(201);
    const f = up.json();
    expect(f).toMatchObject({ status: "pending_authorisation", totalAmount: 586_530 });
    expect(f.rows.every((r: { valid: boolean }) => r.valid)).toBe(true);

    const byAgent = await sites.bank.app.inject({ method: "POST", url: `/api/payment-files/${f.id}/authorise`, payload: { approvedBy: "agent:emp_2" } });
    expect(byAgent.json().error.code).toBe("APPROVAL_REQUIRED");
    const ok = await sites.bank.app.inject({ method: "POST", url: `/api/payment-files/${f.id}/authorise`, payload: { approvedBy: "user:anil.shetty" } });
    expect(ok.json()).toMatchObject({ status: "authorised", authorisedBy: "user:anil.shetty" });
  });

  it("flags invalid rows and a wrong header", async () => {
    const bad = await sites.bank.app.inject({ method: "POST", url: "/api/payment-files", headers: agent,
      payload: { filename: "x.csv", csv: csv + "\nNO IFSC LTD,12345678,BADIFSC,1000,REF-3\nDUP,12345678,UTIB0000501,10,PB-2026-W41/PL-01" } });
    const rows = bad.json().rows;
    expect(rows[2]).toMatchObject({ valid: false, error: "Invalid IFSC" });
    expect(rows[3].error).toMatch(/Duplicate reference/);
    const header = await sites.bank.app.inject({ method: "POST", url: "/api/payment-files", headers: agent, payload: { filename: "x.csv", csv: "name,acct\nA,1" } });
    expect(header.json().error.code).toBe("INVALID_FORMAT");
  });

  it("accepts a real browser-style multipart upload on the /bulk page", async () => {
    const boundary = "----kaveri";
    const body = `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="upload.csv"\r\nContent-Type: text/csv\r\n\r\n${csv}\r\n--${boundary}--\r\n`;
    const r = await sites.bank.app.inject({ method: "POST", url: "/bulk", headers: { ...agent, "content-type": `multipart/form-data; boundary=${boundary}` }, payload: body });
    expect(r.statusCode).toBe(302);
    expect(kaveri.state.paymentFiles[0]).toMatchObject({ filename: "upload.csv", uploadedBy: "agent:emp_2" });
  });
});

describe("Government portals", () => {
  it("GST portal returns status + legal name; Udyam portal returns the MSME category", async () => {
    const g = await sites.gst.app.inject({ url: "/api/taxpayers/29AAKFS4821M1ZM" });
    expect(g.json()).toMatchObject({ status: "Active", legalName: "SHREE GANESH CONSTRUCTIONS" });
    const u = await sites.udyam.app.inject({ url: "/api/udyam/UDYAM-KR-27-0001150" });
    expect(u.json()).toMatchObject({ category: "micro", enterpriseName: "TUNGA ELECTRICALS" });
    const missing = await sites.udyam.app.inject({ url: "/api/udyam/UDYAM-KR-00-0000000" });
    expect(missing.statusCode).toBe(404);
  });
});

describe("eProcure", () => {
  it("lists the 3 qualified bidders with EMD guarantees and downloadable PDFs", async () => {
    const t = (await sites.eproc.app.inject({ url: "/api/tenders/T-2026-14" })).json();
    expect(t.bidders.map((b: { emdGuarantee: string }) => b.emdGuarantee)).toEqual(["PBG/HDFC/2026/88123", "PBG/ICICI/2026/55120", "PBG/SBI/2026/40917"]);
    const pdf = await sites.eproc.app.inject({ url: `/api/tenders/T-2026-14/documents/${encodeURIComponent("Bid_Form_Sri_Lakshmi.pdf")}` });
    expect(pdf.headers["content-type"]).toBe("application/pdf");
    expect(pdf.rawPayload.subarray(0, 5).toString()).toBe("%PDF-");
    expect((await sites.eproc.app.inject({ url: "/api/tenders/T-2026-14/documents/nope.pdf" })).statusCode).toBe(404);
  });
});

describe("Mail: drafts with attachments, send needs a human", () => {
  it("agent drafts a reply with a generated file; only a human can send it", async () => {
    const file = Buffer.from("PK-fake-docx-bytes");
    const d = (await sites.mail.app.inject({ method: "POST", url: "/api/drafts", headers: agent,
      payload: { to: "anil.shetty@kaveriinfra.example", subject: "Integrity report W41", body: "Attached.", attachments: [{ name: "Report.docx", base64: file.toString("base64") }] } })).json();
    expect(d.folder).toBe("drafts");
    const att = await sites.mail.app.inject({ url: `/api/messages/${d.id}/attachments/Report.docx` });
    expect(Buffer.compare(att.rawPayload, file)).toBe(0);
    expect((await sites.mail.app.inject({ method: "POST", url: `/api/messages/${d.id}/send`, payload: {} })).statusCode).toBe(403);
    const sent = await sites.mail.app.inject({ method: "POST", url: `/api/messages/${d.id}/send`, payload: { approvedBy: "user:jyotiraditya" } });
    expect(sent.json().folder).toBe("sent");
  });
});

describe("Local workspace", () => {
  const dirs: string[] = [];
  const tmp = async () => {
    const d = await mkdtemp(join(tmpdir(), "kaveri-ws-"));
    dirs.push(d);
    return join(d, "workspace");
  };
  afterAll(async () => Promise.all(dirs.map((d) => rm(d, { recursive: true, force: true }))));

  it("generates the register, policy, templates and folders", async () => {
    const dir = await generateWorkspace(initialState(), await tmp());
    for (const f of Object.values(WORKSPACE_FILES)) expect(existsSync(join(dir, f)), f).toBe(true);
    expect(existsSync(join(dir, MARKER))).toBe(true);

    const wb = new ExcelJS.Workbook();
    await wb.xlsx.readFile(join(dir, WORKSPACE_FILES.register));
    const cases = wb.getWorksheet("Onboarding cases")!;
    expect(cases.getRow(1).values).toEqual([undefined, ...REGISTER_COLUMNS]);
    const open = cases.getRows(2, cases.rowCount - 1)!.filter((r) => r.getCell(13).value === "Docs received").map((r) => r.getCell(3).value);
    expect(open).toEqual(["Nandi Roadways LLP", "Vrishabha Earthmovers", "Sri Lakshmi Buildcon"]);
    const log = wb.getWorksheet("Bank change log")!;
    const sg = log.getRows(2, log.rowCount - 1)!.find((r) => r.getCell(2).value === "V-101")!;
    expect(sg.getCell(7).value ?? "").toBe(""); // the clerk's change has NO call-back reference (a clue)

    const policy = await readFile(join(dir, WORKSPACE_FILES.policy));
    expect(policy.subarray(0, 5).toString()).toBe("%PDF-");
  });

  it("the Word templates render with docxtemplater (no broken tags)", async () => {
    const dir = await generateWorkspace(initialState(), await tmp());
    const zip = new PizZip(await readFile(join(dir, WORKSPACE_FILES.empanelmentTemplate)));
    const doc = new Docxtemplater(zip, { paragraphLoop: true, linebreaks: true });
    const data = Object.fromEntries(EMPANELMENT_TAGS.map((t) => [t, `<${t}>`]));
    doc.render({ ...data, issues: ["PAN card ≠ PAN in GSTIN", "Address matches employee E-07"] });
    const xml = doc.getZip().file("word/document.xml")!.asText();
    expect(xml).toContain("&lt;legal_name&gt;");
    expect(xml).toContain("Address matches employee E-07");
    expect(xml).not.toMatch(/\{[a-z_#/.]+\}/); // every tag was replaced

    const report = new Docxtemplater(new PizZip(await readFile(join(dir, WORKSPACE_FILES.reportTemplate))), { paragraphLoop: true });
    report.render({ batch_id: "PB-2026-W41", held: [{ line: "PL-03", vendor: "Shree Ganesh", amount: "₹8,28,100", reason: "Bank changed via look-alike email" }], corrected: [], priority: [] });
    expect(report.getZip().file("word/document.xml")!.asText()).toContain("Bank changed via look-alike email");
  });

  it("refuses to wipe a folder it didn't create", async () => {
    const dir = await tmp();
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "precious.txt"), "do not delete");
    await expect(generateWorkspace(initialState(), dir)).rejects.toThrow(/isn't a Kaveri workspace/);
    expect(await readFile(join(dir, "precious.txt"), "utf8")).toBe("do not delete");
  });

  it("world reset from the Control Room regenerates the workspace", async () => {
    const dir = await tmp();
    const k = new Kaveri();
    await generateWorkspace(k.state, dir);
    k.onReset.push(async () => void (await generateWorkspace(k.state, dir)));
    const s = buildSites(k, { workspaceDir: dir });
    await rm(join(dir, WORKSPACE_FILES.register));
    await writeFile(join(dir, WORKSPACE_FILES.batchDir, "scratch.csv"), "agent output");
    await s.control.app.inject({ method: "POST", url: "/__admin/reset", payload: {} });
    expect(existsSync(join(dir, WORKSPACE_FILES.register))).toBe(true);
    expect(existsSync(join(dir, WORKSPACE_FILES.batchDir, "scratch.csv"))).toBe(false);
  });
});
