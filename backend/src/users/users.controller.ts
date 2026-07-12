import { Controller, Get, NotFoundException } from '@nestjs/common';
import { UsersService } from './users.service';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import type { AuthenticatedUser } from '../auth/decorators/current-user.decorator';
import { AllowGuest } from '../auth/decorators/allow-guest.decorator';
import { AdminPermissionsService } from '../admin/admin-permissions.service';

@Controller('users')
export class UsersController {
  constructor(
    private readonly usersService: UsersService,
    private readonly adminPermissionsService: AdminPermissionsService,
  ) {}

  // A guest must be able to read their own role/permissions so the frontend can show the
  // "pending activation" screen instead of guessing — everything else stays default-denied
  // by GuestBlockGuard.
  @AllowGuest()
  @Get('me')
  async me(@CurrentUser() currentUser: AuthenticatedUser) {
    const user = await this.usersService.findById(currentUser.id);
    if (!user) {
      throw new NotFoundException('User not found');
    }
    const permissions = await this.adminPermissionsService.listForUser(user.id);
    return {
      id: user.id,
      email: user.email,
      displayName: user.displayName,
      role: user.role,
      permissions,
      createdAt: user.createdAt,
    };
  }
}
