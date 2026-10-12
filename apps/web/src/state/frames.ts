/**
 * Live view of the employees' browsers (computer use). The agent host sends
 * a screenshot after every browser action; this keeps the latest one per
 * employee, outside the event-sourced AppState (frames are pictures, not
 * facts, and are never replayed).
 */
import { useSyncExternalStore } from "react";
import type { AgentBridge, BrowserFrame } from "../bridge.ts";

const latest = new Map<string, BrowserFrame>();
const listeners = new Set<() => void>();
const emit = () => {
  for (const l of listeners) l();
};

/** Start receiving frames; returns a stop function. */
export function startFrames(agent: AgentBridge | undefined): () => void {
  if (!agent?.onFrame) return () => {};
  const put = (f: BrowserFrame) => {
    latest.set(f.employeeId, f);
    emit();
  };
  void agent.frames?.().then((fs) => fs.forEach(put), () => undefined);
  const off = agent.onFrame(put);
  const offReset = agent.onReset(() => {
    latest.clear();
    emit();
  });
  return () => {
    off();
    offReset();
  };
}

export function useFrame(employeeId: string): BrowserFrame | undefined {
  return useSyncExternalStore(
    (fn) => (listeners.add(fn), () => listeners.delete(fn)),
    () => latest.get(employeeId),
  );
}

/** The newest browser action of a task as a plain sentence ("Clicking: Save as draft"), for the live view. */
export function latestBrowserAction(calls: Record<string, { taskId: string; tool: string; input?: unknown; at: string }>, taskId: string | undefined): string | undefined {
  if (!taskId) return undefined;
  let last: { tool: string; input?: unknown; at: string } | undefined;
  for (const c of Object.values(calls)) if (c.taskId === taskId && c.tool.startsWith("browser.") && (!last || c.at >= last.at)) last = c;
  if (!last) return undefined;
  const a = (last.input ?? {}) as Record<string, unknown>;
  const str = (v: unknown) => (typeof v === "string" ? v : "");
  switch (last.tool) {
    case "browser.open":
      return `Opening ${str(a.url)}`;
    case "browser.click":
      return `Clicking ${str(a.about) ? `"${str(a.about)}"` : "a button or link"}`;
    case "browser.fill_form":
      return `Filling in the form (${Object.keys(a).length} field${Object.keys(a).length === 1 ? "" : "s"})`;
    case "browser.type":
      return "Typing into a field";
    case "browser.select":
      return "Choosing an option";
    case "browser.look":
      return "Looking at the page";
    case "browser.back":
      return "Going back";
    default:
      return `Browser: ${last.tool.slice("browser.".length).replace(/_/g, " ")}`;
  }
}
