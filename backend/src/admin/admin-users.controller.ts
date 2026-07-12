import {
  Body,
  Controller,
  Get,
  Param,
  Patch,
  Put,
  Query,
  UseGuards,
} from '@nestjs/common';
import { AdminPermission } from '@prisma/client';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import type { AuthenticatedUser } from '../auth/decorators/current-user.decorator';
import { DEFAULT_PAGE_SIZE } from '../chat/dto/pagination-query.dto';
import { PermissionsGuard } from './guards/permissions.guard';
import { RequirePermissions } from './decorators/require-permissions.decorator';
import { AdminUsersService } from './admin-users.service';
import { AdminUsersQueryDto } from './dto/admin-users-query.dto';
import { UpdateUserStatusDto } from './dto/update-user-status.dto';
import { UpdateUserRoleDto } from './dto/update-user-role.dto';
import { UpdateUserPermissionsDto } from './dto/update-user-permissions.dto';

@UseGuards(PermissionsGuard)
@Controller('admin/users')
export class AdminUsersController {
  constructor(private readonly adminUsersService: AdminUsersService) {}

  @RequirePermissions(AdminPermission.users_view)
  @Get()
  list(@Query() query: AdminUsersQueryDto) {
    return this.adminUsersService.list({
      search: query.query,
      take: query.limit ?? DEFAULT_PAGE_SIZE,
      skip: query.offset ?? 0,
    });
  }

  @RequirePermissions(AdminPermission.users_view)
  @Get(':id')
  getDetail(@Param('id') id: string) {
    return this.adminUsersService.getDetail(id);
  }

  @RequirePermissions(AdminPermission.users_manage_status)
  @Patch(':id/status')
  updateStatus(
    @CurrentUser() actor: AuthenticatedUser,
    @Param('id') id: string,
    @Body() dto: UpdateUserStatusDto,
  ) {
    return this.adminUsersService.updateStatus(actor.id, id, dto.isActive);
  }

  @RequirePermissions(AdminPermission.users_manage_role)
  @Patch(':id/role')
  updateRole(
    @CurrentUser() actor: AuthenticatedUser,
    @Param('id') id: string,
    @Body() dto: UpdateUserRoleDto,
  ) {
    return this.adminUsersService.updateRole(actor.id, id, dto.role);
  }

  @RequirePermissions(AdminPermission.users_manage_permissions)
  @Put(':id/permissions')
  updatePermissions(
    @CurrentUser() actor: AuthenticatedUser,
    @Param('id') id: string,
    @Body() dto: UpdateUserPermissionsDto,
  ) {
    return this.adminUsersService.updatePermissions(
      actor.id,
      id,
      dto.permissions,
    );
  }
}
