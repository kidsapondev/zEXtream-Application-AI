import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import cookieParser from 'cookie-parser';
import request, { Response } from 'supertest';
import { App } from 'supertest/types';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';

interface RegisteredUser {
  user: { id: string; email: string };
  accessToken: string;
  refreshCookie: string;
}

describe('Application security flows (e2e)', () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;
  const createdUserIds: string[] = [];

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    app.setGlobalPrefix('api');
    app.use(cookieParser());
    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
      }),
    );
    await app.init();
    prisma = app.get(PrismaService);
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

  function cookieFrom(response: Response): string {
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

  async function register(label: string): Promise<RegisteredUser> {
    const email = `${label}-${Date.now()}-${Math.random().toString(16).slice(2)}@example.com`;
    const response = await request(app.getHttpServer())
      .post('/api/auth/register')
      .send({ email, password: 'IntegrationPassword123!', displayName: label })
      .expect(201);
    const body = response.body as {
      user: { id: string; email: string };
      accessToken: string;
    };
    createdUserIds.push(body.user.id);
    return { ...body, refreshCookie: cookieFrom(response) };
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
      201,
      401,
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
      expect.objectContaining({ id: latest.id, revision: 2, content: latest.content }),
    ]);
    expect(revisions.body).toEqual([
      expect.objectContaining({ id: first.id, revision: 1 }),
      expect.objectContaining({ id: latest.id, revision: 2, parentArtifactId: first.id }),
    ]);
  });
});
