import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_WORKSPACE, Kaveri, PORTS, TODAY, buildSites, generateWorkspace, siteUrl, type SiteKey } from "@theseus/kaveri";

/**
 * The company world the employee works in.
 *  - "inprocess": a fresh Kaveri inside this process (no ports, no browser).
 *    Requests go straight to the sites' handlers, but through the same JSON
 *    APIs and headers as over the network. Used by tests and `pnpm agent`.
 *  - "live": the running `pnpm kaveri` on localhost:4100-4106 (watch it in a browser).
 */
export interface World {
  mode: "inprocess" | "live";
  urls: Record<Exclude<SiteKey, "control">, string>;
  fetch: typeof fetch;
  workspaceDir: string;
  today: string;
  kaveri?: Kaveri;
}

const AGENT_SITES = ["mail", "erp", "bank", "gst", "udyam", "eproc"] as const;
const urlsOf = () => Object.fromEntries(AGENT_SITES.map((k) => [k, siteUrl(k)])) as World["urls"];

export async function inProcessWorld(opts: { workspaceDir?: string | "temp" } = {}): Promise<World> {
  const kaveri = new Kaveri();
  const workspaceDir = opts.workspaceDir === "temp" ? await mkdtemp(join(tmpdir(), "theseus-ws-")) : (opts.workspaceDir ?? DEFAULT_WORKSPACE);
  await generateWorkspace(kaveri.state, workspaceDir);
  const sites = buildSites(kaveri, { workspaceDir: false });
  const byPort = new Map(Object.entries(PORTS).map(([k, port]) => [String(port), sites[k as SiteKey].app]));

  const injectFetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    const app = byPort.get(url.port);
    if (!app) throw new Error(`No Kaveri site on port ${url.port}`);
    const res = await app.inject({
      method: (init?.method ?? "GET") as "GET",
      url: `${url.pathname}${url.search}`,
      headers: (init?.headers ?? {}) as Record<string, string>,
      ...(init?.body !== undefined ? { payload: init.body as string } : {}),
    });
    return new Response(res.rawPayload, { status: res.statusCode, headers: res.headers as Record<string, string> });
  }) as typeof fetch;

  return { mode: "inprocess", urls: urlsOf(), fetch: injectFetch, workspaceDir, today: TODAY, kaveri };
}

export function liveWorld(workspaceDir = DEFAULT_WORKSPACE): World {
  return { mode: "live", urls: urlsOf(), fetch: (...a) => fetch(...a), workspaceDir, today: TODAY };
}
