import { Page, expect } from '@playwright/test';
import { Client } from 'pg';

/** Same DB this suite's backend webServer points at — see playwright.config.ts's BACKEND_ENV. */
const TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL ??
  'postgresql://chatapp:e2etestpassword@127.0.0.1:5455/chatapp';

/**
 * New accounts register as `role: 'guest'` (see GuestBlockGuard) and can't use chat until
 * an admin promotes them — real coverage of that activation flow itself lives in
 * `guest-activation.spec.ts`. Every other spec in this suite just needs a working,
 * already-usable account as a fixture, so `registerNewUser` promotes directly via the DB
 * rather than driving the backoffice UI every single time (mirrors the same shortcut
 * `backend/test/support/test-app.ts`'s `registerUser()` takes, for the same reason).
 */
async function promoteToUser(email: string): Promise<void> {
  const client = new Client({ connectionString: TEST_DATABASE_URL });
  await client.connect();
  try {
    await client.query("UPDATE users SET role = 'user' WHERE email = $1", [
      email,
    ]);
  } finally {
    await client.end();
  }
}

/**
 * Promotes an account to admin and grants it the given permissions — used by
 * `guest-activation.spec.ts` to get a real admin account that can drive the backoffice
 * Users page through the browser.
 */
export async function promoteToAdmin(
  email: string,
  permissions: string[],
): Promise<void> {
  const client = new Client({ connectionString: TEST_DATABASE_URL });
  await client.connect();
  try {
    const { rows } = await client.query<{ id: string }>(
      'UPDATE users SET role = $1 WHERE email = $2 RETURNING id',
      ['admin', email],
    );
    const userId = rows[0]?.id;
    if (!userId) throw new Error(`promoteToAdmin: no user found for ${email}`);
    for (const permission of permissions) {
      await client.query(
        'INSERT INTO admin_permission_grants (user_id, permission) VALUES ($1, $2)',
        [userId, permission],
      );
    }
  } finally {
    await client.end();
  }
}

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
 * form and submits it. A new account registers as `role: 'guest'` (see
 * GuestBlockGuard) and lands on /account-pending, not /chat — this helper
 * promotes it to `user` via the DB right after (see `promoteToUser`'s doc
 * comment for why that's an acceptable shortcut here) and reloads, which is
 * enough to land on /chat authenticated. This is the standard "get me a
 * logged-in, chat-capable page" fixture for tests that don't care about
 * registration or account-activation specifically — that flow has its own
 * dedicated real-browser coverage in `guest-activation.spec.ts`.
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
    const reachedPending = await page
      .waitForURL(/\/account-pending/, { timeout: 8_000 })
      .then(() => true)
      .catch(() => false);
    if (reachedPending) {
      await promoteToUser(user.email);
      await page.reload();
      await expect(page).toHaveURL(/\/chat/, { timeout: 15_000 });
      return user;
    }
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
