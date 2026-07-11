import { Injectable, Logger, OnApplicationShutdown } from '@nestjs/common';

/**
 * Generic graceful-shutdown hook, activated by app.enableShutdownHooks() in main.ts.
 * NestJS invokes onApplicationShutdown(signal) on every provider that implements it
 * when a termination signal (SIGTERM/SIGINT) is received, before the process actually
 * exits — giving in-flight work a chance to notice and wind down instead of being cut
 * off mid-request. This is intentionally a plain logger, not a place that reaches into
 * feature-specific state: ActiveStreamRegistry
 * (backend/src/chat/active-stream-registry.service.ts) implements the same interface
 * itself to abort in-flight AI streams on shutdown, so that concern lives with the
 * registry rather than being injected here across a module boundary. Nest calls every
 * onApplicationShutdown implementation independently — there's no ordering dependency
 * between this and the registry's own hook.
 */
@Injectable()
export class AppShutdownService implements OnApplicationShutdown {
  private readonly logger = new Logger(AppShutdownService.name);

  onApplicationShutdown(signal?: string): void {
    this.logger.log(
      `Received shutdown signal (${signal ?? 'unknown'}); beginning graceful shutdown`,
    );
  }
}
