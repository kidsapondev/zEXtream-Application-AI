import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { App } from 'supertest/types';
import { CodeArtifact } from '@prisma/client';
import { PrismaService } from '../src/prisma/prisma.service';
import { ArtifactsService } from '../src/artifacts/artifacts.service';
import { createE2eApp, registerUser } from './support/test-app';

/**
 * Proves `ArtifactsService.listLatestForSession()`'s new `DISTINCT ON`
 * raw-SQL implementation (plan.md Phase 1 "ต้องทำต่อ" → "ปรับ
 * listLatestForSession() ให้ query เฉพาะ revision ล่าสุดจาก database แทนโหลด
 * ทุก revision เข้า memory") returns exactly what the old in-memory reduction
 * would have: the highest-`revision` row per filename in the session, nothing
 * else. Reimplements the *old* algorithm here (independently, against a real
 * multi-file/multi-revision dataset) rather than asserting a hardcoded
 * expected list, so this test would catch a regression in either direction.
 */
describe('ArtifactsService.listLatestForSession (e2e)', () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;
  let artifactsService: ArtifactsService;
  const createdUserIds: string[] = [];

  beforeAll(async () => {
    ({ app, prisma } = await createE2eApp());
    artifactsService = app.get(ArtifactsService);
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

  /** The pre-optimization algorithm, reimplemented independently for comparison. */
  function oldLatestByFilename(all: CodeArtifact[]): CodeArtifact[] {
    const sorted = [...all].sort((a, b) => b.revision - a.revision);
    const latestByFilename = new Map<string, CodeArtifact>();
    for (const artifact of sorted) {
      if (!latestByFilename.has(artifact.filename)) {
        latestByFilename.set(artifact.filename, artifact);
      }
    }
    return [...latestByFilename.values()];
  }

  it('matches the old in-memory reduction for a session with many files at many revisions', async () => {
    const user = await registerUser(app, 'latest-revision-equivalence');
    createdUserIds.push(user.user.id);

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
        content: 'Created several files.',
        streamingStatus: 'complete',
      },
    });

    const files = ['src/a.ts', 'src/b.ts', 'lib/c.js', 'README.md'];
    const revisionCounts: Record<string, number> = {
      'src/a.ts': 4,
      'src/b.ts': 1,
      'lib/c.js': 6,
      'README.md': 3,
    };

    for (const filename of files) {
      let parentId: string | undefined;
      for (
        let revision = 1;
        revision <= revisionCounts[filename];
        revision += 1
      ) {
        const artifact = await prisma.codeArtifact.create({
          data: {
            sessionId: session.id,
            messageId: message.id,
            filename,
            language: filename.endsWith('.js') ? 'javascript' : 'typescript',
            content: `content for ${filename} revision ${revision}`,
            revision,
            parentArtifactId: parentId,
            origin: revision % 2 === 0 ? 'user' : 'ai',
          },
        });
        parentId = artifact.id;
      }
    }

    const allRows = await prisma.codeArtifact.findMany({
      where: { sessionId: session.id },
    });
    expect(allRows.length).toBe(
      Object.values(revisionCounts).reduce((a, b) => a + b, 0),
    );

    const expected = oldLatestByFilename(allRows).sort((a, b) =>
      a.filename.localeCompare(b.filename),
    );

    const actual = (
      await artifactsService.listLatestForSession(session.id)
    ).sort((a, b) => a.filename.localeCompare(b.filename));

    expect(actual).toHaveLength(files.length);
    expect(
      actual.map((a) => ({
        filename: a.filename,
        revision: a.revision,
        id: a.id,
      })),
    ).toEqual(
      expected.map((a) => ({
        filename: a.filename,
        revision: a.revision,
        id: a.id,
      })),
    );
    // Full-row equality too (content, origin, timestamps, parentArtifactId
    // survive the raw-SQL column mapping unchanged).
    expect(actual).toEqual(expected);

    // Same result through the REST layer that actually serves the file-tabs panel.
    const viaRest = await request(app.getHttpServer())
      .get(`/api/chat/sessions/${session.id}/artifacts`)
      .set('Authorization', `Bearer ${user.accessToken}`)
      .expect(200);
    const restSorted = (
      viaRest.body as Array<{ filename: string; revision: number }>
    ).sort((a, b) => a.filename.localeCompare(b.filename));
    expect(
      restSorted.map((a) => ({ filename: a.filename, revision: a.revision })),
    ).toEqual(
      expected.map((a) => ({ filename: a.filename, revision: a.revision })),
    );
  });

  it('returns an empty array for a session with no artifacts', async () => {
    const user = await registerUser(app, 'latest-revision-empty');
    createdUserIds.push(user.user.id);

    const created = await request(app.getHttpServer())
      .post('/api/chat/sessions')
      .set('Authorization', `Bearer ${user.accessToken}`)
      .send({ defaultProvider: 'ollama', defaultModel: 'test-model' })
      .expect(201);
    const session = created.body as { id: string };

    const result = await artifactsService.listLatestForSession(session.id);
    expect(result).toEqual([]);
  });
});
