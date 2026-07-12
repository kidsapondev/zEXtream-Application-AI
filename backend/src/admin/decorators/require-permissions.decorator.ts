import { SetMetadata } from '@nestjs/common';
import { AdminPermission } from '@prisma/client';

export const REQUIRED_PERMISSIONS_KEY = 'requiredAdminPermissions';

/** Applied per-route inside a controller already guarded by PermissionsGuard. */
export const RequirePermissions = (...permissions: AdminPermission[]) =>
  SetMetadata(REQUIRED_PERMISSIONS_KEY, permissions);
