import type { BankGuarantee, DebarmentEntry, Email, Employee, PaidBill, PaymentLine, Tender, UdyamCategory, Vendor } from "../domain.ts";
import { gstin } from "./ids.ts";

/**
 * Deterministic "everyday" data that surrounds the planted traps: ordinary
 * vendors, employees, payment lines and a lot of irrelevant mail. A real
 * employee's day is mostly routine; the agent has to find the few things that
 * matter inside it.
 *
 * Rule: filler must NEVER create an accidental trap (a test runs every
 * detector over the whole world and expects to find exactly the planted ones).
 * So: TDS always correct, MSME deadlines comfortably in the future, unique
 * bill numbers and amounts, no recent bank changes, distinct names/addresses.
 */

function mulberry32(seed: number) {
  return () => {
    let t = (seed += 0x6d2b79f5);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rand = mulberry32(2026);
const int = (a: number, b: number) => a + Math.floor(rand() * (b - a + 1));
const pick = <T>(xs: readonly T[]): T => xs[Math.floor(rand() * xs.length)]!;
const LETTERS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
const digits = (n: number) => Array.from({ length: n }, () => int(0, 9)).join("");
const ts = (date: string, time: string) => `${date}T${time}:00.000+05:30`;
const daysBefore = (date: string, d: number) => new Date(Date.parse(`${date}T00:00:00Z`) - d * 86_400_000).toISOString().slice(0, 10);
const time = () => `${String(int(8, 19)).padStart(2, "0")}:${String(int(0, 59)).padStart(2, "0")}`;

/** Real IFSC codes (present in Razorpay's IFSC dataset; verified by tests). */
const IFSC_POOL = [
  "SBIN0000041", "SBIN0000141", "SBIN0000261", "SBIN0000391", "CNRB0000048", "CNRB0000169", "CNRB0000291", "CNRB0000423",
  "HDFC0000041", "HDFC0000149", "HDFC0000277", "HDFC0000408", "ICIC0000041", "ICIC0000190", "ICIC0000311", "ICIC0000446",
  "UTIB0000042", "UTIB0000141", "UTIB0000261", "UTIB0000391", "KKBK0000192", "KKBK0000431", "KKBK0000732", "KKBK0001414",
  "UBIN0530425", "UBIN0531456", "UBIN0532665", "UBIN0534030", "KARB0000041", "KARB0000142", "KARB0000264", "KARB0000396",
  "BARB0AGHARX", "BARB0AMARWA", "BARB0ARMCUT", "BARB0BAHADA", "IDIB000A044", "IDIB000A169", "IDIB000A565", "IDIB000B019",
  "PUNB0001020", "PUNB0003610", "PUNB0006710", "PUNB0010000", "IOBA0000042", "IOBA0000145", "IOBA0000267", "IOBA0000399",
] as const;

/** Name stems chosen to be clearly distinct from each other and from the trap parties. */
const STEMS = [
  "Ambika", "Bhoomika", "Chamundi", "Durga", "Ekadanta", "Gajanana", "Hemavathi", "Indira", "Jayalakshmi", "Kalyani",
  "Lokesh", "Manjunatha", "Nethra", "Omkar", "Pavan", "Rajarajeshwari", "Sharavathi", "Tirumala", "Uttara", "Vinayaka",
  "Yamuna", "Annapoorna", "Basava", "Chandrika", "Dhanvantari", "Girija", "Harsha", "Ishwar", "Janani", "Kumaradhara",
  "Mahadeshwara", "Narmada", "Padmavathi", "Saraswathi", "Shivaganga", "Udupi", "Vajra", "Yashas", "Aditya", "Bhavani",
  "Chitra", "Devaki", "Garuda", "Hampi", "Jogfalls", "Kodachadri", "Malaprabha", "Nagarhole",
] as const;
const DEBARRED_STEMS = ["Pampa", "Sahyadri", "Talakadu", "Vanivilas", "Ranganatha", "Belur", "Sringeri", "Bandipur"] as const;

const KINDS = [
  { suffix: "Constructions", pan: "F", work: "civil works" },
  { suffix: "Engineering Works", pan: "F", work: "fabrication & erection" },
  { suffix: "Infra Projects Private Limited", pan: "C", work: "road works" },
  { suffix: "Enterprises", pan: "P", work: "site services" },
  { suffix: "Electricals", pan: "F", work: "electrical works" },
  { suffix: "Earthmovers", pan: "F", work: "excavation & hire" },
  { suffix: "Builders", pan: "P", work: "masonry works" },
  { suffix: "Hydraulics Private Limited", pan: "C", work: "pumping & dewatering" },
  { suffix: "Surveyors", pan: "P", work: "survey services" },
  { suffix: "Logistics", pan: "F", work: "material haulage" },
  { suffix: "Interiors", pan: "P", work: "site office fit-out" },
  { suffix: "Waterproofing Solutions", pan: "F", work: "waterproofing" },
  { suffix: "Geotech Labs LLP", pan: "F", work: "soil & material testing" },
  { suffix: "Road Lines", pan: "F", work: "road marking & signage" },
] as const;

const FIRST = ["Prakash", "Nagaraj", "Shobha", "Vinod", "Rekha", "Ganesh", "Lata", "Mohan", "Asha", "Srinivas", "Pooja", "Harish", "Deepa", "Arun", "Sunita", "Kiran", "Manoj", "Geetha", "Rahul", "Usha"];
const LAST = ["Gowda", "Hegde", "Kulkarni", "Patil", "Bhat", "Rao", "Shetty", "Naik", "Kamath", "Reddy", "Murthy", "Pai", "Desai", "Joshi", "Acharya"];

const PLACES = [
  { city: "Bengaluru", state: "Karnataka", code: "29", pin: () => `5600${int(10, 99)}` },
  { city: "Mysuru", state: "Karnataka", code: "29", pin: () => `5700${int(10, 30)}` },
  { city: "Hubballi", state: "Karnataka", code: "29", pin: () => "580020" },
  { city: "Belagavi", state: "Karnataka", code: "29", pin: () => "590001" },
  { city: "Tumakuru", state: "Karnataka", code: "29", pin: () => "572101" },
  { city: "Davanagere", state: "Karnataka", code: "29", pin: () => "577001" },
  { city: "Ballari", state: "Karnataka", code: "29", pin: () => "583101" },
  { city: "Kalaburagi", state: "Karnataka", code: "29", pin: () => "585101" },
  { city: "Udupi", state: "Karnataka", code: "29", pin: () => "576101" },
  { city: "Mandya", state: "Karnataka", code: "29", pin: () => "571401" },
  { city: "Chennai", state: "Tamil Nadu", code: "33", pin: () => `6000${int(10, 99)}` },
  { city: "Hyderabad", state: "Telangana", code: "36", pin: () => `5000${int(10, 99)}` },
  { city: "Pune", state: "Maharashtra", code: "27", pin: () => `4110${int(10, 60)}` },
] as const;
const STREETS = ["Industrial Suburb", "KIADB Industrial Area", "Ring Road", "Station Road", "APMC Yard Road", "Hosur Road", "Tumkur Road", "Bypass Road", "Gandhi Bazaar", "Old Post Office Road", "Sector 7 Layout", "Vidyanagar", "Saraswathipuram", "Gokul Road"];

const usedPan = new Set<string>();
function makePan(type: string, nameInitial: string): string {
  for (;;) {
    const p = `A${LETTERS[int(0, 25)]}${LETTERS[int(0, 25)]}${type}${nameInitial}${digits(4)}${LETTERS[int(0, 25)]}`;
    if (!usedPan.has(p)) {
      usedPan.add(p);
      return p;
    }
  }
}
const slug = (s: string) => s.toLowerCase().replace(/private limited|llp/g, "").replace(/[^a-z]+/g, "");

/* ---------------------------------------------------------------- vendors */

export function fillerVendors(startId: number, count: number): Vendor[] {
  const out: Vendor[] = [];
  for (let i = 0; i < count; i++) {
    const stem = STEMS[i]!;
    const kind = KINDS[i % KINDS.length]!;
    const place = i % 9 === 8 ? PLACES[10 + (Math.floor(i / 9) % 3)]! : PLACES[i % 10]!;
    const legalName = `${stem} ${kind.suffix}`;
    const proprietor = kind.pan === "P" ? `${pick(FIRST)} ${pick(LAST)}` : undefined;
    const pan = makePan(kind.pan, kind.pan === "P" ? proprietor!.split(" ")[1]![0]! : stem[0]!);
    const registered = kind.pan !== "P" || i % 3 !== 0; // some small proprietors are below the GST threshold
    const cat: UdyamCategory = pick(["micro", "small", "small", "medium", "none", "none"] as const);
    const createdAt = ts(`20${int(23, 25)}-${String(int(1, 12)).padStart(2, "0")}-${String(int(1, 28)).padStart(2, "0")}`, "10:30");
    const domain = `${slug(legalName)}.example`;
    const v: Vendor = {
      id: `V-${startId + i}`,
      legalName,
      ...(proprietor ? { tradeName: `${legalName} (Prop. ${proprietor})` } : {}),
      pan,
      ...(registered ? { gstin: gstin(place.code, pan) } : {}),
      address: `${int(1, 240)}, ${pick(STREETS)}, ${place.city}, ${place.state} ${place.pin()}`,
      state: place.state,
      email: proprietor ? `${slug(stem)}.${slug(kind.suffix)}@mail.example` : `accounts@${domain}`,
      phone: `+91 9${digits(4)} ${digits(5)}`,
      bank: { accountNumber: `${int(1, 9)}${digits(int(10, 13))}`, ifsc: IFSC_POOL[i % IFSC_POOL.length]!, holderName: (proprietor ?? legalName).toUpperCase() },
      ...(cat !== "none" ? { udyam: { number: `UDYAM-${({ "29": "KR", "33": "TN", "36": "TS", "27": "MH" } as Record<string, string>)[place.code]}-${String(int(1, 31)).padStart(2, "0")}-${digits(7)}`, category: cat } } : {}),
      // Micro/small fillers always have a written 45-day agreement, so their deadlines are never accidental traps.
      ...(cat === "micro" || cat === "small" ? { agreedCreditDays: 45 } : rand() < 0.4 ? { agreedCreditDays: 60 } : {}),
      status: "active",
      paymentsOnHold: false,
      createdBy: pick(["user:meera.iyer", "user:kavya.rao", "user:farhan.ali"]),
      approvedBy: "user:anil.shetty",
      createdAt,
      history: [],
    };
    // Some old, properly verified changes, so history isn't suspiciously empty.
    if (i % 5 === 0) {
      v.history.push({ at: ts("2025-08-12", "15:20"), by: "user:meera.iyer", field: "phone", before: `+91 8${digits(4)} ${digits(5)}`, after: v.phone, source: "vendor letter" });
    }
    if (i % 7 === 3) {
      const old = { accountNumber: `${int(1, 9)}${digits(11)}`, ifsc: IFSC_POOL[(i + 5) % IFSC_POOL.length]!, holderName: v.bank.holderName };
      v.history.push({ at: ts("2025-11-03", "11:05"), by: "user:anil.shetty", field: "bank", before: old, after: v.bank, source: `bank letter; call-back CB-${digits(4)} on number on record` });
    }
    out.push(v);
  }
  return out;
}

export function fillerDebarment(): DebarmentEntry[] {
  const reasons = [
    "Abandoned work mid-contract (Order PWD/DEB/2025/12)",
    "Submitted forged turnover certificate",
    "Repeated quality failures on NH works",
    "Cartelisation in tender T-2024-09",
    "Non-payment of labour wages (Labour Dept. order)",
    "Fake bank guarantee in tender T-2025-02",
    "Debarred by KRDCL for 2 years",
    "Misrepresentation of experience",
  ];
  return DEBARRED_STEMS.map((stem, i) => {
    const kind = KINDS[(i * 3) % KINDS.length]!;
    return { name: `${stem} ${kind.suffix}`, pan: makePan(kind.pan, stem[0]!), reason: reasons[i]!, until: `20${int(27, 29)}-${String(int(1, 12)).padStart(2, "0")}-30` };
  });
}

/* -------------------------------------------------------------- employees */

const DEPTS = ["Accounts Payable", "Accounts Receivable", "Treasury", "Procurement", "Projects (Site Engineer)", "Projects (QS)", "Stores", "HR", "IT", "Admin", "Legal", "Safety", "Planning", "Audit (Internal)"];
const APARTMENTS = ["Prestige Lakeside", "Sobha Daffodil", "Brigade Gardenia", "Mantri Elegance", "Purva Riviera", "Salarpuria Greenage", "Shriram Sameeksha", "Godrej Woodsman"];
const AREAS = ["Whitefield", "HSR Layout", "Koramangala", "Hebbal", "Banashankari", "Rajajinagar", "Indiranagar", "Electronic City", "Marathahalli", "Kengeri"];

export function fillerEmployees(startId: number, count: number): Employee[] {
  return Array.from({ length: count }, (_, i) => ({
    id: `E-${String(startId + i).padStart(2, "0")}`,
    name: `${FIRST[(i * 7) % FIRST.length]} ${LAST[(i * 5 + 2) % LAST.length]}`,
    department: DEPTS[i % DEPTS.length]!,
    address: `Flat ${int(101, 1404)}, ${APARTMENTS[i % APARTMENTS.length]}, ${AREAS[(i * 3) % AREAS.length]}, Bengaluru 5600${int(10, 99)}`,
    bankAccount: `000112${digits(5)}`,
  }));
}

/* ------------------------------------------------------- payment lines */

const usedAmounts = new Set<number>();
const usedBills = new Set<string>();
function uniqueAmount(min: number, max: number): number {
  for (;;) {
    const a = int(min / 500, max / 500) * 500;
    if (!usedAmounts.has(a)) {
      usedAmounts.add(a);
      return a;
    }
  }
}

export function fillerLines(vendors: Vendor[], startNo: number, count: number, today: string): { lines: PaymentLine[]; paid: PaidBill[] } {
  const lines: PaymentLine[] = [];
  const paid: PaidBill[] = [];
  for (let i = 0; i < count; i++) {
    const v = vendors[i % vendors.length]!;
    const rate = v.pan && ["P", "H"].includes(v.pan[3]!) ? 0.01 : 0.02;
    const gross = uniqueAmount(35_000, 950_000);
    const tds = Math.round(gross * rate);
    const prefix = v.legalName.split(" ").map((w) => w[0]).join("").slice(0, 3).toUpperCase();
    let bill = "";
    do bill = `${prefix}/${pick(["2026", "26-27"])}/${String(int(10, 999)).padStart(3, "0")}`;
    while (usedBills.has(bill));
    usedBills.add(bill);
    const kind = KINDS.find((k) => v.legalName.endsWith(k.suffix))!;
    lines.push({
      id: `PL-${String(startNo + i).padStart(2, "0")}`,
      vendorId: v.id,
      billNumber: bill,
      workOrder: `WO-2026-${v.id.slice(2)}`,
      description: `${kind.work[0]!.toUpperCase()}${kind.work.slice(1)}, ${pick(["NH-948 pkg 1", "NH-948 pkg 2", "Depot", "Culvert C-9", "Sector 4", "Ring road", "Toll plaza", "Site office"])} (RA-${int(1, 6)})`,
      gross,
      tds,
      tdsRate: rate,
      net: gross - tds,
      payTo: { accountNumber: v.bank.accountNumber, ifsc: v.bank.ifsc },
      acceptedOn: daysBefore(today, int(3, 24)), // ≥ 21 days left even on a 45-day agreement
      status: "pending",
      history: [],
    });
  }
  // Earlier, legitimately paid bills (different numbers and amounts) for history and FY totals.
  for (const v of vendors.slice(0, 30)) {
    for (let k = 0; k < int(0, 2); k++) {
      const prefix = v.legalName.split(" ").map((w) => w[0]).join("").slice(0, 3).toUpperCase();
      let bill = "";
      do bill = `${prefix}/2026/${String(int(10, 999)).padStart(3, "0")}`;
      while (usedBills.has(bill));
      usedBills.add(bill);
      paid.push({ vendorId: v.id, billNumber: bill, amount: uniqueAmount(40_000, 800_000), paidOn: daysBefore(today, int(35, 160)) });
    }
  }
  return { lines, paid };
}

/* ------------------------------------------------- guarantees & tenders */

export function fillerGuarantees(): BankGuarantee[] {
  const banks = ["Canara Bank, Mysuru", "HDFC Bank, Hubballi", "ICICI Bank, Bengaluru", "Bank of Baroda, Udupi", "Union Bank of India, Tumakuru", "Karnataka Bank, Mangaluru", "Axis Bank, Belagavi", "Indian Bank, Davanagere"];
  return banks.map((b) => ({
    number: `PBG/${b.split(" ")[0]!.toUpperCase()}/2025/${digits(5)}`,
    issuingBank: b,
    amount: int(4, 30) * 50_000,
    validUntil: `2027-${String(int(1, 12)).padStart(2, "0")}-28`,
    genuine: true,
  }));
}

export function fillerTenders(vendors: Vendor[]): Tender[] {
  const titles = [
    "Storm-water drain, Ring Road (Package 4)",
    "Retaining wall & slope protection, Ghat section km 41–44",
    "Toll plaza canopy and electrical works",
    "Depot compound wall and internal roads",
  ];
  return titles.map((title, i) => ({
    id: `T-2026-${String(3 + i * 3).padStart(2, "0")}`,
    title,
    qualifiedBidders: [vendors[i * 2]!.legalName, vendors[i * 2 + 1]!.legalName],
    status: "awarded" as const,
  }));
}

/* ------------------------------------------------------------------ mail */

/**
 * Everyday inbox noise: internal memos, newsletters, routine vendor mail,
 * notifications, promos. Some look relevant at first glance (payment status
 * queries for lines that are fine, ERP maintenance) but need no action.
 */
export function fillerMail(vendors: Vendor[], today: string, companyDomain: string): Email[] {
  const me = `ap@${companyDomain}`;
  const internal = (user: string) => `${user}@${companyDomain}`;
  const v = (i: number) => vendors[i % vendors.length]!;
  const items: Array<Omit<Email, "id" | "receivedAt" | "folder" | "to" | "read" | "attachments">> = [
    { from: internal("it.helpdesk"), fromName: "IT Helpdesk", subject: "Scheduled ERP maintenance: Saturday 10 Oct, 22:00–02:00", body: "The ERP will be unavailable on Saturday night for patching. Please complete any approvals before Saturday 8 PM." },
    { from: internal("hr"), fromName: "HR Team", subject: "Holiday list update: Deepavali (8 Nov) and Kannada Rajyotsava (1 Nov)", body: "Please note the updated holiday list for November. Plan payment runs accordingly." },
    { from: internal("admin"), fromName: "Admin", subject: "Canteen menu for the week", body: "Monday: bisi bele bath · Tuesday: ragi mudde · Wednesday: neer dosa · Thursday: pulao · Friday: special thali." },
    { from: internal("hr"), fromName: "HR Team", subject: "Mandatory POSH training: complete by 31 Oct", body: "All employees must complete the online POSH module by 31 October. Link on the intranet." },
    { from: internal("anil.shetty"), fromName: "Anil Shetty (Finance Head)", subject: "Reminder: Q2 TDS statement due 31 Oct", body: "Please make sure all Q2 deductions are reconciled with challans before we file the quarterly statement." },
    { from: internal("audit"), fromName: "Internal Audit", subject: "Request: vendor ledger extract for H1", body: "Please share the vendor ledger extract for April–September by next Friday. No urgency this week." },
    { from: internal("suresh.naik"), fromName: "Suresh Naik (Site)", subject: "NH-948 pkg 1: weekly progress report", body: "Earthwork 78% complete, sub-base 41%. Two rain days lost. Report attached in the shared drive." },
    { from: internal("kavya.rao"), fromName: "Kavya Rao (Procurement)", subject: "Corrigendum: T-2026-12 bid due date extended", body: "Bid submission for T-2026-12 extended to 20 Oct. No action for AP." },
    { from: internal("it.helpdesk"), fromName: "IT Helpdesk", subject: "Your password expires in 7 days", body: "Please change your Windows password before it expires. Never share your password with anyone." },
    { from: internal("admin"), fromName: "Admin", subject: "Office supplies: requisition window open", body: "Submit stationery requisitions by Thursday." },
    { from: internal("hr"), fromName: "HR Team", subject: "Birthday wishes: Divya Menon 🎉", body: "Join us at 4 PM in the cafeteria." },
    { from: internal("treasury"), fromName: "Treasury", subject: "Bank balance position, 6 Oct", body: "Operating account balance is sufficient for the Friday batch. FD maturity on 15 Oct." },
    { from: "alerts@hdfcbank.example", fromName: "HDFC Bank Alerts", subject: "Account statement for September 2026 is ready", body: "Your e-statement for the period 01-09-2026 to 30-09-2026 is available in net banking." },
    { from: "alerts@canarabank.example", fromName: "Canara Bank", subject: "NEFT credit received", body: "Rs. 12,40,000 credited to your account from NHAI. Ref NEFT/2026/88413." },
    { from: "noreply@epfo.example", fromName: "EPFO", subject: "ECR for September filed successfully", body: "Electronic Challan cum Return for September has been filed. TRRN 3009261144201." },
    { from: "updates@cafirm.example", fromName: "Rao & Kulkarni, Chartered Accountants", subject: "Newsletter: key changes under the Income-tax Act 2025", body: "Section renumbering, new forms for TDS statements, and transition FAQs." },
    { from: "news@constructionworld.example", fromName: "Construction World", subject: "Cement prices steady; monsoon delays ease", body: "This week in construction… (newsletter)" },
    { from: "events@infrasummit.example", fromName: "Infra Summit 2026", subject: "Invitation: South India Infra Summit, 12–13 Nov", body: "Register for early-bird pricing." },
    { from: "deals@officemart.example", fromName: "OfficeMart", subject: "Festive offers on printers and toner", body: "Up to 40% off. Offer valid till Dasara." },
    { from: "winner@lucky-draw.example", fromName: "Lucky Draw", subject: "Congratulations! You've won a smartphone", body: "Click here to claim your prize. (Obvious spam: ignore.)" },
    { from: "notifications@courier.example", fromName: "BlueLine Courier", subject: "Shipment delivered: AWB 77812094", body: "Your shipment was delivered to reception at 11:42." },
    { from: "noreply@gst.example", fromName: "GST Network", subject: "Reminder: GSTR-3B for September due 20 Oct", body: "Automated reminder." },
    { from: "noreply@tin.example", fromName: "TIN Facilitation", subject: "Challan status: TDS deposited", body: "Your TDS payment for September has been accounted. CIN 0510308." },
    { from: "renewals@insurer.example", fromName: "Insurer", subject: "Contractor's All Risk policy renewal due 30 Nov", body: "Please send renewal confirmation." },
    { from: v(0).email, fromName: v(0).legalName, subject: "Navaratri greetings", body: "Wishing the Kaveri Infra team a happy Navaratri and Dasara!" },
    { from: v(3).email, fromName: v(3).legalName, subject: "RA bill copy for your records", body: "Please find our RA bill details as already submitted through the site office. No action needed if received." },
    { from: v(6).email, fromName: v(6).legalName, subject: "Payment status query", body: "Could you confirm our bill is in this week's batch? Thank you." },
    { from: v(9).email, fromName: v(9).legalName, subject: "Updated price list for FY 2026-27", body: "Please find our revised rates effective 1 November." },
    { from: v(12).email, fromName: v(12).legalName, subject: "Request for work completion certificate", body: "Kindly issue the completion certificate for WO-2026 culvert works. (For Projects team.)" },
    { from: v(15).email, fromName: v(15).legalName, subject: "TDS certificate for Q1", body: "Please share Form 16A / TDS certificate for Q1 at your convenience." },
    { from: v(18).email, fromName: v(18).legalName, subject: "Thank you for the timely payment", body: "We acknowledge receipt of last week's payment. Regards." },
    { from: v(21).email, fromName: v(21).legalName, subject: "Site visit next Tuesday", body: "Our engineer will visit the depot site on Tuesday to measure for the next RA bill." },
    { from: v(24).email, fromName: v(24).legalName, subject: "Payment status query: RA bill", body: "Just checking whether our bill has been processed. It is not urgent." },
    { from: v(27).email, fromName: v(27).legalName, subject: "Introducing our new testing lab", body: "We have expanded our NABL-accredited lab. Brochure available on request." },
    { from: v(30).email, fromName: v(30).legalName, subject: "Annual vendor feedback form", body: "Please rate our services; it takes 2 minutes." },
    { from: v(33).email, fromName: v(33).legalName, subject: "Out of office till 12 Oct", body: "Our accounts team is away for Dasara. Replies after 12 Oct." },
    { from: internal("farhan.ali"), fromName: "Farhan Ali (Procurement)", subject: "PO amendments for steel: FYI", body: "Two POs amended for quantity. No impact on this week's batch." },
    { from: internal("divya.menon"), fromName: "Divya Menon (Legal)", subject: "Updated contract template (works)", body: "New works-contract template uploaded. Use for all contracts from 1 Nov." },
    { from: internal("meera.iyer"), fromName: "Meera Iyer (AP)", subject: "Leave: Thursday afternoon", body: "I'll be out Thursday afternoon. Ravi will cover the inbox." },
    { from: internal("ravi.gowda"), fromName: "Ravi Gowda", subject: "Re: vendor ledger formatting", body: "Fixed the column widths in the ledger template. Let me know if anything else." },
  ];
  // Spread across the last three weeks, newest near "today".
  return items.map((m, i) => {
    const d = daysBefore(today, Math.floor((items.length - i) * 0.45));
    return { ...m, id: `msg_${100 + i}`, folder: "inbox" as const, to: me, read: rand() < 0.55, attachments: [], receivedAt: ts(d, time()) };
  });
}
