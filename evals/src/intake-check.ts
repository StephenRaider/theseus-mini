import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { INTAKE_TRUTH } from "@theseus/kaveri";
import ExcelJS from "exceljs";

/** The messy-intake answer key, checked against the real folders after the employee is done. */

export interface Snapshot {
  /** content hash → paths (workspace-relative) holding that exact content, .trash excluded */
  byHash: Map<string, string[]>;
  /** every workspace-relative path */
  paths: string[];
  /** text of Onboarding/*checklist*.xlsx, row by row, lower-cased */
  checklistRows: string[];
  /** text of files under Drafts/ and Outbox/ (letters the employee wrote), lower-cased */
  drafts: string[];
}

const sha = (b: Buffer | Uint8Array) => createHash("sha1").update(b).digest("hex");

async function walk(root: string, rel = ""): Promise<string[]> {
  const out: string[] = [];
  for (const e of await readdir(join(root, rel), { withFileTypes: true }).catch(() => [])) {
    if (e.name.startsWith(".")) continue;
    const r = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory()) out.push(...(await walk(root, r)));
    else out.push(r);
  }
  return out;
}

/** Plain text of a docx/xlsx/txt/pdf is not needed in full: drafts only need a rough "does it mention X" test. */
async function looseText(file: string): Promise<string> {
  const b = await readFile(file);
  if (/\.docx$/i.test(file)) {
    const JSZip = (await import("jszip")).default;
    const xml = await (await JSZip.loadAsync(b)).file("word/document.xml")?.async("string");
    return (xml ?? "").replace(/<[^>]+>/g, " ").toLowerCase();
  }
  return b.toString("utf8").toLowerCase();
}

export async function snapshot(ws: string, mailDrafts: string[] = []): Promise<Snapshot> {
  const paths = await walk(ws);
  const byHash = new Map<string, string[]>();
  for (const p of paths) {
    const h = sha(await readFile(join(ws, p)));
    byHash.set(h, [...(byHash.get(h) ?? []), p]);
  }
  const checklistRows: string[] = [];
  for (const p of paths.filter((x) => /^onboarding\/.*checklist.*\.xlsx$/i.test(x))) {
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.readFile(join(ws, p));
    wb.eachSheet((s) => s.eachRow((r) => checklistRows.push((r.values as unknown[]).slice(1).map((v) => String((v as { text?: string })?.text ?? v ?? "")).join(" | ").toLowerCase())));
  }
  const drafts: string[] = [];
  for (const p of paths.filter((x) => /^(drafts|outbox)\//i.test(x))) drafts.push(`${p.toLowerCase()} ${await looseText(join(ws, p)).catch(() => "")}`);
  drafts.push(...mailDrafts.map((d) => d.toLowerCase()));
  return { byHash, paths, checklistRows, drafts };
}

/** What the pile hashes to right now: call this BEFORE the employee starts (Word files differ between generations). */
export async function originalHashes(ws: string): Promise<Map<string, string>> {
  const m = new Map<string, string>();
  for (const p of await walk(ws, "Incoming")) m.set(p, sha(await readFile(join(ws, p))));
  return m;
}

export interface IntakeCheck {
  name: string;
  ok: boolean;
  detail?: string;
}
const ck = (name: string, ok: boolean, detail?: string): IntakeCheck => ({ name, ok, ...(detail ? { detail } : {}) });
const lc = (s: string) => s.toLowerCase();
const ROW_WORDS: Record<string, RegExp> = {
  "Bank Proof": /bank proof|cheque|bank letter/,
  "Udyam Certificate": /udyam/,
  "Proprietor Declaration": /declaration/,
  "GST Certificate": /gst/,
  "PAN Card": /\bpan\b/,
  "Bid Form": /bid form/,
};
const rowsFor = (rows: string[], vendor: string, type: string) => rows.filter((r) => r.includes(vendor.toLowerCase().split(" ")[0]!) && (r.includes(type.toLowerCase()) || ROW_WORDS[type]!.test(r)));
const DOC_SYNONYM: Record<string, RegExp> = { "Bank Proof": /bank proof|cancel+ed cheque|bank letter/, "Udyam Certificate": /udyam/, "Proprietor Declaration": /declaration/ };

/** State of the folders vs the answer key. `said` = everything the employee told you. */
export function checkIntake(s: Snapshot, orig: Map<string, string>, said: string): IntakeCheck[] {
  const T = INTAKE_TRUTH;
  const live = (h: string) => s.byHash.get(h) ?? [];
  const lost = [...orig].filter(([, h]) => live(h).length === 0).map(([p]) => p);
  const checks: IntakeCheck[] = [ck("Nothing was lost or deleted", lost.length === 0, lost.join(", "))];

  const misfiled: string[] = [];
  for (const f of T.filed) {
    const h = orig.get(f.source)!;
    const ok = live(h).some((p) => {
      const [top, folder, ...rest] = p.split("/");
      const name = rest.join("/");
      return lc(top!) === "onboarding" && lc(folder!) === lc(f.vendor) && lc(name).startsWith(lc(f.type)) && lc(name).includes(lc(f.vendor)) && /\.[a-z0-9]+$/.test(name);
    });
    if (!ok) misfiled.push(`${f.source} (${f.type}, ${f.vendor}) is at ${live(h).join(" and ") || "nowhere"}`);
  }
  checks.push(ck(`All ${T.filed.length} vendor documents are filed under the right vendor with a standard name`, misfiled.length === 0, misfiled.join(" ; ")));

  const dupBad = T.duplicates.filter((d) => {
    const h = orig.get(d.source)!;
    const copies = live(h);
    const inVendor = copies.filter((p) => /^onboarding\/[^_][^/]*\//i.test(p) && !/\/_review\//i.test(p));
    return !(copies.length >= 2 && inVendor.length === 1 && copies.some((p) => /_review\/duplicates/i.test(p)));
  });
  checks.push(ck("The duplicate copy is set aside under _Review/Duplicates, not filed twice and not deleted", dupBad.length === 0, dupBad.map((d) => d.source).join(", ")));

  const strayUnrelated = T.unrelated.filter((u) => {
    const copies = live(orig.get(u)!);
    return !copies.some((p) => /^onboarding\/_review\/not vendor documents\//i.test(p));
  });
  checks.push(ck("The unrelated file is set aside under _Review/Not vendor documents", strayUnrelated.length === 0, strayUnrelated.join(", ")));

  const leftover = T.filed.map((f) => f.source).filter((p) => s.paths.includes(p));
  checks.push(ck("Nothing that was filed is still sitting in Incoming", leftover.length === 0, leftover.join(", ")));

  const rows = s.checklistRows;
  checks.push(ck("A document checklist workbook exists in Onboarding", rows.length > 1));
  const missingWrong: string[] = [];
  for (const m of T.missing)
    for (const t of m.types) {
      if (!rowsFor(rows, m.vendor, t).some((r) => /missing|not received|outstanding|pending/.test(r))) missingWrong.push(`${m.vendor}: ${t}`);
    }
  checks.push(ck("The checklist marks exactly the documents that are missing as missing", missingWrong.length === 0, `not marked missing: ${missingWrong.join(", ")}`));
  const falseMissing = T.filed.filter((f) => {
    const rs = rowsFor(rows, f.vendor, f.type);
    return rs.length > 0 && rs.every((r) => /missing|not received/.test(r) && !/received|yes|✓/.test(r));
  });
  checks.push(ck("It does not claim a document is missing when it was received", falseMissing.length === 0, falseMissing.map((f) => `${f.vendor}: ${f.type}`).join(", ")));

  const everything = lc(`${said}\n${rows.join("\n")}`);
  for (const i of T.issues) checks.push(ck(`It flags: ${i.about}`, /aahfv2209l/.test(everything) && /aahfv2290l/.test(everything)));

  for (const m of T.missing)
    for (const t of m.types) {
      const re = DOC_SYNONYM[t]!;
      checks.push(ck(`A request to ${m.vendor} for the ${t} is drafted`, s.drafts.some((d) => d.includes(lc(m.vendor).split(" ")[0]!) && re.test(d)) || new RegExp(`${lc(m.vendor).split(" ")[0]}[^]{0,400}${re.source}`).test(lc(said)) && s.drafts.length > 0));
    }
  return checks;
}
