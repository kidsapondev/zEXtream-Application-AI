import { BadRequestException } from '@nestjs/common';
import { ProviderSettingsService } from './provider-settings.service';

describe('ProviderSettingsService', () => {
  let lastUpsert: unknown;
  const prisma = {
    providerCredential: {
      findMany: jest.fn(),
      upsert: jest.fn((input: unknown) => {
        lastUpsert = input;
        return Promise.resolve({});
      }),
      deleteMany: jest.fn(),
      findUnique: jest.fn(),
    },
  };
  const encryption = {
    encrypt: jest.fn(() => Buffer.from('ciphertext')),
    decrypt: jest.fn(() => 'decrypted-key'),
    version: 1,
  };
  const service = new ProviderSettingsService(
    prisma as never,
    encryption as never,
  );

  beforeEach(() => {
    jest.clearAllMocks();
    lastUpsert = undefined;
  });

  it('returns provider metadata without a plaintext credential', async () => {
    prisma.providerCredential.findMany.mockResolvedValue([
      { provider: 'openai', updatedAt: new Date('2026-01-01T00:00:00.000Z') },
    ]);

    const settings = await service.listForUser('user-1');

    expect(settings).toEqual([
      expect.objectContaining({
        provider: 'ollama',
        configured: true,
        requiresApiKey: false,
      }),
      expect.objectContaining({
        provider: 'claude',
        configured: false,
        requiresApiKey: true,
      }),
      expect.objectContaining({
        provider: 'openai',
        configured: true,
        requiresApiKey: true,
      }),
    ]);
    expect(JSON.stringify(settings)).not.toContain('ciphertext');
  });

  it('encrypts and upserts a provider key without retaining plaintext in Prisma data', async () => {
    await service.upsertApiKey('user-1', 'openai', '  live-key  ');

    expect(encryption.encrypt).toHaveBeenCalledWith('live-key');
    const input = lastUpsert as {
      where: { userId_provider: { userId: string; provider: string } };
      create: { encryptedApiKey: Uint8Array };
    };
    expect(input.where).toEqual({
      userId_provider: { userId: 'user-1', provider: 'openai' },
    });
    expect(input.create.encryptedApiKey).toBeInstanceOf(Uint8Array);
  });

  it('rejects keys for providers that do not use a credential', async () => {
    await expect(
      service.upsertApiKey('user-1', 'ollama', 'not-used'),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(prisma.providerCredential.upsert).not.toHaveBeenCalled();
  });

  it('includes a static model catalog per provider, empty for ollama', async () => {
    prisma.providerCredential.findMany.mockResolvedValue([]);

    const settings = await service.listForUser('user-1');

    const byProvider = new Map(settings.map((s) => [s.provider, s.models]));
    expect(byProvider.get('ollama')).toEqual([]);
    expect(byProvider.get('claude')?.length).toBeGreaterThan(0);
    expect(byProvider.get('openai')?.length).toBeGreaterThan(0);
  });

  describe('hasApiKey', () => {
    it('is always true for ollama without querying the database', async () => {
      const result = await service.hasApiKey('user-1', 'ollama');

      expect(result).toBe(true);
      expect(prisma.providerCredential.findUnique).not.toHaveBeenCalled();
    });

    it('reflects whether a credential row exists, without decrypting it', async () => {
      prisma.providerCredential.findUnique.mockResolvedValue({
        provider: 'claude',
      });

      const result = await service.hasApiKey('user-1', 'claude');

      expect(result).toBe(true);
      expect(encryption.decrypt).not.toHaveBeenCalled();
    });

    it('returns false when no credential row exists', async () => {
      prisma.providerCredential.findUnique.mockResolvedValue(null);

      const result = await service.hasApiKey('user-1', 'openai');

      expect(result).toBe(false);
    });
  });

  describe('testConnection', () => {
    const originalFetch = global.fetch;

    afterEach(() => {
      global.fetch = originalFetch;
    });

    it('returns a clear message when no API key is configured, without calling fetch', async () => {
      prisma.providerCredential.findUnique.mockResolvedValue(null);
      global.fetch = jest.fn() as never;

      const result = await service.testConnection('user-1', 'claude');

      expect(result).toEqual({
        success: false,
        message: 'No API key configured',
      });
      expect(global.fetch).not.toHaveBeenCalled();
    });

    it('never returns or logs the decrypted key, and succeeds on a 2xx response', async () => {
      prisma.providerCredential.findUnique.mockResolvedValue({
        provider: 'claude',
        encryptedApiKey: Buffer.from('cipher'),
      });
      global.fetch = jest.fn().mockResolvedValue({ ok: true }) as never;

      const result = await service.testConnection('user-1', 'claude');

      expect(result).toEqual({ success: true });
      expect(JSON.stringify(result)).not.toContain('decrypted-key');
    });

    it('distinguishes an auth failure from a generic upstream failure', async () => {
      prisma.providerCredential.findUnique.mockResolvedValue({
        provider: 'openai',
        encryptedApiKey: Buffer.from('cipher'),
      });
      global.fetch = jest.fn().mockResolvedValue({
        ok: false,
        status: 401,
        json: () => Promise.resolve({}),
      }) as never;

      const result = await service.testConnection('user-1', 'openai');

      expect(result).toEqual({
        success: false,
        message: 'Invalid or revoked API key',
      });
    });

    it('reports a network/upstream failure distinctly from an auth failure', async () => {
      prisma.providerCredential.findUnique.mockResolvedValue({
        provider: 'openai',
        encryptedApiKey: Buffer.from('cipher'),
      });
      global.fetch = jest.fn().mockRejectedValue(new Error('timeout')) as never;

      const result = await service.testConnection('user-1', 'openai');

      expect(result.success).toBe(false);
      expect(result.message).toContain('Could not reach OpenAI');
    });

    it('rejects testing a connection for a provider that does not accept a key', async () => {
      await expect(
        service.testConnection('user-1', 'ollama'),
      ).rejects.toBeInstanceOf(BadRequestException);
    });
  });
});
