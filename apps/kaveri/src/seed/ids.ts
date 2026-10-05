/**
 * Builds valid-looking Indian identifiers for fictional parties.
 * The GSTIN checksum is implemented here on purpose instead of importing the
 * agent's validator: the world and the agent must not share code, or a bug
 * in one would silently "agree" with the other. Tests cross-check both.
 */
const CHARS = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ";

export function gstin(stateCode: string, pan: string, entity = "1"): string {
  const first14 = `${stateCode}${pan}${entity}Z`;
  let sum = 0;
  for (let i = 0; i < 14; i++) {
    const v = CHARS.indexOf(first14[i]!) * (i % 2 === 0 ? 1 : 2);
    sum += Math.floor(v / 36) + (v % 36);
  }
  return first14 + CHARS[(36 - (sum % 36)) % 36];
}

/** "Rs. 8,45,000" (Indian digit grouping). */
export function rupees(n: number): string {
  return `Rs. ${n.toLocaleString("en-IN")}`;
}
