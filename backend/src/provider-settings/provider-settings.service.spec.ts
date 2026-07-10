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
});
