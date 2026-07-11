import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { App } from 'supertest/types';
import { PrismaService } from '../src/prisma/prisma.service';
import { createE2eApp, registerUser } from './support/test-app';

/**
 * Artifact ownership integration tests (plan.md Test strategy → Integration
 * tests → "Artifact ownership และ revisions"). Creates an artifact under user
 * A's session by inserting directly via Prisma (the simplest way to get a
 * CodeArtifact row without driving the full AI-streaming pipeline — see
 * ChatGateway.onChatSend for how a real one is produced), then confirms user
 * B, a different registered user, cannot read it or its revision history
 * through the REST layer (artifacts.controller.ts).
 */
describe('Artifact ownership (e2e)', () => {
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

  async function setUpOwnerSessionWithArtifact() {
    const owner = await registerUser(app, 'artifact-owner');
    createdUserIds.push(owner.user.id);
    const attacker = await registerUser(app, 'artifact-attacker');
    createdUserIds.push(attacker.user.id);

    const created = await request(app.getHttpServer())
      .post('/api/chat/sessions')
      .set('Authorization', `Bearer ${owner.accessToken}`)
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
    const artifact = await prisma.codeArtifact.create({
      data: {
        sessionId: session.id,
        messageId: message.id,
        filename: 'src/secret.ts',
        language: 'typescript',
        content: 'export const secret = 42;',
        revision: 1,
        origin: 'ai',
      },
    });

    return { owner, attacker, session, artifact };
  }

  it('lets the owner list artifacts and revisions for their own session', async () => {
    const { owner, session, artifact } = await setUpOwnerSessionWithArtifact();

    const list = await request(app.getHttpServer())
      .get(`/api/chat/sessions/${session.id}/artifacts`)
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .expect(200);
    expect(list.body).toEqual([expect.objectContaining({ id: artifact.id })]);

    const revisions = await request(app.getHttpServer())
      .get(
        `/api/chat/sessions/${session.id}/artifacts/revisions?filename=src%2Fsecret.ts`,
      )
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .expect(200);
    expect(revisions.body).toEqual([
      expect.objectContaining({ id: artifact.id }),
    ]);
  });

  it('denies a different user listing artifacts for a session they do not own', async () => {
    const { attacker, session } = await setUpOwnerSessionWithArtifact();

    await request(app.getHttpServer())
      .get(`/api/chat/sessions/${session.id}/artifacts`)
      .set('Authorization', `Bearer ${attacker.accessToken}`)
      .expect(403);
  });

  it('denies a different user reading revision history for a session they do not own', async () => {
    const { attacker, session } = await setUpOwnerSessionWithArtifact();

    await request(app.getHttpServer())
      .get(
        `/api/chat/sessions/${session.id}/artifacts/revisions?filename=src%2Fsecret.ts`,
      )
      .set('Authorization', `Bearer ${attacker.accessToken}`)
      .expect(403);
  });

  it('denies an unauthenticated request to either artifact endpoint', async () => {
    const { session } = await setUpOwnerSessionWithArtifact();

    await request(app.getHttpServer())
      .get(`/api/chat/sessions/${session.id}/artifacts`)
      .expect(401);

    await request(app.getHttpServer())
      .get(
        `/api/chat/sessions/${session.id}/artifacts/revisions?filename=src%2Fsecret.ts`,
      )
      .expect(401);
  });
});
