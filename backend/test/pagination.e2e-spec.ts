import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { App } from 'supertest/types';
import { PrismaService } from '../src/prisma/prisma.service';
import { createE2eApp, registerUser } from './support/test-app';

/**
 * Pagination for sessions, messages and artifact revisions (plan.md Phase 1
 * "ต้องทำต่อ" → "พิจารณา pagination สำหรับ messages, sessions และ artifact
 * revisions"). Every list endpoint here uses optional offset-based pagination
 * (`limit`/`offset` query params) — see
 * backend/src/chat/dto/pagination-query.dto.ts for the offset-vs-cursor
 * rationale. The load-bearing property under test is backward compatibility:
 * omitting both params must return exactly what the endpoint returned before
 * pagination existed (full array, same order, no wrapper object).
 */
describe('Pagination (e2e)', () => {
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

  describe('GET /api/chat/sessions', () => {
    it('returns the full unpaginated array when limit/offset are omitted', async () => {
      const user = await registerUser(app, 'pagination-sessions-default');
      createdUserIds.push(user.user.id);

      // Sequential creates so updatedAt strictly increases; sessions come
      // back newest-first (orderBy updatedAt desc), matching the pre-existing
      // (pre-pagination) ordering.
      const titles = ['s1', 's2', 's3', 's4', 's5'];
      for (const title of titles) {
        await request(app.getHttpServer())
          .post('/api/chat/sessions')
          .set('Authorization', `Bearer ${user.accessToken}`)
          .send({
            title,
            defaultProvider: 'ollama',
            defaultModel: 'test-model',
          })
          .expect(201);
      }

      const response = await request(app.getHttpServer())
        .get('/api/chat/sessions')
        .set('Authorization', `Bearer ${user.accessToken}`)
        .expect(200);

      expect(Array.isArray(response.body)).toBe(true);
      const body = response.body as Array<{ title: string }>;
      expect(body.map((s) => s.title)).toEqual(['s5', 's4', 's3', 's2', 's1']);
    });

    it('slices the same ordering when limit/offset are provided', async () => {
      const user = await registerUser(app, 'pagination-sessions-sliced');
      createdUserIds.push(user.user.id);

      const titles = ['s1', 's2', 's3', 's4', 's5'];
      for (const title of titles) {
        await request(app.getHttpServer())
          .post('/api/chat/sessions')
          .set('Authorization', `Bearer ${user.accessToken}`)
          .send({
            title,
            defaultProvider: 'ollama',
            defaultModel: 'test-model',
          })
          .expect(201);
      }

      const full = await request(app.getHttpServer())
        .get('/api/chat/sessions')
        .set('Authorization', `Bearer ${user.accessToken}`)
        .expect(200);
      const fullTitles = (full.body as Array<{ title: string }>).map(
        (s) => s.title,
      );

      const page1 = await request(app.getHttpServer())
        .get('/api/chat/sessions?limit=2')
        .set('Authorization', `Bearer ${user.accessToken}`)
        .expect(200);
      expect(
        (page1.body as Array<{ title: string }>).map((s) => s.title),
      ).toEqual(fullTitles.slice(0, 2));

      const page2 = await request(app.getHttpServer())
        .get('/api/chat/sessions?limit=2&offset=2')
        .set('Authorization', `Bearer ${user.accessToken}`)
        .expect(200);
      expect(
        (page2.body as Array<{ title: string }>).map((s) => s.title),
      ).toEqual(fullTitles.slice(2, 4));

      const page3 = await request(app.getHttpServer())
        .get('/api/chat/sessions?limit=2&offset=4')
        .set('Authorization', `Bearer ${user.accessToken}`)
        .expect(200);
      expect(
        (page3.body as Array<{ title: string }>).map((s) => s.title),
      ).toEqual(fullTitles.slice(4, 6));
    });

    it('rejects an out-of-range limit', async () => {
      const user = await registerUser(app, 'pagination-sessions-invalid');
      createdUserIds.push(user.user.id);

      await request(app.getHttpServer())
        .get('/api/chat/sessions?limit=0')
        .set('Authorization', `Bearer ${user.accessToken}`)
        .expect(400);
      await request(app.getHttpServer())
        .get('/api/chat/sessions?limit=abc')
        .set('Authorization', `Bearer ${user.accessToken}`)
        .expect(400);
    });
  });

  describe('GET /api/chat/sessions/:id/messages', () => {
    async function setUpSessionWithMessages(userAccessToken: string) {
      const created = await request(app.getHttpServer())
        .post('/api/chat/sessions')
        .set('Authorization', `Bearer ${userAccessToken}`)
        .send({ defaultProvider: 'ollama', defaultModel: 'test-model' })
        .expect(201);
      const session = created.body as { id: string };

      const contents = ['m1', 'm2', 'm3', 'm4', 'm5'];
      for (const content of contents) {
        await prisma.message.create({
          data: {
            sessionId: session.id,
            role: 'user',
            content,
            streamingStatus: 'complete',
          },
        });
      }
      return session;
    }

    it('returns the full unpaginated array when limit/offset are omitted', async () => {
      const user = await registerUser(app, 'pagination-messages-default');
      createdUserIds.push(user.user.id);
      const session = await setUpSessionWithMessages(user.accessToken);

      const response = await request(app.getHttpServer())
        .get(`/api/chat/sessions/${session.id}/messages`)
        .set('Authorization', `Bearer ${user.accessToken}`)
        .expect(200);

      const body = response.body as Array<{ content: string }>;
      expect(body.map((m) => m.content)).toEqual([
        'm1',
        'm2',
        'm3',
        'm4',
        'm5',
      ]);
    });

    it('slices the same (oldest-first) ordering when limit/offset are provided', async () => {
      const user = await registerUser(app, 'pagination-messages-sliced');
      createdUserIds.push(user.user.id);
      const session = await setUpSessionWithMessages(user.accessToken);

      const page = await request(app.getHttpServer())
        .get(`/api/chat/sessions/${session.id}/messages?limit=2&offset=1`)
        .set('Authorization', `Bearer ${user.accessToken}`)
        .expect(200);

      expect(
        (page.body as Array<{ content: string }>).map((m) => m.content),
      ).toEqual(['m2', 'm3']);
    });
  });

  describe('GET /api/chat/sessions/:sessionId/artifacts/revisions', () => {
    async function setUpSessionWithRevisions(userAccessToken: string) {
      const created = await request(app.getHttpServer())
        .post('/api/chat/sessions')
        .set('Authorization', `Bearer ${userAccessToken}`)
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

      let parentId: string | undefined;
      for (let revision = 1; revision <= 5; revision += 1) {
        const artifact = await prisma.codeArtifact.create({
          data: {
            sessionId: session.id,
            messageId: message.id,
            filename: 'src/paged.ts',
            language: 'typescript',
            content: `export const revision = ${revision};`,
            revision,
            parentArtifactId: parentId,
            origin: 'ai',
          },
        });
        parentId = artifact.id;
      }
      return session;
    }

    it('returns the full unpaginated revision history when limit/offset are omitted', async () => {
      const user = await registerUser(app, 'pagination-revisions-default');
      createdUserIds.push(user.user.id);
      const session = await setUpSessionWithRevisions(user.accessToken);

      const response = await request(app.getHttpServer())
        .get(
          `/api/chat/sessions/${session.id}/artifacts/revisions?filename=src%2Fpaged.ts`,
        )
        .set('Authorization', `Bearer ${user.accessToken}`)
        .expect(200);

      const body = response.body as Array<{ revision: number }>;
      expect(body.map((r) => r.revision)).toEqual([1, 2, 3, 4, 5]);
    });

    it('slices the same (oldest-first) ordering when limit/offset are provided', async () => {
      const user = await registerUser(app, 'pagination-revisions-sliced');
      createdUserIds.push(user.user.id);
      const session = await setUpSessionWithRevisions(user.accessToken);

      const page = await request(app.getHttpServer())
        .get(
          `/api/chat/sessions/${session.id}/artifacts/revisions?filename=src%2Fpaged.ts&limit=2&offset=3`,
        )
        .set('Authorization', `Bearer ${user.accessToken}`)
        .expect(200);

      expect(
        (page.body as Array<{ revision: number }>).map((r) => r.revision),
      ).toEqual([4, 5]);
    });
  });
});
