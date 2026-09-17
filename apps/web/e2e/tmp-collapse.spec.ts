import { expect, test } from '@playwright/test';
import { AUTH_STATE } from './auth-state';

const OUT = process.env.TMP_OUT ?? 'e2e/__tmp__';
test.use({ storageState: AUTH_STATE });

test('collapsed rail geometry', async ({ page }) => {
  await page.goto('/app/analyze-by-symbol', { waitUntil: 'networkidle' });
  await page.evaluate(() => document.fonts.ready);
  await page.getByRole('button', { name: 'Collapse sidebar' }).click();
  await page.waitForTimeout(700);

  const geom = await page.evaluate(() => {
    const rail = document.querySelector('aside.nav')!.getBoundingClientRect();
    const box = (el: Element | null) => {
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { left: +r.left.toFixed(1), width: +r.width.toFixed(1), height: +r.height.toFixed(1),
               centerOffset: +((r.left + r.width / 2) - (rail.left + rail.width / 2)).toFixed(1) };
    };
    const active = document.querySelector('.nav-item[aria-current="page"]');
    return {
      rail: { left: +rail.left.toFixed(1), width: +rail.width.toFixed(1) },
      activeRow: box(active),
      activeIcon: box(active?.querySelector('mat-icon') ?? null),
      toggleBtn: box(document.querySelector('.nav-collapse')),
      toggleIcon: box(document.querySelector('.nav-collapse mat-icon')),
      avatar: box(document.querySelector('.who-mark')),
    };
  });
  console.log(JSON.stringify(geom, null, 2));
  await page.locator('aside.nav').screenshot({ path: `${OUT}/rail-collapsed.png` });
  await page.screenshot({ path: `${OUT}/shell-collapsed.png` });
  expect(Math.abs(geom.activeIcon!.centerOffset)).toBeLessThan(1.5);
  expect(Math.abs(geom.activeRow!.centerOffset)).toBeLessThan(1.5);
  expect(Math.abs(geom.avatar!.centerOffset)).toBeLessThan(1.5);
});
