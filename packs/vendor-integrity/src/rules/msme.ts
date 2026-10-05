/**
 * MSME payment deadline: Income-tax Act Sec. 43B(h) read with MSMED Act
 * Sec. 15 (in force from 1 Apr 2024).
 * Applies to suppliers registered on Udyam as MICRO or SMALL (not Medium):
 *   - written agreement: pay by the agreed date, but never later than 45 days
 *   - no written agreement: pay within 15 days
 * counted from the day goods/services are accepted. Late payment means the
 * expense isn't tax-deductible that year + compound interest at 3× the RBI
 * bank rate under the MSMED Act.
 */
export type UdyamCategory = "micro" | "small" | "medium" | "none";

export interface MsmeDeadlineInput {
  category: UdyamCategory;
  /** Acceptance date of goods/services, YYYY-MM-DD. */
  acceptedOn: string;
  /** Agreed credit period in days, if there is a WRITTEN agreement. */
  agreedDays?: number;
  /** "Today", YYYY-MM-DD (passed in so results are reproducible). */
  today: string;
  /** How many days before the deadline counts as "due soon". */
  dueSoonDays?: number;
}

export interface MsmeDeadline {
  applies: boolean;
  dueOn?: string;
  daysLeft?: number;
  status: "not_applicable" | "ok" | "due_soon" | "overdue";
  reason: string;
}

const DAY = 86_400_000;
const parse = (d: string) => {
  const t = Date.parse(`${d}T00:00:00Z`);
  if (Number.isNaN(t)) throw new Error(`Invalid date "${d}" (expected YYYY-MM-DD)`);
  return t;
};
const fmt = (t: number) => new Date(t).toISOString().slice(0, 10);

export function msmeDeadline(input: MsmeDeadlineInput): MsmeDeadline {
  if (input.category !== "micro" && input.category !== "small") {
    return { applies: false, status: "not_applicable", reason: `Udyam category "${input.category}": 43B(h) applies only to micro and small enterprises` };
  }
  const limit = input.agreedDays === undefined ? 15 : Math.min(input.agreedDays, 45);
  const due = parse(input.acceptedOn) + limit * DAY;
  const daysLeft = Math.round((due - parse(input.today)) / DAY);
  const soon = input.dueSoonDays ?? 3;
  const status = daysLeft < 0 ? "overdue" : daysLeft <= soon ? "due_soon" : "ok";
  const basis = input.agreedDays === undefined ? "no written agreement → 15 days" : `written agreement (${input.agreedDays} days, capped at 45)`;
  return {
    applies: true,
    dueOn: fmt(due),
    daysLeft,
    status,
    reason: `${input.category} enterprise; ${basis}; due ${fmt(due)} (${daysLeft < 0 ? `${-daysLeft} days overdue` : `${daysLeft} days left`})`,
  };
}
