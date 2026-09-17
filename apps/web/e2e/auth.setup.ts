import { expect, test as setup } from '@playwright/test';

import { AUTH_STATE } from './auth-state';

/**
 * Signs in once through the real form and saves the session for the guarded
 * screenshot specs. No injected token and no test-only bypass — the app's own
 * auth path is what runs. The account comes from
 * scripts/seed-screenshot-user.ts.
 */
setup('authenticate', async ({ page }) => {
  await page.goto('/login', { waitUntil: 'networkidle' });
  await page.getByLabel('Email').fill('screenshots@tradesathi.dev');
  await page.locator('input#auth-password').fill('TestPassword123!');
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  // Signing in lands on bare /app, which the router redirects to the shell's
  // default tab — so the URL to wait for is the tab it resolves to.
  await page.waitForURL('**/app/analyze-by-image', { timeout: 30_000 });
  await expect(page.locator('app-analyze-page')).toBeVisible();
  await page.context().storageState({ path: AUTH_STATE });
});
