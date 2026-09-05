import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: [
      "**/node_modules/**",
      "**/dist/**",
      "**/.angular/**",
      "**/*.d.ts",
      // Agent worktrees are throwaway checkouts of this same repo. Linting
      // them reported every finding twice, against paths that do not exist on
      // any branch.
      ".claude/worktrees/**",
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

  // apps/api's golden set lives outside its build tsconfig's `include` (so the
  // build never emits fixtures), but it is real TypeScript against real types
  // and deserves the type-aware rules — so it gets its own project rather than
  // being dropped to syntactic linting.
  {
    files: ["apps/api/tests/**/*.ts"],
    languageOptions: {
      parserOptions: {
        projectService: false,
        project: ["./apps/api/tsconfig.test.json"],
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
