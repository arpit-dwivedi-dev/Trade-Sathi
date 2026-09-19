import { test } from '@playwright/test';
import { AUTH_STATE } from './auth-state';
test.use({ storageState: AUTH_STATE, viewport: { width: 390, height: 800 } });
test('cost note', async ({ page }) => {
  page.on('console', (m) => { if (m.type() === 'error') console.log('CONSOLE', m.text()); });
  await page.goto('/app/daily-briefing');
  await page.waitForTimeout(6000);
  console.log('URL', page.url());
  console.log('NOTE', await page.locator('.daily-briefing-cost-note').evaluateAll((els) => els.map((e) => e.outerHTML)));
  await page.screenshot({ path: process.env.OUT + '/cost.png' });
});
