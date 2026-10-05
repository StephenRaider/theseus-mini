/**
 * Fuzzy matching for duplicate-vendor detection. Real vendor masters are full
 * of near-duplicates: "Shree Ganesh Const." vs "Shri Ganesh Constructions".
 * Deterministic IDs (PAN, GSTIN, bank account) are checked separately; this
 * catches the cases where those differ or are missing.
 */

const ABBREVIATIONS: Record<string, string> = {
  SHRI: "SHREE",
  SRI: "SHREE",
  SHREEE: "SHREE",
  CONST: "CONSTRUCTIONS",
  CONSTN: "CONSTRUCTIONS",
  CONSTRUCTION: "CONSTRUCTIONS",
  CONSTS: "CONSTRUCTIONS",
  ENGG: "ENGINEERING",
  ENGRS: "ENGINEERS",
  INFRA: "INFRASTRUCTURE",
  CO: "COMPANY",
  CORP: "CORPORATION",
  BROS: "BROTHERS",
  ENT: "ENTERPRISES",
  ENTERPRISE: "ENTERPRISES",
  TRDG: "TRADING",
  AND: "&",
};

/** Legal-form words that don't distinguish businesses. */
const NOISE = new Set(["M/S", "MS", "MESSRS", "PVT", "PRIVATE", "LTD", "LIMITED", "LLP", "THE", "&", "OPC", "INC"]);

export function normalizeName(name: string): string {
  return name
    .toUpperCase()
    .replace(/M\/S\.?/g, " ")
    .replace(/[^A-Z0-9& ]+/g, " ")
    .split(/\s+/)
    .filter(Boolean)
    .map((t) => ABBREVIATIONS[t] ?? t)
    .filter((t) => !NOISE.has(t))
    .join(" ");
}

function bigrams(s: string): Map<string, number> {
  const m = new Map<string, number>();
  const t = s.replace(/\s+/g, " ");
  for (let i = 0; i < t.length - 1; i++) {
    const g = t.slice(i, i + 2);
    m.set(g, (m.get(g) ?? 0) + 1);
  }
  return m;
}

/** Sørensen–Dice similarity on character bigrams of normalized names, 0..1. */
export function nameSimilarity(a: string, b: string): number {
  const na = normalizeName(a);
  const nb = normalizeName(b);
  if (!na || !nb) return 0;
  if (na === nb) return 1;
  const A = bigrams(na);
  const B = bigrams(nb);
  let overlap = 0;
  for (const [g, n] of A) overlap += Math.min(n, B.get(g) ?? 0);
  const total = [...A.values()].reduce((x, y) => x + y, 0) + [...B.values()].reduce((x, y) => x + y, 0);
  return total === 0 ? 0 : (2 * overlap) / total;
}

/** Normalize an address for equality checks (employee-conflict detection). */
export function normalizeAddress(addr: string): string {
  return addr
    .toUpperCase()
    .replace(/\b(NO|NUMBER)\b\.?/g, "")
    .replace(/\bRD\b/g, "ROAD")
    .replace(/\bST\b/g, "STREET")
    .replace(/[^A-Z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");
}

export interface DuplicateCandidate<T> {
  record: T;
  score: number;
  reasons: string[];
}

/**
 * Rank existing vendors that might be the same party as `probe`.
 * Hard matches (PAN, GSTIN, bank account) score 1; otherwise name similarity.
 * Same PAN with a different GSTIN is flagged but explained, because one
 * business can legitimately have one GSTIN per state.
 */
export function findDuplicates<T extends { name: string; pan?: string; gstin?: string; bankAccount?: string }>(
  probe: { name: string; pan?: string; gstin?: string; bankAccount?: string },
  existing: readonly T[],
  threshold = 0.82,
): DuplicateCandidate<T>[] {
  const out: DuplicateCandidate<T>[] = [];
  for (const rec of existing) {
    const reasons: string[] = [];
    let score = 0;
    if (probe.gstin && rec.gstin && probe.gstin === rec.gstin) {
      reasons.push("same GSTIN");
      score = 1;
    }
    if (probe.bankAccount && rec.bankAccount && probe.bankAccount === rec.bankAccount) {
      reasons.push("same bank account");
      score = 1;
    }
    if (probe.pan && rec.pan && probe.pan === rec.pan) {
      reasons.push(
        probe.gstin && rec.gstin && probe.gstin !== rec.gstin
          ? "same PAN, different GSTIN (could be another state registration of the same business)"
          : "same PAN",
      );
      score = Math.max(score, 0.95);
    }
    const sim = nameSimilarity(probe.name, rec.name);
    if (sim >= threshold) {
      reasons.push(`similar name (${Math.round(sim * 100)}%)`);
      score = Math.max(score, sim);
    }
    if (reasons.length) out.push({ record: rec, score, reasons });
  }
  return out.sort((a, b) => b.score - a.score);
}
