import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { AuthenticatedUser } from '../decorators/current-user.decorator';
import { IS_PUBLIC_KEY } from '../decorators/public.decorator';
import { ALLOW_GUEST_KEY } from '../decorators/allow-guest.decorator';
import { UsersService } from '../../users/users.service';

/**
 * Default-deny for the `guest` role: a freshly registered account can authenticate (so the
 * frontend can show it a "contact an admin" screen) but cannot touch any REST resource
 * until an admin promotes it to `user` or `admin` via the backoffice. `@Public()` routes are
 * skipped (no `request.user` to check), and `@AllowGuest()` opts a specific route back in
 * (just `GET /api/users/me` today).
 *
 * Registered as a global APP_GUARD in AuthModule, running after JwtAuthGuard so
 * `request.user` is already populated. Re-reads role from the database on every request
 * (same rationale as PermissionsGuard) rather than trusting the JWT, so a just-approved
 * account works immediately instead of waiting out the access token's lifetime.
 */
@Injectable()
export class GuestBlockGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly usersService: UsersService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) return true;

    const isAllowedForGuests = this.reflector.getAllAndOverride<boolean>(
      ALLOW_GUEST_KEY,
      [context.getHandler(), context.getClass()],
    );
    if (isAllowedForGuests) return true;

    const request = context
      .switchToHttp()
      .getRequest<{ user?: AuthenticatedUser }>();
    const currentUser = request.user;
    if (!currentUser) return true;

    const dbUser = await this.usersService.findById(currentUser.id);
    if (dbUser?.role === 'guest') {
      throw new ForbiddenException(
        'Your account is pending activation. Please contact an admin.',
      );
    }
    return true;
  }
}
