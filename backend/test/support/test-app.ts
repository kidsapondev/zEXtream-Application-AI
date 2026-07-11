import { INestApplication, ValidationPipe } from '@nestjs/common';
import { NestExpressApplication } from '@nestjs/platform-express';
import { Test, TestingModule } from '@nestjs/testing';
import cookieParser from 'cookie-parser';
import request, { Response } from 'supertest';
import { App } from 'supertest/types';
import type { AddressInfo } from 'net';
import { AppModule } from '../../src/app.module';
import { PrismaService } from '../../src/prisma/prisma.service';

/**
 * `INestApplication<App>` (the public type every e2e file uses) doesn't
 * expose Express-specific methods like `.set()` — only `NestExpressApplication`
 * does. `createE2eApp()` always actually builds a `NestExpressApplication`
 * under the hood (see main.ts, which does the same), so this narrow cast
 * (confined to this one call site, not the public API) is accurate, not a
 * type-safety hole.
 */
function asExpressApp(app: INestApplication<App>): NestExpressApplication {
  return app as unknown as NestExpressApplication;
}

/**
 * Shared e2e app bootstrap, mirroring backend/src/main.ts's bootstrap() (global
 * prefix, cookie parsing, the same ValidationPipe options) minus the parts that
 * don't apply to an in-process test app (Helmet/CORS/body-size limits/shutdown
 * hooks — none of those are under test here and skipping them keeps every e2e
 * spec file's app construction identical and boring).
 *
 * `trust proxy` is enabled unconditionally (unlike main.ts, which only trusts it
 * when TRUST_PROXY > 0) so e2e specs can hand each simulated "user" a distinct
 * X-Forwarded-For via `registerUser`/`nextTestIp` and exercise the real
 * per-route throttles (register: 3/min, login: 5/min, refresh: 20/min — see
 * auth.controller.ts) without different tests in the same file tripping each
 * other's rate limit. This is the same mechanism a real multi-user deployment
 * behind a reverse proxy relies on, not a bypass of the throttle itself — tests
 * that want to *prove* same-IP throttling still works can simply omit the ip
 * override (or reuse one explicitly).
 */
export async function createE2eApp(): Promise<{
  app: INestApplication<App>;
  prisma: PrismaService;
}> {
  const moduleFixture: TestingModule = await Test.createTestingModule({
    imports: [AppModule],
  }).compile();

  const app = moduleFixture.createNestApplication<INestApplication<App>>();
  app.setGlobalPrefix('api');
  app.use(cookieParser());
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    }),
  );
  asExpressApp(app).set('trust proxy', true);
  await app.init();
  const prisma = app.get(PrismaService);
  return { app, prisma };
}

export interface RegisteredUser {
  user: { id: string; email: string };
  accessToken: string;
  refreshCookie: string;
}

/** Extracts just the `name=value` pair (no attributes) from a Set-Cookie response header. */
export function cookieFrom(response: Response): string {
  const headers = response.headers as unknown as Record<
    string,
    string | string[] | undefined
  >;
  const header = headers['set-cookie'];
  let cookie: unknown = header;
  if (Array.isArray(header)) {
    for (const value of header) {
      if (typeof value === 'string') {
        cookie = value;
        break;
      }
    }
  }
  if (typeof cookie !== 'string') {
    throw new Error('Response did not set a refresh cookie');
  }
  const separator = cookie.indexOf(';');
  return separator >= 0 ? cookie.slice(0, separator) : cookie;
}

let ipCounter = 0;

/** A fresh, deterministic private-range IP for each call — see createE2eApp's doc comment. */
export function nextTestIp(): string {
  ipCounter += 1;
  return `10.${(ipCounter >> 16) & 255}.${(ipCounter >> 8) & 255}.${ipCounter & 255}`;
}

export async function registerUser(
  app: INestApplication<App>,
  label: string,
  opts: { ip?: string; password?: string } = {},
): Promise<RegisteredUser> {
  const email = `${label}-${Date.now()}-${Math.random().toString(16).slice(2)}@example.com`;
  const password = opts.password ?? 'IntegrationPassword123!';
  const response = await request(app.getHttpServer())
    .post('/api/auth/register')
    .set('X-Forwarded-For', opts.ip ?? nextTestIp())
    .send({ email, password, displayName: label })
    .expect(201);
  const body = response.body as {
    user: { id: string; email: string };
    accessToken: string;
  };
  return { ...body, refreshCookie: cookieFrom(response) };
}

export async function loginUser(
  app: INestApplication<App>,
  email: string,
  password: string,
  opts: { ip?: string } = {},
): Promise<Response> {
  return request(app.getHttpServer())
    .post('/api/auth/login')
    .set('X-Forwarded-For', opts.ip ?? nextTestIp())
    .send({ email, password });
}

/**
 * Starts the app listening on a random free port and returns its base URL
 * (`http://127.0.0.1:PORT`). Needed for real Socket.IO integration tests —
 * `app.getHttpServer()` alone (what supertest drives REST calls through)
 * never actually binds a port, and socket.io-client needs a real URL to
 * connect to. Safe to call after `createE2eApp()`: Nest's `listen()` reuses
 * the already-`init()`-ed application instead of re-initializing it.
 */
export async function listen(app: INestApplication<App>): Promise<string> {
  const expressApp = asExpressApp(app);
  await expressApp.listen(0, '127.0.0.1');
  const address = expressApp
    .getHttpServer<import('http').Server>()
    .address() as AddressInfo;
  return `http://127.0.0.1:${address.port}`;
}
