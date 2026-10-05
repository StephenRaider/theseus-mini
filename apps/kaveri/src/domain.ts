/**
 * Kaveri Infra Pvt Ltd: the mock company's data model.
 *
 * Deliberately independent of the agent's code (no imports from the role
 * pack): the environment is the "world", and the agent must discover it
 * through tools like a real employee would. Tests cross-check the two.
 */

export type VendorStatus = "pending" | "active" | "inactive" | "blocked";
export type UdyamCategory = "micro" | "small" | "medium" | "none";

export interface BankAccount {
  accountNumber: string;
  ifsc: string;
  /** Name as recorded by the bank (what a penny-drop returns). */
  holderName: string;
}

export interface VendorChange {
  at: string; // ISO timestamp
  by: string; // "user:…", "agent:emp_1", "system"
  field: string;
  before: unknown;
  after: unknown;
  /** Why/where from, e.g. "email msg_031" or "approval apr_12". */
  source?: string;
}

export interface Vendor {
  id: string; // V-1xx
  legalName: string;
  tradeName?: string;
  pan?: string;
  gstin?: string;
  address: string;
  state: string;
  email: string;
  /** Phone on record: the only number a call-back may use. */
  phone: string;
  bank: BankAccount;
  udyam?: { number: string; category: UdyamCategory };
  /** Written agreement credit period, if any (for 43B(h)). */
  agreedCreditDays?: number;
  status: VendorStatus;
  paymentsOnHold: boolean;
  holdReason?: string;
  createdBy: string;
  createdAt: string;
  approvedBy?: string;
  history: VendorChange[];
}

export interface Employee {
  id: string;
  name: string;
  department: string;
  address: string;
  bankAccount: string;
}

export interface DebarmentEntry {
  name: string;
  pan?: string;
  reason: string;
  until: string;
}

export interface GstRegistration {
  gstin: string;
  legalName: string;
  tradeName?: string;
  status: "Active" | "Cancelled" | "Suspended";
  registeredOn: string;
  stateCode: string;
}

export interface BankGuarantee {
  number: string;
  issuingBank: string;
  amount: number;
  validUntil: string;
  /** Whether the issuing bank confirms it (the fake-BG trap is false). */
  genuine: boolean;
}

export type LineStatus = "pending" | "cleared" | "held" | "corrected";

export interface PaymentLine {
  id: string; // PL-01…
  vendorId: string;
  billNumber: string;
  workOrder: string;
  description: string;
  gross: number;
  tds: number;
  tdsRate: number;
  net: number;
  /** Bank the line will pay to (snapshot when the batch was built). */
  payTo: { accountNumber: string; ifsc: string };
  /** Goods/services acceptance date (for 43B(h)). */
  acceptedOn: string;
  status: LineStatus;
  note?: string;
  history: VendorChange[];
}

export interface PaymentBatch {
  id: string;
  title: string;
  scheduledFor: string;
  status: "draft" | "released";
  lines: PaymentLine[];
  releasedBy?: string;
}

export interface PaidBill {
  vendorId: string;
  billNumber: string;
  amount: number;
  paidOn: string;
}

export interface Attachment {
  name: string;
  mime: "application/pdf";
  /** Key into the generated document registry (docs/pdf.ts). */
  docKey: string;
}

export interface Email {
  id: string; // msg_001
  folder: "inbox" | "sent" | "drafts";
  from: string;
  fromName: string;
  to: string;
  subject: string;
  body: string;
  receivedAt: string;
  attachments: Attachment[];
  read: boolean;
}

export interface Tender {
  id: string;
  title: string;
  qualifiedBidders: string[]; // legal names
  status: "awarded" | "evaluation";
}

export interface KaveriState {
  /** Scenario "today" (fixed so runs are reproducible). */
  today: string;
  vendors: Vendor[];
  employees: Employee[];
  debarment: DebarmentEntry[];
  gstRegistry: GstRegistration[];
  /** Penny-drop registry: "account|ifsc" → name at bank. */
  bankRegistry: Record<string, string>;
  guarantees: BankGuarantee[];
  tenders: Tender[];
  batches: PaymentBatch[];
  paidBills: PaidBill[];
  mail: Email[];
  /** Human tasks / approvals recorded by the company side (call-backs etc.). */
  auditLog: { at: string; actor: string; action: string; detail: string }[];
}
