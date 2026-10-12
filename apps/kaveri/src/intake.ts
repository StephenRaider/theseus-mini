import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Document, Packer, Paragraph, TextRun } from "docx";
import ExcelJS from "exceljs";
import { PDFDocument, StandardFonts, rgb } from "pdf-lib";
import { BIDDERS } from "./seed/scenario.ts";

/**
 * The messy "Incoming" folder: what really lands on a procurement desk. Documents from three bidders arrive
 * in mixed formats (PDF, Word, phone photos), under chaotic names, in whichever sub-folder someone happened
 * to save them. Some are duplicates, one is unrelated, some vendors forgot to send things, and one PAN card
 * disagrees with the GST certificate. The ground truth below says what a careful person would do.
 *
 * Pictures are pre-rendered (apps/kaveri/assets/scans, made by packages/browser/scripts/render-scans.mjs) so
 * generating the workspace needs no browser. Their text is kept here too: it is what the offline stand-in
 * model "reads", and what the renderer draws.
 */
const ASSETS = resolve(dirname(fileURLToPath(import.meta.url)), "../assets/scans");

export const DOC_TYPES = ["GST Certificate", "PAN Card", "Bank Proof", "Udyam Certificate", "Proprietor Declaration", "Bid Form"] as const;
export type DocType = (typeof DOC_TYPES)[number];

const A = BIDDERS.A;
const B = BIDDERS.B;
const C = BIDDERS.C;

export interface Scan {
  file: string;
  kind: "pan" | "gst" | "cheque";
  title: string;
  lines: string[];
}

const pan = (name: string, p: string, dob: string): Scan["lines"] => [`Permanent Account Number: ${p}`, `Name: ${name}`, `Date of Incorporation/Birth: ${dob}`, "Signature: [signed]"];
const gst = (name: string, g: string, addr: string, issued: string): Scan["lines"] => [
  "Registration Number: " + g,
  `Legal Name: ${name}`,
  `Address of Principal Place of Business: ${addr}`,
  "Type of Registration: Regular",
  `Date of issue of Certificate: ${issued}`,
];

/** Pictures. `file` is the asset name; `transcript` is what a perfect reader would write down. */
export const SCANS: Scan[] = [
  { file: "pan-nandi.png", kind: "pan", title: "INCOME TAX DEPARTMENT · GOVT. OF INDIA", lines: pan(A.legalName.toUpperCase(), A.pan, "12/03/2018") },
  { file: "gst-vrishabha.png", kind: "gst", title: "FORM GST REG-06 · REGISTRATION CERTIFICATE", lines: gst(B.legalName.toUpperCase(), B.gstin, B.address, "15/02/2021") },
  { file: "pan-srilakshmi.png", kind: "pan", title: "INCOME TAX DEPARTMENT · GOVT. OF INDIA", lines: pan("LAKSHMI RAGHAVENDRA", C.pan, "04/09/1981") },
  {
    file: "cheque-srilakshmi.png",
    kind: "cheque",
    title: "STATE BANK OF INDIA · MYSURU",
    lines: ["CANCELLED", `Account Number: ${C.bank.accountNumber}`, `IFSC: ${C.bank.ifsc}`, `Account Holder: ${C.bank.holderName}`, "Branch: Vijayanagar, Mysuru"],
  },
];

export const scanTranscript = (s: Scan) => [s.title, ...s.lines].join("\n");
export const scanPath = (s: Scan) => join(ASSETS, s.file);

/* ------------------------------------------------------------------ text documents */

async function pdf(title: string, lines: string[]): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const page = doc.addPage([595, 842]);
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  let y = 780;
  page.drawText(title, { x: 56, y, size: 15, font: bold, color: rgb(0.1, 0.1, 0.1) });
  y -= 34;
  for (const l of lines) {
    page.drawText(l, { x: 56, y, size: 11, font });
    y -= 20;
  }
  page.drawText("SPECIMEN: fictional document generated for the Theseus Mini simulation", { x: 56, y: 40, size: 8, font, color: rgb(0.55, 0.55, 0.55) });
  return doc.save({ useObjectStreams: false });
}

async function docx(title: string, lines: string[]): Promise<Uint8Array> {
  const d = new Document({
    sections: [{ children: [new Paragraph({ children: [new TextRun({ text: title, bold: true, size: 30 })] }), ...lines.map((l) => new Paragraph({ children: [new TextRun(l)] }))] }],
  });
  return new Uint8Array(await Packer.toBuffer(d));
}

async function xlsx(rows: string[][]): Promise<Uint8Array> {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet("Sheet1");
  rows.forEach((r) => ws.addRow(r));
  return new Uint8Array(await wb.xlsx.writeBuffer());
}

const scan = (file: string) => SCANS.find((s) => s.file === file)!;

interface Piece {
  /** Where it lands in the workspace. */
  path: string;
  make: () => Promise<Uint8Array | Buffer | string>;
  /** Ground truth: whose document, and what kind. */
  truth: { vendor: string; type: DocType } | { duplicateOf: string } | { unrelated: true } | { note: true };
}

const gstLines = (v: typeof A | typeof C) => gst(v.legalName.toUpperCase(), v.gstin, v.address, "15/02/2021");

const PIECES: Piece[] = [
  { path: "Incoming/scan0231.pdf", make: () => pdf("Registration Certificate (Form GST REG-06)", gstLines(A)), truth: { vendor: A.legalName, type: "GST Certificate" } },
  { path: "Incoming/IMG-20261003-WA0012.png", make: () => readFile(scanPath(scan("pan-nandi.png"))), truth: { vendor: A.legalName, type: "PAN Card" } },
  {
    path: "Incoming/from Suresh/udyam final (1).docx",
    make: () => docx("Udyam Registration Certificate", [`Udyam Registration Number: ${A.udyam.number}`, `Name of Enterprise: ${A.legalName.toUpperCase()}`, `Type of Enterprise: Small`, "Date of Registration: 01/04/2021"]),
    truth: { vendor: A.legalName, type: "Udyam Certificate" },
  },
  { path: "Incoming/Nandi Bid Form final_FINAL.pdf", make: () => pdf("Bid Form · T-2026-14", [`Bidder: ${A.legalName}`, "Tender: Resurfacing of NH-948 service road (Package 2)", "Quoted amount: Rs. 4,69,50,000"]), truth: { vendor: A.legalName, type: "Bid Form" } },
  { path: "Incoming/WhatsApp Image 2026-10-04 at 4.12.33 PM.png", make: () => readFile(scanPath(scan("gst-vrishabha.png"))), truth: { vendor: B.legalName, type: "GST Certificate" } },
  {
    path: "Incoming/from Suresh/pan_card_scan.pdf",
    make: () => pdf("Income Tax Department · Permanent Account Number Card", pan(B.legalName.toUpperCase(), B.panOnCard, "22/07/2015")),
    truth: { vendor: B.legalName, type: "PAN Card" },
  },
  {
    path: "Incoming/misc/bank letter ICICI.docx",
    make: () => docx("ICICI Bank · Channapatna Branch", ["To whom it may concern", `We confirm that ${B.bank.holderName} holds a current account.`, `Account Number: ${B.bank.accountNumber}`, `IFSC: ${B.bank.ifsc}`, `Account Holder: ${B.bank.holderName}`]),
    truth: { vendor: B.legalName, type: "Bank Proof" },
  },
  { path: "Incoming/GST-REG-06.pdf", make: () => pdf("Registration Certificate (Form GST REG-06)", gstLines(C)), truth: { vendor: C.legalName, type: "GST Certificate" } },
  { path: "Incoming/misc/PXL_20261005_071204.png", make: () => readFile(scanPath(scan("pan-srilakshmi.png"))), truth: { vendor: C.legalName, type: "PAN Card" } },
  { path: "Incoming/misc/img0098 copy.png", make: () => readFile(scanPath(scan("pan-srilakshmi.png"))), truth: { duplicateOf: "Incoming/misc/PXL_20261005_071204.png" } },
  { path: "Incoming/cheque.png", make: () => readFile(scanPath(scan("cheque-srilakshmi.png"))), truth: { vendor: C.legalName, type: "Bank Proof" } },
  { path: "Incoming/Diwali hamper list.xlsx", make: () => xlsx([["Item", "Qty"], ["Sweets box", "40"], ["Dry fruits", "25"]]), truth: { unrelated: true } },
  { path: "Incoming/from Suresh/notes.txt", make: async () => "Sent what I could find. Will forward the rest from the other mails tomorrow. - Suresh\n", truth: { note: true } },
];

/** Create the Incoming pile inside a workspace. */
export async function generateIntake(workspaceDir: string): Promise<void> {
  for (const p of PIECES) {
    const abs = join(workspaceDir, p.path);
    await mkdir(dirname(abs), { recursive: true });
    await writeFile(abs, await p.make());
  }
}

/** True when the pre-rendered pictures exist (they are committed; a missing set means a broken checkout). */
export const scansAvailable = () => SCANS.every((s) => existsSync(scanPath(s)));

/* ------------------------------------------------------------------ ground truth */

export interface IntakeTruth {
  /** Every file that should end up filed under a vendor: the right folder and the right document type in its name. */
  filed: { source: string; vendor: string; type: DocType }[];
  duplicates: { source: string; of: string }[];
  unrelated: string[];
  /** What each vendor still has to send. */
  missing: { vendor: string; types: DocType[] }[];
  /** Things a careful person would flag. */
  issues: { vendor: string; about: string }[];
}

export const INTAKE_TRUTH: IntakeTruth = {
  filed: PIECES.flatMap((p) => ("vendor" in p.truth ? [{ source: p.path, vendor: p.truth.vendor, type: p.truth.type }] : [])),
  duplicates: PIECES.flatMap((p) => ("duplicateOf" in p.truth ? [{ source: p.path, of: p.truth.duplicateOf }] : [])),
  unrelated: PIECES.flatMap((p) => ("unrelated" in p.truth ? [p.path] : [])),
  missing: [
    { vendor: A.legalName, types: ["Bank Proof"] },
    { vendor: C.legalName, types: ["Udyam Certificate", "Proprietor Declaration"] },
  ],
  issues: [{ vendor: B.legalName, about: `PAN on the card (${B.panOnCard}) is not the PAN inside the GSTIN (${B.pan})` }],
};

export const INTAKE_VENDORS = [A.legalName, B.legalName, C.legalName];
