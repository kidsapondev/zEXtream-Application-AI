import { Module } from '@nestjs/common';
import { UsersModule } from '../users/users.module';
import { AdminAuditService } from './admin-audit.service';
import { AdminBootstrapService } from './admin-bootstrap.service';
import { AdminUsersService } from './admin-users.service';
import { AdminDashboardService } from './admin-dashboard.service';
import { PermissionsGuard } from './guards/permissions.guard';
import { AdminUsersController } from './admin-users.controller';
import { AdminDashboardController } from './admin-dashboard.controller';
import { AdminAuditLogController } from './admin-audit-log.controller';

@Module({
  imports: [UsersModule],
  controllers: [
    AdminUsersController,
    AdminDashboardController,
    AdminAuditLogController,
  ],
  providers: [
    AdminAuditService,
    AdminBootstrapService,
    AdminUsersService,
    AdminDashboardService,
    PermissionsGuard,
  ],
  // AdminBootstrapService is called from AuthService.register() so a bootstrap email
  // gets admin access immediately on sign-up, not just at next startup.
  exports: [AdminBootstrapService],
})
export class AdminModule {}
