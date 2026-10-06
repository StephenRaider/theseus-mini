/**
 * Theseus desktop app: Electron MAIN process.
 *
 * This is the only part of the app that touches the disk or the OS. The UI
 * (apps/web) runs sandboxed in the window and reaches these functions only
 * through the preload bridge (preload.ts → window.theseus). Every path is
 * checked by FileSandbox (@theseus/core): granted folders only, no escapes,
 * new files only (no overwrites).
 */
import { FileSandbox, SandboxError, type Root } from "@theseus/core";
import { app, BrowserWindow, dialog, ipcMain, Menu, net, protocol, shell, type IpcMainInvokeEvent } from "electron";
import { watch, type FSWatcher } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url)); // apps/desktop/dist
const REPO_ROOT = path.resolve(here, "../../..");
const WEB_DIST = path.resolve(here, "../../web/dist");
const DEV_URL = process.env.THESEUS_DEV_URL; // set by scripts/run.mjs in dev mode

const WORKSPACE_DIR =
  process.env.THESEUS_WORKSPACE ??
  process.env.KAVERI_WORKSPACE ??
  (app.isPackaged ? path.join(app.getPath("documents"), "Theseus Workspace") : path.join(REPO_ROOT, "workspace"));

/* ------------------------------------------------------------------ settings (granted folders) */

interface Settings {
  extraRoots: Root[];
}
const settingsFile = () => path.join(app.getPath("userData"), "settings.json");

async function loadSettings(): Promise<Settings> {
  try {
    const s = JSON.parse(await fs.readFile(settingsFile(), "utf8")) as Settings;
    return { extraRoots: Array.isArray(s.extraRoots) ? s.extraRoots : [] };
  } catch {
    return { extraRoots: [] };
  }
}
async function saveSettings(s: Settings) {
  await fs.mkdir(path.dirname(settingsFile()), { recursive: true });
  await fs.writeFile(settingsFile(), JSON.stringify(s, null, 2));
}

const sandbox = new FileSandbox([{ id: "workspace", label: "Workspace", path: WORKSPACE_DIR }]);
let settings: Settings = { extraRoots: [] };

/** The Kaveri workspace (register, policy PDF, templates) is generated on first run. */
async function ensureWorkspace() {
  try {
    await fs.access(WORKSPACE_DIR);
  } catch {
    const [{ generateWorkspace }, { initialState }] = await Promise.all([import("@theseus/kaveri/workspace"), import("@theseus/kaveri/seed")]);
    await generateWorkspace(initialState(), WORKSPACE_DIR);
  }
}

/* ------------------------------------------------------------------ live folder watching */

const watchers = new Map<string, FSWatcher>();
let win: BrowserWindow | null = null;

function watchRoot(root: Root) {
  if (watchers.has(root.id)) return;
  try {
    const w = watch(root.path, { recursive: true }, (_event, filename) => {
      if (!filename || win?.isDestroyed()) return;
      const rel = filename.toString().replace(/\\/g, "/");
      if (rel.split("/").some((p) => p.startsWith("."))) return;
      win?.webContents.send("files:changed", { rootId: root.id, rel });
    });
    w.on("error", () => unwatch(root.id));
    watchers.set(root.id, w);
  } catch {
    /* folder missing: the Files panel shows that */
  }
}
function unwatch(id: string) {
  watchers.get(id)?.close();
  watchers.delete(id);
}

/* ------------------------------------------------------------------ IPC: the bridge's other half */

/** Only our own UI may call the bridge. */
function trusted(e: IpcMainInvokeEvent) {
  const url = e.senderFrame?.url ?? "";
  if (!(url.startsWith("app://") || (DEV_URL && url.startsWith(DEV_URL)))) throw new Error(`Untrusted caller: ${url}`);
}

function handle<A extends unknown[], R>(channel: string, fn: (...args: A) => Promise<R>) {
  ipcMain.handle(channel, async (e, ...args) => {
    trusted(e);
    try {
      return await fn(...(args as A));
    } catch (err) {
      // Re-throw as a plain message (the renderer only sees err.message).
      throw new Error(err instanceof SandboxError ? `${err.code}: ${err.message}` : err instanceof Error ? err.message : String(err));
    }
  });
}

const str = (v: unknown, name: string) => {
  if (typeof v !== "string") throw new Error(`${name} must be a string`);
  return v;
};

const ATTACH_DIR = "Attachments";

function registerIpc() {
  handle("files:roots", async () => sandbox.list());
  handle("files:walk", async (rootId: unknown, rel: unknown) => sandbox.walk(str(rootId, "rootId"), typeof rel === "string" ? rel : ""));
  handle("files:readText", async (rootId: unknown, rel: unknown) => sandbox.readText(str(rootId, "rootId"), str(rel, "rel")));
  handle("files:writeNew", async (rootId: unknown, rel: unknown, text: unknown) => sandbox.writeNew(str(rootId, "rootId"), str(rel, "rel"), str(text, "text")));
  handle("files:open", async (rootId: unknown, rel: unknown) => {
    const abs = await sandbox.resolve(str(rootId, "rootId"), str(rel, "rel"));
    await fs.access(abs).catch(() => {
      throw new SandboxError("not_found", `File not found: ${String(rel)}`);
    });
    const err = await shell.openPath(abs);
    if (err) throw new Error(err);
  });
  handle("files:reveal", async (rootId: unknown, rel: unknown) => {
    const abs = await sandbox.resolve(str(rootId, "rootId"), typeof rel === "string" ? rel : "");
    if (!rel) await shell.openPath(abs);
    else shell.showItemInFolder(abs);
  });
  handle("files:grant", async () => {
    const r = await dialog.showOpenDialog(win!, { title: "Grant Theseus access to a folder", properties: ["openDirectory", "createDirectory"] });
    const dir = r.filePaths[0];
    if (r.canceled || !dir) return null;
    const root: Root = { id: `folder_${Date.now().toString(36)}`, label: path.basename(dir) || dir, path: dir };
    sandbox.grant(root);
    settings.extraRoots.push(root);
    await saveSettings(settings);
    watchRoot(root);
    return root;
  });
  handle("files:revoke", async (rootId: unknown) => {
    const id = str(rootId, "rootId");
    if (id === "workspace") throw new Error("The workspace can't be removed");
    sandbox.revoke(id);
    unwatch(id);
    settings.extraRoots = settings.extraRoots.filter((r) => r.id !== id);
    await saveSettings(settings);
  });
  // Attachments: files from anywhere are COPIED into the workspace, so agents only ever see sandboxed copies.
  const importAll = async (paths: string[]) => {
    const out = [];
    for (const p of paths) {
      const rel = await sandbox.importFile("workspace", ATTACH_DIR, p);
      const st = await fs.stat(p);
      out.push({ rootId: "workspace", rel, name: path.basename(rel), size: st.size });
    }
    return out;
  };
  handle("files:pick", async () => {
    const r = await dialog.showOpenDialog(win!, { title: "Attach files", properties: ["openFile", "multiSelections"] });
    return r.canceled ? [] : importAll(r.filePaths);
  });
  handle("files:importPaths", async (paths: unknown) => {
    if (!Array.isArray(paths) || !paths.every((p) => typeof p === "string" && path.isAbsolute(p))) throw new Error("Expected absolute file paths");
    return importAll(paths as string[]);
  });
}

/* ------------------------------------------------------------------ window */

// app:// serves the built UI (safer and more predictable than file://).
protocol.registerSchemesAsPrivileged([{ scheme: "app", privileges: { standard: true, secure: true, supportFetchAPI: true } }]);

function serveApp() {
  protocol.handle("app", (req) => {
    const { pathname } = new URL(req.url);
    const rel = decodeURIComponent(pathname === "/" ? "/index.html" : pathname);
    const abs = path.normalize(path.join(WEB_DIST, rel));
    if (!abs.startsWith(WEB_DIST)) return new Response("Not found", { status: 404 });
    return net.fetch(pathToFileURL(abs).toString());
  });
}

async function createWindow() {
  win = new BrowserWindow({
    width: 1480,
    height: 920,
    minWidth: 1100,
    minHeight: 640,
    title: "Theseus",
    backgroundColor: "#0F0F0F",
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(here, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  // Links never open inside the app window; external ones go to the browser.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith("https://")) void shell.openExternal(url);
    return { action: "deny" };
  });
  win.webContents.on("will-navigate", (e, url) => {
    if (!(url.startsWith("app://") || (DEV_URL && url.startsWith(DEV_URL)))) e.preventDefault();
  });
  await win.loadURL(DEV_URL ?? "app://theseus/index.html");
  win.on("closed", () => {
    win = null;
  });
}

app.setName("Theseus");
app.whenReady().then(async () => {
  Menu.setApplicationMenu(null);
  serveApp();
  settings = await loadSettings();
  for (const r of settings.extraRoots) {
    try {
      sandbox.grant(r);
    } catch {
      /* stale entry */
    }
  }
  await ensureWorkspace().catch((e) => console.error("[theseus] workspace:", e));
  for (const r of sandbox.list()) watchRoot(r);
  registerIpc();
  await createWindow();
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) void createWindow();
  });
});

app.on("window-all-closed", () => {
  for (const id of [...watchers.keys()]) unwatch(id);
  if (process.platform !== "darwin") app.quit();
});
