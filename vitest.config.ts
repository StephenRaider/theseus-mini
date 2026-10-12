import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Many tests drive a real Chromium, a real agent host and local servers. On a slower PC (Windows, antivirus,
    // 20 test files in parallel) the 5s default is too tight and fails for no good reason.
    testTimeout: 60_000,
    hookTimeout: 60_000,
    include: ["packages/*/test/**/*.test.ts", "packs/*/test/**/*.test.ts", "apps/*/test/**/*.test.ts", "evals/test/**/*.test.ts"],
  },
});
