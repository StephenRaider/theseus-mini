import { z } from "zod";
import { Id, Timestamp } from "./common.ts";

/** Theseus is the manager; everyone else is an employee. */
export const EmployeeKind = z.enum(["manager", "employee"]);
export type EmployeeKind = z.infer<typeof EmployeeKind>;

export const EmployeeNaming = z.enum(["numbered", "greek"]);
export type EmployeeNaming = z.infer<typeof EmployeeNaming>;

export const EmployeeStatus = z.enum(["idle", "working", "waiting_on_user", "paused"]);
export type EmployeeStatus = z.infer<typeof EmployeeStatus>;

export const Employee = z.object({
  id: Id,
  kind: EmployeeKind,
  name: z.string().min(1),
  /** Role pack this employee runs, e.g. "vendor-integrity". Theseus has none. */
  rolePack: z.string().optional(),
  /** Free-text scope set by the user, e.g. "Contractors for tender T-14" or "Vendors A–M". */
  scope: z.string().optional(),
  /** Tool allow-list; empty = everything in the role pack. */
  allowedTools: z.array(z.string()).default([]),
  status: EmployeeStatus.default("idle"),
  currentTaskId: Id.optional(),
  createdAt: Timestamp,
});
export type Employee = z.infer<typeof Employee>;

export const THESEUS_ID = "emp_theseus";

/** Curated, easy-to-read Greek names for the `greek` naming mode. */
export const GREEK_NAMES = [
  "Ariadne", "Phaedra", "Nestor", "Calliope", "Leander", "Iolaus", "Penelope", "Castor",
  "Pollux", "Atalanta", "Electra", "Orion", "Thalia", "Hector", "Daphne", "Icarus",
  "Andromeda", "Jason", "Medea", "Perseus", "Cassandra", "Achilles", "Helena", "Ajax",
] as const;

/**
 * Pick the next employee name.
 * numbered → "Employee N" with the smallest N not in use.
 * greek → a random unused Greek name (falls back to numbered if all are taken).
 */
export function nextEmployeeName(
  mode: EmployeeNaming,
  namesInUse: readonly string[],
  random: () => number = Math.random,
): string {
  const used = new Set(namesInUse);
  if (mode === "greek") {
    const free = GREEK_NAMES.filter((n) => !used.has(n));
    if (free.length > 0) return free[Math.floor(random() * free.length)]!;
  }
  let n = 1;
  while (used.has(`Employee ${n}`)) n++;
  return `Employee ${n}`;
}
