import { SetMetadata } from '@nestjs/common';

export const ALLOW_GUEST_KEY = 'allowGuest';

/**
 * Opts a route out of GuestBlockGuard's default-deny. Only `GET /api/users/me` needs this
 * today — a freshly registered guest still needs to read their own role/permissions so the
 * frontend can show the "pending activation" screen instead of guessing from a stale value.
 */
export const AllowGuest = () => SetMetadata(ALLOW_GUEST_KEY, true);
