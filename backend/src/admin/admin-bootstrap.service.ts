import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../prisma/prisma.service';
import { UsersService } from '../users/users.service';
import { AdminPermissionsService } from './admin-permissions.service';

/**
 * Keeps every email in BOOTSTRAP_ADMIN_EMAILS as a full-permission admin, idempotently.
 * Runs at application startup (every email that's already registered) and is also called
 * once from AuthService.register() right after a new account is created, so an email in
 * the list gets admin access immediately on sign-up rather than waiting for the next
 * restart. Intended for dev/staging test accounts — see the env var's doc comment in
 * env.validation.ts for the production caveat (this re-applies on every restart no matter
 * what the backoffice UI changed it to).
 */
@Injectable()
export class AdminBootstrapService implements OnApplicationBootstrap {
  private readonly logger = new Logger(AdminBootstrapService.name);

  constructor(
    private readonly configService: ConfigService,
    private readonly usersService: UsersService,
    private readonly prisma: PrismaService,
    private readonly permissionsService: AdminPermissionsService,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    const emails = this.configService.get<string[]>(
      'BOOTSTRAP_ADMIN_EMAILS',
      [],
    );
    for (const email of emails) {
      await this.ensureBootstrapAdmin(email);
    }
  }

  /**
   * No-op for any email not in BOOTSTRAP_ADMIN_EMAILS, and for an email that hasn't
   * registered yet — safe to call unconditionally right after registration.
   */
  async ensureBootstrapAdmin(email: string): Promise<void> {
    const emails = this.configService.get<string[]>(
      'BOOTSTRAP_ADMIN_EMAILS',
      [],
    );
    const normalized = email.trim().toLowerCase();
    if (!emails.includes(normalized)) return;

    const user = await this.usersService.findByEmail(normalized);
    if (!user) return;

    if (user.role !== 'admin') {
      await this.prisma.user.update({
        where: { id: user.id },
        data: { role: 'admin' },
      });
    }
    await this.permissionsService.grantAll(user.id, null);
    this.logger.log(`Bootstrap admin ensured for ${normalized}`);
  }
}
