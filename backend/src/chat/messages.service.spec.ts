import { MessagesService } from './messages.service';

describe('MessagesService', () => {
  const prisma = {
    message: {
      findMany: jest.fn(),
      update: jest.fn(),
    },
  };
  const service = new MessagesService(prisma as never);

  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('listForSession', () => {
    it('omits take/skip when called with only sessionId (the shape ChatGateway relies on for full AI context)', async () => {
      prisma.message.findMany.mockResolvedValue([]);

      await service.listForSession('session-1');

      expect(prisma.message.findMany).toHaveBeenCalledWith({
        where: { sessionId: 'session-1' },
        orderBy: { createdAt: 'asc' },
      });
    });

    it('applies take/skip when pagination is provided', async () => {
      prisma.message.findMany.mockResolvedValue([]);

      await service.listForSession('session-1', { take: 25, skip: 50 });

      expect(prisma.message.findMany).toHaveBeenCalledWith({
        where: { sessionId: 'session-1' },
        orderBy: { createdAt: 'asc' },
        take: 25,
        skip: 50,
      });
    });
  });

  describe('finalizeAssistantMessage', () => {
    it('persists the reported tokenCount alongside content and status', async () => {
      prisma.message.update.mockResolvedValue({});

      await service.finalizeAssistantMessage(
        'message-1',
        'hello',
        'complete',
        undefined,
        46,
      );

      expect(prisma.message.update).toHaveBeenCalledWith({
        where: { id: 'message-1' },
        data: {
          content: 'hello',
          streamingStatus: 'complete',
          errorMessage: undefined,
          tokenCount: 46,
        },
      });
    });

    it('leaves tokenCount as undefined (column stays null) when the provider reported no usage', async () => {
      prisma.message.update.mockResolvedValue({});

      await service.finalizeAssistantMessage('message-1', 'hello', 'complete');

      expect(prisma.message.update).toHaveBeenCalledWith({
        where: { id: 'message-1' },
        data: {
          content: 'hello',
          streamingStatus: 'complete',
          errorMessage: undefined,
          tokenCount: undefined,
        },
      });
    });
  });
});
