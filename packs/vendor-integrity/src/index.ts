import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Role pack: Vendor & Contractor Integrity Specialist.
 * Declarative part: pack.yaml + playbooks/*.yaml (loaded by @theseus/core).
 * Code part: deterministic validators and rules the tools are built on.
 */
// Installed app: read-only assets are shipped next to the app (THESEUS_ASSETS); otherwise this package.
export const PACK_DIR = process.env.THESEUS_ASSETS ? join(process.env.THESEUS_ASSETS, "packs/vendor-integrity") : join(dirname(fileURLToPath(import.meta.url)), "..");

export * from "./validators/pan.ts";
export * from "./validators/gstin.ts";
export * from "./validators/ifsc.ts";
export * from "./validators/states.ts";
export * from "./rules/tds.ts";
export * from "./rules/msme.ts";
export * from "./matchers/names.ts";
