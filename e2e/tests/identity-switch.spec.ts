import { test, expect } from '@playwright/test';
import { registerNewUser, loginUser, createNewChat, sendComposerMessage, uniqueUser } from './helpers';

/**
 * plan.md Test strategy → Browser E2E: "Logout → login อีก user → socket
 * identity เปลี่ยนถูกต้อง" — the frontend-visible counterpart of the
 * backend-only socket identity test in websocket.e2e-spec.ts. That backend
 * test proves the WebSocket layer enforces identity; this proves the UI
 * actually reflects it too (no stale session list, no leaked chat).
 */
test('logout, then login as a different user, shows only the new user\'s own data', async ({
  page,
}) => {
  await registerNewUser(page, 'identity-a');
  const sessionId = await createNewChat(page);
  const secretText = `User A private message ${Date.now()}`;
  await sendComposerMessage(page, secretText);
  await expect(
    page.locator('.message.message--user .message__content', { hasText: secretText }),
  ).toBeVisible();

  await page.getByRole('button', { name: 'Sign out' }).click();
  await expect(page).toHaveURL(/\/login/, { timeout: 10_000 });

  const userB = uniqueUser('identity-b');
  await page.goto('/register');
  await page.getByLabel('Name').fill(userB.displayName);
  await page.getByLabel('Email').fill(userB.email);
  await page.getByLabel('Password').fill(userB.password);
  await page.getByRole('button', { name: 'Create account' }).click();
  await expect(page).toHaveURL(/\/chat/, { timeout: 15_000 });

  // A brand-new user has no sessions at all — user A's session/title/message
  // must not be visible anywhere in B's UI.
  await expect(page.locator('.session-item-row')).toHaveCount(0);
  await expect(page.getByText(secretText)).toHaveCount(0);

  // B directly navigating to A's session URL must be rejected, not shown.
  const directNav = await page.goto(`/chat/${sessionId}`);
  // The route itself renders (it's a valid app route), but the REST call to
  // load messages for a session B doesn't own must fail — assert the thread
  // never shows A's message and no crash/blank-authenticated state occurs.
  expect(directNav?.ok()).toBeTruthy();
  await expect(page.getByText(secretText)).toHaveCount(0);
});

test('a second login as the original user still sees their own chat', async ({ page }) => {
  const userA = await registerNewUser(page, 'identity-relogin');
  const sessionId = await createNewChat(page);
  const text = `Still mine ${Date.now()}`;
  await sendComposerMessage(page, text);
  await expect(
    page.locator('.message.message--user .message__content', { hasText: text }),
  ).toBeVisible();

  await page.getByRole('button', { name: 'Sign out' }).click();
  await expect(page).toHaveURL(/\/login/, { timeout: 10_000 });

  await loginUser(page, userA);
  await page.goto(`/chat/${sessionId}`);
  await expect(
    page.locator('.message.message--user .message__content', { hasText: text }),
  ).toBeVisible({ timeout: 10_000 });
});
