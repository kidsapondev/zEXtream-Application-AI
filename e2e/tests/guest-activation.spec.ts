import { test, expect } from '@playwright/test';
import { uniqueUser, promoteToAdmin, loginUser } from './helpers';

/**
 * Real-browser coverage for the guest-role feature itself (plan.md Phase 8 "Guest role").
 * Deliberately does NOT use `registerNewUser`'s DB-shortcut promotion — that helper exists
 * so *other* specs can skip past activation; this spec is the one place that drives the
 * actual pending-screen -> admin-activates -> guest-can-chat flow end to end through the UI.
 *
 * The admin account here is promoted directly via `promoteToAdmin` (a DB shortcut) rather
 * than through AdminBootstrapService/another admin's UI action — that plumbing already has
 * dedicated backend coverage in `backend/test/admin.e2e-spec.ts`; this spec's job is to
 * prove the *frontend* (pending screen, backoffice Activate button, guest regaining access)
 * works, not to re-test admin provisioning itself.
 */
test('a guest sees the pending-activation screen and gains access once an admin activates them', async ({
  page,
}) => {
  const guest = uniqueUser('guest-activation');
  await page.goto('/register');
  await page.getByLabel('Name').fill(guest.displayName);
  await page.getByLabel('Email').fill(guest.email);
  await page.getByLabel('Password').fill(guest.password);
  await page.getByRole('button', { name: 'Create account' }).click();
  await expect(page).toHaveURL(/\/account-pending/, { timeout: 15_000 });
  await expect(page.getByText('กรุณาติดต่อ Admin เพื่อเปิดการใช้งาน')).toBeVisible();
  await expect(page.getByText(guest.email)).toBeVisible();

  // A guest can't reach the app directly either — the route itself redirects it straight
  // back to the pending screen instead of rendering chat.
  await page.goto('/chat');
  await expect(page).toHaveURL(/\/account-pending/, { timeout: 10_000 });

  await page.getByRole('button', { name: 'Sign out' }).click();
  await expect(page).toHaveURL(/\/login/, { timeout: 10_000 });

  const admin = uniqueUser('guest-activation-admin');
  await page.goto('/register');
  await page.getByLabel('Name').fill(admin.displayName);
  await page.getByLabel('Email').fill(admin.email);
  await page.getByLabel('Password').fill(admin.password);
  await page.getByRole('button', { name: 'Create account' }).click();
  await expect(page).toHaveURL(/\/account-pending/, { timeout: 15_000 });
  await promoteToAdmin(admin.email, ['users_view', 'users_manage_role']);
  await page.reload();
  await expect(page).toHaveURL(/\/chat/, { timeout: 15_000 });

  await page.goto('/admin/users');
  await page.getByPlaceholder('Search by email or name…').fill(guest.email);
  await page.getByRole('button', { name: 'Search' }).click();
  await expect(page.getByText(guest.email)).toBeVisible({ timeout: 10_000 });
  await page.getByRole('button', { name: 'Activate' }).click();
  // The row re-renders once the PATCH lands: a `user`-role row shows "Promote to
  // admin", not "Activate" — the clearest visible signal the role actually changed.
  await expect(page.getByRole('button', { name: 'Promote to admin' })).toBeVisible({
    timeout: 10_000,
  });

  await page.getByRole('button', { name: 'Sign out' }).click();
  await expect(page).toHaveURL(/\/login/, { timeout: 10_000 });

  await loginUser(page, guest);
  await expect(page).toHaveURL(/\/chat/, { timeout: 15_000 });
});
