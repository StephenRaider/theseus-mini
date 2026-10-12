/**
 * ONE place that decides where things live.
 *
 *   dev (pnpm app)         everything under the repo, exactly as before.
 *   installed (packaged)   read-only assets ship in <resources>/ (THESEUS_ASSETS);
 *                          writable things live in the per-user data dir (THESEUS_HOME,
 *                          %APPDATA%/Theseus on Windows): .env, workspace/, .theseus/ logs
 *                          and spend, browsers/.
 *
 * THESEUS_HOME set in the environment always wins (tests, smoke runs, portable use).
 */
import path from "node:path";

export interface AppPaths {
  /** True when running as an installed/packaged app (or THESEUS_HOME was given). */
  installed: boolean;
  /** Writable per-user dir; undefined in dev (the repo is used). */
  home?: string;
  /** Read-only assets dir (contains packs/…); undefined in dev. */
  assets?: string;
  /** The Kaveri workspace folder. */
  workspace: string;
  /** Playwright browsers dir to use (an externally set PLAYWRIGHT_BROWSERS_PATH wins). */
  browsers?: string;
  /** The .env file the agent host reads. */
  envFile: string;
  /** The built UI. */
  webDist: string;
  /** The agent host entry. */
  hostScript: string;
}

export function resolvePaths(i: { isPackaged: boolean; userData: string; resourcesPath: string; here: string; repoRoot: string; env: NodeJS.ProcessEnv }): AppPaths {
  const home = i.env.THESEUS_HOME ?? (i.isPackaged ? i.userData : undefined);
  const installed = i.isPackaged || !!i.env.THESEUS_HOME;
  const workspace = i.env.THESEUS_WORKSPACE ?? i.env.KAVERI_WORKSPACE ?? path.join(home ?? i.repoRoot, "workspace");
  const assets = i.env.THESEUS_ASSETS ?? (i.isPackaged ? i.resourcesPath : undefined);
  const browsers = i.env.PLAYWRIGHT_BROWSERS_PATH ?? (home && installed ? path.join(home, "browsers") : undefined);
  return {
    installed,
    ...(home ? { home } : {}),
    ...(assets ? { assets } : {}),
    workspace,
    ...(browsers ? { browsers } : {}),
    envFile: path.join(home ?? i.repoRoot, ".env"),
    // Packaged: the UI is copied into dist/web by scripts/run.mjs dist. Dev: apps/web/dist.
    webDist: i.isPackaged ? path.join(i.here, "web") : path.resolve(i.here, "../../web/dist"),
    hostScript: i.isPackaged ? path.join(i.here, "host.mjs") : path.join(i.repoRoot, "apps/server/src/host.ts"),
  };
}

/** What a new .env contains. Same comments as .env.example. */
export const ENV_TEMPLATE = `# Theseus settings. Save this file, then use Settings > Restart agent in the menu.
# Put ONE key below to go live; with no key Theseus runs in demo mode (scripted answers, real tools).
ANTHROPIC_API_KEY=
GEMINI_API_KEY=

# Which provider the employees use: gemini | anthropic. Leave commented to use whichever key is set.
# MODEL_PROVIDER=anthropic

# Claude (ANTHROPIC_API_KEY above).
# Spend cap in US dollars for the whole project: calls stop at this total (kept in .theseus/anthropic-spend.json).
ANTHROPIC_BUDGET_USD=12
# Optional overrides: main model (route/plan/operate/verify) and small model (triage/summaries).
# ANTHROPIC_MODEL=claude-sonnet-5-5
# ANTHROPIC_MODEL_SMALL=claude-haiku-5-5
# Set to "off" to disable the server-side refusal fallback.
# ANTHROPIC_FALLBACK=on

# Gemini model and free-tier limits (requests per minute / per day)
# GEMINI_MODEL=gemini-3.5-flash-lite
# GEMINI_RPM=15
# GEMINI_RPD=500
`;
