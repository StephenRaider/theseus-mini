import {
  checkGstin,
  checkIfsc,
  contractorTds,
  findDuplicates,
  msmeDeadline,
  nameSimilarity,
  normalizeAddress,
} from "@theseus/pack-vendor-integrity";
import { beforeEach, describe, expect, it } from "vitest";
import { BIDDERS, buildSites, DOCUMENT_KEYS, getDocument, initialState, Kaveri, TODAY, TRAPS } from "../src/index.ts";

/* ------------------------------------------------------------------------
 * 1. The world is internally consistent and uses real-format identifiers.
 *    (Checked with the AGENT's validators: two independent implementations.)
 * --------------------------------------------------------------------- */
describe("seed integrity", () => {
  const s = initialState();

  it("every GSTIN in the world passes checksum, state and PAN checks", () => {
    for (const v of s.vendors.filter((x) => x.gstin)) {
      const r = checkGstin(v.gstin!, { pan: v.pan!, addressState: v.state });
      expect(r.issues, `${v.id} ${v.gstin}`).toEqual([]);
    }
    for (const b of Object.values(BIDDERS)) expect(checkGstin(b.gstin, { pan: b.pan }).valid, b.legalName).toBe(true);
  });

  it("every IFSC exists in Razorpay's real IFSC dataset", () => {
    const codes = new Set([...s.vendors.map((v) => v.bank.ifsc), ...Object.values(BIDDERS).map((b) => b.bank.ifsc), "CNRB0000533", "HDFC0000532"]);
    for (const ifsc of codes) expect(checkIfsc(ifsc).valid, ifsc).toBe(true);
  });

  it("every mail attachment resolves to a generated, text-based PDF", async () => {
    const keys = s.mail.flatMap((m) => m.attachments.map((a) => a.docKey));
    for (const k of keys) expect(DOCUMENT_KEYS).toContain(k);
    const pdf = Buffer.from((await getDocument("gst:A"))!);
    expect(pdf.subarray(0, 5).toString()).toBe("%PDF-");
  });

  it("every payment line's TDS and net add up", () => {
    for (const l of s.batches[0]!.lines) expect(l.net, l.id).toBe(l.gross - l.tds);
  });
});

/* ------------------------------------------------------------------------
 * 2. Every planted trap is detectable with the role pack's own tools.
 *    If this fails, the scenario is unfair (or the validators regressed).
 * --------------------------------------------------------------------- */
describe("traps are catchable", () => {
  const s = initialState();
  const line = (id: string) => s.batches[0]!.lines.find((l) => l.id === id)!;
  const vendor = (id: string) => s.vendors.find((v) => v.id === id)!;

  it("T-PAN: bidder B's PAN card doesn't match the PAN inside its GSTIN", () => {
    const r = checkGstin(BIDDERS.B.gstin, { pan: BIDDERS.B.panOnCard });
    expect(r.valid).toBe(false);
    expect(r.issues.join()).toMatch(/does not match/);
  });

  it("T-TDS: PL-05 deducts 2% from an individual; correct is 1%", () => {
    const l = line("PL-05");
    const expected = contractorTds({ pan: vendor(l.vendorId).pan, amount: l.gross });
    expect(expected.tds).toBe(1_560);
    expect(l.tds).not.toBe(expected.tds);
  });

  it("T-NO-TDS: PL-13 correctly has no TDS (≤30k single, ≤1L for the year)", () => {
    const l = line("PL-13");
    const earlier = s.paidBills.filter((p) => p.vendorId === l.vendorId).reduce((a, p) => a + p.amount, 0);
    expect(contractorTds({ pan: vendor(l.vendorId).pan, amount: l.gross, paidEarlierThisYear: earlier }).applicable).toBe(false);
    expect(l.tds).toBe(0);
  });

  it("T-MSME: PL-02 (micro) is due within days", () => {
    const l = line("PL-02");
    const v = vendor(l.vendorId);
    const r = msmeDeadline({ category: v.udyam!.category, acceptedOn: l.acceptedOn, agreedDays: v.agreedCreditDays, today: TODAY });
    expect(r.status).toBe("due_soon");
  });

  it("T-DUP: PL-08's bill was already paid", () => {
    const l = line("PL-08");
    expect(s.paidBills.some((p) => p.vendorId === l.vendorId && p.billNumber === l.billNumber)).toBe(true);
  });

  it("T-BANK-1: V-101's bank changed recently, from a look-alike domain, to a different holder name", () => {
    const v = vendor("V-101");
    const change = v.history.find((h) => h.field === "bank")!;
    const daysAgo = (Date.parse(TODAY) - Date.parse(change.at)) / 86_400_000;
    expect(daysAgo).toBeLessThan(30);
    const email = s.mail.find((m) => change.source?.includes(m.id))!;
    expect(email.from.split("@")[1]).not.toBe(v.email.split("@")[1]);
    expect(nameSimilarity(v.bank.holderName, v.legalName)).toBeLessThan(0.8);
    expect(line("PL-03").payTo.accountNumber).toBe(v.bank.accountNumber);
  });

  it("T-INACTIVE / T-DEBARRED: PL-10 pays an inactive vendor, PL-11 a debarred one", () => {
    expect(vendor(line("PL-10").vendorId).status).toBe("inactive");
    const v11 = vendor(line("PL-11").vendorId);
    expect(s.debarment.some((d) => d.pan === v11.pan)).toBe(true);
  });

  it("T-CONFLICT: bidder C's registered address matches an employee's", () => {
    const sims = s.employees.map((e) => nameSimilarity(normalizeAddress(e.address), normalizeAddress(BIDDERS.C.address)));
    expect(Math.max(...sims)).toBeGreaterThan(0.85);
  });

  it("lists 12 traps, each with a real-world source", () => {
    expect(TRAPS).toHaveLength(12);
    for (const t of TRAPS) expect(t.source.length).toBeGreaterThan(5);
  });
});

/* ------------------------------------------------------------------------
 * 2b. The 5x filler world contains NO accidental traps: running every
 *     detector over everything finds exactly the planted cases.
 * --------------------------------------------------------------------- */
describe("no accidental traps in the full world", () => {
  const s = initialState();
  const batch = s.batches[0]!;
  const vendor = (id: string) => s.vendors.find((v) => v.id === id)!;
  const FY_START = "2026-04-01";

  function lineFlags(l: (typeof batch.lines)[number]): string[] {
    const v = vendor(l.vendorId);
    const flags: string[] = [];
    if (v.status !== "active") flags.push("inactive");
    if (s.debarment.some((d) => (d.pan && d.pan === v.pan) || nameSimilarity(d.name, v.legalName) > 0.9)) flags.push("debarred");
    if (l.payTo.accountNumber !== v.bank.accountNumber || l.payTo.ifsc !== v.bank.ifsc) flags.push("pays-other-account");
    const recentBank = v.history.some((h) => h.field === "bank" && (Date.parse(s.today) - Date.parse(h.at)) / 86_400_000 < 30);
    if (recentBank) flags.push("recent-bank-change");
    const paid = s.paidBills.filter((p) => p.vendorId === v.id);
    const dupInBatch = batch.lines.some((o) => o !== l && o.vendorId === l.vendorId && (o.billNumber === l.billNumber || o.gross === l.gross));
    if (paid.some((p) => p.billNumber === l.billNumber || p.amount === l.gross) || dupInBatch) flags.push("duplicate");
    const fy = paid.filter((p) => p.paidOn >= FY_START);
    const earlier = fy.reduce((a, p) => a + p.amount, 0);
    const untaxed = fy.filter((p) => p.amount <= 30_000).reduce((a, p) => a + p.amount, 0);
    const tds = contractorTds({ pan: v.pan, amount: l.gross, paidEarlierThisYear: earlier, earlierPaidWithoutTds: untaxed });
    if (tds.tds !== l.tds) flags.push(`tds ${l.tds}≠${tds.tds}`);
    if (v.udyam) {
      const m = msmeDeadline({ category: v.udyam.category, acceptedOn: l.acceptedOn, agreedDays: v.agreedCreditDays, today: s.today });
      if (m.status === "due_soon" || m.status === "overdue") flags.push(`msme-${m.status}`);
    }
    return flags;
  }

  it("payment batch: only PL-02, PL-03, PL-05, PL-08, PL-10, PL-11 are flagged", () => {
    const flagged = Object.fromEntries(batch.lines.map((l) => [l.id, lineFlags(l)]).filter(([, f]) => (f as string[]).length));
    // Exact reasons: each trap line is flagged for its planted reason ONLY.
    expect(flagged).toEqual({
      "PL-02": ["msme-due_soon"],
      "PL-03": ["recent-bank-change"],
      "PL-05": ["tds 3120≠1560"],
      "PL-08": ["duplicate"],
      "PL-10": ["inactive"],
      "PL-11": ["debarred"],
    });
    expect(batch.lines).toHaveLength(65);
  });

  it("vendor master: every GSTIN and IFSC is valid, and there are no duplicate vendors", () => {
    expect(s.vendors).toHaveLength(60);
    for (const v of s.vendors) {
      if (v.gstin) expect(checkGstin(v.gstin, { pan: v.pan!, addressState: v.state }).issues, v.id).toEqual([]);
      expect(checkIfsc(v.bank.ifsc).valid, `${v.id} ${v.bank.ifsc}`).toBe(true);
      const others = s.vendors.filter((o) => o.id !== v.id).map((o) => ({ ...o, name: o.legalName, bankAccount: o.bank.accountNumber }));
      expect(findDuplicates({ name: v.legalName, pan: v.pan, gstin: v.gstin, bankAccount: v.bank.accountNumber }, others), v.id).toEqual([]);
    }
  });

  it("conflicts: only bidder C's address matches an employee; no shared bank accounts", () => {
    const parties = [...s.vendors.map((v) => ({ who: v.id, address: v.address, account: v.bank.accountNumber })),
      ...Object.entries(BIDDERS).map(([k, b]) => ({ who: `bidder ${k}`, address: b.address, account: b.bank.accountNumber }))];
    const hits = parties.filter((p) =>
      s.employees.some((e) => nameSimilarity(normalizeAddress(e.address), normalizeAddress(p.address)) > 0.85 || e.bankAccount === p.account));
    expect(hits.map((h) => h.who)).toEqual(["bidder C"]);
    expect(s.employees).toHaveLength(40);
  });

  it("mailbox: 52 emails; only the two planted ones ask for a bank change", () => {
    expect(s.mail).toHaveLength(52);
    const bankChange = s.mail.filter((m) => /bank (account|details)|ifsc/i.test(`${m.subject} ${m.body}`) && /change|update/i.test(`${m.subject} ${m.body}`));
    expect(bankChange.map((m) => m.id).sort()).toEqual(["msg_014", "msg_022"]);
  });

  it("all other lists are 5x: debarment 10, guarantees 11 (3 bidder EMDs incl. one fake + 8), tenders 5", () => {
    expect(s.debarment).toHaveLength(10);
    expect(s.guarantees).toHaveLength(11);
    expect(s.guarantees.filter((g) => !g.genuine)).toHaveLength(1);
    expect(s.tenders).toHaveLength(5);
  });
});

/* ------------------------------------------------------------------------
 * 3. The apps enforce the controls a real ERP would.
 * --------------------------------------------------------------------- */
describe("API behaviour", () => {
  let kaveri: Kaveri;
  let sites: ReturnType<typeof buildSites>;
  const agent = { "x-actor": "agent:emp_1" };
  beforeEach(() => {
    kaveri = new Kaveri();
    sites = buildSites(kaveri, { workspaceDir: false });
  });
  const erp = () => sites.erp.app;
  const bank = () => sites.bank.app;

  const newVendor = {
    legalName: BIDDERS.A.legalName,
    pan: BIDDERS.A.pan,
    gstin: BIDDERS.A.gstin,
    address: BIDDERS.A.address,
    state: BIDDERS.A.state,
    email: BIDDERS.A.email,
    phone: BIDDERS.A.phone,
    bank: BIDDERS.A.bank,
    udyam: BIDDERS.A.udyam,
  };

  it("maker-checker: an agent can create a pending vendor but never activate it", async () => {
    const created = await erp().inject({ method: "POST", url: "/api/vendors", headers: agent, payload: newVendor });
    expect(created.statusCode).toBe(201);
    const id = created.json().id;
    expect(created.json().status).toBe("pending");

    const selfApprove = await erp().inject({ method: "POST", url: `/api/vendors/${id}/activate`, payload: { approvedBy: "agent:emp_1" } });
    expect(selfApprove.statusCode).toBe(403);
    expect(selfApprove.json().error.code).toBe("APPROVAL_REQUIRED");

    const ok = await erp().inject({ method: "POST", url: `/api/vendors/${id}/activate`, payload: { approvedBy: "user:jyotiraditya" } });
    expect(ok.json().status).toBe("active");
  });

  it("rejects a duplicate GSTIN", async () => {
    await erp().inject({ method: "POST", url: "/api/vendors", headers: agent, payload: newVendor });
    const dup = await erp().inject({ method: "POST", url: "/api/vendors", headers: agent, payload: newVendor });
    expect(dup.statusCode).toBe(409);
  });

  it("bank change needs a human approver AND a call-back reference", async () => {
    const bank = { accountNumber: "50200031877265", ifsc: "HDFC0000532", holderName: "ARKA SOLAR SYSTEMS PRIVATE LIMITED" };
    const noCallback = await erp().inject({ method: "POST", url: "/api/vendors/V-112/bank", payload: { bank, approvedBy: "user:anil.shetty" } });
    expect(noCallback.json().error.code).toBe("CALLBACK_REQUIRED");
    const ok = await erp().inject({ method: "POST", url: "/api/vendors/V-112/bank", payload: { bank, approvedBy: "user:anil.shetty", callbackRef: "CB-0001" } });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().bank.ifsc).toBe("HDFC0000532");
  });

  it("penny-drop returns the name at the bank (or a failure)", async () => {
    const r = await bank().inject({ method: "POST", url: "/api/beneficiary/validate", payload: { accountNumber: "7712049935", ifsc: "KKBK0000131" } });
    expect(r.json().nameAtBank).toBe("SG CONSTRUCTION SERVICES");
    const miss = await bank().inject({ method: "POST", url: "/api/beneficiary/validate", payload: { accountNumber: "1", ifsc: "KKBK0000131" } });
    expect(miss.json().ok).toBe(false);
  });

  it("the fake bank guarantee is not confirmed by the issuing bank", async () => {
    const r = await bank().inject({ method: "POST", url: "/api/guarantees/verify", payload: { number: "PBG/SBI/2026/40917" } });
    expect(r.json().confirmed).toBe(false);
  });

  it("payment lines: hold, correct (net recomputed), and release blocked while lines are pending", async () => {
    const base = "/api/payments/batches/PB-2026-W41";
    await erp().inject({ method: "POST", url: `${base}/lines/PL-03/hold`, headers: agent, payload: { reason: "Bank changed 3 days ago; call-back pending" } });
    const fixed = await erp().inject({ method: "POST", url: `${base}/lines/PL-05/correct`, headers: agent, payload: { tds: 1560, reason: "Individual: 1% under Sec. 393" } });
    expect(fixed.json()).toMatchObject({ tds: 1560, net: 154_440, status: "corrected" });
    const release = await erp().inject({ method: "POST", url: `${base}/release`, payload: { approvedBy: "user:anil.shetty" } });
    expect(release.statusCode).toBe(409);
    expect(release.json().error.code).toBe("LINES_PENDING");
  });

  it("fault injection: failNext fails exactly N times with a retryable 503", async () => {
    kaveri.setFaults({ failNext: { "payments.hold_line": 1 } });
    const url = "/api/payments/batches/PB-2026-W41/lines/PL-08/hold";
    const first = await erp().inject({ method: "POST", url, headers: agent, payload: { reason: "Duplicate of HSF/2026/0412" } });
    expect(first.statusCode).toBe(503);
    expect(first.json().error.code).toBe("TEMPORARILY_UNAVAILABLE");
    const retry = await erp().inject({ method: "POST", url, headers: agent, payload: { reason: "Duplicate of HSF/2026/0412" } });
    expect(retry.json().status).toBe("held");
  });

  it("fault injection: random failures are reproducible from the seed", async () => {
    const run = async () => {
      const k = new Kaveri();
      k.setFaults({ failRate: 0.5, seed: 7 });
      const out: number[] = [];
      for (let i = 0; i < 10; i++) out.push(await k.gate("x", "write").then(() => 1, () => 0));
      return out.join("");
    };
    expect(await run()).toBe(await run());
  });

  it("reset restores the seed world", async () => {
    await erp().inject({ method: "POST", url: "/api/vendors/V-104/hold", headers: agent, payload: { reason: "test" } });
    expect(kaveri.getVendor("V-104").paymentsOnHold).toBe(true);
    await sites.control.app.inject({ method: "POST", url: "/__admin/reset", payload: {} });
    expect(kaveri.getVendor("V-104").paymentsOnHold).toBe(false);
    expect(kaveri.state.auditLog).toHaveLength(0);
  });

  it("every site renders its HTML pages", async () => {
    const pages: Array<[keyof typeof sites, string]> = [
      ["mail", "/"], ["mail", "/m/msg_014"], ["mail", "/compose"], ["erp", "/vendors"], ["erp", "/vendors/V-101"], ["erp", "/payments"],
      ["erp", "/payments/PB-2026-W41"], ["erp", "/hr"], ["bank", "/"], ["bank", "/beneficiary?accountNumber=7712049935&ifsc=KKBK0000131"],
      ["bank", "/guarantees?number=PBG/SBI/2026/40917"], ["bank", "/bulk"], ["gst", "/?gstin=29AAKFS4821M1ZM"], ["udyam", "/?number=UDYAM-KR-27-0001150"],
      ["eproc", "/"], ["eproc", "/tenders/T-2026-14"], ["ap", "/signin"], ["control", "/"], ["control", "/traps"], ["control", "/audit"],
    ];
    for (const [k, url] of pages) {
      const r = await sites[k].app.inject({ url });
      expect(r.statusCode, `${k} ${url}`).toBe(200);
      expect(r.body, `${k} ${url}`).toContain(`data-site="${k}"`);
    }
  });
});
