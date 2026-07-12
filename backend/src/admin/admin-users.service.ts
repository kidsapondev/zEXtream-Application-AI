import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { AdminPermission, Prisma, UserRole } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { AdminPermissionsService } from './admin-permissions.service';
import { AdminAuditService } from './admin-audit.service';

const USER_SELECT = {
  id: true,
  email: true,
  displayName: true,
  role: true,
  isActive: true,
  createdAt: true,
} satisfies Prisma.UserSelect;

@Injectable()
export class AdminUsersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly permissionsService: AdminPermissionsService,
    private readonly auditService: AdminAuditService,
  ) {}

  async list(params: { search?: string; take: number; skip: number }) {
    const where: Prisma.UserWhereInput = params.search
      ? {
          OR: [
            { email: { contains: params.search, mode: 'insensitive' } },
            { displayName: { contains: params.search, mode: 'insensitive' } },
          ],
        }
      : {};
    const [total, users] = await Promise.all([
      this.prisma.user.count({ where }),
      this.prisma.user.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        take: params.take,
        skip: params.skip,
        select: USER_SELECT,
      }),
    ]);
    return { total, users };
  }

  async getDetail(userId: string) {
    const user = await this.findOrThrow(userId);
    const permissions = await this.permissionsService.listForUser(userId);
    return { ...user, permissions };
  }

  async updateStatus(actorId: string, targetId: string, isActive: boolean) {
    this.assertNotSelf(actorId, targetId);
    const user = await this.findOrThrow(targetId);
    const updated = await this.prisma.user.update({
      where: { id: targetId },
      data: { isActive },
      select: USER_SELECT,
    });
    await this.auditService.record({
      actorUserId: actorId,
      targetUserId: targetId,
      action: 'user_status_changed',
      detail: { from: user.isActive, to: isActive },
    });
    return updated;
  }

  async updateRole(actorId: string, targetId: string, role: UserRole) {
    this.assertNotSelf(actorId, targetId);
    const user = await this.findOrThrow(targetId);
    const updated = await this.prisma.$transaction(async (tx) => {
      const next = await tx.user.update({
        where: { id: targetId },
        data: { role },
        select: USER_SELECT,
      });
      // Demoting to a plain user must also strip any lingering permission grants —
      // otherwise re-promoting later would silently resurrect the old permission set.
      if (role === 'user') {
        await this.permissionsService.revokeAllForUser(targetId, tx);
      }
      return next;
    });
    await this.auditService.record({
      actorUserId: actorId,
      targetUserId: targetId,
      action: 'user_role_changed',
      detail: { from: user.role, to: role },
    });
    return updated;
  }

  async updatePermissions(
    actorId: string,
    targetId: string,
    permissions: AdminPermission[],
  ) {
    this.assertNotSelf(actorId, targetId);
    const user = await this.findOrThrow(targetId);
    if (user.role !== 'admin') {
      throw new BadRequestException(
        'Only users with the admin role can hold backoffice permissions',
      );
    }
    const before = await this.permissionsService.listForUser(targetId);
    await this.permissionsService.replaceForUser(
      targetId,
      permissions,
      actorId,
    );
    await this.auditService.record({
      actorUserId: actorId,
      targetUserId: targetId,
      action: 'user_permissions_changed',
      detail: { from: before, to: permissions },
    });
    return { permissions };
  }

  private assertNotSelf(actorId: string, targetId: string): void {
    if (actorId === targetId) {
      throw new BadRequestException(
        'You cannot change your own status, role, or permissions',
      );
    }
  }

  private async findOrThrow(userId: string) {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: USER_SELECT,
    });
    if (!user) {
      throw new NotFoundException('User not found');
    }
    return user;
  }
}
