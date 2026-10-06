/**
 * pnpm app       → dev: Vite dev server (live reload of the UI) + Electron
 * pnpm app:prod  → build the UI, then run Electron on the built files
 * build          → only bundle main + preload (and the UI)
 */
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build as esbuild } from "esbuild";
// Static import (vite is a devDependency of this package). A dynamic import of a
// resolved Windows path like "D:\\..." fails on Windows: ESM needs file:// URLs.
import { build as viteBuild, createServer } from "vite";

const mode = process.argv[2] ?? "dev";
const here = path.dirname(fileURLToPath(import.meta.url));
const desktop = path.resolve(here, "..");
const web = path.resolve(desktop, "../web");
const require = createRequire(import.meta.url);

async function bundle() {
  const common = { bundle: true, platform: "node", target: "node22", external: ["electron"], sourcemap: true, logLevel: "warning" };
  await Promise.all([
    // Main: ESM so modules that use import.meta.url work when bundled.
    esbuild({
      ...common,
      entryPoints: [path.join(desktop, "src/main.ts")],
      outfile: path.join(desktop, "dist/main.js"),
      format: "esm",
      // Some bundled CommonJS deps call require(); give ESM a real one.
      banner: { js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" },
    }),
    // Preload: must be CommonJS because the window runs sandboxed.
    esbuild({ ...common, entryPoints: [path.join(desktop, "src/preload.ts")], outfile: path.join(desktop, "dist/preload.cjs"), format: "cjs" }),
  ]);
}

function electron(env = {}) {
  const bin = require("electron");
  const args = [desktop];
  if (process.env.ELECTRON_NO_SANDBOX) args.push("--no-sandbox");
  const child = spawn(bin, args, { stdio: "inherit", env: { ...process.env, ...env } });
  child.on("exit", (code) => process.exit(code ?? 0));
  return child;
}

await bundle();

if (mode === "dev") {
  const server = await createServer({ root: web, configFile: path.join(web, "vite.config.ts") });
  await server.listen();
  const url = server.resolvedUrls?.local?.[0] ?? "http://localhost:5173/";
  console.log(`[theseus] UI dev server ${url}`);
  const child = electron({ THESEUS_DEV_URL: url });
  const stop = () => {
    child.kill();
    void server.close();
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
} else {
  await viteBuild({ root: web, configFile: path.join(web, "vite.config.ts"), logLevel: "warn" });
  if (mode === "prod") electron();
  else console.log("[theseus] built apps/desktop/dist and apps/web/dist");
}
