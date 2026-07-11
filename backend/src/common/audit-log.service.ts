import { Injectable } from '@nestjs/common';
import { InjectPinoLogger, PinoLogger } from 'nestjs-pino';

/**
 * Security-relevant events worth a durable, structured trail. Add new event names here
 * rather than inventing ad-hoc strings at call sites, so the set of audited events stays
 * discoverable in one place.
 */
export type AuditEvent =
  | 'auth.register'
  | 'auth.login.success'
  | 'auth.login.failure'
  | 'auth.refresh.success'
  | 'auth.refresh.reuse_detected'
  | 'auth.logout'
  | 'provider_credential.upsert'
  | 'provider_credential.remove';

export interface AuditLogFields {
  /** Actor's user id — never the email, to keep audit logs light on PII. */
  userId?: string | null;
  ipAddress?: string | null;
  outcome?: 'success' | 'failure';
  [key: string]: unknown;
}

/**
 * Structured audit trail for auth and credential-management events, emitted through the
 * same pino pipeline as the rest of the app's logs (see logger.config.ts) so it lands in
 * whatever log sink the deployment already ships to, tagged `audit: true` for easy
 * filtering/routing.
 *
 * Hard rule: never pass a password, JWT, refresh token, or API key VALUE into `fields`.
 * Only event type, actor id, request metadata, and outcome.
 */
@Injectable()
export class AuditLogService {
  constructor(
    @InjectPinoLogger(AuditLogService.name)
    private readonly logger: PinoLogger,
  ) {}

  record(event: AuditEvent, fields: AuditLogFields = {}): void {
    this.logger.info({ audit: true, event, ...fields }, event);
  }
}
