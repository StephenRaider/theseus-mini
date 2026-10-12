import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FileSandbox, ToolGateway, EventLog, IdMaker, fileTools } from "@theseus/core";
import { INTAKE_TRUTH, generateIntake } from "@theseus/kaveri";
import { describe, expect, it } from "vitest";
import { checkIntake, originalHashes, snapshot } from "../src/intake-check.ts";

async function pile() {
  const ws = await mkdtemp(join(tmpdir(), "intake-test-"));
  await generateIntake(ws);
  const log = new EventLog();
  const g = new ToolGateway({ log, ids: new IdMaker(), tools: fileTools(new FileSandbox([{ id: "w", label: "W", path: ws }]), "w") });
  return { ws, log, g, orig: await originalHashes(ws) };
}

const ext = (p: string) => p.slice(p.lastIndexOf("."));
const idealMoves = () => [
  ...INTAKE_TRUTH.filed.map((f) => ({ from: f.source, to: `Onboarding/${f.vendor}/${f.type} - ${f.vendor}${ext(f.source)}` })),
  ...INTAKE_TRUTH.duplicates.map((d) => ({ from: d.source, to: "Onboarding/_Review/Duplicates/" + d.source.split("/").pop() })),
  ...INTAKE_TRUTH.unrelated.map((u) => ({ from: u, to: "Onboarding/_Review/Not vendor documents/" + u.split("/").pop() })),
];

describe("messy intake: fixtures, answer key and the tools to clear it", () => {
  it("the untouched pile fails every sorting check (the checker is not a rubber stamp)", async () => {
    const { ws, orig } = await pile();
    const failed = checkIntake(await snapshot(ws), orig, "").filter((c) => !c.ok);
    expect(failed.length).toBeGreaterThanOrEqual(6);
    expect(failed.map((c) => c.name)).not.toContain("Nothing was lost or deleted");
  });

  it("files can be read by the model's own hands: PDFs, Word, and pictures by sight", async () => {
    const { g } = await pile();
    const r = await g.call<{ files: { path: string; text?: string; error?: string }[] }>("files.read_many", { paths: "Incoming/scan0231.pdf\nIncoming/from Suresh/udyam final (1).docx\nIncoming/cheque.png" }, { employeeId: "e" });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data.files[0]!.text).toContain("29AAQFN6623R");
    expect(r.data.files[1]!.text).toContain("UDYAM-KR-29-0006614");
    expect(r.data.files[2]!.error).toMatch(/no model that can look at pictures/); // no vision model attached in this bare gateway
  });

  it("the ideal clean-up passes every check; undoing it puts the pile back exactly", async () => {
    const { ws, g, log, orig } = await pile();
    const moved = await g.call("files.move_many", { moves: idealMoves().map((m) => `${m.from} => ${m.to}`).join("\n") }, { employeeId: "e", taskId: "t" });
    expect(moved.ok).toBe(true);
    const { default: ExcelJS } = await import("exceljs");
    void ExcelJS;
    const rows: string[][] = [["Vendor", "Document", "Status", "Issues"]];
    for (const f of INTAKE_TRUTH.filed) rows.push([f.vendor, f.type, "Received", ""]);
    for (const m of INTAKE_TRUTH.missing) for (const t of m.types) rows.push([m.vendor, t, "Missing", ""]);
    rows.push(["Vrishabha Earthmovers", "PAN Card", "Received", "PAN on card AAHFV2209L does not match the GSTIN's PAN: mismatch"]);
    await g.call("files.save_xlsx", { path: "Onboarding/Document Checklist.xlsx", sheet: "Checklist", rows: rows.map((r) => r.join(" | ")).join("\n") }, { employeeId: "e", taskId: "t" });
    await g.call("files.save_text", { path: "Drafts/Nandi Roadways LLP - request.txt", text: "Dear Nandi Roadways LLP, please send a cancelled cheque (bank proof)." }, { employeeId: "e", taskId: "t" });
    await g.call("files.save_text", { path: "Drafts/Sri Lakshmi Buildcon - request.txt", text: "Dear Sri Lakshmi Buildcon, please send your Udyam certificate and a signed proprietor declaration." }, { employeeId: "e", taskId: "t" });

    const bad = checkIntake(await snapshot(ws), orig, "").filter((c) => !c.ok);
    expect(bad.map((c) => `${c.name}: ${c.detail}`)).toEqual([]);

    // Undo everything, newest first, exactly as the kernel does.
    for (const e of log.ofType("effect.recorded").reverse()) {
      const u = e.payload.undo!;
      expect((await g.call(u.tool, u.input, { employeeId: "e", taskId: "t" })).ok).toBe(true);
    }
    const after = await snapshot(ws);
    for (const [path, hash] of orig) expect(after.byHash.get(hash)).toContain(path);
    expect(after.paths.filter((p) => p.startsWith("Onboarding/"))).toEqual([]);
  });
});
