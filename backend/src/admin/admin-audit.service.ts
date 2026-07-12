import { Injectable } from '@nestjs/common';
import { AdminAuditAction, Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';

export interface RecordAdminAuditParams {
  actorUserId: string;
  targetUserId?: string | null;
  action: AdminAuditAction;
  detail: Record<string, unknown>;
}

/**
 * DB-backed audit trail for actions taken *through the backoffice* (role/status/permission
 * changes), separate from the existing pino-only AuditLogService (backend/src/common) which
 * covers auth/provider-credential events. That one has no queryable store; this one exists
 * specifically so the audit-log backoffice page has something to list.
 */
@Injectable()
export class AdminAuditService {
  constructor(private readonly prisma: PrismaService) {}

  record(params: RecordAdminAuditParams) {
    return this.prisma.adminAuditLogEntry.create({
      data: {
        actorUserId: params.actorUserId,
        targetUserId: params.targetUserId ?? null,
        action: params.action,
        detail: params.detail as Prisma.InputJsonValue,
      },
    });
  }

  async list(pagination: { take: number; skip: number }) {
    const [total, entries] = await Promise.all([
      this.prisma.adminAuditLogEntry.count(),
      this.prisma.adminAuditLogEntry.findMany({
        orderBy: { createdAt: 'desc' },
        take: pagination.take,
        skip: pagination.skip,
        include: {
          actor: { select: { id: true, email: true, displayName: true } },
          target: { select: { id: true, email: true, displayName: true } },
        },
      }),
    ]);
    return { total, entries };
  }
}
