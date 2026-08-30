import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Globals on, matching apps/web (whose tsconfig.spec.json already declares
    // "vitest/globals"), so describe/it/expect need no per-file import.
    globals: true,
    environment: "node",
    include: ["src/**/*.{test,spec}.ts"],
    // No API tests exist yet; an empty suite is a pass, not a failure.
    passWithNoTests: true,
  },
});
