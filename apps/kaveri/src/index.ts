/**
 * @theseus/kaveri: the mock company Kaveri Infra Pvt Ltd (the agent's "world").
 * Mail, ERP (vendor master, payment batches), bank portal, GST lookup, HR and
 * debarment lists, with a deterministic seed scenario, fault injection and
 * ground truth (/__admin). Run: `pnpm kaveri` → http://localhost:4100
 */
export * from "./domain.ts";
export { buildServer } from "./server.ts";
export { Kaveri, KaveriError, NO_FAULTS, type FaultConfig } from "./store.ts";
export { BIDDERS, COMPANY, TODAY, TRAPS, initialState } from "./seed/scenario.ts";
export { getDocument, DOCUMENT_KEYS } from "./docs/pdf.ts";
