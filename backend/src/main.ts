import { NestFactory } from '@nestjs/core';
import { ValidationPipe } from '@nestjs/common';
import { NestExpressApplication } from '@nestjs/platform-express';
import { ConfigService } from '@nestjs/config';
import cookieParser from 'cookie-parser';
import helmet from 'helmet';
import { Logger } from 'nestjs-pino';
import { AppModule } from './app.module';

// Explicit REST body-size cap. Express/body-parser's own default is ~100kb, which is
// undocumented-by-omission and easy to accidentally outgrow; chat messages and artifact
// edits go over WebSocket, not REST, so REST DTOs here are small (auth payloads, session
// titles, provider-key upserts) — 256kb is generous headroom for those while still
// blocking someone from POSTing a multi-MB body at a JSON endpoint that never needs one.
const REST_BODY_SIZE_LIMIT = '256kb';

async function bootstrap() {
  // bufferLogs holds any Logger.log() calls made during bootstrap (before the pino
  // logger below is attached) instead of dropping them, then flushes them through pino
  // once useLogger() runs.
  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    bufferLogs: true,
  });
  app.useLogger(app.get(Logger));

  const configService = app.get(ConfigService);

  // Only trust proxy headers (X-Forwarded-For) when explicitly configured with the
  // number of hops in front of the app; 0 means no proxy is trusted, so req.ip stays
  // the raw socket address and can't be spoofed via headers.
  const trustProxy = configService.get<number>('TRUST_PROXY', 0);
  if (trustProxy > 0) {
    app.set('trust proxy', trustProxy);
  }

  app.setGlobalPrefix('api');
  app.use(cookieParser());

  app.use(
    helmet({
      // This process only ever returns JSON (API responses) or plain text (the
      // /api/metrics scrape endpoint) — it never serves the frontend's HTML, so CSP has
      // little surface here (a JSON body can't execute a <script> tag). The teeth are
      // in frontend/nginx.conf, which serves the actual SPA HTML/JS including Monaco.
      // Still set a conservative default-deny CSP for defense in depth (e.g. Nest's own
      // error pages, or any future HTML response), and keep Helmet's other defaults
      // (X-Content-Type-Options, X-Frame-Options, Referrer-Policy, etc.) — those apply
      // regardless of content type and cost nothing to also set on the API origin.
      contentSecurityPolicy: {
        directives: {
          defaultSrc: ["'self'"],
          scriptSrc: ["'none'"],
          styleSrc: ["'none'"],
          imgSrc: ["'none'"],
          connectSrc: ["'none'"],
          objectSrc: ["'none'"],
          baseUri: ["'none'"],
          frameAncestors: ["'none'"],
        },
      },
    }),
  );

  // Explicit allowlist instead of reflecting/accepting any origin. An empty allowlist
  // (the production default — nginx serves frontend+backend same-origin, so no
  // cross-origin browser requests are expected) disables CORS outright rather than
  // falling back to "allow everything", which is what passing `origin: undefined`
  // through to the underlying `cors` package would otherwise do.
  const corsOrigins = configService.get<string[]>('CORS_ORIGIN', []);
  app.enableCors({
    origin: corsOrigins.length > 0 ? corsOrigins : false,
    credentials: true,
  });

  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    }),
  );

  app.useBodyParser('json', { limit: REST_BODY_SIZE_LIMIT });
  app.useBodyParser('urlencoded', {
    limit: REST_BODY_SIZE_LIMIT,
    extended: true,
  });

  // Lets NestJS run onModuleDestroy/onApplicationShutdown lifecycle hooks (see
  // AppShutdownService) on SIGTERM/SIGINT instead of the process just dying — required
  // for any graceful-shutdown behavior to run at all under Docker's `docker stop`.
  app.enableShutdownHooks();

  await app.listen(process.env.PORT ?? 3000);
}
void bootstrap();
