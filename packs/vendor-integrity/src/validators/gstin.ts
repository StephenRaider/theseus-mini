import { checkPan } from "./pan.ts";
import { GST_STATE_CODES, stateCodeFor } from "./states.ts";

/**
 * GSTIN: 15 characters.
 *   1–2   state code
 *   3–12  PAN of the business
 *   13    entity number for the same PAN in that state (1–9, then A–Z)
 *   14    "Z" by default for regular taxpayers
 *   15    checksum (mod-36, see gstinChecksum)
 * Format/checksum validity ≠ registration status: whether a GSTIN is active
 * still has to be looked up on the GST portal (mocked in apps/kaveri).
 */
export const GSTIN_PATTERN = /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z][A-Z0-9][0-9A-Z]$/;
const CHARS = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ";

/** Checksum character for the first 14 characters of a GSTIN. */
export function gstinChecksum(first14: string): string {
  let sum = 0;
  for (let i = 0; i < 14; i++) {
    const value = CHARS.indexOf(first14[i]!);
    if (value < 0) throw new Error(`Invalid GSTIN character "${first14[i]}"`);
    const product = value * (i % 2 === 0 ? 1 : 2);
    sum += Math.floor(product / 36) + (product % 36);
  }
  return CHARS[(36 - (sum % 36)) % 36]!;
}

export interface GstinCheck {
  valid: boolean;
  gstin: string;
  stateCode?: string;
  stateName?: string;
  pan?: string;
  entityNumber?: string;
  /** Hard problems: the GSTIN cannot be right. */
  issues: string[];
  /** Soft problems: unusual, worth a human look. */
  warnings: string[];
}

export interface GstinCrossCheck {
  /** PAN the vendor gave separately: must equal characters 3–12. */
  pan?: string;
  /** State from the vendor's registered address: must match the state code. */
  addressState?: string;
}

export function checkGstin(input: string, cross: GstinCrossCheck = {}): GstinCheck {
  const gstin = input.replace(/\s+/g, "").toUpperCase();
  const issues: string[] = [];
  const warnings: string[] = [];

  if (gstin.length !== 15) {
    issues.push(`GSTIN must be 15 characters (got ${gstin.length})`);
    return { valid: false, gstin, issues, warnings };
  }
  if (!GSTIN_PATTERN.test(gstin)) {
    issues.push("GSTIN does not follow the 2-digit state + PAN + entity + Z + checksum pattern");
    return { valid: false, gstin, issues, warnings };
  }

  const stateCode = gstin.slice(0, 2);
  const pan = gstin.slice(2, 12);
  const entityNumber = gstin[12]!;
  const stateName = GST_STATE_CODES[stateCode];

  if (!stateName) issues.push(`Unknown GST state code "${stateCode}"`);
  if (gstin[13] !== "Z") warnings.push(`14th character is "${gstin[13]}", expected "Z" for regular taxpayers`);

  const embeddedPan = checkPan(pan);
  if (!embeddedPan.valid) issues.push(`Embedded PAN "${pan}" is invalid: ${embeddedPan.issues.join("; ")}`);

  const expected = gstinChecksum(gstin.slice(0, 14));
  if (gstin[14] !== expected) issues.push(`Checksum mismatch: last character should be "${expected}", not "${gstin[14]}"`);

  if (cross.pan !== undefined && cross.pan.trim().toUpperCase() !== pan)
    issues.push(`PAN inside GSTIN (${pan}) does not match the PAN provided (${cross.pan.trim().toUpperCase()})`);

  if (cross.addressState !== undefined) {
    const addrCode = stateCodeFor(cross.addressState);
    if (!addrCode) warnings.push(`Could not map address state "${cross.addressState}" to a GST state code`);
    else if (addrCode !== stateCode)
      issues.push(`GSTIN is registered in ${stateName ?? stateCode} but the address is in ${cross.addressState}`);
  }

  return {
    valid: issues.length === 0,
    gstin,
    stateCode,
    ...(stateName ? { stateName } : {}),
    pan,
    entityNumber,
    issues,
    warnings,
  };
}
