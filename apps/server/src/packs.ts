import type { BrowserPool } from "@theseus/browser";
import type { PackRuntime } from "@theseus/core";
import { createVendorIntegrityRuntime } from "@theseus/pack-vendor-integrity/runtime";
import type { World } from "./world.ts";

/**
 * The platform's pack registry: the ONE place that knows which employee types
 * exist. Theseus is the platform; a role pack is a type of employee. To add a
 * new type, write a pack (see packs/README.md) and register one line here.
 * Nothing else in the keel, the server or the app changes.
 */
export interface PackContext {
  world: World;
  employeeId: string;
  /** Present when the run has a browser (computer use). */
  browser?: { pool: BrowserPool; urls: Record<string, string> };
}

export type PackFactory = (ctx: PackContext) => Promise<PackRuntime>;

export const PACKS: Record<string, PackFactory> = {
  "vendor-integrity": (ctx) =>
    createVendorIntegrityRuntime({
      client: { urls: ctx.world.urls, actor: `agent:${ctx.employeeId}`, fetch: ctx.world.fetch },
      workspaceDir: ctx.world.workspaceDir,
      today: ctx.world.today,
      ...(ctx.browser ? { browser: ctx.browser } : {}),
    }),
};

export const DEFAULT_PACK = "vendor-integrity";

/** Pack id from the caller or THESEUS_PACK, falling back to the default. */
export function packId(requested?: string): string {
  return requested ?? process.env.THESEUS_PACK ?? DEFAULT_PACK;
}

export function loadPack(id: string, ctx: PackContext): Promise<PackRuntime> {
  const factory = PACKS[id];
  if (!factory) throw new Error(`Unknown employee type "${id}". Available: ${Object.keys(PACKS).join(", ")}. Register new ones in apps/server/src/packs.ts.`);
  return factory(ctx);
}
