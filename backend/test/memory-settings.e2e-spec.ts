import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { App } from 'supertest/types';
import { PrismaService } from '../src/prisma/prisma.service';
import { createE2eApp, registerUser } from './support/test-app';

/**
 * Phase 11 (chat memory) REST surface: GET/DELETE `/api/settings/memory`.
 * Notes are seeded directly via Prisma (the extraction pipeline itself is
 * covered by chat.gateway.spec.ts/memory.service.spec.ts unit tests — this
 * file is about ownership and the REST contract, not the Ollama call).
 */
describe('Memory settings (e2e)', () => {
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

  async function seedNote(userId: string, content: string) {
    return prisma.userMemoryNote.create({ data: { userId, content } });
  }

  it('lists only the requesting user’s own memory notes', async () => {
    const owner = await registerUser(app, 'memory-owner');
    createdUserIds.push(owner.user.id);
    const other = await registerUser(app, 'memory-other');
    createdUserIds.push(other.user.id);

    await seedNote(owner.user.id, 'Lives in Bangkok');
    await seedNote(other.user.id, 'Lives in Chiang Mai');

    const response = await request(app.getHttpServer())
      .get('/api/settings/memory')
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .expect(200);

    expect(response.body).toEqual([
      expect.objectContaining({ content: 'Lives in Bangkok' }),
    ]);
  });

  it('denies an unauthenticated request', async () => {
    await request(app.getHttpServer()).get('/api/settings/memory').expect(401);
  });

  it('deletes a note owned by the requesting user', async () => {
    const owner = await registerUser(app, 'memory-delete-owner');
    createdUserIds.push(owner.user.id);
    const note = await seedNote(owner.user.id, 'Prefers dark mode');

    await request(app.getHttpServer())
      .delete(`/api/settings/memory/${note.id}`)
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .expect(200);

    await expect(
      prisma.userMemoryNote.findUnique({ where: { id: note.id } }),
    ).resolves.toBeNull();
  });

  it('denies deleting a note that belongs to a different user', async () => {
    const owner = await registerUser(app, 'memory-owner-2');
    createdUserIds.push(owner.user.id);
    const attacker = await registerUser(app, 'memory-attacker');
    createdUserIds.push(attacker.user.id);
    const note = await seedNote(owner.user.id, 'Secret preference');

    await request(app.getHttpServer())
      .delete(`/api/settings/memory/${note.id}`)
      .set('Authorization', `Bearer ${attacker.accessToken}`)
      .expect(404);

    await expect(
      prisma.userMemoryNote.findUnique({ where: { id: note.id } }),
    ).resolves.not.toBeNull();
  });

  it('deletes every note for the requesting user only', async () => {
    const owner = await registerUser(app, 'memory-clear-owner');
    createdUserIds.push(owner.user.id);
    const other = await registerUser(app, 'memory-clear-other');
    createdUserIds.push(other.user.id);

    await seedNote(owner.user.id, 'Fact one');
    await seedNote(owner.user.id, 'Fact two');
    const otherNote = await seedNote(other.user.id, 'Untouched fact');

    await request(app.getHttpServer())
      .delete('/api/settings/memory')
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .expect(200);

    const remainingForOwner = await prisma.userMemoryNote.count({
      where: { userId: owner.user.id },
    });
    expect(remainingForOwner).toBe(0);

    await expect(
      prisma.userMemoryNote.findUnique({ where: { id: otherNote.id } }),
    ).resolves.not.toBeNull();
  });
});
