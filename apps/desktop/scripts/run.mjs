/**
 * pnpm app       → dev: Vite dev server (live reload of the UI) + Electron
 * pnpm app:prod  → build the UI, then run Electron on the built files
 * build          → only bundle main + preload (and the UI)
 * dist           → what electron-builder packages: main + preload + the agent host (host.mjs) + the UI
 */
import { spawn } from "node:child_process";
import { cp, readFile, rm } from "node:fs/promises";
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
  // playwright-core cannot be bundled (it loads optional parts at runtime); the main process never needs it anyway.
  const common = { bundle: true, platform: "node", target: "node22", external: ["electron", "playwright-core", "chromium-bidi", "chromium-bidi/*"], sourcemap: true, logLevel: "warning" };
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

/**
 * The agent host as ONE file, so the installed app needs neither tsx nor the repo.
 * playwright-core (and its optional chromium-bidi) can't be bundled: they ship as a package.
 */
async function bundleHost() {
  const root = path.resolve(desktop, "../..");
  await esbuild({
    entryPoints: [path.join(root, "apps/server/src/host.ts")],
    outfile: path.join(desktop, "dist/host.mjs"),
    bundle: true,
    platform: "node",
    target: "node22",
    format: "esm",
    sourcemap: true,
    logLevel: "warning",
    external: ["electron", "playwright-core", "chromium-bidi", "chromium-bidi/*"],
    banner: { js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" },
    plugins: [
      {
        // validators/ifsc.ts loads its data with createRequire(import.meta.url)("ifsc/src/*.json");
        // turn those into static imports so the data is inside the bundle.
        name: "inline-ifsc-json",
        setup(b) {
          b.onLoad({ filter: /validators[\\/]ifsc\.ts$/ }, async (args) => {
            let src = await readFile(args.path, "utf8");
            const imports = [];
            src = src.replace(/require\("(ifsc\/src\/[\w.]+\.json)"\)/g, (_m, spec) => {
              const id = `__ifsc_${imports.length}`;
              imports.push(`import ${id} from ${JSON.stringify(spec)};`);
              return id;
            });
            src = src.replace("const require = createRequire(import.meta.url);", "");
            return { contents: `${imports.join("\n")}\n${src}`, loader: "ts", resolveDir: path.dirname(args.path) };
          });
        },
      },
    ],
  });
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
if (mode === "dist") await bundleHost();

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
  else if (mode === "dist") {
    // electron-builder only packages files under apps/desktop: put the built UI in dist/web.
    await rm(path.join(desktop, "dist/web"), { recursive: true, force: true });
    await cp(path.join(web, "dist"), path.join(desktop, "dist/web"), { recursive: true });
    // playwright-core is external to the host bundle: ship the real package next to it (dereferenced from pnpm).
    const pw = path.dirname(require.resolve("playwright-core/package.json"));
    await rm(path.join(desktop, "dist/node_modules"), { recursive: true, force: true });
    await cp(pw, path.join(desktop, "dist/node_modules/playwright-core"), { recursive: true, dereference: true });
    console.log("[theseus] built dist/ (main, preload, host.mjs, web)");
  }
  else console.log("[theseus] built apps/desktop/dist and apps/web/dist");
}
