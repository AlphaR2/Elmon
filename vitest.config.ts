import { defineConfig } from "vitest/config";
import path from "node:path";

export default defineConfig({
  resolve: {
    alias: {
      "@": path.resolve(import.meta.dirname, "."),
      // Next maps "server-only" itself; outside Next (tests) it is an empty module.
      "server-only": path.resolve(import.meta.dirname, "test/stubs/server-only.ts"),
    },
  },
  test: {
    include: ["test/**/*.test.ts"],
    environment: "node",
    // Each test file boots its own in-process Postgres (PGlite, WebAssembly). With every file starting at once
    // the first boot can take 10-20 s on a laptop; give hooks and tests room so that is not read as a failure.
    hookTimeout: 60_000,
    // Each worker holds a WebAssembly Postgres; too many at once can exhaust memory and crash workers.
    maxWorkers: 2,
    testTimeout: 60_000,
  },
});
