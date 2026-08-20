import { defineConfig } from "vitest/config";
import path from "path";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts", "lib/**/*.test.ts"],
    exclude: ["lib/**/__oos-measure.test.ts"],
    environment: "node",
    // 2026-08-20: raised from the 5s default. tests/markets-overview.test.ts
    // dynamically imports a route inside the test body, and under full-suite
    // parallel load (232 files) that module resolution alone exceeded 5s — the
    // same test passes in isolation every time. It flaked on four separate runs
    // today, each costing a rerun and, worse, teaching us to shrug at a red
    // suite. This is module-load latency, not slow assertions, so a higher
    // ceiling costs nothing when tests are healthy and removes a false signal.
    testTimeout: 20_000,
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "."),
    },
  },
});
