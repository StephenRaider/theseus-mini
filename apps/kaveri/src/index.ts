/**
 * @theseus/kaveri: the mock company Kaveri Infra Pvt Ltd (the agent's "world").
 * Mail, ERP (vendor master, payment batches), bank portal, GST lookup, HR and
 * debarment lists, with a deterministic seed scenario, fault injection and
 * ground truth (/__admin). Run: `pnpm kaveri` → Control Room http://localhost:4100 + six sites on 4101–4106
 */
export * from "./domain.ts";
export { buildSites, startWorld, PORTS, siteUrl, type SiteKey } from "./sites/index.ts";
export { generateWorkspace, WORKSPACE_FILES, REGISTER_COLUMNS, POLICY_SECTIONS, EMPANELMENT_TAGS, REPORT_TAGS, DEFAULT_WORKSPACE, MARKER } from "./workspace.ts";
export { batchToXlsx } from "./exports.ts";
export { Kaveri, KaveriError, NO_FAULTS, type FaultConfig } from "./store.ts";
export { BIDDERS, COMPANY, TODAY, TRAPS, initialState } from "./seed/scenario.ts";
export { getDocument, DOCUMENT_KEYS } from "./docs/pdf.ts";
