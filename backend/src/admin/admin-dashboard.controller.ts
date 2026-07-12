import { Controller, Get, UseGuards } from '@nestjs/common';
import { AdminPermission } from '@prisma/client';
import { PermissionsGuard } from './guards/permissions.guard';
import { RequirePermissions } from './decorators/require-permissions.decorator';
import { AdminDashboardService } from './admin-dashboard.service';

@UseGuards(PermissionsGuard)
@Controller('admin/dashboard')
export class AdminDashboardController {
  constructor(private readonly dashboardService: AdminDashboardService) {}

  @RequirePermissions(AdminPermission.dashboard_view)
  @Get()
  get() {
    return this.dashboardService.getStats();
  }
}
