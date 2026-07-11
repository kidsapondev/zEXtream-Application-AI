import { ArgumentsHost, Catch, HttpException } from '@nestjs/common';
import { BaseExceptionFilter } from '@nestjs/core';
import * as Sentry from '@sentry/node';

/**
 * Reports unexpected failures to Sentry, then delegates to Nest's normal
 * exception handling (via BaseExceptionFilter) for the actual HTTP response
 * — this only adds reporting, it never changes what the client receives.
 * Sentry.captureException() is a safe no-op if Sentry.init() was never
 * called (no SENTRY_DSN configured), so this filter can always be
 * registered without any conditional wiring in app.module.ts.
 *
 * Deliberately skips routine 4xx HttpExceptions (bad login, failed
 * validation, etc.) — those are expected outcomes, not application errors,
 * and reporting every one of them would drown out the failures actually
 * worth paging someone for. REST only: NestJS's exception filters (like its
 * guards/pipes) don't reach @SubscribeMessage WebSocket handlers, a finding
 * pinned elsewhere in this codebase (see chat.gateway.ts's own comments) —
 * gateway-level Sentry reporting would need separate wiring, not added here.
 */
@Catch()
export class SentryExceptionFilter extends BaseExceptionFilter {
  catch(exception: unknown, host: ArgumentsHost) {
    const isExpectedHttpError =
      exception instanceof HttpException && exception.getStatus() < 500;
    if (!isExpectedHttpError) {
      Sentry.captureException(exception);
    }
    super.catch(exception, host);
  }
}
