import { Injectable } from '@nestjs/common';
import { AdminPermission, Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';

/** Every permission that exists — used to grant a full set (bootstrap admin) or to validate input. */
export const ALL_ADMIN_PERMISSIONS = Object.values(AdminPermission);

/**
 * Reads/writes `AdminPermissionGrant` rows. Permissions are looked up from the database
 * on every check (see PermissionsGuard) rather than cached in the JWT, so a revoke takes
 * effect on the very next request instead of waiting out the access token's lifetime.
 *
 * Global (see admin-permissions.module.ts) because it's needed outside the admin feature
 * itself — auth.service.ts includes a user's permissions in the login/register response,
 * and users.controller.ts includes them in `GET /api/users/me` — without creating a
 * module import cycle back into AdminModule (which itself depends on UsersModule).
 */
@Injectable()
export class AdminPermissionsService {
  constructor(private readonly prisma: PrismaService) {}

  async listForUser(userId: string): Promise<AdminPermission[]> {
    const grants = await this.prisma.adminPermissionGrant.findMany({
      where: { userId },
      select: { permission: true },
    });
    return grants.map((grant) => grant.permission);
  }

  async hasAll(userId: string, required: AdminPermission[]): Promise<boolean> {
    if (required.length === 0) return true;
    const count = await this.prisma.adminPermissionGrant.count({
      where: { userId, permission: { in: required } },
    });
    return count === new Set(required).size;
  }

  /** Replaces a user's entire permission set atomically. */
  async replaceForUser(
    userId: string,
    permissions: AdminPermission[],
    grantedBy: string,
  ): Promise<void> {
    await this.prisma.$transaction([
      this.prisma.adminPermissionGrant.deleteMany({ where: { userId } }),
      this.prisma.adminPermissionGrant.createMany({
        data: permissions.map((permission) => ({
          userId,
          permission,
          grantedBy,
        })),
      }),
    ]);
  }

  async revokeAllForUser(
    userId: string,
    tx: Prisma.TransactionClient | PrismaService = this.prisma,
  ): Promise<void> {
    await tx.adminPermissionGrant.deleteMany({ where: { userId } });
  }

  /** Idempotent — used by AdminBootstrapService to keep a known email at full access. */
  async grantAll(userId: string, grantedBy: string | null): Promise<void> {
    await this.prisma.$transaction(
      ALL_ADMIN_PERMISSIONS.map((permission) =>
        this.prisma.adminPermissionGrant.upsert({
          where: { userId_permission: { userId, permission } },
          update: {},
          create: { userId, permission, grantedBy },
        }),
      ),
    );
  }
}
