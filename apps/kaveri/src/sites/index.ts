import { Kaveri } from "../store.ts";
import { DEFAULT_WORKSPACE, generateWorkspace } from "../workspace.ts";
import { apSite } from "./ap.ts";
import { bankSite } from "./bank.ts";
import { PORTS, siteUrl, type Site, type SiteKey } from "./common.ts";
import { controlSite } from "./control.ts";
import { eprocSite } from "./eproc.ts";
import { gstSite, udyamSite } from "./gov.ts";
import { mailSite } from "./mail.ts";
import { erpSite } from "./erp.ts";

export { PORTS, siteUrl, type SiteKey } from "./common.ts";

/** Build all sites over ONE shared world (they're separate systems to the agent, one process for us). */
export function buildSites(kaveri = new Kaveri(), opts: { workspaceDir?: string | false } = {}): Record<SiteKey, Site> {
  return {
    control: controlSite(kaveri, opts),
    mail: mailSite(kaveri),
    erp: erpSite(kaveri),
    bank: bankSite(kaveri),
    gst: gstSite(kaveri),
    udyam: udyamSite(kaveri),
    eproc: eprocSite(kaveri),
    ap: apSite(kaveri),
  };
}

/** Start every site on its port and generate the local workspace (also on every reset). */
export async function startWorld(opts: { host?: string; workspaceDir?: string | false } = {}) {
  const kaveri = new Kaveri();
  const workspaceDir = opts.workspaceDir === undefined ? DEFAULT_WORKSPACE : opts.workspaceDir;
  if (workspaceDir) {
    await generateWorkspace(kaveri.state, workspaceDir);
    kaveri.onReset.push(async () => void (await generateWorkspace(kaveri.state, workspaceDir)));
  }
  const sites = buildSites(kaveri, { workspaceDir });
  for (const [k, s] of Object.entries(sites)) await s.app.listen({ port: PORTS[k as SiteKey], host: opts.host ?? "127.0.0.1" });
  return { kaveri, sites, workspaceDir, urls: Object.fromEntries(Object.keys(PORTS).map((k) => [k, siteUrl(k as SiteKey)])) as Record<SiteKey, string> };
}
