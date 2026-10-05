import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["packages/*/test/**/*.test.ts", "packs/*/test/**/*.test.ts", "apps/*/test/**/*.test.ts", "evals/test/**/*.test.ts"],
  },
});
