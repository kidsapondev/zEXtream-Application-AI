import { Controller, Get } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Public } from '../auth/decorators/public.decorator';

interface PublicConfigResponse {
  sentryDsn: string | null;
  sentryEnvironment: string;
}

/**
 * Non-secret runtime config the frontend needs before it can do anything
 * else useful — today just whether/where to report errors. A Sentry
 * browser DSN is meant to be public (it's embedded in client-side JS by
 * design, unlike an API key), so serving it here is standard practice, not
 * a leak. Never add anything actually secret to this endpoint.
 */
@Controller('config')
export class PublicConfigController {
  constructor(private readonly configService: ConfigService) {}

  @Public()
  @Get()
  get(): PublicConfigResponse {
    // Deliberately `||`, not `??`: ConfigService.get() falls back to the raw
    // process.env value for any key that resolves to undefined in the
    // validated config, and docker-compose.yml passes SENTRY_DSN/
    // SENTRY_ENVIRONMENT through as `${VAR:-}` — an empty string, not truly
    // absent, whenever the corresponding .env var is unset. `??` only
    // catches null/undefined, so it would let that empty string through as
    // a "configured" (but blank) DSN; `||` also treats it as not configured,
    // which is what "unset" actually means here (confirmed live: without
    // this fix, GET /api/config returned {"sentryDsn":"",...} instead of
    // {"sentryDsn":null,...} against the real docker-compose stack).
    const sentryDsn = this.configService.get<string>('SENTRY_DSN');
    const sentryEnvironment = this.configService.get<string>(
      'SENTRY_ENVIRONMENT',
    );
    return {
      sentryDsn: sentryDsn || null,
      sentryEnvironment:
        sentryEnvironment || this.configService.get<string>('NODE_ENV', 'development'),
    };
  }
}
