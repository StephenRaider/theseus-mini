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
