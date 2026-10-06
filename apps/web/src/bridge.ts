/**
 * The desktop bridge: the ONLY native powers the UI has.
 *
 * In the Electron app, `apps/desktop/src/preload.ts` exposes this object as
 * `window.theseus`. Each function is a message to the main process, which
 * checks every path against the granted folders (FileSandbox in @theseus/core).
 * In a plain browser `window.theseus` is undefined and the UI degrades
 * gracefully (files are listed but can't be opened).
 */

import type { Command, TheseusEvent } from "@theseus/protocol";

export interface BridgeRoot {
  id: string;
  label: string;
  path: string;
}

export interface BridgeEntry {
  name: string;
  rel: string;
  kind: "file" | "dir";
  size: number;
  mtimeMs: number;
}

export interface FileChange {
  rootId: string;
  rel: string;
}

export type AgentMode = "live" | "demo";

export interface AgentInfo {
  mode: AgentMode;
  /** e.g. "gemini:gemini-3.5-flash-lite" or "scripted" */
  model: string;
  note?: string;
  workspaceDir: string;
  today: string;
  suggestions: string[];
}

export interface AgentSnapshot {
  info: AgentInfo | null;
  error: string | null;
  events: TheseusEvent[];
}

/** The live employees (apps/server/src/host.ts, run by the desktop app in its own process). */
export interface AgentBridge {
  init(): Promise<AgentSnapshot>;
  command(c: Command): Promise<void>;
  /** Restart with a fresh company world, optionally switching live ↔ demo. */
  restart(mode?: AgentMode): Promise<AgentSnapshot>;
  onEvent(cb: (e: TheseusEvent) => void): () => void;
  onStatus(cb: (s: { info: AgentInfo | null; error: string | null }) => void): () => void;
  onReset(cb: () => void): () => void;
}

export interface TheseusBridge {
  /** Live agents (desktop app only). */
  agent: AgentBridge;
  readonly isDesktop: true;
  readonly platform: string;
  roots(): Promise<BridgeRoot[]>;
  /** Ask the user to pick a folder and grant it (native dialog). */
  grantFolder(): Promise<BridgeRoot | null>;
  revokeFolder(rootId: string): Promise<void>;
  walk(rootId: string, rel?: string): Promise<BridgeEntry[]>;
  readText(rootId: string, rel: string): Promise<string>;
  /** Open with the default app (Excel, Word, PDF viewer…). */
  open(rootId: string, rel: string): Promise<void>;
  /** Show in Explorer / Finder. */
  reveal(rootId: string, rel: string): Promise<void>;
  /** Create a new file; never overwrites. Returns the path actually used. */
  writeNew(rootId: string, rel: string, text: string): Promise<string>;
  /** Native file picker → files are copied into the workspace's Attachments folder. */
  pickAttachments(): Promise<{ rootId: string; rel: string; name: string; size: number }[]>;
  /** Files dropped on the window (File objects from a drop event) → copied in the same way. */
  importDropped(files: File[]): Promise<{ rootId: string; rel: string; name: string; size: number }[]>;
  /** Live changes in any granted folder. Returns an unsubscribe function. */
  onFilesChanged(cb: (change: FileChange) => void): () => void;
}

declare global {
  interface Window {
    theseus?: TheseusBridge;
  }
}

export const bridge = (): TheseusBridge | undefined => (typeof window === "undefined" ? undefined : window.theseus);

/** Attachments reference files as "rootId:rel" so a message never stores an absolute path. */
export const attachmentRef = (rootId: string, rel: string) => `${rootId}:${rel}`;
export function parseRef(ref: string): { rootId: string; rel: string } | null {
  const i = ref.indexOf(":");
  return i > 0 ? { rootId: ref.slice(0, i), rel: ref.slice(i + 1) } : null;
}

export function mimeOf(name: string): string {
  const ext = name.toLowerCase().split(".").pop() ?? "";
  return (
    {
      pdf: "application/pdf",
      xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      csv: "text/csv",
      txt: "text/plain",
      png: "image/png",
      jpg: "image/jpeg",
    } as Record<string, string>
  )[ext] ?? "application/octet-stream";
}
