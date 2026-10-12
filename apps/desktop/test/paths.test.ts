import path from "node:path";
import { describe, expect, it } from "vitest";
import { chromiumInstalled, requiredBrowserDirs } from "../src/browsers.ts";
import { ENV_TEMPLATE, resolvePaths } from "../src/paths.ts";

const base = { userData: path.resolve("/u/Theseus"), resourcesPath: path.resolve("/r"), here: path.resolve("/app/dist"), repoRoot: path.resolve("/repo") };

describe("path model", () => {
  it("dev: everything stays in the repo", () => {
    const p = resolvePaths({ ...base, isPackaged: false, env: {} });
    expect(p.installed).toBe(false);
    expect(p.home).toBeUndefined();
    expect(p.assets).toBeUndefined();
    expect(p.workspace).toBe(path.join(base.repoRoot, "workspace"));
    expect(p.envFile).toBe(path.join(base.repoRoot, ".env"));
    expect(p.hostScript).toBe(path.join(base.repoRoot, "apps/server/src/host.ts"));
    expect(p.browsers).toBeUndefined();
  });

  it("packaged: assets from resources, writable things in the user data dir", () => {
    const p = resolvePaths({ ...base, isPackaged: true, env: {} });
    expect(p.installed).toBe(true);
    expect(p.assets).toBe(base.resourcesPath);
    expect(p.home).toBe(base.userData);
    expect(p.workspace).toBe(path.join(base.userData, "workspace"));
    expect(p.envFile).toBe(path.join(base.userData, ".env"));
    expect(p.browsers).toBe(path.join(base.userData, "browsers"));
    expect(p.hostScript).toBe(path.join(base.here, "host.mjs"));
    expect(p.webDist).toBe(path.join(base.here, "web"));
  });

  it("THESEUS_HOME and PLAYWRIGHT_BROWSERS_PATH override", () => {
    const home = path.resolve("/tmp/h");
    const p = resolvePaths({ ...base, isPackaged: true, env: { THESEUS_HOME: home, PLAYWRIGHT_BROWSERS_PATH: "/pw" } });
    expect(p.home).toBe(home);
    expect(p.workspace).toBe(path.join(home, "workspace"));
    expect(p.browsers).toBe("/pw");
  });
});

describe("browser install decision", () => {
  const json = { browsers: [{ name: "chromium", revision: "1194" }, { name: "chromium-headless-shell", revision: "1194" }, { name: "ffmpeg", revision: "1011" }] };
  const required = requiredBrowserDirs(json);

  it("names the directories Playwright creates", () => {
    expect(required).toEqual(["chromium-1194", "chromium_headless_shell-1194"]);
  });
  it("is installed only when every required browser has its completion marker", () => {
    const has = (set: string[]) => (rel: string) => set.map((s) => path.join(s, "INSTALLATION_COMPLETE")).includes(rel);
    expect(chromiumInstalled(required, has([]))).toBe(false);
    expect(chromiumInstalled(required, has(["chromium-1194"]))).toBe(false);
    expect(chromiumInstalled(required, has(["chromium-1194", "chromium_headless_shell-1194"]))).toBe(true);
    expect(chromiumInstalled([], () => true)).toBe(false);
  });
});

describe("settings template", () => {
  it("has the keys people need and no secrets", () => {
    for (const k of ["ANTHROPIC_API_KEY=\n", "GEMINI_API_KEY=\n", "ANTHROPIC_BUDGET_USD=12", "MODEL_PROVIDER"]) expect(ENV_TEMPLATE).toContain(k);
  });
});
