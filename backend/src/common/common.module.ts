import { Global, Module } from '@nestjs/common';
import { APP_FILTER } from '@nestjs/core';
import { ScheduleModule } from '@nestjs/schedule';
import { AuditLogService } from './audit-log.service';
import { AppShutdownService } from './app-shutdown.service';
import { MetricsService } from './metrics.service';
import { MetricsMiddleware } from './metrics.middleware';
import { MetricsController } from './metrics.controller';
import { RefreshTokenCleanupService } from './refresh-token-cleanup.service';
import { PublicConfigController } from './public-config.controller';
import { SentryExceptionFilter } from './sentry-exception.filter';

/**
 * Cross-cutting production-readiness concerns that don't belong to any one feature
 * module: audit logging, HTTP metrics, scheduled cleanup, and the graceful-shutdown
 * hook. See main.ts/app.module.ts for how MetricsMiddleware and enableShutdownHooks()
 * get wired in.
 *
 * @Global() because AuditLogService in particular is meant to be called from any
 * feature module that touches security-relevant state (auth today, provider-settings
 * potentially next) — without it, every consumer would need to remember to add
 * CommonModule to its own `imports`, and forgetting to is a silent runtime-only
 * failure (Nest's DI error only surfaces when the app actually boots, not at
 * build/typecheck time, and not in unit tests that construct services manually).
 */
@Global()
@Module({
  imports: [ScheduleModule.forRoot()],
  controllers: [MetricsController, PublicConfigController],
  providers: [
    AuditLogService,
    AppShutdownService,
    MetricsService,
    MetricsMiddleware,
    RefreshTokenCleanupService,
    { provide: APP_FILTER, useClass: SentryExceptionFilter },
  ],
  exports: [AuditLogService, MetricsService, MetricsMiddleware],
})
export class CommonModule {}
