import { Global, Module } from '@nestjs/common';
import { AdminPermissionsService } from './admin-permissions.service';

/**
 * Split out from AdminModule and marked @Global() so auth/users (which sit "below"
 * AdminModule in the dependency graph — AdminModule imports UsersModule, not the other
 * way around) can inject AdminPermissionsService without an import cycle. See
 * admin-permissions.service.ts for why those modules need it.
 */
@Global()
@Module({
  providers: [AdminPermissionsService],
  exports: [AdminPermissionsService],
})
export class AdminPermissionsModule {}
