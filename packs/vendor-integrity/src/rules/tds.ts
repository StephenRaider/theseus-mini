import { checkPan } from "../validators/pan.ts";

/**
 * TDS on payments to contractors.
 * Income-tax Act 2025, Section 393 (formerly Sec. 194C of the 1961 Act),
 * from 1 Apr 2026. Rates and thresholds unchanged from 194C:
 *   - Individual / HUF: 1%   · everyone else: 2%   · no valid PAN: 20%
 *   - Applies when a single payment exceeds ₹30,000, or the year's aggregate
 *     exceeds ₹1,00,000. Once the aggregate is crossed, TDS is due on the whole
 *     aggregate, so earlier payments made without TDS get a catch-up.
 * Not modelled: transporter exemption (≤10 goods carriages + PAN), lower-
 * deduction certificates. The tool reports these as things to ask about.
 */
export const TDS_CONTRACTOR = {
  section: "393 (formerly 194C)",
  rateIndividualOrHuf: 0.01,
  rateOthers: 0.02,
  rateNoPan: 0.2,
  singlePaymentThreshold: 30_000,
  aggregateThreshold: 100_000,
} as const;

export interface ContractorTdsInput {
  /** Contractor PAN; missing or invalid → 20%. */
  pan?: string;
  /** This payment, in rupees. */
  amount: number;
  /** Paid to this contractor earlier in the same financial year. */
  paidEarlierThisYear?: number;
  /** Of the earlier payments, how much was paid WITHOUT deducting TDS. */
  earlierPaidWithoutTds?: number;
}

export interface ContractorTdsResult {
  applicable: boolean;
  rate: number;
  /** TDS on this payment, plus catch-up on earlier un-taxed payments. */
  tds: number;
  catchUp: number;
  reason: string;
}

const round = (n: number) => Math.round(n);

export function contractorTds(input: ContractorTdsInput): ContractorTdsResult {
  const { amount } = input;
  const earlier = input.paidEarlierThisYear ?? 0;
  const earlierUntaxed = input.earlierPaidWithoutTds ?? 0;
  if (amount < 0 || earlier < 0 || earlierUntaxed < 0) throw new Error("Amounts must be non-negative");

  const pan = input.pan ? checkPan(input.pan) : undefined;
  const rate = !pan?.valid
    ? TDS_CONTRACTOR.rateNoPan
    : pan.holderCode === "P" || pan.holderCode === "H"
      ? TDS_CONTRACTOR.rateIndividualOrHuf
      : TDS_CONTRACTOR.rateOthers;
  const who = !pan?.valid ? "no valid PAN" : pan.holderType!;

  const singleCrossed = amount > TDS_CONTRACTOR.singlePaymentThreshold;
  const aggregateCrossed = earlier + amount > TDS_CONTRACTOR.aggregateThreshold;
  if (!singleCrossed && !aggregateCrossed) {
    return {
      applicable: false,
      rate: 0,
      tds: 0,
      catchUp: 0,
      reason: `No TDS: payment ≤ ₹30,000 and year total ≤ ₹1,00,000 (Sec. ${TDS_CONTRACTOR.section})`,
    };
  }
  const catchUp = aggregateCrossed ? round(earlierUntaxed * rate) : 0;
  const tds = round(amount * rate) + catchUp;
  const trigger = singleCrossed ? "single payment > ₹30,000" : "year total > ₹1,00,000";
  return {
    applicable: true,
    rate,
    tds,
    catchUp,
    reason: `${(rate * 100).toFixed(0)}% for ${who}; ${trigger} (Sec. ${TDS_CONTRACTOR.section})${catchUp ? `; includes ₹${catchUp} catch-up on earlier payments` : ""}`,
  };
}
