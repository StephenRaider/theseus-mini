/**
 * PAN (Permanent Account Number): 10 characters, AAAAA9999A.
 * The 4th character tells you the holder type, which decides the contractor
 * TDS rate (individual/HUF 1%, others 2%; see rules/tds.ts).
 */
export const PAN_PATTERN = /^[A-Z]{5}[0-9]{4}[A-Z]$/;

export const PAN_HOLDER_TYPES = {
  P: "Individual",
  C: "Company",
  H: "Hindu Undivided Family (HUF)",
  F: "Firm / LLP",
  A: "Association of Persons (AOP)",
  T: "Trust",
  B: "Body of Individuals (BOI)",
  L: "Local Authority",
  J: "Artificial Juridical Person",
  G: "Government",
} as const;
export type PanHolderCode = keyof typeof PAN_HOLDER_TYPES;

export interface PanCheck {
  valid: boolean;
  pan: string;
  holderCode?: PanHolderCode;
  holderType?: string;
  issues: string[];
}

export function checkPan(input: string): PanCheck {
  const pan = input.trim().toUpperCase();
  const issues: string[] = [];
  if (!PAN_PATTERN.test(pan)) {
    issues.push("PAN must be 5 letters, 4 digits, 1 letter (e.g. ABCPE1234F)");
    return { valid: false, pan, issues };
  }
  const code = pan[3] as string;
  if (!(code in PAN_HOLDER_TYPES)) {
    issues.push(`4th character "${code}" is not a known PAN holder type`);
    return { valid: false, pan, issues };
  }
  const holderCode = code as PanHolderCode;
  return { valid: true, pan, holderCode, holderType: PAN_HOLDER_TYPES[holderCode], issues };
}
