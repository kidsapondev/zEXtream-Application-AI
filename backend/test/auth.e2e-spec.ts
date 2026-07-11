import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { App } from 'supertest/types';
import { PrismaService } from '../src/prisma/prisma.service';
import {
  cookieFrom,
  createE2eApp,
  loginUser,
  RegisteredUser,
  registerUser,
} from './support/test-app';

/**
 * Covers the auth P1 integration tests listed in plan.md's Phase 2 "P1 —
 * Tests ที่ต้องเพิ่ม" that weren't already covered by app.e2e-spec.ts
 * (concurrent refresh, cross-user session access). Every test here goes
 * through real HTTP requests (supertest) against a real Nest app instance
 * backed by a real Postgres (see backend/test/setup-e2e.ts for how
 * DATABASE_URL/JWT secrets/etc. are provisioned for this suite).
 */
describe('Auth flows (e2e)', () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;
  const createdUserIds: string[] = [];

  beforeAll(async () => {
    ({ app, prisma } = await createE2eApp());
  });

  afterEach(async () => {
    if (createdUserIds.length === 0) return;
    await prisma.user.deleteMany({
      where: { id: { in: createdUserIds.splice(0) } },
    });
  });

  afterAll(async () => {
    await app.close();
  });

  async function register(
    label: string,
    password?: string,
  ): Promise<RegisteredUser> {
    const registered = await registerUser(app, label, { password });
    createdUserIds.push(registered.user.id);
    return registered;
  }

  describe('register', () => {
    it('succeeds and returns a user + access token + refresh cookie', async () => {
      const email = `register-success-${Date.now()}@example.com`;
      const response = await request(app.getHttpServer())
        .post('/api/auth/register')
        .set('X-Forwarded-For', '10.10.0.1')
        .send({
          email,
          password: 'IntegrationPassword123!',
          displayName: 'Register Success',
        })
        .expect(201);

      const body = response.body as {
        user: { id: string; email: string; displayName: string };
        accessToken: string;
      };
      createdUserIds.push(body.user.id);

      expect(body.user.email).toBe(email.toLowerCase());
      expect(typeof body.accessToken).toBe('string');
      expect(body.accessToken.length).toBeGreaterThan(0);
      expect(() => cookieFrom(response)).not.toThrow();
    });

    it('rejects a duplicate email with 409 Conflict', async () => {
      const user = await register('register-dup');

      await request(app.getHttpServer())
        .post('/api/auth/register')
        .set('X-Forwarded-For', '10.10.0.2')
        .send({
          email: user.user.email,
          password: 'AnotherPassword456!',
          displayName: 'Duplicate',
        })
        .expect(409);
    });
  });

  describe('login', () => {
    it('succeeds with the correct password', async () => {
      const password = 'CorrectPassword789!';
      const user = await register('login-correct', password);

      const response = await loginUser(app, user.user.email, password);

      expect(response.status).toBe(201);
      const body = response.body as { accessToken: string };
      expect(typeof body.accessToken).toBe('string');
    });

    it('rejects an incorrect password', async () => {
      const user = await register('login-wrong', 'CorrectPassword789!');

      const response = await loginUser(
        app,
        user.user.email,
        'TotallyWrongPassword000!',
      );

      expect(response.status).toBe(401);
    });

    it('rejects a login for an inactive (deactivated) user', async () => {
      const password = 'CorrectPassword789!';
      const user = await register('login-inactive', password);
      await prisma.user.update({
        where: { id: user.user.id },
        data: { isActive: false },
      });

      const response = await loginUser(app, user.user.email, password);

      expect(response.status).toBe(401);
    });
  });

  describe('refresh', () => {
    it('succeeds, rotates the refresh cookie, and invalidates the old cookie', async () => {
      const user = await register('refresh-success');

      const refreshed = await request(app.getHttpServer())
        .post('/api/auth/refresh')
        .set('Cookie', user.refreshCookie)
        .expect(201);
      const refreshedBody = refreshed.body as { accessToken: string };
      expect(typeof refreshedBody.accessToken).toBe('string');
      expect(refreshedBody.accessToken.length).toBeGreaterThan(0);

      // Note: the *access* token can legitimately be byte-identical to the one
      // issued at register (JWT signing is deterministic and both share the
      // same {sub, email, iat} when issued within the same second) — it is not
      // a useful rotation signal. The refresh *cookie* is what actually
      // rotates and is asserted below.
      const newCookie = cookieFrom(refreshed);
      expect(newCookie).not.toBe(user.refreshCookie);

      // The newly issued cookie is itself valid and usable for a follow-up
      // rotation. (Checked before the old-cookie check below: presenting the
      // old, already-rotated cookie triggers reuse detection, which revokes
      // the *entire* token family — including this new cookie — by design;
      // see the dedicated reuse-detection test further down. Checking order
      // here matters.)
      await request(app.getHttpServer())
        .post('/api/auth/refresh')
        .set('Cookie', newCookie)
        .expect(201);

      // The old (now-rotated) cookie must no longer work.
      await request(app.getHttpServer())
        .post('/api/auth/refresh')
        .set('Cookie', user.refreshCookie)
        .expect(401);
    });

    it('rejects a refresh token whose DB row has expired', async () => {
      const user = await register('refresh-expired');
      const row = await prisma.refreshToken.findFirstOrThrow({
        where: { userId: user.user.id, revokedAt: null },
      });
      await prisma.refreshToken.update({
        where: { id: row.id },
        data: { expiresAt: new Date(Date.now() - 1000) },
      });

      const response = await request(app.getHttpServer())
        .post('/api/auth/refresh')
        .set('Cookie', user.refreshCookie);

      expect(response.status).toBe(401);
    });

    it('detects reuse of an already-rotated token and revokes the whole family', async () => {
      const user = await register('refresh-reuse');

      // First refresh rotates the token (this is the legitimate use).
      await request(app.getHttpServer())
        .post('/api/auth/refresh')
        .set('Cookie', user.refreshCookie)
        .expect(201);

      // Presenting the now-revoked original cookie again simulates a stolen
      // token being replayed after the legitimate client already rotated it.
      const reuseResponse = await request(app.getHttpServer())
        .post('/api/auth/refresh')
        .set('Cookie', user.refreshCookie);
      expect(reuseResponse.status).toBe(401);

      const remainingValid = await prisma.refreshToken.count({
        where: { userId: user.user.id, revokedAt: null },
      });
      expect(remainingValid).toBe(0);

      const allTokens = await prisma.refreshToken.findMany({
        where: { userId: user.user.id },
      });
      expect(allTokens.length).toBeGreaterThan(0);
      expect(allTokens.every((token) => token.revokedAt !== null)).toBe(true);
    });
  });

  describe('logout', () => {
    it('revokes the refresh token so a subsequent refresh fails', async () => {
      const user = await register('logout-then-refresh');

      await request(app.getHttpServer())
        .post('/api/auth/logout')
        .set('Cookie', user.refreshCookie)
        .expect(201);

      const response = await request(app.getHttpServer())
        .post('/api/auth/refresh')
        .set('Cookie', user.refreshCookie);

      expect(response.status).toBe(401);
    });
  });

  describe('hard-reload session restore', () => {
    it('issues a new access token from only the httpOnly refresh cookie, mirroring the app initializer', async () => {
      const user = await register('hard-reload');

      // Simulates the frontend app initializer on a fresh page load: no
      // Authorization header at all (the access token only ever lived in
      // memory and is gone after a hard reload), just whatever the browser
      // sends automatically via the httpOnly cookie.
      const response = await request(app.getHttpServer())
        .post('/api/auth/refresh')
        .set('Cookie', user.refreshCookie)
        .expect(201);

      const body = response.body as { accessToken: string };
      expect(typeof body.accessToken).toBe('string');
      expect(body.accessToken.length).toBeGreaterThan(0);

      // The freshly restored access token must actually authenticate REST calls.
      const me = await request(app.getHttpServer())
        .get('/api/users/me')
        .set('Authorization', `Bearer ${body.accessToken}`);
      expect(me.status).toBe(200);
    });
  });
});
