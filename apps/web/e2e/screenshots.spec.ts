import { expect, test, type Page } from '@playwright/test';

import { AUTH_STATE } from './auth-state';

const THEMES = ['light', 'dark'] as const;
type Theme = (typeof THEMES)[number];

const OUT = 'e2e/__screenshots__';

/**
 * Sets the theme the way the app itself does — through localStorage, which
 * ThemeService reads on construction — then asserts the real
 * html[data-theme] attribute landed. Never by patching classes on the page:
 * that would validate a code path the app does not use.
 */
async function gotoWithTheme(page: Page, path: string, theme: Theme): Promise<void> {
  await page.addInitScript(
    ([key, value]) => localStorage.setItem(key, value),
    ['chartanalyzer.theme', theme] as const,
  );
  await page.goto(path, { waitUntil: 'networkidle' });
  await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
  // Let webfonts settle so text metrics are stable between passes.
  await page.evaluate(() => document.fonts.ready);
}

async function shoot(page: Page, name: string, theme: Theme): Promise<void> {
  await page.screenshot({ path: `${OUT}/${name}.${theme}.png`, fullPage: true });
}

for (const theme of THEMES) {
  test(`01 landing — ${theme}`, async ({ page }) => {
    await gotoWithTheme(page, '/', theme);
    await shoot(page, '01-landing', theme);
  });

  test(`02 auth sign-in — ${theme}`, async ({ page }) => {
    await gotoWithTheme(page, '/login', theme);
    await shoot(page, '02-auth-signin', theme);
  });

  test(`03 auth sign-up — ${theme}`, async ({ page }) => {
    await gotoWithTheme(page, '/login', theme);
    await page.getByRole('button', { name: /need an account/i }).click();
    await shoot(page, '03-auth-signup', theme);
  });
}

/**
 * Guarded screens reuse the session saved by auth.setup.ts — a genuine
 * sign-in through the real form, just performed once.
 */
test.use({ storageState: AUTH_STATE });

async function signIn(page: Page, theme: Theme): Promise<void> {
  await gotoWithTheme(page, '/app', theme);
  await expect(page.locator('app-analyze-page')).toBeVisible();
}

for (const theme of THEMES) {
  test(`04 analyze idle — ${theme}`, async ({ page }) => {
    await signIn(page, theme);
    await expect(page.locator('.drop-zone')).toBeVisible();
    await shoot(page, '04-analyze-idle', theme);
  });

  test(`05 analyze drag-over — ${theme}`, async ({ page }) => {
    await signIn(page, theme);
    // Real dragover on the real element, so the .over branch is what renders.
    await page.locator('.drop-zone').dispatchEvent('dragover');
    await expect(page.locator('.drop-zone.over')).toBeVisible();
    await shoot(page, '05-analyze-dragover', theme);
  });

  test(`06 history — ${theme}`, async ({ page }) => {
    await signIn(page, theme);
    await page.getByRole('button', { name: 'History' }).click();
    await expect(page.locator('.trow').first()).toBeVisible();
    await shoot(page, '06-history', theme);
  });

  test(`07 analysis result — ${theme}`, async ({ page }) => {
    await signIn(page, theme);
    await page.getByRole('button', { name: 'History' }).click();
    // Newest-first puts the in-flight row on top, so pick by status rather
    // than position: the first completed analysis is the seeded RELIANCE one.
    await page.locator('.trow', { has: page.locator('.st-complete') }).first().click();
    await expect(page.locator('app-analysis-result')).toBeVisible({ timeout: 15_000 });
    await shoot(page, '07-analysis-result', theme);
  });

  test(`08 history failed row — ${theme}`, async ({ page }) => {
    await signIn(page, theme);
    await page.getByRole('button', { name: 'History' }).click();
    await page.locator('.trow', { has: page.locator('.st-failed') }).first().click();
    await expect(page.locator('.result-failed')).toBeVisible({ timeout: 15_000 });
    await shoot(page, '08-result-failed', theme);
  });

  test(`09 account & plan — ${theme}`, async ({ page }) => {
    await signIn(page, theme);
    await page.getByRole('link', { name: 'Account' }).click();
    await page.waitForURL('**/account');
    // The panel shell is visible while still loading — wait for the resolved
    // usage figure so the screenshot is not of a spinner.
    await expect(page.locator('.account-used')).toBeVisible({ timeout: 15_000 });
    await page.evaluate(() => document.fonts.ready);
    await shoot(page, '09-account', theme);
  });
}

/**
 * Quota-exhausted analyze screen. Requires the seed script to have been run
 * with --quota-full; skipped otherwise so the default suite stays green.
 */
for (const theme of THEMES) {
  test(`10 analyze quota exhausted — ${theme}`, async ({ page }) => {
    await signIn(page, theme);
    // fetchQuota resolves after ngOnInit, so the block appears asynchronously.
    const block = page.locator('.note');
    const exhausted = await block
      .waitFor({ state: 'visible', timeout: 8_000 })
      .then(() => true)
      .catch(() => false);
    test.skip(!exhausted, 'seed with --quota-full to capture this state');
    await expect(page.locator('.drop-zone.disabled')).toBeVisible();
    await shoot(page, '10-analyze-quota', theme);
  });
}
