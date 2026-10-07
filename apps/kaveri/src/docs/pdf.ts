import { PDFDocument, StandardFonts, rgb, type PDFFont, type PDFPage } from "pdf-lib";
import { BIDDERS, COMPANY, VENDORS } from "../seed/scenario.ts";

/**
 * Generates the scenario's documents as real, text-based PDFs (so the agent
 * has to actually read/extract them). Simplified look-alikes of Indian
 * formats, clearly marked SPECIMEN. All parties are fictional.
 * Note: standard PDF fonts can't render "₹", so amounts use "Rs.".
 */

type Line = { text: string; size?: number; bold?: boolean; gap?: number; color?: [number, number, number] };

async function render(title: string, subtitle: string, lines: Line[]): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  doc.setTitle(title);
  doc.setProducer("Kaveri mock environment (specimen documents)");
  const page = doc.addPage([595, 842]); // A4
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  let y = 790;
  const draw = (p: PDFPage, t: string, f: PDFFont, size: number, color = rgb(0.1, 0.1, 0.1)) => {
    p.drawText(t, { x: 56, y, size, font: f, color });
  };
  draw(page, title, bold, 16);
  y -= 20;
  draw(page, subtitle, font, 10, rgb(0.35, 0.35, 0.35));
  y -= 14;
  page.drawLine({ start: { x: 56, y }, end: { x: 539, y }, thickness: 0.8, color: rgb(0.6, 0.6, 0.6) });
  y -= 26;
  for (const l of lines) {
    draw(page, l.text, l.bold ? bold : font, l.size ?? 11, l.color ? rgb(...l.color) : undefined);
    y -= l.gap ?? 18;
  }
  page.drawText("SPECIMEN: fictional document generated for the Theseus Mini mock environment", {
    x: 56, y: 40, size: 8, font, color: rgb(0.55, 0.55, 0.55),
  });
  return doc.save({ useObjectStreams: false });
}

const kv = (k: string, v: string): Line => ({ text: `${k}:  ${v}` });

type Bidder = (typeof BIDDERS)[keyof typeof BIDDERS];

const gstCert = (b: Bidder) =>
  render("Form GST REG-06: Registration Certificate", "Government of India · Goods and Services Tax", [
    kv("Registration Number (GSTIN)", b.gstin),
    kv("Legal Name", b.legalName.toUpperCase()),
    kv("Trade Name, if any", ("tradeName" in b && b.tradeName) || b.legalName),
    kv("Constitution of Business", constitution(b.pan)),
    kv("Address of Principal Place of Business", b.address),
    kv("Date of Liability", "15/02/2021"),
    kv("Type of Registration", "Regular"),
    { text: "", gap: 10 },
    { text: "This is a system generated digitally signed Registration Certificate.", size: 9 },
  ]);

const panCard = (b: Bidder) => {
  const pan = "panOnCard" in b ? b.panOnCard : b.pan;
  return render("Permanent Account Number Card", "Income Tax Department · Govt. of India", [
    kv("Name", b.legalName.toUpperCase()),
    kv("Permanent Account Number", pan),
    kv("Date of Incorporation / Formation", "11/06/2018"),
  ]);
};

const cheque = (b: Bidder) =>
  render("Cancelled Cheque", bankName(b.bank.ifsc), [
    { text: "CANCELLED", bold: true, size: 28, color: [0.75, 0.1, 0.1], gap: 34 },
    kv("Pay", "____________________"),
    kv("A/c No.", b.bank.accountNumber),
    kv("IFSC", b.bank.ifsc),
    kv("A/c Holder", b.bank.holderName),
  ]);

const udyam = (b: Bidder & { udyam?: { number: string; category: string } }) =>
  render("UDYAM Registration Certificate", "Ministry of Micro, Small and Medium Enterprises", [
    kv("Udyam Registration Number", b.udyam!.number),
    kv("Name of Enterprise", b.legalName.toUpperCase()),
    kv("Type of Enterprise", b.udyam!.category.toUpperCase()),
    kv("Major Activity", "Services (Construction)"),
    kv("Date of Classification", "01/04/2025"),
  ]);

const sgChangeLetter = () =>
  render("SHREE GANESH CONSTRUCTIONS", "No. 88, 5th Main, Peenya Industrial Area, Bengaluru", [
    kv("Date", "03/10/2026"),
    { text: `To: Accounts Department, ${COMPANY.name}`, gap: 26 },
    { text: "Sub: Change of bank account: URGENT", bold: true, gap: 24 },
    { text: "Due to an audit our existing account is frozen. Please make all future payments to:" },
    kv("Account name", "SG Construction Services"),
    kv("Account number", "7712049935"),
    kv("IFSC", "KKBK0000131"),
    { text: "Kindly do not call our office as the MD is travelling; reply on email only.", gap: 30 },
    { text: "For Shree Ganesh Constructions,  (signed)  Authorised Signatory" },
  ]);

const arkaChangeLetter = () =>
  render("HDFC Bank Ltd", "Branch relocation notice", [
    kv("Date", "01/10/2026"),
    { text: "To whom it may concern,", gap: 24 },
    { text: "Our Electronic City branch has relocated. Accounts are unchanged; the IFSC changes:" },
    kv("Old IFSC", "HDFC0000001"),
    kv("New IFSC", "HDFC0000532"),
    kv("Account holder", "ARKA SOLAR SYSTEMS PRIVATE LIMITED"),
    kv("Account number", "50200031877265"),
    { text: "Branch Manager (signed)" },
  ]);

const bidForm = (b: Bidder, tenderBid: { amount: number; emd: string }) =>
  render("Bid Form: Tender T-2026-14", "Kaveri eProcure · Resurfacing of NH-948 service road, Ramanagara (Package 2)", [
    kv("Bidder", b.legalName),
    kv("PAN (as declared)", "panOnCard" in b ? b.panOnCard : b.pan),
    kv("GSTIN", b.gstin),
    kv("Registered address", b.address),
    kv("Contact", `${b.email} · ${b.phone}`),
    kv("Quoted amount", `Rs. ${tenderBid.amount.toLocaleString("en-IN")}`),
    kv("Bid security (EMD)", `Bank guarantee ${tenderBid.emd}`),
    { text: "", gap: 10 },
    { text: "We declare that the information furnished above is true and correct.", size: 10 },
    { text: "Authorised Signatory (signed)", size: 10 },
  ]);

const emdGuarantee = (b: Bidder, g: { number: string; bank: string; amount: number; until: string }) =>
  render("Bank Guarantee: Bid Security (EMD)", g.bank, [
    kv("Guarantee No.", g.number),
    kv("Beneficiary", COMPANY.name),
    kv("On behalf of", b.legalName),
    kv("Amount", `Rs. ${g.amount.toLocaleString("en-IN")}`),
    kv("Valid until", g.until),
    kv("Tender", "T-2026-14"),
    { text: "", gap: 10 },
    { text: "We undertake to pay the beneficiary on first written demand without demur.", size: 10 },
    { text: "Authorised Officer (signed and sealed)", size: 10 },
  ]);

/** A GST tax invoice (CGST + SGST, intra-state), the kind AP books every day. */
const taxInvoice = (inv: { number: string; date: string; due: string; wo: string; lines: [string, number][]; taxable: number; gst: number }) => {
  const rs = (n: number) => `Rs. ${n.toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  const half = inv.gst / 2;
  return render("TAX INVOICE", "Hoysala Steel Fabricators Private Limited · Plot 21, KIADB, Dobbaspet, Tumakuru, Karnataka 562111", [
    kv("GSTIN", VENDORS.find((v) => v.id === "V-103")!.gstin!),
    kv("Invoice No.", inv.number),
    kv("Invoice Date", inv.date),
    kv("Due Date", inv.due),
    kv("Bill to", `${COMPANY.name}, ${COMPANY.address.split(",").slice(0, 2).join(",")}`),
    kv("Buyer GSTIN", COMPANY.gstin),
    kv("Work order", inv.wo),
    { text: "", gap: 8 },
    { text: "Description                                                    Amount", bold: true },
    ...inv.lines.map(([d, a]) => ({ text: `${d.padEnd(60, " ")} ${rs(a)}` })),
    { text: "", gap: 8 },
    kv("Taxable value", rs(inv.taxable)),
    kv("CGST @ 9%", rs(half)),
    kv("SGST @ 9%", rs(half)),
    { text: `Invoice total:  ${rs(inv.taxable + inv.gst)}`, bold: true },
    { text: "Payment terms: 30 days from invoice date. Please quote the invoice number with payment.", size: 9 },
    { text: "For Hoysala Steel Fabricators Pvt Ltd  (signed)  Authorised Signatory", size: 10 },
  ]);
};

function constitution(pan: string): string {
  return ({ P: "Proprietorship", F: "Partnership / LLP", C: "Private Limited Company" } as Record<string, string>)[pan[3]!] ?? "Other";
}
function bankName(ifsc: string): string {
  return ({ HDFC: "HDFC Bank Ltd", ICIC: "ICICI Bank Ltd", SBIN: "State Bank of India" } as Record<string, string>)[ifsc.slice(0, 4)] ?? "Bank";
}

const GENERATORS: Record<string, () => Promise<Uint8Array>> = {
  "gst:A": () => gstCert(BIDDERS.A),
  "gst:B": () => gstCert(BIDDERS.B),
  "gst:C": () => gstCert(BIDDERS.C),
  "pan:A": () => panCard(BIDDERS.A),
  "pan:B": () => panCard(BIDDERS.B),
  "pan:C": () => panCard(BIDDERS.C),
  "cheque:A": () => cheque(BIDDERS.A),
  "cheque:B": () => cheque(BIDDERS.B),
  "cheque:C": () => cheque(BIDDERS.C),
  "udyam:A": () => udyam(BIDDERS.A),
  "udyam:C": () => udyam(BIDDERS.C),
  "bidform:A": () => bidForm(BIDDERS.A, { amount: 46_950_000, emd: "PBG/HDFC/2026/88123" }),
  "bidform:B": () => bidForm(BIDDERS.B, { amount: 47_400_000, emd: "PBG/ICICI/2026/55120" }),
  "bidform:C": () => bidForm(BIDDERS.C, { amount: 45_880_000, emd: "PBG/SBI/2026/40917" }),
  "emdbg:A": () => emdGuarantee(BIDDERS.A, { number: "PBG/HDFC/2026/88123", bank: "HDFC Bank, Bidadi", amount: 1_250_000, until: "31/10/2027" }),
  "emdbg:B": () => emdGuarantee(BIDDERS.B, { number: "PBG/ICICI/2026/55120", bank: "ICICI Bank, Channapatna", amount: 1_100_000, until: "31/08/2027" }),
  "emdbg:C": () => emdGuarantee(BIDDERS.C, { number: "PBG/SBI/2026/40917", bank: "State Bank of India, Mysuru", amount: 980_000, until: "30/09/2027" }),
  "bankchange:SG": sgChangeLetter,
  "bankchange:ARKA": arkaChangeLetter,
  "invoice:HSF-0431": () =>
    taxInvoice({ number: "HSF/2026/0431", date: "23/09/2026", due: "23/10/2026", wo: "WO-2026-103", lines: [["Structural steel fabrication, culvert C-7 (RA-3)", 349_576]], taxable: 349_576, gst: 62_924 }),
  "invoice:HSF-0447": () =>
    taxInvoice({
      number: "HSF/2026/0447",
      date: "03/10/2026",
      due: "02/11/2026",
      wo: "WO-2026-103",
      lines: [["Structural steel fabrication, culvert C-7 (RA-4)", 298_000], ["Hot-dip galvanising, 4.2 t", 64_000]],
      taxable: 362_000,
      gst: 65_160,
    }),
};

const cache = new Map<string, Promise<Uint8Array>>();

/** PDF bytes for a document key, or undefined if unknown. Cached after first render. */
export function getDocument(key: string): Promise<Uint8Array> | undefined {
  const gen = GENERATORS[key];
  if (!gen) return undefined;
  if (!cache.has(key)) cache.set(key, gen());
  return cache.get(key);
}

export const DOCUMENT_KEYS = Object.keys(GENERATORS);
