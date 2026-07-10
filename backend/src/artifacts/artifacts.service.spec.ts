import { Prisma } from '@prisma/client';
import { ArtifactsService } from './artifacts.service';

describe('ArtifactsService', () => {
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
