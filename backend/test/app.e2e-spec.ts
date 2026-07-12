import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { App } from 'supertest/types';
import { PrismaService } from '../src/prisma/prisma.service';
import { createE2eApp, RegisteredUser, registerUser } from './support/test-app';

describe('Application security flows (e2e)', () => {
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

  async function register(label: string): Promise<RegisteredUser> {
    const registered = await registerUser(app, label);
    createdUserIds.push(registered.user.id);
    return registered;
  }

  it('reports database readiness', async () => {
    await request(app.getHttpServer())
      .get('/api/health')
      .expect(200)
      .expect({ status: 'ok', database: 'connected' });
  });

  it('allows only one concurrent rotation of the same refresh token', async () => {
    const user = await register('refresh-race');

    const responses = await Promise.all([
      request(app.getHttpServer())
        .post('/api/auth/refresh')
        .set('Cookie', user.refreshCookie),
      request(app.getHttpServer())
        .post('/api/auth/refresh')
        .set('Cookie', user.refreshCookie),
    ]);

    expect(responses.map((response) => response.status).sort()).toEqual([
      201, 401,
    ]);
    const validDescendants = await prisma.refreshToken.count({
      where: { userId: user.user.id, revokedAt: null },
    });
    expect(validDescendants).toBeLessThanOrEqual(1);
  });

  it('denies cross-user access to another user session', async () => {
    const owner = await register('session-owner');
    const attacker = await register('session-attacker');
    const created = await request(app.getHttpServer())
      .post('/api/chat/sessions')
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .send({ defaultProvider: 'ollama', defaultModel: 'test-model' })
      .expect(201);
    const session = created.body as { id: string };

    await request(app.getHttpServer())
      .get(`/api/chat/sessions/${session.id}/messages`)
      .set('Authorization', `Bearer ${attacker.accessToken}`)
      .expect(403);
  });

  it('restores the latest artifact and its revision history through the session API', async () => {
    const user = await register('artifact-reload');
    const created = await request(app.getHttpServer())
      .post('/api/chat/sessions')
      .set('Authorization', `Bearer ${user.accessToken}`)
      .send({ defaultProvider: 'ollama', defaultModel: 'test-model' })
      .expect(201);
    const session = created.body as { id: string };
    const message = await prisma.message.create({
      data: {
        sessionId: session.id,
        role: 'assistant',
        content: 'Created a file.',
        streamingStatus: 'complete',
      },
    });
    const first = await prisma.codeArtifact.create({
      data: {
        sessionId: session.id,
        messageId: message.id,
        filename: 'src/example.ts',
        language: 'typescript',
        content: 'export const version = 1;',
        revision: 1,
        origin: 'ai',
      },
    });
    const latest = await prisma.codeArtifact.create({
      data: {
        sessionId: session.id,
        messageId: message.id,
        filename: 'src/example.ts',
        language: 'typescript',
        content: 'export const version = 2;',
        revision: 2,
        parentArtifactId: first.id,
        origin: 'user',
      },
    });

    const artifacts = await request(app.getHttpServer())
      .get(`/api/chat/sessions/${session.id}/artifacts`)
      .set('Authorization', `Bearer ${user.accessToken}`)
      .expect(200);
    const revisions = await request(app.getHttpServer())
      .get(
        `/api/chat/sessions/${session.id}/artifacts/revisions?filename=src%2Fexample.ts`,
      )
      .set('Authorization', `Bearer ${user.accessToken}`)
      .expect(200);

    expect(artifacts.body).toEqual([
      expect.objectContaining({
        id: latest.id,
        revision: 2,
        content: latest.content,
      }),
    ]);
    expect(revisions.body).toEqual([
      expect.objectContaining({ id: first.id, revision: 1 }),
      expect.objectContaining({
        id: latest.id,
        revision: 2,
        parentArtifactId: first.id,
      }),
    ]);
  });

  it('reports claude/openai as unconfigured (no per-user key involved) when their host-bridge is unreachable', async () => {
    const user = await register('provider-settings');

    // claude/openai no longer take a per-user API key at all — availability is
    // server-wide, driven by the host-bridge (see ProviderSettingsService). This e2e
    // suite deliberately leaves CLAUDE_BRIDGE_URL/CODEX_BRIDGE_URL unset (see
    // setup-e2e.ts), so both report unconfigured here — the same "bridge not running"
    // state a real deployment would show if the host-bridge process were down.
    const settings = await request(app.getHttpServer())
      .get('/api/settings/providers')
      .set('Authorization', `Bearer ${user.accessToken}`)
      .expect(200);
    expect(settings.body).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          provider: 'claude',
          requiresApiKey: false,
          configured: false,
        }),
        expect.objectContaining({
          provider: 'openai',
          requiresApiKey: false,
          configured: false,
        }),
      ]),
    );

    // The BYOK endpoints are gone entirely — confirm they're no longer routed.
    await request(app.getHttpServer())
      .put('/api/settings/providers/openai')
      .set('Authorization', `Bearer ${user.accessToken}`)
      .send({ apiKey: 'test-openai-secret' })
      .expect(404);
  });
});
