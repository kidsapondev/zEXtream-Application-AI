import { ConfigService } from '@nestjs/config';
import { NotFoundException } from '@nestjs/common';
import {
  MAX_MEMORY_NOTE_BYTES,
  MAX_MEMORY_NOTES_PER_USER,
  MEMORY_NOTES_INJECTED,
  MemoryService,
} from './memory.service';

function createConfig(values: Record<string, string | undefined>) {
  return {
    get: jest.fn((key: string) => values[key]),
  } as unknown as ConfigService;
}

function createPrisma() {
  return {
    userMemoryNote: {
      findMany: jest.fn().mockResolvedValue([]),
      findFirst: jest.fn().mockResolvedValue(null),
      create: jest.fn().mockResolvedValue({}),
      deleteMany: jest.fn().mockResolvedValue({ count: 1 }),
      count: jest.fn().mockResolvedValue(0),
    },
  };
}

describe('MemoryService', () => {
  const originalFetch = global.fetch;

  afterEach(() => {
    global.fetch = originalFetch;
    jest.restoreAllMocks();
  });

  describe('list/remove/removeAll', () => {
    it('lists notes newest-first for the given user', async () => {
      const prisma = createPrisma();
      const service = new MemoryService(prisma as never, createConfig({}));

      await service.list('user-1');

      expect(prisma.userMemoryNote.findMany).toHaveBeenCalledWith({
        where: { userId: 'user-1' },
        orderBy: { createdAt: 'desc' },
      });
    });

    it('throws NotFoundException when deleting a note that does not belong to the user', async () => {
      const prisma = createPrisma();
      prisma.userMemoryNote.deleteMany.mockResolvedValue({ count: 0 });
      const service = new MemoryService(prisma as never, createConfig({}));

      await expect(service.remove('user-1', 'note-1')).rejects.toThrow(
        NotFoundException,
      );
    });

    it('deletes a note scoped to the owning user', async () => {
      const prisma = createPrisma();
      const service = new MemoryService(prisma as never, createConfig({}));

      await service.remove('user-1', 'note-1');

      expect(prisma.userMemoryNote.deleteMany).toHaveBeenCalledWith({
        where: { id: 'note-1', userId: 'user-1' },
      });
    });

    it('removeAll deletes every note for the user', async () => {
      const prisma = createPrisma();
      const service = new MemoryService(prisma as never, createConfig({}));

      await service.removeAll('user-1');

      expect(prisma.userMemoryNote.deleteMany).toHaveBeenCalledWith({
        where: { userId: 'user-1' },
      });
    });
  });

  describe('notesForPrompt', () => {
    it('returns null when the user has no notes (so callers skip an empty system message)', async () => {
      const prisma = createPrisma();
      const service = new MemoryService(prisma as never, createConfig({}));

      await expect(service.notesForPrompt('user-1')).resolves.toBeNull();
    });

    it('returns notes oldest-first, capped at MEMORY_NOTES_INJECTED', async () => {
      const prisma = createPrisma();
      prisma.userMemoryNote.findMany.mockResolvedValue([
        { content: 'newest' },
        { content: 'oldest' },
      ]);
      const service = new MemoryService(prisma as never, createConfig({}));

      const notes = await service.notesForPrompt('user-1');

      expect(notes).toEqual(['oldest', 'newest']);
      expect(prisma.userMemoryNote.findMany).toHaveBeenCalledWith({
        where: { userId: 'user-1' },
        orderBy: { createdAt: 'desc' },
        take: MEMORY_NOTES_INJECTED,
        select: { content: true },
      });
    });
  });

  describe('extractFromExchange', () => {
    it('does nothing when MEMORY_EXTRACTION_MODEL is unset', async () => {
      const prisma = createPrisma();
      global.fetch = jest.fn();
      const service = new MemoryService(prisma as never, createConfig({}));

      await service.extractFromExchange('user-1', 'session-1', 'hi', 'hello');

      expect(global.fetch).not.toHaveBeenCalled();
      expect(prisma.userMemoryNote.create).not.toHaveBeenCalled();
    });

    it('does nothing when OLLAMA_BASE_URL is unset', async () => {
      const prisma = createPrisma();
      global.fetch = jest.fn();
      const service = new MemoryService(
        prisma as never,
        createConfig({ MEMORY_EXTRACTION_MODEL: 'llama3.2:3b' }),
      );

      await service.extractFromExchange('user-1', 'session-1', 'hi', 'hello');

      expect(global.fetch).not.toHaveBeenCalled();
    });

    it('calls Ollama /api/generate with a JSON-forced extraction prompt', async () => {
      const prisma = createPrisma();
      global.fetch = jest.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ response: '[]' }),
      });
      const service = new MemoryService(
        prisma as never,
        createConfig({
          MEMORY_EXTRACTION_MODEL: 'llama3.2:3b',
          OLLAMA_BASE_URL: 'http://ollama.local',
        }),
      );

      await service.extractFromExchange(
        'user-1',
        'session-1',
        'I live in Bangkok',
        'Got it, noted.',
      );

      expect(global.fetch).toHaveBeenCalledWith(
        'http://ollama.local/api/generate',
        expect.objectContaining({
          method: 'POST',
          body: expect.stringContaining('"model":"llama3.2:3b"'),
        }),
      );
      const body = JSON.parse(
        (global.fetch as jest.Mock).mock.calls[0][1].body,
      );
      expect(body.format).toBe('json');
      expect(body.stream).toBe(false);
      expect(body.prompt).toContain('I live in Bangkok');
      expect(body.prompt).toContain('Got it, noted.');
    });

    it('stores each extracted fact as a note', async () => {
      const prisma = createPrisma();
      global.fetch = jest.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          response: JSON.stringify(['Lives in Bangkok', 'Prefers dark mode']),
        }),
      });
      const service = new MemoryService(
        prisma as never,
        createConfig({
          MEMORY_EXTRACTION_MODEL: 'llama3.2:3b',
          OLLAMA_BASE_URL: 'http://ollama.local',
        }),
      );

      await service.extractFromExchange('user-1', 'session-1', 'q', 'a');

      expect(prisma.userMemoryNote.create).toHaveBeenCalledTimes(2);
      expect(prisma.userMemoryNote.create).toHaveBeenCalledWith({
        data: {
          userId: 'user-1',
          content: 'Lives in Bangkok',
          sourceSessionId: 'session-1',
        },
      });
    });

    it('stores facts from the requested {"facts": [...]} wrapper shape', async () => {
      const prisma = createPrisma();
      global.fetch = jest.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          response: JSON.stringify({ facts: ['Lives in Bangkok', 'Prefers dark mode'] }),
        }),
      });
      const service = new MemoryService(
        prisma as never,
        createConfig({
          MEMORY_EXTRACTION_MODEL: 'llama3.2:3b',
          OLLAMA_BASE_URL: 'http://ollama.local',
        }),
      );

      await service.extractFromExchange('user-1', 'session-1', 'q', 'a');

      expect(prisma.userMemoryNote.create).toHaveBeenCalledTimes(2);
    });

    it('falls back to a flat object’s string values when the model ignores the wrapper shape', async () => {
      // Confirmed by hand against a real local model (qwen2.5-coder:14b via
      // Ollama): asked for {"facts": [...]}, it sometimes instead returns its
      // own invented flat object, e.g. {"location": "Bangkok", "ui": "dark
      // mode"}. Discarding a well-formed extraction just because of the
      // wrapper shape would silently lose real signal.
      const prisma = createPrisma();
      global.fetch = jest.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          response: JSON.stringify({ location: 'Bangkok', ui: 'dark mode' }),
        }),
      });
      const service = new MemoryService(
        prisma as never,
        createConfig({
          MEMORY_EXTRACTION_MODEL: 'llama3.2:3b',
          OLLAMA_BASE_URL: 'http://ollama.local',
        }),
      );

      await service.extractFromExchange('user-1', 'session-1', 'q', 'a');

      expect(prisma.userMemoryNote.create).toHaveBeenCalledTimes(2);
      expect(prisma.userMemoryNote.create).toHaveBeenCalledWith({
        data: { userId: 'user-1', content: 'Bangkok', sourceSessionId: 'session-1' },
      });
      expect(prisma.userMemoryNote.create).toHaveBeenCalledWith({
        data: { userId: 'user-1', content: 'dark mode', sourceSessionId: 'session-1' },
      });
    });

    it('skips a fact that already exists (case-insensitive)', async () => {
      const prisma = createPrisma();
      prisma.userMemoryNote.findFirst.mockResolvedValue({ id: 'existing' });
      global.fetch = jest.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ response: JSON.stringify(['Lives in Bangkok']) }),
      });
      const service = new MemoryService(
        prisma as never,
        createConfig({
          MEMORY_EXTRACTION_MODEL: 'llama3.2:3b',
          OLLAMA_BASE_URL: 'http://ollama.local',
        }),
      );

      await service.extractFromExchange('user-1', 'session-1', 'q', 'a');

      expect(prisma.userMemoryNote.create).not.toHaveBeenCalled();
    });

    it('skips a fact longer than MAX_MEMORY_NOTE_BYTES', async () => {
      const prisma = createPrisma();
      const tooLong = 'a'.repeat(MAX_MEMORY_NOTE_BYTES + 1);
      global.fetch = jest.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ response: JSON.stringify([tooLong]) }),
      });
      const service = new MemoryService(
        prisma as never,
        createConfig({
          MEMORY_EXTRACTION_MODEL: 'llama3.2:3b',
          OLLAMA_BASE_URL: 'http://ollama.local',
        }),
      );

      await service.extractFromExchange('user-1', 'session-1', 'q', 'a');

      expect(prisma.userMemoryNote.create).not.toHaveBeenCalled();
    });

    it('ignores malformed JSON from the model without throwing', async () => {
      const prisma = createPrisma();
      global.fetch = jest.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ response: 'not json' }),
      });
      const service = new MemoryService(
        prisma as never,
        createConfig({
          MEMORY_EXTRACTION_MODEL: 'llama3.2:3b',
          OLLAMA_BASE_URL: 'http://ollama.local',
        }),
      );

      await expect(
        service.extractFromExchange('user-1', 'session-1', 'q', 'a'),
      ).resolves.toBeUndefined();
      expect(prisma.userMemoryNote.create).not.toHaveBeenCalled();
    });

    it('never throws when Ollama is unreachable', async () => {
      const prisma = createPrisma();
      global.fetch = jest.fn().mockRejectedValue(new Error('ECONNREFUSED'));
      const service = new MemoryService(
        prisma as never,
        createConfig({
          MEMORY_EXTRACTION_MODEL: 'llama3.2:3b',
          OLLAMA_BASE_URL: 'http://ollama.local',
        }),
      );

      await expect(
        service.extractFromExchange('user-1', 'session-1', 'q', 'a'),
      ).resolves.toBeUndefined();
    });

    it('evicts the oldest notes once a user exceeds MAX_MEMORY_NOTES_PER_USER', async () => {
      const prisma = createPrisma();
      prisma.userMemoryNote.count.mockResolvedValue(MAX_MEMORY_NOTES_PER_USER + 1);
      prisma.userMemoryNote.findMany.mockResolvedValue([{ id: 'oldest-note' }]);
      global.fetch = jest.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ response: JSON.stringify(['New fact']) }),
      });
      const service = new MemoryService(
        prisma as never,
        createConfig({
          MEMORY_EXTRACTION_MODEL: 'llama3.2:3b',
          OLLAMA_BASE_URL: 'http://ollama.local',
        }),
      );

      await service.extractFromExchange('user-1', 'session-1', 'q', 'a');

      expect(prisma.userMemoryNote.deleteMany).toHaveBeenCalledWith({
        where: { id: { in: ['oldest-note'] } },
      });
    });
  });
});
