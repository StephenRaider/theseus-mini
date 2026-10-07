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
import { fork, type ChildProcess } from "node:child_process";
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

/* ------------------------------------------------------------------ the agent host (employees run in their own process) */

type HostMode = "live" | "demo";
interface HostInfo {
  mode: HostMode;
  model: string;
  note?: string;
  workspaceDir: string;
  today: string;
  suggestions: string[];
}

let host: ChildProcess | null = null;
let hostInfo: HostInfo | null = null;
let hostError: string | null = null;
let hostReady: Promise<void> = Promise.resolve();
/** Every event since the host started: a reloaded window replays these. */
let backlog: unknown[] = [];
/** Latest browser frame per employee (live view of computer use). */
let frames = new Map<string, unknown>();

/**
 * Fork apps/server/src/host.ts with tsx, using Electron's own Node. The kernel,
 * the company world and the model calls all live there; this process only relays.
 */
function startHost(mode?: HostMode) {
  backlog = [];
  frames = new Map();
  hostInfo = null;
  hostError = null;
  const script = path.join(REPO_ROOT, "apps/server/src/host.ts");
  const child = fork(script, mode ? [mode] : [], {
    cwd: REPO_ROOT,
    execArgv: ["--import", "tsx"],
    env: { ...process.env, ELECTRON_RUN_AS_NODE: "1", THESEUS_WORKSPACE: WORKSPACE_DIR },
    stdio: ["ignore", "inherit", "inherit", "ipc"],
  });
  host = child;
  hostReady = new Promise<void>((resolve) => {
    child.on("message", (m: { type: string; event?: unknown; info?: HostInfo; message?: string; frame?: { employeeId: string } }) => {
      if (child !== host) return;
      if (m.type === "frame" && m.frame) {
        frames.set(m.frame.employeeId, m.frame);
        win?.webContents.send("agent:frame", m.frame);
      } else if (m.type === "event") {
        backlog.push(m.event);
        win?.webContents.send("agent:event", m.event);
      } else if (m.type === "ready") {
        hostInfo = m.info!;
        win?.webContents.send("agent:status", { info: hostInfo, error: null });
        resolve();
      } else if (m.type === "fatal" || m.type === "error") {
        hostError = m.message ?? "unknown error";
        win?.webContents.send("agent:status", { info: hostInfo, error: hostError });
        if (m.type === "fatal") resolve();
      }
    });
    child.on("exit", (code) => {
      if (child !== host) return;
      if (code) {
        hostError = hostError ?? `The agent process stopped (exit code ${code})`;
        win?.webContents.send("agent:status", { info: hostInfo, error: hostError });
      }
      resolve();
    });
  });
}

function stopHost() {
  const h = host;
  host = null;
  h?.kill();
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
  handle("agent:init", async () => {
    await hostReady;
    return { info: hostInfo, error: hostError, events: backlog };
  });
  handle("agent:frames", async () => [...frames.values()]);
  handle("agent:command", async (command: unknown) => {
    if (!command || typeof command !== "object" || typeof (command as { type?: unknown }).type !== "string") throw new Error("Bad command");
    if (!host?.connected) throw new Error(hostError ?? "The agent isn't running");
    host.send({ type: "command", command });
  });
  handle("agent:restart", async (mode: unknown) => {
    stopHost();
    win?.webContents.send("agent:reset");
    startHost(mode === "live" || mode === "demo" ? mode : undefined);
    await hostReady;
    return { info: hostInfo, error: hostError, events: backlog };
  });
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
  startHost(process.env.THESEUS_MODE === "live" || process.env.THESEUS_MODE === "demo" ? process.env.THESEUS_MODE : undefined);
  registerIpc();
  await createWindow();
  if (process.env.THESEUS_SMOKE) void smoke();
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) void createWindow();
  });
});

app.on("window-all-closed", () => {
  for (const id of [...watchers.keys()]) unwatch(id);
  stopHost();
  if (process.platform !== "darwin") app.quit();
});

/**
 * THESEUS_SMOKE=1: an automated end-to-end check of the packaged wiring
 * (window + agent process + UI). Asks Theseus for the batch check, waits for
 * the task to finish, prints what the window shows, and quits.
 */
async function smoke() {
  const fail = (why: string) => {
    console.log(`[smoke] FAIL: ${why}`);
    app.exit(1);
  };
  const timer = setTimeout(() => fail("timed out"), 120_000);
  await hostReady;
  if (!host?.connected) return fail(hostError ?? "agent did not start");
  console.log(`[smoke] agent ready: ${JSON.stringify(hostInfo)}`);
  // Drive the real UI: type into Theseus's composer and press Enter, like a person would.
  await new Promise((r) => setTimeout(r, 1500));
  await win!.webContents.executeJavaScript(`document.querySelector(".composer textarea")?.focus()`);
  win!.webContents.focus();
  await win!.webContents.insertText("Run the integrity check on this week's payment batch");
  await new Promise((r) => setTimeout(r, 200));
  win!.webContents.sendInputEvent({ type: "keyDown", keyCode: "Enter" });
  win!.webContents.sendInputEvent({ type: "char", keyCode: "\r" });
  win!.webContents.sendInputEvent({ type: "keyUp", keyCode: "Enter" });
  const sentAt = Date.now();
  while (backlog.length && !backlog.some((e) => (e as { type: string }).type === "message.posted" && JSON.stringify(e).includes("integrity check"))) {
    if (Date.now() - sentAt > 8000) return fail(`the UI did not deliver the message (toast: ${await win!.webContents.executeJavaScript(`document.querySelector(".toast")?.innerText ?? "none"`)})`);
    await new Promise((r) => setTimeout(r, 200));
  }
  const done = () => backlog.some((e) => (e as { type: string; payload: { status?: string } }).type === "task.status_changed" && (e as { payload: { status?: string } }).payload.status === "done");
  while (!done()) await new Promise((r) => setTimeout(r, 250));
  await new Promise((r) => setTimeout(r, 1500)); // let the UI flush
  const text = String(await win!.webContents.executeJavaScript("document.body.innerText"));
  console.log(`[smoke] events: ${backlog.length}`);
  console.log(`[smoke] window text:\n${text.slice(0, 1500)}`);
  const shots = process.env.THESEUS_SMOKE_SHOTS;
  if (shots) {
    await fs.mkdir(shots, { recursive: true });
    win!.setSize(1480, 920);
    await fs.writeFile(path.join(shots, "1-theseus.png"), (await win!.webContents.capturePage()).toPNG());
    await win!.webContents.executeJavaScript(`document.querySelectorAll(".chatrow")[1]?.click()`);
    await new Promise((r) => setTimeout(r, 800));
    await fs.writeFile(path.join(shots, "2-employee.png"), (await win!.webContents.capturePage()).toPNG());
  }
  clearTimeout(timer);
  console.log("[smoke] OK");
  app.exit(0);
}
