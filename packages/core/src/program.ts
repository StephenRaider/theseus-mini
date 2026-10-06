import { z } from "zod";

/**
 * Composed plans (task tier 3, Framework Spec §10): for a task no playbook
 * covers, the model writes a small declarative PROGRAM once (which items, which
 * tool calls per item, when to flag). The kernel then runs it like any plan:
 * same grid, same gateway, same evidence, any number of items, and no further
 * model calls. "The model writes the program, the kernel runs it."
 *
 * Paths: "item.legalName", "steps.verify.confirmed", "steps.bills.bills[].paidOn"
 * ("[]" maps over an array). Templates: "{{item.emdGuarantee}}".
 */

export const CONDITION_OPS = [
  "eq", "ne", "lt", "lte", "gt", "gte", "contains", "not_contains", "exists", "missing",
  "days_ago_gt", "days_ago_lt", "days_until_lt", "days_until_gt",
] as const;
export const AGGREGATES = ["count", "max", "min", "sum", "first", "last"] as const;

export const Condition = z.object({
  path: z.string().describe('Where the value is, e.g. "steps.verify.confirmed" or "item.validUntil"'),
  agg: z.enum(AGGREGATES).optional().describe("Combine a list first (count, max, min, sum, first, last)"),
  op: z.enum(CONDITION_OPS),
  value: z.string().optional().describe("Compared value as text (numbers and true/false are understood)"),
});
export type Condition = z.infer<typeof Condition>;

export const ProgramStep = z.object({
  id: z.string().describe("short snake_case id, e.g. verify"),
  title: z.string().describe("column label, max 24 characters"),
  tool: z.string(),
  args: z.record(z.string(), z.string()).describe('Tool input; use templates like "{{item.number}}"'),
  flagIf: z.array(Condition).optional().describe("Flag the item if ANY of these is true"),
  flagNote: z.string().optional().describe("Why it was flagged; templates allowed"),
});
export type ProgramStep = z.infer<typeof ProgramStep>;

export const Program = z.object({
  title: z.string(),
  itemKind: z.string().describe('Noun for one row, e.g. "bank guarantee"'),
  items: z.object({
    tool: z.string().describe("A read tool that lists the items"),
    args: z.record(z.string(), z.string()),
    listPath: z.string().describe('Path to the list inside the tool output ("" if the output is the list)'),
    idPath: z.string().describe('Path inside one element to its unique id, e.g. "number"'),
    labelTemplate: z.string().describe('Row label, e.g. "{{item.legalName}}"'),
    where: z.array(Condition).optional().describe("Keep only elements where ALL are true (paths start with item.)"),
  }),
  steps: z.array(ProgramStep).min(1).max(6),
  columns: z.array(z.object({ title: z.string(), path: z.string() })).max(8).describe("What the final report table shows"),
});
export type Program = z.infer<typeof Program>;

/* ------------------------------------------------------------------ paths */

export function getPath(obj: unknown, path: string): unknown {
  if (!path) return obj;
  const segs = path.split(".").filter(Boolean);
  let cur: unknown[] = [obj];
  let mapped = false;
  for (const raw of segs) {
    const many = raw.endsWith("[]");
    const key = many ? raw.slice(0, -2) : raw;
    const next: unknown[] = [];
    for (const c of cur) {
      if (c == null || typeof c !== "object") continue;
      const v = key ? (c as Record<string, unknown>)[key] : c;
      if (many) {
        if (Array.isArray(v)) next.push(...v);
      } else next.push(v);
    }
    cur = next;
    if (many) mapped = true;
  }
  return mapped ? cur.filter((v) => v !== undefined) : cur[0];
}

/** Fill "{{path}}" templates. A string that is exactly one template keeps the value's type. */
export function interpolate(tpl: string, scope: unknown): unknown {
  const whole = /^\{\{\s*([^}]+?)\s*\}\}$/.exec(tpl);
  if (whole) return getPath(scope, whole[1]!);
  return tpl.replace(/\{\{\s*([^}]+?)\s*\}\}/g, (_, p: string) => {
    const v = getPath(scope, p);
    return v == null ? "" : typeof v === "object" ? JSON.stringify(v) : String(v);
  });
}

export function fillArgs(args: Record<string, string>, scope: unknown): Record<string, unknown> {
  return Object.fromEntries(Object.entries(args).map(([k, v]) => [k, interpolate(v, scope)]));
}

/** "5" → 5, "true" → true; used when a tool rejects text where it wants a number. */
export function coerceArgs(args: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(args).map(([k, v]) => {
      if (typeof v !== "string") return [k, v];
      if (/^-?\d+(\.\d+)?$/.test(v)) return [k, Number(v)];
      if (v === "true" || v === "false") return [k, v === "true"];
      return [k, v];
    }),
  );
}

/* ------------------------------------------------------------------ conditions */

const DAY = 86_400_000;

export function parseDate(v: unknown): number | undefined {
  if (typeof v !== "string") return undefined;
  const dmy = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(v.trim());
  const t = dmy ? Date.parse(`${dmy[3]}-${dmy[2]}-${dmy[1]}T00:00:00Z`) : Date.parse(v.length === 10 ? `${v}T00:00:00Z` : v);
  return Number.isNaN(t) ? undefined : t;
}

const lit = (s: string | undefined): unknown => {
  if (s === undefined) return undefined;
  if (s === "true" || s === "false") return s === "true";
  if (s === "null") return null;
  if (/^-?\d+(\.\d+)?$/.test(s.trim())) return Number(s);
  return s;
};

function aggregate(v: unknown, agg: Condition["agg"]): unknown {
  if (!agg) return v;
  const arr = Array.isArray(v) ? v : v == null ? [] : [v];
  switch (agg) {
    case "count":
      return arr.length;
    case "first":
      return arr[0];
    case "last":
      return arr[arr.length - 1];
    case "sum":
      return arr.reduce((a: number, x) => a + (Number(x) || 0), 0);
    case "max":
    case "min": {
      if (!arr.length) return undefined;
      const sorted = [...arr].sort((a, b) => (typeof a === "number" && typeof b === "number" ? a - b : String(a).localeCompare(String(b))));
      return agg === "max" ? sorted[sorted.length - 1] : sorted[0];
    }
  }
}

const same = (a: unknown, b: unknown) =>
  typeof a === "string" && typeof b === "string" ? a.trim().toLowerCase() === b.trim().toLowerCase() : a === b || String(a) === String(b);

/**
 * Evaluate one condition. Date ops treat a MISSING date as "infinitely long
 * ago / never": days_ago_gt is true (e.g. a vendor never paid counts as dormant).
 */
export function evalCondition(c: Condition, scope: unknown, today: string): boolean {
  const v = aggregate(getPath(scope, c.path), c.agg);
  const x = lit(c.value);
  const empty = v == null || v === "" || (Array.isArray(v) && v.length === 0);
  switch (c.op) {
    case "exists":
      return !empty;
    case "missing":
      return empty;
    case "eq":
      return same(v, x);
    case "ne":
      return !same(v, x);
    case "lt":
      return Number(v) < Number(x);
    case "lte":
      return Number(v) <= Number(x);
    case "gt":
      return Number(v) > Number(x);
    case "gte":
      return Number(v) >= Number(x);
    case "contains":
      return Array.isArray(v) ? v.some((e) => same(e, x)) : String(v ?? "").toLowerCase().includes(String(x ?? "").toLowerCase());
    case "not_contains":
      return !(Array.isArray(v) ? v.some((e) => same(e, x)) : String(v ?? "").toLowerCase().includes(String(x ?? "").toLowerCase()));
    case "days_ago_gt":
    case "days_ago_lt":
    case "days_until_lt":
    case "days_until_gt": {
      const t = parseDate(v);
      const now = parseDate(today)!;
      const n = Number(x);
      if (t === undefined) return c.op === "days_ago_gt";
      const ago = (now - t) / DAY;
      if (c.op === "days_ago_gt") return ago > n;
      if (c.op === "days_ago_lt") return ago < n;
      if (c.op === "days_until_lt") return -ago < n;
      return -ago > n;
    }
  }
}

export const anyTrue = (cs: Condition[] | undefined, scope: unknown, today: string) => !!cs?.some((c) => evalCondition(c, scope, today));
export const allTrue = (cs: Condition[] | undefined, scope: unknown, today: string) => !cs || cs.every((c) => evalCondition(c, scope, today));

/** Plain-language form of a condition, for notes: "steps.verify.confirmed eq false". */
export const describeCondition = (c: Condition) => `${c.agg ? `${c.agg}(${c.path})` : c.path} ${c.op.replace(/_/g, " ")}${c.value !== undefined ? ` ${c.value}` : ""}`;

/* ------------------------------------------------------------------ normalisation (weak models write "3 months") */

const DATE_OPS = new Set(["days_ago_gt", "days_ago_lt", "days_until_lt", "days_until_gt"]);
const NUMBER_OPS = new Set(["lt", "lte", "gt", "gte"]);
const WORD_NUMBERS: Record<string, number> = {
  a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
  eleven: 11, twelve: 12, fifteen: 15, eighteen: 18, twenty: 20, thirty: 30, sixty: 60, ninety: 90,
};
const UNIT_DAYS: Record<string, number> = { day: 1, week: 7, month: 30, year: 365 };

/** "3 months" → 90, "six weeks" → 42, "90 days" → 90, "180" → 180; undefined if it isn't a duration. */
export function toDays(v: string | undefined): number | undefined {
  if (v === undefined) return undefined;
  const t = v.trim().toLowerCase();
  if (/^-?\d+(\.\d+)?$/.test(t)) return Number(t);
  const m = /^(-?\d+(?:\.\d+)?|[a-z]+)\s*(day|week|month|year)s?$/.exec(t);
  if (!m) return undefined;
  const n = /^-?\d/.test(m[1]!) ? Number(m[1]) : WORD_NUMBERS[m[1]!];
  return n === undefined ? undefined : Math.round(n * UNIT_DAYS[m[2]!]!);
}

/**
 * Fix what can be fixed safely (durations written in words) and return notes
 * about it, so the plan shows what was assumed. Mutates and returns `p`.
 */
export function normalizeProgram(p: Program): { program: Program; notes: string[] } {
  const notes: string[] = [];
  const fix = (c: Condition) => {
    if (!DATE_OPS.has(c.op) || c.value === undefined) return;
    const d = toDays(c.value);
    if (d !== undefined && String(d) !== c.value.trim()) {
      notes.push(`read "${c.value}" as ${d} days`);
      c.value = String(d);
    }
  };
  for (const c of p.items.where ?? []) fix(c);
  for (const st of p.steps) for (const c of st.flagIf ?? []) fix(c);
  return { program: p, notes };
}

/**
 * Does this path exist in the data's SHAPE? true / false, or "unknown" when a
 * list on the way is empty (nothing to look inside). Used to catch a program
 * that reads a field the tool never returns: the classic weak-model mistake,
 * which would otherwise make every condition silently true or false.
 */
export function pathResolves(obj: unknown, path: string): boolean | "unknown" {
  if (!path) return true;
  let cur: unknown[] = [obj];
  for (const raw of path.split(".").filter(Boolean)) {
    const many = raw.endsWith("[]");
    const key = many ? raw.slice(0, -2) : raw;
    const objects = cur.filter((c): c is Record<string, unknown> => c != null && typeof c === "object");
    if (!objects.length) return cur.length ? false : "unknown";
    const holders = key ? objects.filter((o) => key in o) : objects;
    if (!holders.length) return false;
    const next: unknown[] = [];
    for (const h of holders) {
      const v = key ? h[key] : h;
      if (many) {
        if (!Array.isArray(v)) return false;
        next.push(...v);
      } else next.push(v);
    }
    cur = next;
    if (!cur.length) return "unknown";
  }
  return true;
}

/** Every path a program reads, with where it's used (for checks and repairs). */
export function programPaths(p: Program): { path: string; where: string; cond?: Condition; stepIndex: number }[] {
  const out: { path: string; where: string; cond?: Condition; stepIndex: number }[] = [];
  const fromTemplate = (t: string) => [...t.matchAll(/\{\{\s*([^}]+?)\s*\}\}/g)].map((m) => m[1]!);
  p.steps.forEach((st, i) => {
    for (const v of Object.values(st.args)) for (const path of fromTemplate(v)) out.push({ path, where: `step "${st.id}" args`, stepIndex: i });
    for (const c of st.flagIf ?? []) out.push({ path: c.path, where: `step "${st.id}" flagIf`, cond: c, stepIndex: i });
  });
  for (const c of p.columns) out.push({ path: c.path, where: `column "${c.title}"`, stepIndex: p.steps.length });
  return out;
}

/** Static checks before running a composed program. Returns problems (empty = OK). */
export function validateProgram(
  p: Program,
  tools: { has(name: string): boolean; get(name: string): { risk: string } | undefined },
): string[] {
  const problems: string[] = [];
  const check = (name: string, where: string) => {
    const t = tools.get(name);
    if (!tools.has(name) || !t) problems.push(`${where}: unknown tool "${name}"`);
    else if (t.risk === "irreversible") problems.push(`${where}: "${name}" is irreversible; composed plans may only read or make reversible changes`);
  };
  check(p.items.tool, "items");
  const ids = new Set<string>();
  for (const s of p.steps) {
    if (!/^[a-z][a-z0-9_]*$/.test(s.id)) problems.push(`step "${s.id}": id must be snake_case`);
    if (ids.has(s.id)) problems.push(`duplicate step id "${s.id}"`);
    ids.add(s.id);
    check(s.tool, `step "${s.id}"`);
  }
  // Conditions: numbers where numbers are needed.
  const conds = [...(p.items.where ?? []).map((c) => ({ c, where: "items.where" })), ...p.steps.flatMap((s) => (s.flagIf ?? []).map((c) => ({ c, where: `step "${s.id}" flagIf` })))];
  for (const { c, where } of conds) {
    if (DATE_OPS.has(c.op) && toDays(c.value) === undefined) problems.push(`${where}: ${c.op} needs value = a number of days (got "${c.value ?? ""}")`);
    if (NUMBER_OPS.has(c.op) && (c.value === undefined || Number.isNaN(Number(c.value)))) problems.push(`${where}: ${c.op} needs a number as value (got "${c.value ?? ""}")`);
  }
  // Paths: only item.*, params.* or a step that has already run.
  const stepIds = p.steps.map((s) => s.id);
  for (const { path, where, stepIndex } of programPaths(p)) {
    const head = path.split(".")[0];
    if (head === "item" || head === "params") continue;
    if (head !== "steps") {
      problems.push(`${where}: path "${path}" must start with item., steps.<id>. or params.`);
      continue;
    }
    const id = path.split(".")[1]?.replace(/\[\]$/, "");
    const at = stepIds.indexOf(id ?? "");
    const isFlag = where.endsWith("flagIf");
    if (at < 0) problems.push(`${where}: "${path}" refers to a step "${id}" that doesn't exist`);
    else if (at > stepIndex || (at === stepIndex && !isFlag)) problems.push(`${where}: "${path}" reads step "${id}" before it has run`);
  }
  return problems;
}
