import { mkdtemp } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_WORKSPACE, Kaveri, PORTS, TODAY, buildSites, generateWorkspace, siteUrl, type SiteKey } from "@theseus/kaveri";

/**
 * The company world the employee works in.
 *  - "inprocess": a fresh Kaveri inside this process. By default requests go
 *    straight to the sites' handlers (no ports), through the same JSON APIs
 *    and headers as over the network. With `listen`, the sites also listen on
 *    free local ports so a real browser can open them (computer use).
 *  - "live": the running `pnpm kaveri` on localhost:4100-4107 (watch it in a browser).
 */
export interface World {
  mode: "inprocess" | "live";
  urls: Record<Exclude<SiteKey, "control">, string>;
  fetch: typeof fetch;
  workspaceDir: string;
  today: string;
  kaveri?: Kaveri;
  /** True when the sites can be reached over HTTP (a browser can use them). */
  browsable: boolean;
  close(): Promise<void>;
}

const AGENT_SITES = ["mail", "erp", "bank", "gst", "udyam", "eproc", "ap"] as const;
const urlsOf = () => Object.fromEntries(AGENT_SITES.map((k) => [k, siteUrl(k)])) as World["urls"];

export async function inProcessWorld(opts: { workspaceDir?: string | "temp"; listen?: boolean } = {}): Promise<World> {
  const kaveri = new Kaveri();
  const workspaceDir = opts.workspaceDir === "temp" ? await mkdtemp(join(tmpdir(), "theseus-ws-")) : (opts.workspaceDir ?? DEFAULT_WORKSPACE);
  await generateWorkspace(kaveri.state, workspaceDir);
  const sites = buildSites(kaveri, { workspaceDir: false });

  if (opts.listen) {
    // Free ports, so tests and a running `pnpm kaveri` never collide.
    const urls = {} as World["urls"];
    for (const k of AGENT_SITES) {
      await sites[k].app.listen({ port: 0, host: "127.0.0.1" });
      urls[k] = `http://127.0.0.1:${(sites[k].app.server.address() as AddressInfo).port}`;
    }
    return {
      mode: "inprocess",
      urls,
      fetch: (...a) => fetch(...a),
      workspaceDir,
      today: TODAY,
      kaveri,
      browsable: true,
      async close() {
        for (const k of AGENT_SITES) await sites[k].app.close().catch(() => undefined);
      },
    };
  }

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
    return new Response(new Uint8Array(res.rawPayload), { status: res.statusCode, headers: res.headers as Record<string, string> });
  }) as typeof fetch;

  return { mode: "inprocess", urls: urlsOf(), fetch: injectFetch, workspaceDir, today: TODAY, kaveri, browsable: false, close: async () => undefined };
}

export function liveWorld(workspaceDir = DEFAULT_WORKSPACE): World {
  return { mode: "live", urls: urlsOf(), fetch: (...a) => fetch(...a), workspaceDir, today: TODAY, browsable: true, close: async () => undefined };
}
