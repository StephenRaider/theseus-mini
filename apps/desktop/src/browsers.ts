/**
 * First-run browser setup for computer use. The installer does not ship
 * Chromium (about 150 MB); the app downloads it once into <userData>/browsers
 * with playwright-core's own CLI, run by Electron acting as plain Node.
 */
import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

/** The browsers directories one launch needs (names as Playwright lays them out). */
export function requiredBrowserDirs(browsersJson: { browsers: Array<{ name: string; revision: string }> }): string[] {
  const rev = (n: string) => browsersJson.browsers.find((b) => b.name === n)?.revision;
  return [
    ["chromium", "chromium"],
    ["chromium-headless-shell", "chromium_headless_shell"],
  ].flatMap(([name, dir]) => (rev(name!) ? [`${dir}-${rev(name!)}`] : []));
}

/** Pure decision: is Chromium installed? `exists` answers for a path relative to the browsers dir. */
export function chromiumInstalled(required: string[], exists: (rel: string) => boolean): boolean {
  return required.length > 0 && required.every((d) => exists(path.join(d, "INSTALLATION_COMPLETE")));
}

export type EnsureResult = "present" | "installed" | "failed";

export async function ensureChromium(o: {
  browsersPath: string;
  /** Directory of the playwright-core package. */
  playwrightDir: string;
  log: (line: string) => void;
}): Promise<EnsureResult> {
  const browsersJson = JSON.parse(readFileSync(path.join(o.playwrightDir, "browsers.json"), "utf8"));
  const required = requiredBrowserDirs(browsersJson);
  if (chromiumInstalled(required, (rel) => existsSync(path.join(o.browsersPath, rel)))) return "present";
  o.log("Setting up the employees' browser: downloading Chromium (about 150 MB, once). Computer-use tasks work after this finishes.");
  const code = await new Promise<number>((resolve) => {
    const child = spawn(process.execPath, [path.join(o.playwrightDir, "cli.js"), "install", "chromium"], {
      env: { ...process.env, ELECTRON_RUN_AS_NODE: "1", PLAYWRIGHT_BROWSERS_PATH: o.browsersPath },
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    const pipe = (d: Buffer) => d.toString().split(/\r?\n/).filter((l) => l.trim() && !/^\s*\|/.test(l) && !/^\s*at /.test(l)).forEach((l) => o.log(l.trim()));
    child.stdout.on("data", pipe);
    child.stderr.on("data", pipe);
    child.on("error", (e) => {
      o.log(`Browser download could not start: ${e.message}`);
      resolve(-1);
    });
    child.on("exit", (c) => resolve(c ?? -1));
  });
  if (code === 0 && chromiumInstalled(required, (rel) => existsSync(path.join(o.browsersPath, rel)))) {
    o.log("Browser ready.");
    return "installed";
  }
  o.log("The browser download did not finish (check your internet connection). Restart Theseus to try again; tasks that need a browser will say so until then.");
  return "failed";
}
