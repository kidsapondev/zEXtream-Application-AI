import { Injectable, Logger, OnApplicationShutdown } from '@nestjs/common';

/**
 * Generic graceful-shutdown hook, activated by app.enableShutdownHooks() in main.ts.
 * NestJS invokes onApplicationShutdown(signal) on every provider that implements it
 * when a termination signal (SIGTERM/SIGINT) is received, before the process actually
 * exits — giving in-flight work a chance to notice and wind down instead of being cut
 * off mid-request.
 *
 * This only logs today. Actually draining in-flight AI streams needs a hook into
 * ActiveStreamRegistry (backend/src/chat/active-stream-registry.service.ts once the
 * realtime-module migration another agent is doing lands) to mark active streams as
 * interrupted and stop accepting new ones — left as a follow-up to avoid a file
 * conflict with that in-progress move. In the meantime this is not a silent data-loss
 * gap: messages.service.ts's reconcileStuckMessages() already flips any message left in
 * `streaming` status to `error` the next time its session is opened, so a restart mid-
 * stream is recovered from, just not gracefully drained ahead of time.
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
