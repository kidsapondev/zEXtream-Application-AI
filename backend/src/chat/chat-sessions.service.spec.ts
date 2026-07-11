import { BadRequestException } from '@nestjs/common';
import { ChatSessionsService } from './chat-sessions.service';

describe('ChatSessionsService', () => {
  const prisma = {
    chatSession: {
      create: jest.fn(),
      findMany: jest.fn(),
      findUnique: jest.fn(),
      delete: jest.fn(),
      update: jest.fn(),
      updateMany: jest.fn(),
    },
  };
  const streamRegistry = {
    stopAllForSession: jest.fn(),
  };
  const providerSettingsService = {
    hasApiKey: jest.fn(),
  };

  const service = new ChatSessionsService(
    prisma as never,
    streamRegistry as never,
    providerSettingsService as never,
  );

  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('listForUser', () => {
    it('omits take/skip entirely when called without pagination (backward compatible)', async () => {
      prisma.chatSession.findMany.mockResolvedValue([]);

      await service.listForUser('user-1');

      expect(prisma.chatSession.findMany).toHaveBeenCalledWith({
        where: { userId: 'user-1', isArchived: false },
        orderBy: { updatedAt: 'desc' },
      });
    });

    it('applies take/skip when pagination is provided', async () => {
      prisma.chatSession.findMany.mockResolvedValue([]);

      await service.listForUser('user-1', { take: 10, skip: 20 });

      expect(prisma.chatSession.findMany).toHaveBeenCalledWith({
        where: { userId: 'user-1', isArchived: false },
        orderBy: { updatedAt: 'desc' },
        take: 10,
        skip: 20,
      });
    });
  });

  describe('create', () => {
    it('creates an ollama session without checking for a configured key', async () => {
      prisma.chatSession.create.mockResolvedValue({ id: 'session-1' });

      await service.create('user-1', {
        defaultProvider: 'ollama',
        defaultModel: 'llama3',
      });

      expect(providerSettingsService.hasApiKey).not.toHaveBeenCalled();
      expect(prisma.chatSession.create).toHaveBeenCalled();
    });

    it('rejects creating a claude session when the user has no configured key', async () => {
      providerSettingsService.hasApiKey.mockResolvedValue(false);

      await expect(
        service.create('user-1', {
          defaultProvider: 'claude',
          defaultModel: 'claude-sonnet-5',
        }),
      ).rejects.toBeInstanceOf(BadRequestException);

      expect(providerSettingsService.hasApiKey).toHaveBeenCalledWith(
        'user-1',
        'claude',
      );
      expect(prisma.chatSession.create).not.toHaveBeenCalled();
    });

    it('creates an openai session when the user has a configured key', async () => {
      providerSettingsService.hasApiKey.mockResolvedValue(true);
      prisma.chatSession.create.mockResolvedValue({ id: 'session-2' });

      await service.create('user-1', {
        defaultProvider: 'openai',
        defaultModel: 'gpt-5.1',
      });

      expect(prisma.chatSession.create).toHaveBeenCalled();
    });
  });

  describe('remove', () => {
    it('stops all active streams for the session before deleting it', async () => {
      prisma.chatSession.findUnique.mockResolvedValue({
        id: 'session-1',
        userId: 'user-1',
      });

      await service.remove('user-1', 'session-1');

      expect(streamRegistry.stopAllForSession).toHaveBeenCalledWith(
        'session-1',
      );
      expect(prisma.chatSession.delete).toHaveBeenCalledWith({
        where: { id: 'session-1' },
      });
      const stopOrder =
        streamRegistry.stopAllForSession.mock.invocationCallOrder[0];
      const deleteOrder = prisma.chatSession.delete.mock.invocationCallOrder[0];
      expect(stopOrder).toBeLessThan(deleteOrder);
    });
  });

  describe('setTitleIfDefault', () => {
    it('only updates rows that still have the default title', async () => {
      await service.setTitleIfDefault('session-1', 'Derived title');

      expect(prisma.chatSession.updateMany).toHaveBeenCalledWith({
        where: { id: 'session-1', title: 'New Chat' },
        data: { title: 'Derived title' },
      });
    });
  });
});
