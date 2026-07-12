import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { AdminPermission } from '@prisma/client';
import {
  DEFAULT_PAGE_SIZE,
  PaginationQueryDto,
} from '../chat/dto/pagination-query.dto';
import { PermissionsGuard } from './guards/permissions.guard';
import { RequirePermissions } from './decorators/require-permissions.decorator';
import { AdminAuditService } from './admin-audit.service';

@UseGuards(PermissionsGuard)
@Controller('admin/audit-log')
export class AdminAuditLogController {
  constructor(private readonly auditService: AdminAuditService) {}

  @RequirePermissions(AdminPermission.audit_log_view)
  @Get()
  list(@Query() query: PaginationQueryDto) {
    return this.auditService.list({
      take: query.limit ?? DEFAULT_PAGE_SIZE,
      skip: query.offset ?? 0,
    });
  }
}
