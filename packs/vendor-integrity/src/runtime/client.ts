import { ToolFailure } from "@theseus/core";

/**
 * HTTP client for the company's systems (Kaveri's six sites). Agents use the
 * same JSON APIs a real integration would, identified by the `x-actor` header
 * so the systems' own rules (maker-checker etc.) apply to them.
 *
 * Every HTTP failure becomes a CLASSIFIED ToolFailure (Framework Spec §4), so
 * the kernel can pick a policy (retry, park, ask) instead of guessing.
 */
export type SiteKey = "mail" | "erp" | "bank" | "gst" | "udyam" | "eproc";

export interface ClientOptions {
  /** Base URL per site, e.g. { erp: "http://localhost:4102", … }. */
  urls: Record<SiteKey, string>;
  /** "agent:emp_001": who the systems see. */
  actor: string;
  /** Injectable for tests (in-process world). */
  fetch?: typeof fetch;
}

export class KaveriClient {
  constructor(private readonly opts: ClientOptions) {}

  get actor() {
    return this.opts.actor;
  }

  private async request(site: SiteKey, method: string, path: string, body?: unknown): Promise<Response> {
    const f = this.opts.fetch ?? fetch;
    try {
      return await f(`${this.opts.urls[site]}${path}`, {
        method,
        headers: { "x-actor": this.opts.actor, ...(body !== undefined ? { "content-type": "application/json" } : {}) },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      });
    } catch (e) {
      throw new ToolFailure("transient", `${site.toUpperCase()} is unreachable (${(e as Error).message})`, "Is the Kaveri world running? (pnpm kaveri)");
    }
  }

  async json<T = any>(site: SiteKey, method: "GET" | "POST" | "PATCH", path: string, body?: unknown): Promise<T> {
    const res = await this.request(site, method, path, body);
    const payload = (await res.json().catch(() => ({}))) as T & { error?: { code?: string; message?: string } };
    if (res.ok) return payload;
    throw classify(site, res.status, payload.error?.code, payload.error?.message);
  }

  async bytes(site: SiteKey, path: string): Promise<Buffer> {
    const res = await this.request(site, "GET", path);
    if (!res.ok) {
      const j = (await res.json().catch(() => ({}))) as { error?: { code?: string; message?: string } };
      throw classify(site, res.status, j.error?.code, j.error?.message);
    }
    return Buffer.from(await res.arrayBuffer());
  }
}

function classify(site: SiteKey, status: number, code?: string, message?: string): ToolFailure {
  const msg = `${site.toUpperCase()}: ${message ?? `HTTP ${status}`}`;
  if (status === 503 || status === 502 || status === 504 || status === 429) return new ToolFailure("transient", msg);
  if (status === 404) return new ToolFailure("not_found", msg);
  if (status === 403) {
    if (code === "APPROVAL_REQUIRED" || code === "MAKER_CHECKER") return new ToolFailure("policy_violation", msg, "A human must approve this");
    return new ToolFailure("blocked_needs_human", msg);
  }
  if (status === 409 || status === 422 || status === 400) return new ToolFailure("validation", msg);
  return new ToolFailure("fatal", msg);
}
