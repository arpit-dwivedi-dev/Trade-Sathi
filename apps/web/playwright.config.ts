import { defineConfig } from '@playwright/test';

/**
 * Visual-verification harness for the design pass. Screenshots only — it does
 * not assert behaviour, which stays with the vitest suite.
 *
 * `auth.setup.ts` signs in once and saves the session; the guarded specs reuse
 * it. Signing in per test tripped Supabase's auth rate limit.
 */
export default defineConfig({
  testDir: './e2e',
  fullyParallel: false,
  workers: 1,
  reporter: 'list',
  timeout: 60_000,
  use: {
    baseURL: 'http://localhost:4200',
    viewport: { width: 1280, height: 900 },
    deviceScaleFactor: 1,
  },
  projects: [
    { name: 'setup', testMatch: /auth\.setup\.ts/ },
    { name: 'screens', testMatch: /screenshots\.spec\.ts/, dependencies: ['setup'] },
  ],
  webServer: {
    command: 'pnpm start',
    url: 'http://localhost:4200',
    reuseExistingServer: true,
    timeout: 180_000,
  },
});
