import { describe, expect, it } from "vitest";
import { leadParagraph, shortReply } from "../src/shortreply.ts";

const LONG = `Sorted 10 vendor documents into Onboarding under each vendor, set aside 1 duplicate and 1 unrelated file. Missing: Nandi Roadways LLP: Bank Proof. Flag: Vrishabha's PAN card shows AAHFV2209L but its GSTIN has AAHFV2290L. Checklist saved. Letters are in Drafts. More detail that goes on and on and on and on and on and on and on and on and on and on and on and on and on and on and on and on and on and on.

What I found:
• filing rule: 2.8 … (seen in files.read_text path="Vendor Desk/Policies/Vendor Master Policy.pdf": “2.8 Filing documents…”)

What I changed:
• Moved Incoming/a.pdf → Onboarding/X/GST Certificate - X.pdf

Verifier: all 3 checks passed on a fresh read.`;

describe("short reply for people (the full report stays for debugging)", () => {
  it("keeps only the lead paragraph, cut at a sentence, never the evidence sections", () => {
    const lead = leadParagraph(LONG);
    expect(lead.startsWith("Sorted 10 vendor documents")).toBe(true);
    expect(lead.length).toBeLessThanOrEqual(430);
    expect(lead).not.toMatch(/What I found|seen in/);
    expect(/[.!?…]$/.test(lead)).toBe(true);
  });

  it("says whether it was checked, how much changed and how much is open", () => {
    const ok = shortReply({ report: LONG, verdicts: [{ criterion: "a", verdict: "pass" }, { criterion: "b", verdict: "pass" }], changes: 12, open: 0 });
    expect(ok).toContain("✓ Checked again from the sources: all 2 checks passed.");
    expect(ok).toContain("12 changes made. You can undo any of them in the Changes tab.");
    expect(ok).not.toContain("still open");
    const bad = shortReply({ report: "Done.", verdicts: [{ criterion: "The invoice shows the due date", verdict: "fail" }], changes: 1, open: 2 });
    expect(bad).toContain("⚠ Not fully confirmed: The invoice shows the due date.");
    expect(bad).toContain("1 change made.");
    expect(bad).toContain("2 items are still open.");
  });

  it("a rehearsal says nothing was changed and what is ready", () => {
    const r = shortReply({ report: "Plan ready.", verdicts: [], changes: 0, open: 0, rehearsal: { previews: 14 } });
    expect(r).toBe("Plan ready.\nNothing has been changed yet. 14 changes are ready: apply them or discard.");
  });
});
