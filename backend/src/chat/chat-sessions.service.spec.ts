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
    isProviderAvailable: jest.fn(),
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
    it('creates an ollama session without checking availability (a momentary Ollama hiccup must not block session creation)', async () => {
      providerSettingsService.isProviderAvailable.mockResolvedValue(false);
      prisma.chatSession.create.mockResolvedValue({ id: 'session-1' });

      await service.create('user-1', {
        defaultProvider: 'ollama',
        defaultModel: 'llama3',
      });

      expect(
        providerSettingsService.isProviderAvailable,
      ).not.toHaveBeenCalled();
      expect(prisma.chatSession.create).toHaveBeenCalled();
    });

    it('rejects creating a claude session when the host-bridge is not available', async () => {
      providerSettingsService.isProviderAvailable.mockResolvedValue(false);

      await expect(
        service.create('user-1', {
          defaultProvider: 'claude',
          defaultModel: 'sonnet',
        }),
      ).rejects.toBeInstanceOf(BadRequestException);

      expect(providerSettingsService.isProviderAvailable).toHaveBeenCalledWith(
        'claude',
      );
      expect(prisma.chatSession.create).not.toHaveBeenCalled();
    });

    it('creates an openai (codex) session when it is currently available', async () => {
      providerSettingsService.isProviderAvailable.mockResolvedValue(true);
      prisma.chatSession.create.mockResolvedValue({ id: 'session-2' });

      await service.create('user-1', {
        defaultProvider: 'openai',
        defaultModel: 'gpt-5.6-sol',
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

  describe('update', () => {
    it('requires the target provider to be currently available when changing a session provider', async () => {
      prisma.chatSession.findUnique.mockResolvedValue({
        id: 'session-1',
        userId: 'user-1',
        defaultProvider: 'ollama',
        defaultModel: 'llama3',
      });
      providerSettingsService.isProviderAvailable.mockResolvedValue(false);

      await expect(
        service.update('user-1', 'session-1', {
          defaultProvider: 'openai',
          defaultModel: 'gpt-5.6-sol',
        }),
      ).rejects.toBeInstanceOf(BadRequestException);

      expect(prisma.chatSession.update).not.toHaveBeenCalled();
    });

    it('updates model-only changes after confirming the existing provider remains available', async () => {
      prisma.chatSession.findUnique.mockResolvedValue({
        id: 'session-1',
        userId: 'user-1',
        defaultProvider: 'claude',
        defaultModel: 'haiku',
      });
      providerSettingsService.isProviderAvailable.mockResolvedValue(true);
      prisma.chatSession.update.mockResolvedValue({ id: 'session-1' });

      await service.update('user-1', 'session-1', {
        defaultModel: 'sonnet',
      });

      expect(providerSettingsService.isProviderAvailable).toHaveBeenCalledWith(
        'claude',
      );
      expect(prisma.chatSession.update).toHaveBeenCalledWith({
        where: { id: 'session-1' },
        data: { defaultModel: 'sonnet' },
      });
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
