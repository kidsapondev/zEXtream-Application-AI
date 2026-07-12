import { inject } from '@angular/core';
import { Router, type CanMatchFn } from '@angular/router';
import { AuthStore } from './auth.store';

/**
 * Gates `/admin/*` on role alone (not specific permissions) — a logged-in non-admin is
 * redirected to `/chat` rather than `/login`, since they're authenticated already, just
 * not authorized. Individual admin pages additionally check their own specific permission
 * (see admin.store.ts consumers) and render an inline "no access" state, matching Phase 3's
 * existing convention of handling access/empty/error states inside the component rather
 * than multiplying router guards per permission.
 */
export const adminGuard: CanMatchFn = () => {
  const authStore = inject(AuthStore);
  const router = inject(Router);

  if (authStore.isAdmin()) {
    return true;
  }

  return router.createUrlTree(['/chat']);
};
