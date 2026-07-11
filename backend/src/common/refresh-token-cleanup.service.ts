import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { PrismaService } from '../prisma/prisma.service';

// How long to keep expired/revoked refresh-token rows around before purging them —
// long enough to be useful if someone needs to investigate a reported token-theft
// incident after the fact (reuse detection revokes a whole token family; those rows are
// the forensic trail for "which sessions did this affect"), short enough that the table
// doesn't grow forever. Not exposed via env for now; bump this constant if a different
// retention window is needed.
const RETENTION_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

/**
 * Periodic sweep for the "refresh tokens accumulate forever" gap: rotation/reuse
 * detection already revoke rows (see auth.service.ts) but never delete them. Runs daily
 * rather than on every request since this is pure housekeeping with no user-facing
 * latency to protect.
 */
@Injectable()
export class RefreshTokenCleanupService {
  private readonly logger = new Logger(RefreshTokenCleanupService.name);

  constructor(private readonly prisma: PrismaService) {}

  @Cron(CronExpression.EVERY_DAY_AT_3AM)
  async cleanupStaleTokens(): Promise<void> {
    const cutoff = new Date(Date.now() - RETENTION_MS);
    const result = await this.prisma.refreshToken.deleteMany({
      where: {
        OR: [{ expiresAt: { lt: cutoff } }, { revokedAt: { lt: cutoff } }],
      },
    });
    if (result.count > 0) {
      this.logger.log(`Purged ${result.count} stale refresh token row(s)`);
    }
  }
}
