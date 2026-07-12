import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { AdminPermission } from '@prisma/client';
import type { AuthenticatedUser } from '../../auth/decorators/current-user.decorator';
import { UsersService } from '../../users/users.service';
import { AdminPermissionsService } from '../admin-permissions.service';
import { REQUIRED_PERMISSIONS_KEY } from '../decorators/require-permissions.decorator';

/**
 * Runs after the global JwtAuthGuard (so `request.user` is already populated) on every
 * route in the admin controllers. Role and permissions are both re-read from the database
 * on every request rather than trusted from the JWT — see AdminPermissionsService's doc
 * comment for why (a revoked permission or a demotion must take effect immediately, not
 * after the access token expires).
 */
@Injectable()
export class PermissionsGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly usersService: UsersService,
    private readonly permissionsService: AdminPermissionsService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const required =
      this.reflector.getAllAndOverride<AdminPermission[]>(
        REQUIRED_PERMISSIONS_KEY,
        [context.getHandler(), context.getClass()],
      ) ?? [];

    const request = context
      .switchToHttp()
      .getRequest<{ user?: AuthenticatedUser }>();
    const currentUser = request.user;
    if (!currentUser) {
      throw new ForbiddenException('Admin access required');
    }

    const dbUser = await this.usersService.findById(currentUser.id);
    if (!dbUser || !dbUser.isActive || dbUser.role !== 'admin') {
      throw new ForbiddenException('Admin access required');
    }

    if (required.length === 0) return true;

    const hasAll = await this.permissionsService.hasAll(
      currentUser.id,
      required,
    );
    if (!hasAll) {
      throw new ForbiddenException(
        'Missing required permission for this action',
      );
    }
    return true;
  }
}
