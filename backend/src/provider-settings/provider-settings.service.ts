import { BadRequestException, Injectable } from '@nestjs/common';
import { AiProvider } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { ApiKeyEncryptionService } from './api-key-encryption.service';

const API_KEY_PROVIDERS = new Set<AiProvider>(['claude', 'openai']);

function toPrismaBytes(value: Buffer): Uint8Array<ArrayBuffer> {
  return Uint8Array.from(value);
}

function assertApiKeyProvider(
  provider: string,
): asserts provider is AiProvider {
  if (!API_KEY_PROVIDERS.has(provider as AiProvider)) {
    throw new BadRequestException(
      'Only claude and openai accept a provider API key',
    );
  }
}

@Injectable()
export class ProviderSettingsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly encryption: ApiKeyEncryptionService,
  ) {}

  async listForUser(userId: string) {
    const credentials = await this.prisma.providerCredential.findMany({
      where: { userId },
      select: { provider: true, updatedAt: true },
    });
    const configured = new Map(
      credentials.map((credential) => [
        credential.provider,
        credential.updatedAt,
      ]),
    );
    return (['ollama', 'claude', 'openai'] as const).map((provider) => ({
      provider,
      requiresApiKey: provider !== 'ollama',
      configured: provider === 'ollama' || configured.has(provider),
      updatedAt: configured.get(provider) ?? null,
    }));
  }

  async upsertApiKey(userId: string, provider: string, apiKey: string) {
    assertApiKeyProvider(provider);
    const encryptedApiKey = toPrismaBytes(
      this.encryption.encrypt(apiKey.trim()),
    );
    await this.prisma.providerCredential.upsert({
      where: { userId_provider: { userId, provider } },
      create: {
        userId,
        provider,
        encryptedApiKey,
        encryptionVersion: this.encryption.version,
      },
      update: {
        encryptedApiKey,
        encryptionVersion: this.encryption.version,
      },
    });
  }

  async removeApiKey(userId: string, provider: string) {
    assertApiKeyProvider(provider);
    await this.prisma.providerCredential.deleteMany({
      where: { userId, provider },
    });
  }

  async getApiKeyForRuntime(
    userId: string,
    provider: AiProvider,
  ): Promise<string | null> {
    if (!API_KEY_PROVIDERS.has(provider)) return null;
    const credential = await this.prisma.providerCredential.findUnique({
      where: { userId_provider: { userId, provider } },
    });
    return credential
      ? this.encryption.decrypt(credential.encryptedApiKey)
      : null;
  }
}
