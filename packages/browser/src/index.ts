/**
 * @theseus/browser: a real browser for the employees (Playwright + Chromium).
 * Pages are observed as text outlines with element refs ([e12]) and operated
 * with a few verbs; see session.ts. Swappable (e.g. for a vision model later)
 * because the kernel only sees the browser tools built on top of this.
 */
export * from "./session.ts";
export type { ElementInfo, RefInfo } from "./snapshot.ts";
