import { Prisma } from '@prisma/client';
import { BadRequestException } from '@nestjs/common';
import {
  ArtifactsService,
  MAX_ARTIFACT_CONTENT_BYTES,
  MAX_ARTIFACT_FILENAME_BYTES,
  assertArtifactContent,
  normalizeArtifactFilename,
} from './artifacts.service';

describe('artifact input validation', () => {
  it('normalizes safe relative paths before persistence', () => {
    expect(normalizeArtifactFilename(' ./src//app.ts ')).toBe('src/app.ts');
    expect(normalizeArtifactFilename('src\\components\\button.ts')).toBe(
      'src/components/button.ts',
    );
  });

  it.each([
    '../secrets.ts',
    'src/../../secrets.ts',
    '/etc/passwd',
    'C:\\Windows\\system32\\config',
    '\\\\server\\share\\file.ts',
    'src/',
    '.',
    'src/\u0000hidden.ts',
  ])('rejects unsafe artifact filename %p', (filename) => {
    expect(() => normalizeArtifactFilename(filename)).toThrow(
      BadRequestException,
    );
  });

  it('enforces filename and UTF-8 content size limits', () => {
    expect(() =>
      normalizeArtifactFilename(
        `src/${'a'.repeat(MAX_ARTIFACT_FILENAME_BYTES)}.ts`,
      ),
    ).toThrow(BadRequestException);
    expect(() =>
      assertArtifactContent('a'.repeat(MAX_ARTIFACT_CONTENT_BYTES + 1)),
    ).toThrow(BadRequestException);
    expect(() => assertArtifactContent('🙂'.repeat(300_000))).toThrow(
      BadRequestException,
    );
  });
});

describe('ArtifactsService', () => {
  it('rejects invalid revisions before opening a database transaction', async () => {
    const prisma = { $transaction: jest.fn() };
    const service = new ArtifactsService(prisma as never);

    await expect(
      service.createRevision({
        sessionId: 'session-1',
        messageId: 'message-1',
        filename: '../secrets.ts',
        language: 'typescript',
        content: 'console.log(1);',
        origin: 'ai',
      }),
    ).rejects.toBeInstanceOf(BadRequestException);

    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('persists the normalized relative path', async () => {
    const transaction = {
      codeArtifact: {
        findFirst: jest.fn().mockResolvedValue(null),
        create: jest.fn().mockResolvedValue({ id: 'artifact-1', revision: 1 }),
      },
    };
    const prisma = {
      $transaction: jest.fn((callback: (tx: typeof transaction) => unknown) =>
        callback(transaction),
      ),
    };
    const service = new ArtifactsService(prisma as never);

    await service.createRevision({
      sessionId: 'session-1',
      messageId: 'message-1',
      filename: ' ./src//app.ts ',
      language: 'typescript',
      content: 'console.log(1);',
      origin: 'ai',
    });

    expect(transaction.codeArtifact.findFirst).toHaveBeenCalledWith({
      where: { sessionId: 'session-1', filename: 'src/app.ts' },
      orderBy: { revision: 'desc' },
    });
    expect(transaction.codeArtifact.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ filename: 'src/app.ts' }),
    });
  });

  it('retries after a revision unique conflict and uses the new latest parent', async () => {
    const firstTransaction = {
      codeArtifact: {
        findFirst: jest.fn().mockResolvedValue(null),
        create: jest.fn().mockRejectedValue(
          new Prisma.PrismaClientKnownRequestError('conflict', {
            code: 'P2002',
            clientVersion: '7.8.0',
          }),
        ),
      },
    };
    const secondTransaction = {
      codeArtifact: {
        findFirst: jest
          .fn()
          .mockResolvedValue({ id: 'artifact-1', revision: 1 }),
        create: jest.fn().mockResolvedValue({ id: 'artifact-2', revision: 2 }),
      },
    };
    const transactions = [firstTransaction, secondTransaction];
    const prisma = {
      $transaction: jest.fn(
        (callback: (tx: typeof firstTransaction) => unknown) => {
          const tx = transactions.shift();
          if (!tx) throw new Error('unexpected transaction');
          return Promise.resolve(callback(tx));
        },
      ),
    };
    const service = new ArtifactsService(prisma as never);

    const result = await service.createRevision({
      sessionId: 'session-1',
      messageId: 'message-1',
      filename: 'main.ts',
      language: 'typescript',
      content: 'console.log(2);',
      origin: 'user',
    });

    expect(result).toEqual({ id: 'artifact-2', revision: 2 });
    expect(secondTransaction.codeArtifact.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        revision: 2,
        parentArtifactId: 'artifact-1',
      }),
    });
  });
});
