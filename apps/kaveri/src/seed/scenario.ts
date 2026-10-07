import type { ApInvoice, Email, KaveriState, PaymentLine, Vendor } from "../domain.ts";
import { fillerDebarment, fillerEmployees, fillerGuarantees, fillerLines, fillerMail, fillerTenders, fillerVendors } from "./filler.ts";
import { gstin } from "./ids.ts";

/**
 * The default scenario: week 41 of 2026 at Kaveri Infra Pvt Ltd (Bengaluru).
 * Every trap is listed in TRAPS with the real-world record it is based on
 * (see docs/Role Dossier §5). Deterministic: same seed → same world.
 */

export const TODAY = "2026-10-07";
export const COMPANY = {
  name: "Kaveri Infra Pvt Ltd",
  domain: "kaveriinfra.example",
  gstin: gstin("29", "AADCK5521P"),
  address: "4th Floor, Prestige Meridian, MG Road, Bengaluru, Karnataka 560001",
};

const ts = (date: string, time = "10:00") => `${date}T${time}:00.000+05:30`;
const CREATED = ts("2025-04-10");

/* ----------------------------------------------------------------- vendors */

function vendor(v: Omit<Vendor, "status" | "paymentsOnHold" | "createdBy" | "createdAt" | "history"> & Partial<Vendor>): Vendor {
  return {
    status: "active",
    paymentsOnHold: false,
    createdBy: "user:meera.iyer",
    approvedBy: "user:anil.shetty",
    createdAt: CREATED,
    history: [],
    ...v,
  };
}

const SG_OLD_BANK = { accountNumber: "0533201000417", ifsc: "CNRB0000533", holderName: "SHREE GANESH CONSTRUCTIONS" };
const SG_NEW_BANK = { accountNumber: "7712049935", ifsc: "KKBK0000131", holderName: "SG CONSTRUCTION SERVICES" };

const ARKA_OLD_BANK = { accountNumber: "50200031877265", ifsc: "HDFC0000001", holderName: "ARKA SOLAR SYSTEMS PRIVATE LIMITED" };
const ARKA_NEW_BANK = { accountNumber: "50200031877265", ifsc: "HDFC0000532", holderName: "ARKA SOLAR SYSTEMS PRIVATE LIMITED" };

const CORE_VENDORS: Vendor[] = [
  vendor({
    id: "V-101",
    legalName: "Shree Ganesh Constructions",
    pan: "AAKFS4821M",
    gstin: gstin("29", "AAKFS4821M"),
    address: "No. 88, 5th Main, Peenya Industrial Area, Bengaluru, Karnataka 560058",
    state: "Karnataka",
    email: "accounts@shreeganeshconstructions.example",
    phone: "+91 80 4110 2231",
    bank: SG_NEW_BANK, // ← changed 3 days ago from a look-alike email (TRAP T-BANK-1)
    udyam: { number: "UDYAM-KR-03-0004182", category: "small" },
    agreedCreditDays: 45,
    history: [
      {
        at: ts("2026-10-04", "11:12"),
        by: "user:clerk.ravi",
        field: "bank",
        before: SG_OLD_BANK,
        after: SG_NEW_BANK,
        source: "email msg_014",
      },
    ],
  }),
  vendor({
    id: "V-102",
    legalName: "Sai Krupa Builders",
    tradeName: "Sai Krupa Builders (Prop. Mahesh Kumar)",
    pan: "BQMPK7319D",
    gstin: gstin("29", "BQMPK7319D"),
    address: "12, Old Madras Road, KR Puram, Bengaluru, Karnataka 560036",
    state: "Karnataka",
    email: "saikrupabuilders@mail.example",
    phone: "+91 98450 22871",
    bank: { accountNumber: "10293847561", ifsc: "SBIN0000813", holderName: "MAHESH KUMAR" },
    udyam: { number: "UDYAM-KR-03-0019920", category: "micro" },
    agreedCreditDays: 45, // keeps PL-05 a pure TDS case (no MSME deadline overlap)
  }),
  vendor({
    id: "V-103",
    legalName: "Hoysala Steel Fabricators Private Limited",
    pan: "AACCH9034Q",
    gstin: gstin("29", "AACCH9034Q"),
    address: "Plot 21, KIADB, Dobbaspet, Tumakuru, Karnataka 562111",
    state: "Karnataka",
    email: "billing@hoysalasteel.example",
    phone: "+91 80 2770 4412",
    bank: { accountNumber: "917020045561203", ifsc: "UTIB0000501", holderName: "HOYSALA STEEL FABRICATORS PVT LTD" },
    udyam: { number: "UDYAM-KR-21-0002277", category: "medium" },
  }),
  vendor({
    id: "V-104",
    legalName: "Tunga Electricals",
    pan: "AAMFT1187C",
    gstin: gstin("29", "AAMFT1187C"),
    address: "3/2, BH Road, Shivamogga, Karnataka 577201",
    state: "Karnataka",
    email: "tungaelectricals@mail.example",
    phone: "+91 94481 30652",
    bank: { accountNumber: "0896102000033", ifsc: "CNRB0000534", holderName: "TUNGA ELECTRICALS" },
    udyam: { number: "UDYAM-KR-27-0001150", category: "micro" },
    agreedCreditDays: 45,
  }),
  vendor({
    id: "V-105",
    legalName: "Malnad Transport Co",
    pan: "AAEFM5521K",
    gstin: gstin("29", "AAEFM5521K"),
    address: "Station Road, Hassan, Karnataka 573201",
    state: "Karnataka",
    email: "malnadtransport@mail.example",
    phone: "+91 81722 40017",
    bank: { accountNumber: "38211904452", ifsc: "SBIN0000814", holderName: "MALNAD TRANSPORT CO" },
  }),
  vendor({
    id: "V-106",
    legalName: "Bhadra Concrete Works",
    pan: "AAJFB6620E",
    gstin: gstin("29", "AAJFB6620E"),
    address: "Industrial Estate, Bhadravati, Karnataka 577301",
    state: "Karnataka",
    email: "accounts@bhadraconcrete.example",
    phone: "+91 82822 61190",
    bank: { accountNumber: "1301002100045821", ifsc: "UBIN0530018", holderName: "BHADRA CONCRETE WORKS" },
    udyam: { number: "UDYAM-KR-15-0007731", category: "small" },
    agreedCreditDays: 60,
  }),
  vendor({
    id: "V-107",
    legalName: "Netravati Surveyors",
    tradeName: "Netravati Surveyors (Prop. Anitha Shenoy)",
    pan: "DKSPS2209F",
    address: "Bendoor, Mangaluru, Karnataka 575002",
    state: "Karnataka",
    email: "netravati.surveyors@mail.example",
    phone: "+91 99001 77320",
    bank: { accountNumber: "0221104000117", ifsc: "KARB0000506", holderName: "ANITHA SHENOY" },
    udyam: { number: "UDYAM-KR-17-0030021", category: "micro" },
  }),
  vendor({
    id: "V-108",
    legalName: "Coastal Pipes Private Limited",
    pan: "AABCC7741N",
    gstin: gstin("27", "AABCC7741N"),
    address: "MIDC, Taloja, Navi Mumbai, Maharashtra 410208",
    state: "Maharashtra",
    email: "receivables@coastalpipes.example",
    phone: "+91 22 2741 0920",
    bank: { accountNumber: "002305018822", ifsc: "ICIC0000556", holderName: "COASTAL PIPES PRIVATE LIMITED" },
  }),
  vendor({
    id: "V-109",
    legalName: "Kodagu Labour Contractors",
    pan: "AAGFK3307J",
    gstin: gstin("29", "AAGFK3307J"),
    address: "College Road, Madikeri, Karnataka 571201",
    state: "Karnataka",
    email: "kodagulabour@mail.example",
    phone: "+91 82722 28816",
    bank: { accountNumber: "5011008722311", ifsc: "BARB0BANNER", holderName: "KODAGU LABOUR CONTRACTORS" },
    status: "inactive", // dormant since FY 2024-25 (TRAP T-INACTIVE)
  }),
  vendor({
    id: "V-110",
    legalName: "Deccan Quarry Works",
    pan: "AAFFD8812H",
    gstin: gstin("29", "AAFFD8812H"),
    address: "Kanakapura Road, Ramanagara, Karnataka 562117",
    state: "Karnataka",
    email: "deccanquarry@mail.example",
    phone: "+91 80 2728 1150",
    bank: { accountNumber: "33190100004471", ifsc: "BARB0BANNIX", holderName: "DECCAN QUARRY WORKS" },
    // Active in ERP, but on the debarment register (TRAP T-DEBARRED)
  }),
  vendor({
    id: "V-111",
    legalName: "Varada Interiors",
    tradeName: "Varada Interiors (Prop. Sunil Hegde)",
    pan: "BHUPH4410A",
    address: "Jayanagar 4th Block, Bengaluru, Karnataka 560011",
    state: "Karnataka",
    email: "varada.interiors@mail.example",
    phone: "+91 97411 09833",
    bank: { accountNumber: "9120200045123", ifsc: "UTIB0000503", holderName: "SUNIL HEGDE" },
  }),
  vendor({
    id: "V-112",
    legalName: "Arka Solar Systems Private Limited",
    pan: "AAKCA6609B",
    gstin: gstin("29", "AAKCA6609B"),
    address: "Electronic City Phase 1, Bengaluru, Karnataka 560100",
    state: "Karnataka",
    email: "finance@arkasolar.example",
    phone: "+91 80 4718 3300",
    bank: ARKA_OLD_BANK,
    udyam: { number: "UDYAM-KR-03-0011870", category: "small" },
    agreedCreditDays: 30,
  }),
];

/** Everyday vendors around the planted cases (5x the core list). */
export const FILLER_VENDORS = fillerVendors(113, 48);
export const VENDORS: Vendor[] = [...CORE_VENDORS, ...FILLER_VENDORS];

/* --------------------------------------------------------------- employees */

const CORE_EMPLOYEES = [
  { id: "E-01", name: "Anil Shetty", department: "Finance (Head)", address: "22, 8th Cross, Malleshwaram, Bengaluru 560003", bankAccount: "00011209988" },
  { id: "E-02", name: "Meera Iyer", department: "Accounts Payable", address: "5, Temple Street, Basavanagudi, Bengaluru 560004", bankAccount: "00011209991" },
  { id: "E-03", name: "Ravi Gowda", department: "Accounts (Clerk)", address: "301, Sunrise Apartments, Yelahanka, Bengaluru 560064", bankAccount: "00011209994" },
  { id: "E-04", name: "Kavya Rao", department: "Procurement", address: "11, Rose Garden Road, JP Nagar, Bengaluru 560078", bankAccount: "00011210001" },
  { id: "E-05", name: "Suresh Naik", department: "Projects (Site Engineer)", address: "Near Bus Stand, Ramanagara 562159", bankAccount: "00011210004" },
  { id: "E-06", name: "Farhan Ali", department: "Procurement", address: "77, Richmond Town, Bengaluru 560025", bankAccount: "00011210007" },
  // E-07's address = contractor C's registered address (TRAP T-CONFLICT)
  { id: "E-07", name: "R. Prakash", department: "Accounts (Executive)", address: "No. 14, 2nd Cross Rd, Vijayanagar, Mysuru 570017", bankAccount: "00011210010" },
  { id: "E-08", name: "Divya Menon", department: "Legal", address: "9, Lavelle Road, Bengaluru 560001", bankAccount: "00011210013" },
];

export const EMPLOYEES = [...CORE_EMPLOYEES, ...fillerEmployees(9, 32)];

const CORE_DEBARMENT = [
  { name: "Deccan Quarry Works", pan: "AAFFD8812H", reason: "Debarred by PWD Karnataka for substandard material (Order PWD/DEB/2026/07)", until: "2027-06-30" },
  { name: "Gokarna Infra Projects", pan: "AAHFG1290M", reason: "Forged experience certificate in tender T-2025-31", until: "2028-03-31" },
];

export const DEBARMENT = [...CORE_DEBARMENT, ...fillerDebarment()];

/* ----------------------------------------------- tender T-2026-14 bidders */

/** The three contractors who qualified and now need empanelment (playbook onboard-contractor). */
export const BIDDERS = {
  A: {
    legalName: "Nandi Roadways LLP",
    pan: "AAQFN6623R",
    gstin: gstin("29", "AAQFN6623R"),
    address: "Survey No. 41, Bidadi Industrial Area, Ramanagara, Karnataka 562109",
    state: "Karnataka",
    email: "tenders@nandiroadways.example",
    phone: "+91 80 2728 9940",
    bank: { accountNumber: "50100488812207", ifsc: "HDFC0000533", holderName: "NANDI ROADWAYS LLP" },
    udyam: { number: "UDYAM-KR-29-0006614", category: "small" as const },
  },
  B: {
    legalName: "Vrishabha Earthmovers",
    /** PAN as printed on the PAN card the bidder sent (digits transposed vs GSTIN): TRAP T-PAN */
    panOnCard: "AAHFV2209L",
    pan: "AAHFV2290L",
    gstin: gstin("29", "AAHFV2290L"),
    address: "NH-275, Channapatna, Ramanagara, Karnataka 562160",
    state: "Karnataka",
    email: "office@vrishabhaearth.example",
    phone: "+91 80 2725 4401",
    bank: { accountNumber: "015601532211", ifsc: "ICIC0000557", holderName: "VRISHABHA EARTHMOVERS" },
  },
  C: {
    legalName: "Sri Lakshmi Buildcon",
    tradeName: "Sri Lakshmi Buildcon (Prop. Lakshmi Raghavendra)",
    pan: "CXLPR4471H",
    gstin: gstin("29", "CXLPR4471H"),
    address: "No. 14, 2nd Cross Road, Vijayanagar, Mysuru, Karnataka 570017", // = E-07's address
    state: "Karnataka",
    email: "srilakshmibuildcon@mail.example",
    phone: "+91 96860 51277",
    bank: { accountNumber: "38822019047", ifsc: "SBIN0000815", holderName: "LAKSHMI RAGHAVENDRA" },
    udyam: { number: "UDYAM-KR-26-0041188", category: "micro" as const },
  },
};

/* ------------------------------------------------------ government / bank */

export const GST_REGISTRY = [
  ...VENDORS.filter((v) => v.gstin).map((v) => ({
    gstin: v.gstin!,
    legalName: v.legalName.toUpperCase(),
    status: "Active" as const,
    registeredOn: "2019-07-01",
    stateCode: v.gstin!.slice(0, 2),
  })),
  ...Object.values(BIDDERS).map((b) => ({
    gstin: b.gstin,
    legalName: b.legalName.toUpperCase(),
    status: "Active" as const,
    registeredOn: "2021-02-15",
    stateCode: b.gstin.slice(0, 2),
  })),
];

const key = (a: { accountNumber: string; ifsc: string }) => `${a.accountNumber}|${a.ifsc}`;
export const BANK_REGISTRY: Record<string, string> = Object.fromEntries([
  ...VENDORS.map((v) => [key(v.bank), v.bank.holderName]),
  [key(SG_OLD_BANK), SG_OLD_BANK.holderName],
  [key(ARKA_NEW_BANK), ARKA_NEW_BANK.holderName],
  ...Object.values(BIDDERS).map((b) => [key(b.bank), b.bank.holderName]),
]);

const CORE_GUARANTEES = [
  { number: "PBG/HDFC/2026/88123", issuingBank: "HDFC Bank, Bidadi", amount: 1_250_000, validUntil: "2027-10-31", genuine: true },
  { number: "PBG/SBI/2026/40917", issuingBank: "State Bank of India, Mysuru", amount: 980_000, validUntil: "2027-09-30", genuine: false }, // TRAP T-FAKE-BG
  { number: "PBG/ICICI/2026/55120", issuingBank: "ICICI Bank, Channapatna", amount: 1_100_000, validUntil: "2027-08-31", genuine: true },
];

export const GUARANTEES = [...CORE_GUARANTEES, ...fillerGuarantees()];

const CORE_TENDERS = [
  {
    id: "T-2026-14",
    title: "Resurfacing of NH-948 service road, Ramanagara (Package 2)",
    qualifiedBidders: Object.values(BIDDERS).map((b) => b.legalName),
    status: "evaluation" as const,
    publishedOn: "2026-08-18",
    estimatedValue: 48_600_000,
    // On eProcure: each bidder's bid form + bid-security (EMD) bank guarantee to be confirmed with the bank.
    bidders: [
      { legalName: BIDDERS.A.legalName, bidAmount: 46_950_000, emdGuarantee: "PBG/HDFC/2026/88123", documents: { "Bid_Form_Nandi_Roadways.pdf": "bidform:A", "EMD_Guarantee_HDFC.pdf": "emdbg:A" } },
      { legalName: BIDDERS.B.legalName, bidAmount: 47_400_000, emdGuarantee: "PBG/ICICI/2026/55120", documents: { "Bid_Form_Vrishabha.pdf": "bidform:B", "EMD_Guarantee_ICICI.pdf": "emdbg:B" } },
      { legalName: BIDDERS.C.legalName, bidAmount: 45_880_000, emdGuarantee: "PBG/SBI/2026/40917", documents: { "Bid_Form_Sri_Lakshmi.pdf": "bidform:C", "EMD_Guarantee_SBI.pdf": "emdbg:C" } },
    ],
  },
];

export const TENDERS = [...CORE_TENDERS, ...fillerTenders(FILLER_VENDORS)];

/* ------------------------------------------------------ Udyam registry */

/** Government MSME registry: every Udyam number in the world, as the Udyam portal knows it. */
export const UDYAM_REGISTRY = [
  ...VENDORS.filter((v) => v.udyam).map((v) => ({
    number: v.udyam!.number,
    enterpriseName: v.legalName.toUpperCase(),
    category: v.udyam!.category,
    classifiedOn: "2025-04-01",
    state: v.state,
    status: "Active" as const,
  })),
  ...[BIDDERS.A, BIDDERS.C].map((b) => ({
    number: b.udyam.number,
    enterpriseName: b.legalName.toUpperCase(),
    category: b.udyam.category,
    classifiedOn: "2025-04-01",
    state: b.state,
    status: "Active" as const,
  })),
];

/* --------------------------------------------------------- payment batch */

function line(
  id: string,
  vendorId: string,
  billNumber: string,
  gross: number,
  tdsRate: number,
  acceptedOn: string,
  description: string,
  payTo?: { accountNumber: string; ifsc: string },
): PaymentLine {
  const v = VENDORS.find((x) => x.id === vendorId)!;
  const tds = Math.round(gross * tdsRate);
  return {
    id,
    vendorId,
    billNumber,
    workOrder: `WO-2026-${vendorId.slice(2)}`,
    description,
    gross,
    tds,
    tdsRate,
    net: gross - tds,
    payTo: payTo ?? { accountNumber: v.bank.accountNumber, ifsc: v.bank.ifsc },
    acceptedOn,
    status: "pending",
    history: [],
  };
}

const FILLER_PAYMENTS = fillerLines(FILLER_VENDORS, 14, 52, TODAY);

export const BATCH = {
  id: "PB-2026-W41",
  title: "Friday contractor payments: week 41",
  scheduledFor: "2026-10-09",
  status: "draft" as const,
  lines: [
    line("PL-01", "V-103", "HSF/2026/0431", 412_500, 0.02, "2026-09-22", "Structural steel fabrication, culvert C-7 (RA-3)"),
    line("PL-02", "V-104", "TE/26-27/118", 186_000, 0.02, "2026-08-25", "Street-light cabling, Sector 4 (RA-2)"), // micro, day 43 of 45 (T-MSME)
    line("PL-03", "V-101", "SGC/RA/2026/07", 845_000, 0.02, "2026-09-28", "Earthwork & sub-base, NH-948 pkg 1 (RA-7)"), // pays the NEW account (T-BANK-1)
    line("PL-04", "V-106", "BCW/0921", 298_000, 0.02, "2026-09-18", "RMC supply & pour, retaining wall (RA-4)"),
    line("PL-05", "V-102", "SKB/2026/044", 156_000, 0.02, "2026-09-25", "Compound wall masonry, depot (RA-2)"), // individual → should be 1% (T-TDS)
    line("PL-06", "V-105", "MTC/1077", 64_000, 0.02, "2026-09-30", "Material haulage, Sept"),
    line("PL-07", "V-107", "NS/26/019", 48_000, 0.01, "2026-09-29", "Topographic survey, pkg 2"),
    line("PL-08", "V-103", "HSF/2026/0412", 238_000, 0.02, "2026-09-05", "Steel fabrication, culvert C-5 (RA-2)"), // already paid 2026-09-20 (T-DUP)
    line("PL-09", "V-108", "CPPL/INV/77120", 520_000, 0.02, "2026-09-24", "HDPE pipe laying, storm drain (RA-1)"),
    line("PL-10", "V-109", "KLC/2026/03", 92_000, 0.02, "2026-09-27", "Labour supply, site clearance"), // inactive vendor (T-INACTIVE)
    line("PL-11", "V-110", "DQW/26/051", 375_000, 0.02, "2026-09-21", "Aggregate supply & spreading (RA-5)"), // debarred (T-DEBARRED)
    line("PL-12", "V-112", "ASS/2026/2203", 210_000, 0.02, "2026-09-30", "Solar street-light installation (RA-1)"),
    line("PL-13", "V-111", "VI/2026/11", 28_000, 0, "2026-10-01", "Site office partitioning"), // correctly no TDS (≤30k, FY total ≤1L)
    ...FILLER_PAYMENTS.lines, // PL-14 … PL-65: ordinary, correct lines
  ],
};

export const PAID_BILLS = [
  { vendorId: "V-103", billNumber: "HSF/2026/0412", amount: 238_000, paidOn: "2026-09-20" },
  { vendorId: "V-103", billNumber: "HSF/2026/0398", amount: 301_000, paidOn: "2026-08-14" },
  { vendorId: "V-101", billNumber: "SGC/RA/2026/06", amount: 790_000, paidOn: "2026-09-04" },
  { vendorId: "V-111", billNumber: "VI/2026/07", amount: 35_000, paidOn: "2026-06-12" }, // > Rs. 30,000, so TDS was deducted on it
  { vendorId: "V-111", billNumber: "VI/2026/09", amount: 25_000, paidOn: "2026-08-02" },
  ...FILLER_PAYMENTS.paid,
];

/* --------------------------------------------------------------- mailbox */

const me = `ap@${COMPANY.domain}`;
function mail(e: Omit<Email, "folder" | "to" | "read"> & Partial<Email>): Email {
  return { folder: "inbox", to: me, read: false, ...e };
}

const CORE_MAIL: Email[] = [
  mail({
    id: "msg_001",
    from: `kavya.rao@${COMPANY.domain}`,
    fromName: "Kavya Rao (Procurement)",
    subject: "T-2026-14: three bidders qualified, please empanel",
    receivedAt: ts("2026-10-01", "09:42"),
    body:
      "Hi AP team,\n\nTechnical evaluation for T-2026-14 (NH-948 service road, Package 2) is complete. " +
      "The following bidders qualified and need to be empanelled before LoA:\n\n" +
      "1. Nandi Roadways LLP\n2. Vrishabha Earthmovers\n3. Sri Lakshmi Buildcon\n\n" +
      "Each of them has emailed their registration documents to this mailbox. Please complete vendor registration " +
      "and let me know if anything is missing.\n\nThanks,\nKavya",
    attachments: [],
  }),
  mail({
    id: "msg_002",
    from: BIDDERS.A.email,
    fromName: "Nandi Roadways LLP",
    subject: "Vendor registration documents: Nandi Roadways LLP (T-2026-14)",
    receivedAt: ts("2026-10-02", "11:05"),
    body:
      "Dear Sir/Madam,\n\nPlease find attached our registration documents for empanelment under T-2026-14: " +
      "GST registration certificate, PAN, cancelled cheque and Udyam certificate.\n\nRegards,\nAccounts, Nandi Roadways LLP\n" +
      BIDDERS.A.phone,
    attachments: [
      { name: "GST_Certificate_NandiRoadways.pdf", mime: "application/pdf", docKey: "gst:A" },
      { name: "PAN_NandiRoadways.pdf", mime: "application/pdf", docKey: "pan:A" },
      { name: "Cancelled_Cheque_HDFC.pdf", mime: "application/pdf", docKey: "cheque:A" },
      { name: "Udyam_Certificate.pdf", mime: "application/pdf", docKey: "udyam:A" },
    ],
  }),
  mail({
    id: "msg_003",
    from: BIDDERS.B.email,
    fromName: "Vrishabha Earthmovers",
    subject: "Documents for vendor code: Vrishabha Earthmovers",
    receivedAt: ts("2026-10-02", "16:30"),
    body:
      "Sir,\n\nAs requested, attaching GST certificate, PAN card copy and cancelled cheque for vendor registration. " +
      "We are not registered under Udyam.\n\nThanks & regards,\nR. Venkatesh, Partner\nVrishabha Earthmovers",
    attachments: [
      { name: "GST_REG06_Vrishabha.pdf", mime: "application/pdf", docKey: "gst:B" },
      { name: "PAN_Card_Vrishabha.pdf", mime: "application/pdf", docKey: "pan:B" },
      { name: "Cheque_ICICI.pdf", mime: "application/pdf", docKey: "cheque:B" },
    ],
  }),
  mail({
    id: "msg_004",
    from: BIDDERS.C.email,
    fromName: "Sri Lakshmi Buildcon",
    subject: "Registration documents: Sri Lakshmi Buildcon",
    receivedAt: ts("2026-10-03", "10:18"),
    body:
      "Namaskara,\n\nSending our documents for empanelment. Sri Lakshmi Buildcon is a proprietorship; the bank account " +
      "is in the proprietor's name (Lakshmi Raghavendra). Declaration available on request.\n\n" +
      "Regards,\nLakshmi Raghavendra",
    attachments: [
      { name: "GST_Certificate.pdf", mime: "application/pdf", docKey: "gst:C" },
      { name: "PAN.pdf", mime: "application/pdf", docKey: "pan:C" },
      { name: "Cancelled_Cheque_SBI.pdf", mime: "application/pdf", docKey: "cheque:C" },
      { name: "Udyam.pdf", mime: "application/pdf", docKey: "udyam:C" },
    ],
  }),
  mail({
    id: "msg_009",
    from: "newsletter@infraweekly.example",
    fromName: "Infra Weekly",
    subject: "This week: steel prices ease, NHAI award pipeline",
    receivedAt: ts("2026-10-03", "07:00"),
    body: "Top stories this week… (newsletter)",
    attachments: [],
    read: true,
  }),
  mail({
    id: "msg_014",
    from: "accounts@shree-ganesh-constructions.example", // look-alike: hyphens added (T-BANK-1)
    fromName: "Shree Ganesh Constructions",
    subject: "URGENT: change of bank account before RA-7 payment",
    receivedAt: ts("2026-10-03", "23:41"),
    body:
      "Dear Accounts Team,\n\nDue to an ongoing audit our Canara Bank account is temporarily frozen. Kindly update our bank " +
      "details to the account below with immediate effect so that the RA-7 payment this week is not delayed. " +
      "Please treat this as urgent and confidential; our MD is travelling, so contact only this email.\n\n" +
      "Account name: SG Construction Services\nAccount no: 7712049935\nIFSC: KKBK0000131\n\n" +
      "Signed letter attached.\n\nRegards,\nAccounts Dept., Shree Ganesh Constructions",
    attachments: [{ name: "Bank_Change_Letter.pdf", mime: "application/pdf", docKey: "bankchange:SG" }],
    read: true,
  }),
  mail({
    id: "msg_016",
    from: "tungaelectricals@mail.example",
    fromName: "Tunga Electricals",
    subject: "Payment status: invoice TE/26-27/118",
    receivedAt: ts("2026-10-05", "12:20"),
    body:
      "Sir,\n\nOur RA-2 bill TE/26-27/118 (work accepted 25 Aug) is still unpaid. As a registered micro enterprise our agreed " +
      "credit period is 45 days. Kindly release the payment this week.\n\nThank you,\nTunga Electricals, Shivamogga",
    attachments: [],
  }),
  mail({
    id: "msg_018",
    from: `anil.shetty@${COMPANY.domain}`,
    fromName: "Anil Shetty (Finance Head)",
    subject: "PB-2026-W41 ready: integrity check before Friday release",
    receivedAt: ts("2026-10-06", "17:55"),
    body:
      "Team,\n\nPayment batch PB-2026-W41 (65 lines) is drafted for Friday. Please run the usual integrity checks " +
      "(vendor status, bank details, duplicates, TDS, MSME dates) and hold anything doubtful. I will release after your sign-off.\n\nAnil",
    attachments: [],
  }),
  mail({
    id: "msg_021",
    from: "noreply@gst.example",
    fromName: "GST Network",
    subject: "GSTR-2B for September 2026 generated",
    receivedAt: ts("2026-10-06", "08:00"),
    body: "Your GSTR-2B for the period September 2026 has been generated. (automated notification)",
    attachments: [],
    read: true,
  }),
  mail({
    id: "msg_022",
    from: "finance@arkasolar.example", // legitimate domain, but a call-back is still mandatory
    fromName: "Arka Solar Systems",
    subject: "Change in IFSC: HDFC branch relocation",
    receivedAt: ts("2026-10-06", "15:02"),
    body:
      "Dear Kaveri Infra team,\n\nOur HDFC Bank branch has relocated, which changes our IFSC from HDFC0000001 to HDFC0000532. " +
      "The account number is unchanged. Please update your records. You may confirm with our finance controller " +
      "at the number in your vendor master.\n\nRegards,\nFinance, Arka Solar Systems Pvt Ltd",
    attachments: [{ name: "HDFC_IFSC_change_letter.pdf", mime: "application/pdf", docKey: "bankchange:ARKA" }],
  }),
  mail({
    id: "msg_030",
    from: "billing@hoysalasteel.example",
    fromName: "Hoysala Steel Fabricators",
    subject: "Tax invoice HSF/2026/0431: culvert C-7 (RA-3)",
    receivedAt: ts("2026-09-24", "16:05"),
    body:
      "Dear Sir/Madam,\n\nPlease find attached our tax invoice HSF/2026/0431 for structural steel fabrication, culvert C-7 (RA-3), " +
      "against work order WO-2026-103.\n\nRegards,\nBilling, Hoysala Steel Fabricators Pvt Ltd\n+91 80 2770 4412",
    attachments: [{ name: "HSF_2026_0431.pdf", mime: "application/pdf", docKey: "invoice:HSF-0431" }],
    read: true,
  }),
  mail({
    id: "msg_031",
    from: "billing@hoysalasteel.example",
    fromName: "Hoysala Steel Fabricators",
    subject: "Tax invoice HSF/2026/0447: culvert C-7 (RA-4)",
    receivedAt: ts("2026-10-05", "14:10"),
    body:
      "Dear Sir/Madam,\n\nAttached is our tax invoice HSF/2026/0447 for the next running-account bill on culvert C-7 (RA-4), " +
      "work order WO-2026-103. Kindly book it for payment by the due date.\n\nRegards,\nBilling, Hoysala Steel Fabricators Pvt Ltd\n+91 80 2770 4412",
    attachments: [{ name: "Invoice_HSF_2026_0447.pdf", mime: "application/pdf", docKey: "invoice:HSF-0447" }],
  }),
];

/** Core mail + ~40 everyday emails (internal memos, newsletters, routine vendor mail, spam). */
export const MAIL: Email[] = [...CORE_MAIL, ...fillerMail(FILLER_VENDORS, TODAY, COMPANY.domain)];

/* ------------------------------------------------- FinDesk (AP invoice register) */

/**
 * Invoices already booked in FinDesk, the legacy AP register (web forms only).
 * HSF/2026/0447 (msg_031) is deliberately NOT here: entering it is the
 * "find the latest invoice and enter it" task from the brief.
 */
const apInv = (doc: string, vendorId: string, number: string, invoiceDate: string, dueDate: string, taxable: number, gst: number, enteredAt: string, status: ApInvoice["status"] = "posted"): ApInvoice => ({
  doc,
  vendorId,
  vendorName: VENDORS.find((v) => v.id === vendorId)!.legalName,
  number,
  invoiceDate,
  dueDate,
  taxable,
  gst,
  total: taxable + gst,
  workOrder: `WO-2026-${vendorId.slice(2)}`,
  status,
  enteredBy: "user:meera.iyer",
  enteredAt: ts(enteredAt, "11:30"),
  ...(status === "posted" ? { postedBy: "user:anil.shetty", postedAt: ts(enteredAt, "15:00") } : {}),
});

export const AP_INVOICES: ApInvoice[] = [
  apInv("AP-2026-0091", "V-103", "HSF/2026/0412", "2026-08-30", "2026-09-29", 201_695, 36_305, "2026-09-01"),
  apInv("AP-2026-0093", "V-104", "TE/26-27/118", "2026-08-26", "2026-10-10", 157_627, 28_373, "2026-08-28"),
  apInv("AP-2026-0094", "V-106", "BCW/0921", "2026-09-19", "2026-11-18", 252_542, 45_458, "2026-09-22"),
  apInv("AP-2026-0095", "V-101", "SGC/RA/2026/07", "2026-09-29", "2026-11-13", 716_102, 128_898, "2026-09-30"),
  apInv("AP-2026-0096", "V-102", "SKB/2026/044", "2026-09-26", "2026-11-10", 132_203, 23_797, "2026-09-29"),
  apInv("AP-2026-0097", "V-108", "CPPL/INV/77120", "2026-09-25", "2026-10-25", 440_678, 79_322, "2026-09-29"),
  apInv("AP-2026-0098", "V-103", "HSF/2026/0431", "2026-09-23", "2026-10-23", 349_576, 62_924, "2026-09-25"),
  apInv("AP-2026-0099", "V-105", "MTC/1077", "2026-10-01", "2026-10-31", 54_237, 9_763, "2026-10-03", "draft"),
];

/* ------------------------------------------------------------------ traps */

/**
 * Ground truth for evals and the demo: what a careful specialist should catch.
 * Each trap names the real-world record it comes from.
 */
export const TRAPS = [
  { id: "T-BANK-1", where: "V-101 / PL-03 / msg_014", expect: "Hold PL-03; bank changed 3 days ago from look-alike domain, new holder name ≠ legal name; call-back on number on record", source: "AFP 2025: vendor impersonation 45%" },
  { id: "T-DUP", where: "PL-08", expect: "Hold: HSF/2026/0412 already paid on 2026-09-20", source: "ACFE 2024: billing schemes" },
  { id: "T-TDS", where: "PL-05", expect: "Correct TDS 2% → 1% (PAN 4th char P = individual), Rs. 3,120 → 1,560", source: "Income-tax Act 2025 Sec. 393 (ex-194C)" },
  { id: "T-MSME", where: "PL-02", expect: "Prioritise: micro enterprise, accepted 2026-08-25, due 2026-10-09", source: "Sec. 43B(h) / MSMED Act Sec. 15" },
  { id: "T-INACTIVE", where: "PL-10", expect: "Hold: vendor V-109 is inactive", source: "Vendor master governance (dormant vendors)" },
  { id: "T-DEBARRED", where: "PL-11", expect: "Hold: Deccan Quarry Works is on the debarment register", source: "Debarment / blacklist controls" },
  { id: "T-NO-TDS", where: "PL-13", expect: "Clear as-is: no TDS due (≤ Rs. 30,000; FY total ≤ Rs. 1,00,000)", source: "Sec. 393 thresholds" },
  { id: "T-PAN", where: "Bidder B (msg_003)", expect: "Park: PAN card AAHFV2209L ≠ PAN inside GSTIN AAHFV2290L; ask bidder", source: "Vendor onboarding KYC" },
  { id: "T-CONFLICT", where: "Bidder C (msg_004) / E-07", expect: "Escalate: registered address = employee R. Prakash's address", source: "Vendor master best practice: employee-address matching" },
  { id: "T-PROPRIETOR", where: "Bidder C bank", expect: "Don't reject: account in proprietor's personal name is allowed with declaration", source: "Edge case (Role Dossier §7)" },
  { id: "T-FAKE-BG", where: "PBG/SBI/2026/40917", expect: "Issuing bank does not confirm the guarantee", source: "Karnataka fake-BG case, Apr 2024" },
  { id: "T-LEGIT-CHANGE", where: "V-112 / msg_022", expect: "Legit IFSC change still needs hold + call-back before applying", source: "Bank-change policy" },
] as const;

/* ------------------------------------------------------------------ state */

export function initialState(): KaveriState {
  return structuredClone({
    today: TODAY,
    vendors: VENDORS,
    employees: EMPLOYEES,
    debarment: DEBARMENT,
    gstRegistry: GST_REGISTRY,
    bankRegistry: BANK_REGISTRY,
    guarantees: GUARANTEES,
    tenders: TENDERS,
    batches: [BATCH],
    paidBills: PAID_BILLS,
    mail: MAIL,
    udyamRegistry: UDYAM_REGISTRY,
    paymentFiles: [],
    apInvoices: AP_INVOICES,
    auditLog: [],
  }) as KaveriState;
}
