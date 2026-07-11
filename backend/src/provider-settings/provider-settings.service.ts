import { BadRequestException, Injectable } from '@nestjs/common';
import { AiProvider } from '@prisma/client';
import { AuditLogService } from '../common/audit-log.service';
import { PrismaService } from '../prisma/prisma.service';
import { ApiKeyEncryptionService } from './api-key-encryption.service';

const API_KEY_PROVIDERS = new Set<AiProvider>(['claude', 'openai']);

/**
 * Static capability metadata per provider, consumed by the frontend model
 * selector. Ollama has no fixed catalog (it's locally configured and the
 * user can run whatever model they've pulled), so its list is empty.
 *
 * The claude/openai model IDs below are illustrative current-generation
 * placeholders meant to wire the shape end-to-end, not a guarantee that
 * these exact IDs exist upstream — update this list as the real catalogs
 * change; nothing else needs to change to pick up new values.
 */
const PROVIDER_MODELS: Record<AiProvider, string[]> = {
  ollama: [],
  claude: ['claude-sonnet-5', 'claude-opus-4-8', 'claude-haiku-4-5'],
  openai: ['gpt-5.1', 'gpt-5.1-mini'],
};

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

export interface ConnectionTestResult {
  success: boolean;
  message?: string;
}

async function extractUpstreamErrorMessage(
  response: Response,
): Promise<string | undefined> {
  try {
    const body = (await response.json()) as {
      error?: { message?: string };
    };
    return body?.error?.message;
  } catch {
    return undefined;
  }
}

@Injectable()
export class ProviderSettingsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly encryption: ApiKeyEncryptionService,
    private readonly auditLog: AuditLogService,
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
      models: PROVIDER_MODELS[provider],
    }));
  }

  /** Existence check only — never decrypts the key. Used to gate session creation. */
  async hasApiKey(userId: string, provider: AiProvider): Promise<boolean> {
    if (!API_KEY_PROVIDERS.has(provider)) return true;
    const credential = await this.prisma.providerCredential.findUnique({
      where: { userId_provider: { userId, provider } },
      select: { provider: true },
    });
    return credential !== null;
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
    this.auditLog.record('provider_credential.upsert', {
      userId,
      provider,
      outcome: 'success',
    });
  }

  async removeApiKey(userId: string, provider: string) {
    assertApiKeyProvider(provider);
    await this.prisma.providerCredential.deleteMany({
      where: { userId, provider },
    });
    this.auditLog.record('provider_credential.remove', {
      userId,
      provider,
      outcome: 'success',
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

  /**
   * Makes one minimal real request to the provider using the user's stored
   * key to confirm it is valid and the provider is reachable. Never returns
   * or logs the key itself — only a success flag and a human-readable
   * failure reason (auth failure vs. network/upstream failure).
   */
  async testConnection(
    userId: string,
    provider: string,
  ): Promise<ConnectionTestResult> {
    assertApiKeyProvider(provider);
    const credential = await this.prisma.providerCredential.findUnique({
      where: { userId_provider: { userId, provider } },
    });
    if (!credential) {
      return { success: false, message: 'No API key configured' };
    }
    const apiKey = this.encryption.decrypt(credential.encryptedApiKey);
    return provider === 'claude'
      ? testClaudeConnection(apiKey)
      : testOpenAiConnection(apiKey);
  }
}

async function testClaudeConnection(
  apiKey: string,
): Promise<ConnectionTestResult> {
  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5',
        max_tokens: 1,
        messages: [{ role: 'user', content: 'ping' }],
      }),
    });
    if (response.ok) return { success: true };
    if (response.status === 401 || response.status === 403) {
      return { success: false, message: 'Invalid or revoked API key' };
    }
    const upstreamMessage = await extractUpstreamErrorMessage(response);
    return {
      success: false,
      message: upstreamMessage ?? `Claude returned HTTP ${response.status}`,
    };
  } catch (error) {
    return {
      success: false,
      message: `Could not reach Claude: ${(error as Error).message}`,
    };
  }
}

async function testOpenAiConnection(
  apiKey: string,
): Promise<ConnectionTestResult> {
  try {
    const response = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: 'gpt-5.1-mini',
        max_tokens: 1,
        messages: [{ role: 'user', content: 'ping' }],
      }),
    });
    if (response.ok) return { success: true };
    if (response.status === 401 || response.status === 403) {
      return { success: false, message: 'Invalid or revoked API key' };
    }
    const upstreamMessage = await extractUpstreamErrorMessage(response);
    return {
      success: false,
      message: upstreamMessage ?? `OpenAI returned HTTP ${response.status}`,
    };
  } catch (error) {
    return {
      success: false,
      message: `Could not reach OpenAI: ${(error as Error).message}`,
    };
  }
}
