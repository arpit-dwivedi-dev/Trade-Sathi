import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: [
      "**/node_modules/**",
      "**/dist/**",
      "**/.angular/**",
      "**/*.d.ts",
    ],
  },

  // Plain JS (this config file, scripts) — parsed, but never type-aware.
  {
    files: ["**/*.js", "**/*.mjs", "**/*.cjs"],
    extends: [tseslint.configs.base],
  },

  // All TypeScript in the monorepo. projectService resolves the nearest
  // tsconfig per file, so apps/web (tsconfig.app.json is what covers
  // src/server.ts and src/main.server.ts), apps/web's tsconfig.spec.json,
  // apps/api and packages/shared are each parsed with their own compiler
  // options — instead of a single hardcoded project path covering only some.
  {
    files: ["**/*.ts", "**/*.mts", "**/*.cts"],
    extends: [tseslint.configs.recommendedTypeChecked],
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
  },

  // TypeScript that no tsconfig's `include` covers: the repo-level scripts,
  // and apps/web's Playwright config and e2e specs (tsconfig.app.json excludes
  // *.spec.ts and tsconfig.spec.json only covers src/). Type-aware parsing
  // would throw "was not found by the project service" on these, so they are
  // linted syntactically instead of being skipped.
  {
    files: [
      "scripts/**/*.ts",
      "apps/*/*.config.ts",
      "apps/web/e2e/**/*.ts",
    ],
    extends: [tseslint.configs.disableTypeChecked],
    languageOptions: {
      parserOptions: { projectService: false, project: false },
    },
  },
);
