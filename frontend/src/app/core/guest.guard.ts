import { inject } from '@angular/core';
import { Router, type CanMatchFn } from '@angular/router';
import { AuthStore } from './auth.store';

/**
 * Applied alongside `authGuard` on every route that requires an activated account (chat,
 * settings, admin). A guest is authenticated (so `authGuard` alone would let it through)
 * but hasn't been promoted to `user`/`admin` yet — redirect it to `/account-pending`
 * instead of letting it hit a 403 from the backend's own GuestBlockGuard.
 */
export const guestGuard: CanMatchFn = () => {
  const authStore = inject(AuthStore);
  const router = inject(Router);

  if (!authStore.isGuest()) {
    return true;
  }

  return router.createUrlTree(['/account-pending']);
};

/** The inverse, applied to `/account-pending` itself: an already-activated account has no
 * reason to see that page — send it back to the app instead of leaving it stranded there. */
export const onlyGuestGuard: CanMatchFn = () => {
  const authStore = inject(AuthStore);
  const router = inject(Router);

  if (authStore.isGuest()) {
    return true;
  }

  return router.createUrlTree(['/chat']);
};
