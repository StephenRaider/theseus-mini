import { describe, expect, it } from "vitest";
import { contractorTds, findDuplicates, msmeDeadline, nameSimilarity, normalizeAddress, normalizeName } from "../src/index.ts";

describe("contractor TDS (Sec. 393, ex-194C)", () => {
  it("1% for an individual above ₹30,000", () => {
    expect(contractorTds({ pan: "ABCPE1234F", amount: 50_000 })).toMatchObject({ applicable: true, rate: 0.01, tds: 500 });
  });
  it("2% for a firm or company", () => {
    expect(contractorTds({ pan: "AAAFR1234Q", amount: 50_000 })).toMatchObject({ rate: 0.02, tds: 1_000 });
    expect(contractorTds({ pan: "AAGCB7383J", amount: 50_000 }).rate).toBe(0.02);
  });
  it("20% without a valid PAN", () => {
    expect(contractorTds({ amount: 50_000 })).toMatchObject({ rate: 0.2, tds: 10_000 });
    expect(contractorTds({ pan: "BAD", amount: 50_000 }).rate).toBe(0.2);
  });
  it("no TDS at or below both thresholds", () => {
    expect(contractorTds({ pan: "ABCPE1234F", amount: 30_000, paidEarlierThisYear: 60_000 }).applicable).toBe(false);
  });
  it("crossing ₹1,00,000 in the year triggers catch-up on earlier un-taxed payments", () => {
    const r = contractorTds({ pan: "ABCPE1234F", amount: 25_000, paidEarlierThisYear: 80_000, earlierPaidWithoutTds: 80_000 });
    expect(r).toMatchObject({ applicable: true, catchUp: 800, tds: 250 + 800 });
    expect(r.reason).toMatch(/catch-up/);
  });
});

describe("MSME deadline (Sec. 43B(h))", () => {
  it("caps a written agreement at 45 days", () => {
    const r = msmeDeadline({ category: "micro", acceptedOn: "2026-08-25", agreedDays: 60, today: "2026-10-06" });
    expect(r).toMatchObject({ applies: true, dueOn: "2026-10-09", daysLeft: 3, status: "due_soon" });
  });
  it("uses 15 days without a written agreement", () => {
    const r = msmeDeadline({ category: "small", acceptedOn: "2026-09-01", today: "2026-10-06" });
    expect(r).toMatchObject({ dueOn: "2026-09-16", status: "overdue" });
    expect(r.daysLeft).toBe(-20);
  });
  it("does not apply to medium enterprises", () => {
    expect(msmeDeadline({ category: "medium", acceptedOn: "2026-09-01", today: "2026-10-06" }).applies).toBe(false);
  });
});

describe("duplicate detection", () => {
  it("normalizes common Indian business-name variants", () => {
    expect(normalizeName("M/s. Shri Ganesh Const. Pvt Ltd")).toBe("SHREE GANESH CONSTRUCTIONS");
    expect(nameSimilarity("Shree Ganesh Constructions", "Shri Ganesh Const.")).toBe(1);
    expect(nameSimilarity("Shree Ganesh Constructions", "Sai Krupa Builders")).toBeLessThan(0.5);
  });

  it("ranks hard ID matches above name similarity and explains multi-state PANs", () => {
    const existing = [
      { id: "V-101", name: "Sai Krupa Builders", pan: "AAAFS1111K", gstin: "29AAAFS1111K1ZX", bankAccount: "111" },
      { id: "V-102", name: "Shri Ganesh Const.", pan: "AAAFG2222L", gstin: "29AAAFG2222L1ZY", bankAccount: "222" },
      { id: "V-103", name: "Ganesh Constructions (TN)", pan: "AAAFG2222L", gstin: "33AAAFG2222L1ZZ", bankAccount: "333" },
    ];
    const hits = findDuplicates(
      { name: "Shree Ganesh Constructions", pan: "AAAFG2222L", gstin: "29AAAFG2222L1ZY", bankAccount: "999" },
      existing,
    );
    expect(hits.map((h) => h.record.id)).toEqual(["V-102", "V-103"]);
    expect(hits[0]!.reasons).toContain("same GSTIN");
    expect(hits[1]!.reasons.join()).toMatch(/another state registration/);
  });

  it("normalizes addresses for employee-conflict checks", () => {
    expect(normalizeAddress("No. 12, 3rd Cross Rd, Jayanagar")).toBe(normalizeAddress("12 3rd cross road jayanagar"));
  });
});
