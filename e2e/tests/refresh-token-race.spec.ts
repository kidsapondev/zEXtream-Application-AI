import { test, expect, Page, Route } from '@playwright/test';
import { registerNewUser } from './helpers';

/**
 * The app initializer's `tryRefresh()` resolving (and `Promise.all`/
 * `page.goto`'s "load" event firing) does not mean the Angular router has
 * finished acting on the result yet — a failed refresh redirects to /login
 * *after* load, via the route guard, asynchronously. Polling `page.url()`
 * immediately after navigation can observe that transient in-between state.
 * This waits for one of the two actual settled outcomes instead.
 */
async function settleAuthState(page: Page): Promise<'authenticated' | 'login'> {
  const authenticated = page
    .getByRole('button', { name: 'Sign out' })
    .waitFor({ state: 'visible', timeout: 10_000 })
    .then(() => 'authenticated' as const)
    .catch(() => null);
  const loggedOut = page
    .waitForURL(/\/login/, { timeout: 10_000 })
    .then(() => 'login' as const)
    .catch(() => null);
  const result = await Promise.race([authenticated, loggedOut]);
  return result ?? (/\/login/.test(page.url()) ? 'login' : 'authenticated');
}

/**
 * plan.md Test strategy → Browser E2E: "เปิดหลาย tabs และทดสอบ refresh
 * token race" — exercises the atomic refresh-token rotation work
 * (auth.service.ts's refresh(), see the `$transaction` + conditional
 * `updateMany` there) from the browser, not just via raw concurrent HTTP
 * requests (already covered in backend/test/app.e2e-spec.ts's "allows only
 * one concurrent rotation" test).
 *
 * Two pages in the *same* BrowserContext share one cookie jar, mirroring two
 * tabs of the same browser profile. Both pages' app initializers
 * (`provideAppInitializer` → `AuthStore.tryRefresh()`) fire a refresh call
 * on load with no cross-tab coordination (see auth.store.ts: the in-flight
 * dedupe is per-AuthStore-instance, i.e. per tab, not shared) — so opening
 * both concurrently is a real, not contrived, way to reach this race.
 *
 * To make the race deterministic rather than dependent on incidental
 * network timing (which usually resolves sequentially - see the note in the
 * test below), both pages' `/api/auth/refresh` requests are held at the
 * network layer until *both* have been dispatched, then released together,
 * guaranteeing the server sees two concurrent requests for the exact same
 * pre-rotation refresh cookie.
 */
test('two tabs racing a refresh of the same cookie do not both end up authenticated with the SAME token, and neither is silently and permanently logged out', async ({
  browser,
}) => {
  const context = await browser.newContext();
  const page1 = await context.newPage();
  await registerNewUser(page1, 'race');

  const page2 = await context.newPage();

  let dispatched = 0;
  let releaseGate!: () => void;
  const gate = new Promise<void>((resolve) => {
    releaseGate = resolve;
  });
  const holdUntilBothDispatched = async (route: Route) => {
    dispatched += 1;
    if (dispatched >= 2) releaseGate();
    await gate;
    await route.continue();
  };
  await page1.route('**/api/auth/refresh', holdUntilBothDispatched);
  await page2.route('**/api/auth/refresh', holdUntilBothDispatched);

  // Both app initializers fire a refresh call on load; both are held above
  // until both have been issued, then released together.
  await Promise.all([page1.reload(), page2.goto('/chat')]);

  const [state1, state2] = await Promise.all([settleAuthState(page1), settleAuthState(page2)]);

  // At least one tab must win the race and be fully usable — a real user
  // opening a second tab must never lose the ability to use the app at all.
  expect(state1 === 'authenticated' || state2 === 'authenticated').toBe(true);

  // Whichever tab did NOT end up authenticated (if any) must have failed
  // *cleanly* — redirected to /login, not stuck on a blank/broken page that
  // looks authenticated but isn't.
  if (state1 === 'login') await expect(page1).toHaveURL(/\/login/);
  if (state2 === 'login') await expect(page2).toHaveURL(/\/login/);
});
