import { createRequire } from "node:module";

/**
 * IFSC: 11 characters, AAAA0XXXXXX (4-letter bank code, "0", 6-char branch).
 *
 * Offline-first: existence is checked against Razorpay's open IFSC dataset
 * (npm `ifsc`, MIT), so validation works without network. Branch details
 * (branch, city, address) come from Razorpay's public API when reachable.
 */
const require = createRequire(import.meta.url);
const IFSC_DATA = require("ifsc/src/IFSC.json") as Record<string, Array<number | string>>;
const BANK_NAMES = require("ifsc/src/banknames.json") as Record<string, string>;
const SUBLETS = require("ifsc/src/sublet.json") as Record<string, string>;

export const IFSC_PATTERN = /^[A-Z]{4}0[A-Z0-9]{6}$/;

export interface IfscCheck {
  valid: boolean;
  ifsc: string;
  /** False when the format is fine but the code isn't in the dataset. */
  known: boolean;
  bankCode?: string;
  bankName?: string;
  issues: string[];
}

export function checkIfsc(input: string): IfscCheck {
  const ifsc = input.trim().toUpperCase();
  if (!IFSC_PATTERN.test(ifsc)) {
    return {
      valid: false,
      ifsc,
      known: false,
      issues: ["IFSC must be 4 letters, then 0, then 6 letters/digits (e.g. HDFC0000001)"],
    };
  }
  const bankCode = ifsc.slice(0, 4);
  const branch = ifsc.slice(5);
  const list = IFSC_DATA[bankCode];
  const known = !!list && (/^\d+$/.test(branch) ? list.includes(parseInt(branch, 10)) : list.includes(branch));
  // Sublet branches are operated by another bank under this bank's code.
  const operatingBank = SUBLETS[ifsc] ?? bankCode;
  const bankName = BANK_NAMES[operatingBank] ?? BANK_NAMES[bankCode];
  return {
    valid: known,
    ifsc,
    known,
    bankCode,
    ...(bankName ? { bankName } : {}),
    issues: known ? [] : [`IFSC ${ifsc} is not in the IFSC dataset (wrong code, typo, or a branch that closed/merged)`],
  };
}

export interface IfscDetails {
  IFSC: string;
  BANK: string;
  BRANCH: string;
  CITY?: string;
  DISTRICT?: string;
  STATE?: string;
  ADDRESS?: string;
}

export type IfscLookup =
  | { ok: true; details: IfscDetails }
  | { ok: false; reason: "not_found" | "unreachable"; message: string };

/** Live branch details from https://ifsc.razorpay.com/{IFSC}. */
export async function lookupIfscOnline(
  ifsc: string,
  opts: { timeoutMs?: number; fetchImpl?: typeof fetch } = {},
): Promise<IfscLookup> {
  const code = ifsc.trim().toUpperCase();
  const f = opts.fetchImpl ?? fetch;
  try {
    const res = await f(`https://ifsc.razorpay.com/${code}`, { signal: AbortSignal.timeout(opts.timeoutMs ?? 5000) });
    if (res.status === 404) return { ok: false, reason: "not_found", message: `IFSC ${code} not found` };
    if (!res.ok) return { ok: false, reason: "unreachable", message: `IFSC API returned ${res.status}` };
    return { ok: true, details: (await res.json()) as IfscDetails };
  } catch (err) {
    return { ok: false, reason: "unreachable", message: `IFSC API unreachable: ${(err as Error).message}` };
  }
}
