/**
 * Preload: runs in the window before the UI, with access to a few Electron
 * APIs. It exposes exactly the functions in TheseusBridge (apps/web/src/bridge.ts)
 * as `window.theseus`, and nothing else: no Node, no `require`, no raw IPC.
 */
import { contextBridge, ipcRenderer, webUtils } from "electron";
import type { FileChange, TheseusBridge } from "@theseus/web/bridge";

const call = <T>(channel: string, ...args: unknown[]) => ipcRenderer.invoke(channel, ...args) as Promise<T>;

const api: TheseusBridge = {
  isDesktop: true,
  platform: process.platform,
  roots: () => call("files:roots"),
  grantFolder: () => call("files:grant"),
  revokeFolder: (rootId) => call("files:revoke", rootId),
  walk: (rootId, rel) => call("files:walk", rootId, rel ?? ""),
  readText: (rootId, rel) => call("files:readText", rootId, rel),
  open: (rootId, rel) => call("files:open", rootId, rel),
  reveal: (rootId, rel) => call("files:reveal", rootId, rel),
  writeNew: (rootId, rel, text) => call("files:writeNew", rootId, rel, text),
  pickAttachments: () => call("files:pick"),
  // Dropped File objects carry their real path only here (webUtils), never in the page.
  importDropped: (files) => call("files:importPaths", files.map((f) => webUtils.getPathForFile(f)).filter(Boolean)),
  onFilesChanged: (cb) => {
    const listener = (_e: unknown, change: FileChange) => cb(change);
    ipcRenderer.on("files:changed", listener);
    return () => ipcRenderer.removeListener("files:changed", listener);
  },
};

contextBridge.exposeInMainWorld("theseus", api);
