import { describe, expect, it } from "vitest";
import { checkGstin, checkIfsc, checkPan, gstinChecksum, lookupIfscOnline, stateCodeFor } from "../src/index.ts";

// Publicly cited sample GSTINs whose checksums are known to be correct.
const KNOWN_VALID = ["27AAPFU0939F1ZV", "29AAGCB7383J1Z4", "33AAACH7409R1Z8"];

describe("GSTIN", () => {
  it.each(KNOWN_VALID)("computes the correct checksum for %s", (g) => {
    expect(gstinChecksum(g.slice(0, 14))).toBe(g[14]);
    expect(checkGstin(g).valid).toBe(true);
  });

  it("decodes state and embedded PAN", () => {
    const r = checkGstin("29AAGCB7383J1Z4");
    expect(r.stateCode).toBe("29");
    expect(r.stateName).toBe("Karnataka");
    expect(r.pan).toBe("AAGCB7383J");
  });

  it("catches a single-character typo through the checksum", () => {
    const r = checkGstin("29AAGCB7388J1Z4"); // 3 → 8
    expect(r.valid).toBe(false);
    expect(r.issues.join()).toMatch(/Checksum mismatch/);
  });

  it("flags a PAN that doesn't match the one inside the GSTIN", () => {
    const r = checkGstin("29AAGCB7383J1Z4", { pan: "AAGCB7384J" });
    expect(r.valid).toBe(false);
    expect(r.issues.join()).toMatch(/does not match the PAN provided/);
  });

  it("flags a state mismatch with the registered address", () => {
    const r = checkGstin("29AAGCB7383J1Z4", { addressState: "Maharashtra" });
    expect(r.valid).toBe(false);
    expect(r.issues.join()).toMatch(/registered in Karnataka/);
    expect(checkGstin("29AAGCB7383J1Z4", { addressState: "karnataka" }).valid).toBe(true);
  });

  it("rejects wrong length and bad patterns with a readable reason", () => {
    expect(checkGstin("29AAGCB7383J1Z").issues[0]).toMatch(/15 characters/);
    expect(checkGstin("2XAAGCB7383J1Z4").valid).toBe(false);
  });

  it("tolerates spaces and lowercase from OCR/extraction", () => {
    expect(checkGstin(" 29aagcb7383j1z4 ").valid).toBe(true);
  });
});

describe("PAN", () => {
  it("identifies holder type from the 4th character", () => {
    expect(checkPan("ABCPE1234F").holderType).toBe("Individual");
    expect(checkPan("AAGCB7383J").holderType).toBe("Company");
    expect(checkPan("AAAFR1234Q").holderCode).toBe("F");
  });
  it("rejects malformed PANs and unknown holder types", () => {
    expect(checkPan("ABCP1234F").valid).toBe(false);
    expect(checkPan("ABCXE1234F").valid).toBe(false);
  });
});

describe("state codes", () => {
  it("maps names to GST state codes", () => {
    expect(stateCodeFor("Tamil Nadu")).toBe("33");
    expect(stateCodeFor("Andaman & Nicobar Islands")).toBe("35");
    expect(stateCodeFor("Atlantis")).toBeUndefined();
  });
});

describe("IFSC (offline dataset)", () => {
  it("accepts real IFSCs and names the bank", () => {
    const r = checkIfsc("HDFC0000001");
    expect(r.valid).toBe(true);
    expect(r.bankName).toMatch(/HDFC/i);
    expect(checkIfsc("SBIN0000001").valid).toBe(true);
  });
  it("rejects bad format and unknown branches", () => {
    expect(checkIfsc("HDFC1000001").issues[0]).toMatch(/4 letters, then 0/);
    const unknown = checkIfsc("HDFC0ZZZZZZ");
    expect(unknown.valid).toBe(false);
    expect(unknown.known).toBe(false);
  });
});

describe("IFSC (online lookup)", () => {
  it("returns details on 200 and classifies 404 / network errors", async () => {
    const ok = await lookupIfscOnline("HDFC0000001", {
      fetchImpl: async () => new Response(JSON.stringify({ IFSC: "HDFC0000001", BANK: "HDFC Bank", BRANCH: "SANDOZ HOUSE" })),
    });
    expect(ok).toMatchObject({ ok: true, details: { BRANCH: "SANDOZ HOUSE" } });
    const missing = await lookupIfscOnline("HDFC0999999", { fetchImpl: async () => new Response("Not Found", { status: 404 }) });
    expect(missing).toMatchObject({ ok: false, reason: "not_found" });
    const down = await lookupIfscOnline("HDFC0000001", {
      fetchImpl: async () => {
        throw new Error("ECONNRESET");
      },
    });
    expect(down).toMatchObject({ ok: false, reason: "unreachable" });
  });
});
