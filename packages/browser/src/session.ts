/// <reference lib="dom" />
/// <reference lib="dom.iterable" />
import { chromium, type Browser, type BrowserContext, type Download, type Locator, type Page } from "playwright-core";
import { describeInPage, outlineInPage, REF_ATTR, type ElementInfo, type RefInfo } from "./snapshot.ts";

/**
 * A real Chromium, driven by Playwright, one isolated session (cookies, tabs)
 * per employee. The agent observes pages as text outlines with element refs
 * (snapshot.ts) and acts with a handful of verbs: open, click, type, select,
 * check, upload, back. After every action it gets a fresh observation, so the
 * loop is always observe → act → observe.
 *
 * Safety rails that live here, not in a prompt:
 *  - an origin allow-list: requests to any other site are aborted, so the
 *    agent can only reach the company's own systems;
 *  - every request carries `x-actor: agent:<employee>`, so the systems' own
 *    rules (maker-checker, audit log) see an agent, never a human;
 *  - failures are classified (stale element, blocked origin, HTTP status,
 *    timeout) so the kernel can pick a policy instead of guessing.
 */

export type BrowserErrorKind = "stale_ref" | "blocked" | "http" | "timeout" | "invalid" | "crashed";

export class BrowserError extends Error {
  constructor(
    public readonly kind: BrowserErrorKind,
    message: string,
    public readonly status?: number,
  ) {
    super(message);
  }
}

export interface Observation {
  url: string;
  title: string;
  /** HTTP status of the last page load caused by the action (if it loaded a page). */
  status?: number;
  /** True when the action loaded a different page. */
  navigated: boolean;
  /** Text of a JS dialog (confirm/alert) the action raised; it was accepted. */
  dialog?: string;
  /** A file the action downloaded. */
  download?: { name: string; bytes: Buffer };
  /** The page as the agent sees it. */
  outline: string;
  truncated: boolean;
}

export interface BrowserPoolOptions {
  /** Origins the agent may visit, e.g. ["http://127.0.0.1:4101"]. Everything else is blocked. */
  allowOrigins: string[];
  headless?: boolean;
  /** Chromium binary (defaults to Playwright's own; THESEUS_CHROMIUM overrides). */
  executablePath?: string;
  /** Slow every action down (ms) so a person can watch a headed browser. */
  slowMo?: number;
  maxChars?: number;
  maxRows?: number;
  /** Called after every action with a screenshot, for live viewing in the app. */
  onFrame?: (sessionId: string, frame: { url: string; title: string; jpeg: Buffer }) => void;
}

/** Run an in-page function from its source (immune to bundler helpers like esbuild's __name). */
function inPage<A, R>(page: Page, fn: (arg: A) => R, arg: A): Promise<R> {
  return page.evaluate(`(() => { const __name = (f) => f; return (${fn.toString()})(${JSON.stringify(arg)}); })()`) as Promise<R>;
}

const ROLE_FOR_LOCATOR: Record<string, Parameters<Page["getByRole"]>[0]> = {
  link: "link",
  button: "button",
  textbox: "textbox",
  select: "combobox",
  checkbox: "checkbox",
  radio: "radio",
  tab: "tab",
};

export class BrowserPool {
  private browser?: Promise<Browser>;
  private sessions = new Map<string, Promise<BrowserSession>>();

  constructor(readonly opts: BrowserPoolOptions) {}

  private launch(): Promise<Browser> {
    this.browser ??= chromium.launch({
      headless: this.opts.headless ?? true,
      ...((this.opts.executablePath ?? process.env.THESEUS_CHROMIUM) ? { executablePath: this.opts.executablePath ?? process.env.THESEUS_CHROMIUM } : {}),
      ...(this.opts.slowMo ? { slowMo: this.opts.slowMo } : {}),
    });
    return this.browser;
  }

  /** The session for one employee (created on first use). */
  session(id: string, headers: Record<string, string> = {}): Promise<BrowserSession> {
    let s = this.sessions.get(id);
    if (!s) {
      s = (async () => {
        const browser = await this.launch().catch((e: Error) => {
          this.browser = undefined;
          throw new BrowserError("crashed", `Couldn't start the browser: ${e.message.split("\n")[0]}. Install it once with: pnpm exec playwright-core install chromium`);
        });
        const context = await browser.newContext({ extraHTTPHeaders: headers, acceptDownloads: true, viewport: { width: 1280, height: 860 } });
        const allowed = new Set(this.opts.allowOrigins.map((o) => new URL(o).origin));
        await context.route("**/*", (route) => {
          const u = new URL(route.request().url());
          if (u.protocol === "data:" || u.protocol === "blob:" || allowed.has(u.origin)) return route.continue();
          return route.abort("blockedbyclient");
        });
        return new BrowserSession(id, context, await context.newPage(), allowed, this.opts);
      })();
      this.sessions.set(id, s);
      s.catch(() => this.sessions.delete(id));
    }
    return s;
  }

  async close() {
    const b = this.browser;
    this.browser = undefined;
    this.sessions.clear();
    if (b) await (await b).close().catch(() => undefined);
  }
}

export class BrowserSession {
  /** Refs of the last observation: what each ref was when the agent saw it. */
  refs: Record<string, RefInfo> = {};
  private lastStatus?: number;
  private dialog?: string;
  private downloads: Download[] = [];

  constructor(
    readonly id: string,
    readonly context: BrowserContext,
    readonly page: Page,
    private readonly allowed: Set<string>,
    private readonly opts: BrowserPoolOptions,
  ) {
    page.on("response", (r) => {
      if (r.request().isNavigationRequest() && r.frame() === page.mainFrame()) this.lastStatus = r.status();
    });
    page.on("dialog", (d) => {
      this.dialog = d.message();
      void d.accept().catch(() => undefined);
    });
    page.on("download", (d) => this.downloads.push(d));
  }

  get url() {
    return this.page.url();
  }

  /** Go to a URL on an allowed site. */
  async open(url: string): Promise<Observation> {
    let u: URL;
    try {
      u = new URL(url, this.page.url().startsWith("http") ? this.page.url() : undefined);
    } catch {
      throw new BrowserError("invalid", `"${url}" is not a valid address`);
    }
    if (!this.allowed.has(u.origin)) throw new BrowserError("blocked", `${u.origin} is not one of the company systems I'm allowed to use`);
    return this.act(async () => {
      await this.page.goto(u.href, { waitUntil: "domcontentloaded", timeout: 15_000 }).catch((e: Error) => {
        // A file opened directly (PDF) arrives as a download, not a page.
        if (!/Download is starting/i.test(e.message)) throw e;
      });
    }, true);
  }

  /** Fresh observation of the current page. */
  async look(): Promise<Observation> {
    return this.observe({ navigated: false });
  }

  async click(ref: string, expect?: RefInfo): Promise<Observation> {
    const loc = await this.locate(ref, expect);
    const info = await this.describe(ref).catch(() => undefined);
    const mayNavigate = !info || info.tag === "a" || !!info.form;
    return this.act(() => loc.click({ timeout: 5_000 }), mayNavigate);
  }

  /** Type into a field (replacing its value). With submit, press Enter afterwards. */
  async type(ref: string, text: string, opts: { submit?: boolean; expect?: RefInfo } = {}): Promise<Observation> {
    const loc = await this.locate(ref, opts.expect);
    return this.act(async () => {
      await loc.fill(text, { timeout: 5_000 });
      if (opts.submit) await loc.press("Enter");
    }, !!opts.submit);
  }

  /** Choose an option by its visible text (case-insensitive, partial match allowed when unique) or value. */
  async select(ref: string, option: string, expect?: RefInfo): Promise<Observation> {
    const loc = await this.locate(ref, expect);
    const options = await loc.evaluate((el) => (el instanceof HTMLSelectElement ? Array.from(el.options).map((o) => ({ value: o.value, label: (o.textContent ?? "").replace(/\s+/g, " ").trim() })) : null));
    if (!options) throw new BrowserError("invalid", `${ref} is not a drop-down`);
    const want = option.trim().toLowerCase();
    const exact = options.find((o) => o.label.toLowerCase() === want || o.value.toLowerCase() === want);
    const partial = options.filter((o) => o.label.toLowerCase().includes(want));
    const pick = exact ?? (partial.length === 1 ? partial[0] : undefined);
    if (!pick)
      throw new BrowserError(
        "invalid",
        partial.length > 1
          ? `"${option}" matches several options: ${partial.slice(0, 6).map((o) => o.label).join(" · ")}. Be more specific.`
          : `No option "${option}" in that drop-down`,
      );
    return this.act(() => loc.selectOption(pick.value, { timeout: 5_000 }).then(() => undefined), false);
  }

  async check(ref: string, checked: boolean, expect?: RefInfo): Promise<Observation> {
    const loc = await this.locate(ref, expect);
    return this.act(() => loc.setChecked(checked, { timeout: 5_000 }), false);
  }

  async upload(ref: string, file: { name: string; mimeType: string; buffer: Buffer }, expect?: RefInfo): Promise<Observation> {
    const loc = await this.locate(ref, expect);
    return this.act(() => loc.setInputFiles(file, { timeout: 5_000 }), false);
  }

  async back(): Promise<Observation> {
    return this.act(() => this.page.goBack({ waitUntil: "domcontentloaded" }).then(() => undefined), true);
  }

  /** What one element is, which form it submits and with what values: for risk and constraint checks. */
  async describe(ref: string): Promise<ElementInfo> {
    const d = await inPage(this.page, describeInPage, ref);
    if (!d.found) throw new BrowserError("stale_ref", `Element ${ref} isn't on the page any more`);
    const r = this.refs[ref] ?? { role: d.tag, name: "" };
    const { found: _f, ...rest } = d;
    return { ...rest, role: r.role, name: r.name };
  }

  async screenshot(): Promise<Buffer> {
    return this.page.screenshot({ type: "jpeg", quality: 70 });
  }

  /* ------------------------------------------------------------------ internals */

  /**
   * Find the element a ref names. Refs come from the last observation; if the
   * page re-rendered since, fall back to the same role + name (what the agent
   * meant), and fail as "stale" only when that is gone too.
   */
  private async locate(ref: string, expect?: RefInfo): Promise<Locator> {
    const want = expect ?? this.refs[ref];
    const byRef = this.page.locator(`[${REF_ATTR}="${ref}"]`);
    if ((await byRef.count()) === 1) {
      if (!want) return byRef;
      const now = await inPage(this.page, outlineRefInfo, ref);
      if (!now || (now.role === want.role && now.name === want.name)) return byRef;
    }
    if (want && want.name && ROLE_FOR_LOCATOR[want.role]) {
      const alt = this.page.getByRole(ROLE_FOR_LOCATOR[want.role]!, { name: want.name, exact: true });
      if ((await alt.count()) >= 1) return alt.first();
    }
    throw new BrowserError("stale_ref", `Element ${ref}${want ? ` (${want.role} "${want.name}")` : ""} isn't on the page any more; look at the page again`);
  }

  private async act(fn: () => Promise<void>, mayNavigate: boolean): Promise<Observation> {
    const before = this.page.url();
    this.lastStatus = undefined;
    this.dialog = undefined;
    const nDownloads = this.downloads.length;
    // Did the action start loading a new page? (a navigation request or a frame navigation)
    let started = false;
    const onRequest = (r: { isNavigationRequest(): boolean; frame(): unknown }) => {
      if (r.isNavigationRequest() && r.frame() === this.page.mainFrame()) started = true;
    };
    const onNav = (f: unknown) => {
      if (f === this.page.mainFrame()) started = true;
    };
    this.page.on("request", onRequest);
    this.page.on("framenavigated", onNav);
    try {
      await fn();
      if (mayNavigate) {
        for (let i = 0; i < 8 && !started && this.downloads.length === nDownloads; i++) await this.page.waitForTimeout(50);
        if (started) await this.page.waitForLoadState("domcontentloaded", { timeout: 15_000 }).catch(() => undefined);
      }
    } catch (e) {
      const msg = (e as Error).message.split("\n")[0] ?? "";
      if (/Timeout/i.test(msg)) throw new BrowserError("timeout", `The page didn't respond in time (${msg})`);
      if (/ERR_BLOCKED_BY_CLIENT|blockedbyclient/i.test(msg)) throw new BrowserError("blocked", "That address is outside the systems I'm allowed to use");
      if (/ERR_CONNECTION_REFUSED|ERR_NAME_NOT_RESOLVED|ERR_CONNECTION/i.test(msg)) throw new BrowserError("http", `The site can't be reached (${msg})`, 503);
      if (/Target (page|closed)|has been closed/i.test(msg)) throw new BrowserError("crashed", `The browser tab closed (${msg})`);
      throw new BrowserError("invalid", msg);
    } finally {
      this.page.off("request", onRequest);
      this.page.off("framenavigated", onNav);
    }
    // A link to a site outside the allow-list ends on Chrome's error page: go back and say so.
    if (this.page.url().startsWith("chrome-error://")) {
      if (before.startsWith("http")) await this.page.goto(before, { waitUntil: "domcontentloaded" }).catch(() => undefined);
      throw new BrowserError("blocked", "That link leads outside the systems I'm allowed to use (or the site is down)");
    }
    let download: Observation["download"];
    const d = this.downloads.length > nDownloads ? this.downloads[this.downloads.length - 1] : undefined;
    if (d) {
      const path = await d.path().catch(() => null);
      if (path) {
        const { readFile } = await import("node:fs/promises");
        download = { name: d.suggestedFilename(), bytes: await readFile(path) };
      }
    }
    return this.observe({ navigated: this.page.url() !== before || this.lastStatus !== undefined, ...(download ? { download } : {}) });
  }

  private async observe(extra: { navigated: boolean; download?: Observation["download"] }): Promise<Observation> {
    let res;
    try {
      res = await inPage(this.page, outlineInPage, { maxChars: this.opts.maxChars ?? 9_000, maxRows: this.opts.maxRows ?? 40, maxOptions: 25 });
    } catch (e) {
      // Mid-navigation the document can vanish; wait for it once and retry.
      await this.page.waitForLoadState("domcontentloaded", { timeout: 5_000 }).catch(() => undefined);
      res = await inPage(this.page, outlineInPage, { maxChars: this.opts.maxChars ?? 9_000, maxRows: this.opts.maxRows ?? 40, maxOptions: 25 }).catch(() => ({ text: `(couldn't read the page: ${(e as Error).message})`, refs: {}, truncated: false }));
    }
    this.refs = res.refs;
    const obs: Observation = {
      url: this.page.url(),
      title: await this.page.title().catch(() => ""),
      navigated: extra.navigated,
      outline: res.text,
      truncated: res.truncated,
      ...(this.lastStatus !== undefined ? { status: this.lastStatus } : {}),
      ...(this.dialog ? { dialog: this.dialog } : {}),
      ...(extra.download ? { download: extra.download } : {}),
    };
    if (this.opts.onFrame) {
      const jpeg = await this.screenshot().catch(() => undefined);
      if (jpeg) this.opts.onFrame(this.id, { url: obs.url, title: obs.title, jpeg });
    }
    return obs;
  }
}

/** Role + name of the element at a ref right now (runs in the page). */
function outlineRefInfo(ref: string): RefInfo | null {
  const el = document.querySelector(`[data-tref="${ref}"]`);
  if (!el) return null;
  const clean = (s: string | null | undefined) => (s ?? "").replace(/\s+/g, " ").trim();
  if (el instanceof HTMLAnchorElement) return { role: "link", name: clean(el.textContent) || clean(el.getAttribute("aria-label")) };
  if (el instanceof HTMLSelectElement) return null; // labels are computed differently; trust the ref
  if (el instanceof HTMLInputElement && ["submit", "button", "reset"].includes(el.type)) return { role: "button", name: clean(el.value) };
  if (el instanceof HTMLButtonElement) return { role: "button", name: clean(el.textContent) || clean(el.getAttribute("aria-label")) };
  return null; // fields: label lookup is the outline's job; trust the ref
}
