import { Page, expect } from '@playwright/test';

/** A fresh, collision-free identity for one test run. */
export function uniqueUser(label: string) {
  const stamp = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  return {
    email: `${label}-${stamp}@example.com`,
    password: 'BrowserE2ePassword123!',
    displayName: `${label} ${stamp}`,
  };
}

/**
 * Drives the real registration form end to end (no API shortcuts): fills the
 * form, submits, and waits for the app to land on /chat authenticated.
 * RegisterComponent auto-logs the new user in and navigates to /chat, so
 * this is also the standard "get me a logged-in page" fixture for tests
 * that don't care about the login form specifically.
 *
 * `POST /api/auth/register` is deliberately rate-limited to 3/min per IP
 * (see REGISTER_THROTTLE in auth.controller.ts — real anti-abuse policy,
 * not something this suite should work around by disabling it). Every test
 * in this project shares one backend behind one proxy IP, and the suite as
 * a whole registers more than 3 distinct users, so hitting that limit here
 * is expected, not a bug — RegisterComponent shows a generic error and
 * stays on /register when it does (see register.component.ts's catch
 * block), which is what's detected below. Retrying with a backoff comfortably
 * longer than the throttle's 60s window is the realistic, honest way to
 * keep this suite green under the same policy production traffic is held to.
 */
export async function registerNewUser(
  page: Page,
  label: string,
): Promise<ReturnType<typeof uniqueUser>> {
  const user = uniqueUser(label);
  const maxAttempts = 3;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    await page.goto('/register');
    await page.getByLabel('Name').fill(user.displayName);
    await page.getByLabel('Email').fill(user.email);
    await page.getByLabel('Password').fill(user.password);
    await page.getByRole('button', { name: 'Create account' }).click();
    const reachedChat = await page
      .waitForURL(/\/chat/, { timeout: 8_000 })
      .then(() => true)
      .catch(() => false);
    if (reachedChat) return user;
    if (attempt === maxAttempts) {
      throw new Error(
        `registerNewUser: still on ${page.url()} after ${maxAttempts} attempts (register throttle likely still active)`,
      );
    }
    await page.waitForTimeout(65_000);
  }
  return user;
}

export async function loginUser(
  page: Page,
  user: { email: string; password: string },
): Promise<void> {
  await page.goto('/login');
  await page.getByLabel('Email').fill(user.email);
  await page.getByLabel('Password').fill(user.password);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page).toHaveURL(/\/chat/, { timeout: 15_000 });
}

/** Clicks "+ New chat" and waits for the app to navigate into the freshly created session. */
export async function createNewChat(page: Page): Promise<string> {
  await page.getByRole('button', { name: 'New chat' }).click();
  await expect(page).toHaveURL(/\/chat\/[0-9a-f-]{20,}/, { timeout: 10_000 });
  const url = page.url();
  const sessionId = url.split('/chat/')[1];
  return sessionId;
}

/** Types into the composer and submits it — does not wait for any AI response. */
export async function sendComposerMessage(page: Page, text: string): Promise<void> {
  const input = page.locator('.chat-thread__composer input[name="draft"]');
  await input.fill(text);
  await page.locator('.chat-thread__composer button[type="submit"]').click();
}
