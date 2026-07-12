import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AiProvider } from '@prisma/client';

const OLLAMA_TAGS_TIMEOUT_MS = 3_000;
const BRIDGE_STATUS_TIMEOUT_MS = 5_000;

/**
 * How long a provider's model list / availability is trusted before re-checking —
 * long enough that `GET /api/settings/providers` polling and back-to-back `chat:send`
 * calls don't spam Ollama's `/api/tags` or spawn `claude auth status`/`codex login
 * status` on every request; short enough that pulling a new Ollama model or the CLI's
 * login state changing is picked up within one refresh, not stale forever.
 */
const AVAILABILITY_CACHE_MS = 10_000;

/**
 * `claude.exe`'s documented model aliases (verified: `--model haiku` works). No fixed
 * catalog endpoint exists to query this live, unlike Ollama's `/api/tags`.
 */
const CLAUDE_MODELS = ['sonnet', 'opus', 'haiku'];

/**
 * The one codex.exe model confirmed to work on this deployment (`~/.codex/config.toml`'s
 * configured default, verified via a real `codex exec` call). Codex has no queryable
 * model-catalog endpoint either, and further aliases weren't tested to avoid running up
 * more billed CLI calls purely to enumerate options — expand this list once other model
 * IDs are confirmed to work.
 */
const CODEX_MODELS = ['gpt-5.6-sol'];

interface CachedModels {
  models: string[];
  checkedAt: number;
}

/**
 * claude/openai no longer call Anthropic/OpenAI's APIs with a per-user key — both
 * providers now call a "host-bridge" service (see `host-bridge/`) that spawns the
 * deployment host's already-logged-in `claude`/`codex` CLIs. Availability is therefore
 * server-wide (is the bridge reachable and the CLI logged in?), not per-user, and
 * `models` reflects what's genuinely usable right now rather than a fixed catalog:
 * Ollama's list comes live from `/api/tags`, and claude/openai (codex) only report
 * their fixed alias list when the bridge confirms the CLI is actually logged in.
 */
@Injectable()
export class ProviderSettingsService {
  private readonly cache = new Map<AiProvider, CachedModels>();

  constructor(private readonly configService: ConfigService) {}

  /** No longer "for" any particular user — availability is server-wide now (see the
   * class doc comment above), kept as a method for symmetry with the rest of the
   * service and in case a future per-user override is ever reintroduced. */
  async list() {
    const providers = await Promise.all(
      (['ollama', 'claude', 'openai'] as const).map(async (provider) => {
        const models = await this.modelsFor(provider);
        return {
          provider,
          requiresApiKey: false,
          configured: models.length > 0,
          updatedAt: null,
          models,
        };
      }),
    );
    return providers;
  }

  async isProviderAvailable(provider: AiProvider): Promise<boolean> {
    const models = await this.modelsFor(provider);
    return models.length > 0;
  }

  private async modelsFor(provider: AiProvider): Promise<string[]> {
    const cached = this.cache.get(provider);
    if (cached && Date.now() - cached.checkedAt < AVAILABILITY_CACHE_MS) {
      return cached.models;
    }
    const models = await this.fetchModels(provider);
    this.cache.set(provider, { models, checkedAt: Date.now() });
    return models;
  }

  private fetchModels(provider: AiProvider): Promise<string[]> {
    if (provider === 'ollama') return this.fetchOllamaModels();
    if (provider === 'claude') {
      return this.fetchBridgeModels(
        'claude',
        'CLAUDE_BRIDGE_URL',
        CLAUDE_MODELS,
      );
    }
    return this.fetchBridgeModels('codex', 'CODEX_BRIDGE_URL', CODEX_MODELS);
  }

  private async fetchOllamaModels(): Promise<string[]> {
    const baseUrl = this.configService.get<string>('OLLAMA_BASE_URL');
    if (!baseUrl) return [];
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), OLLAMA_TAGS_TIMEOUT_MS);
    try {
      const response = await fetch(`${baseUrl}/api/tags`, {
        signal: controller.signal,
      });
      if (!response.ok) return [];
      const body = (await response.json()) as {
        models?: Array<{ name: string }>;
      };
      return (body.models ?? []).map((model) => model.name);
    } catch {
      // Ollama unreachable/timed out — no models are usable, not an error page.
      return [];
    } finally {
      clearTimeout(timer);
    }
  }

  private async fetchBridgeModels(
    kind: 'claude' | 'codex',
    urlEnvKey: 'CLAUDE_BRIDGE_URL' | 'CODEX_BRIDGE_URL',
    catalog: string[],
  ): Promise<string[]> {
    const bridgeUrl = this.configService.get<string>(urlEnvKey);
    const token = this.configService.get<string>('HOST_BRIDGE_TOKEN');
    if (!bridgeUrl || !token) return [];
    const controller = new AbortController();
    const timer = setTimeout(
      () => controller.abort(),
      BRIDGE_STATUS_TIMEOUT_MS,
    );
    try {
      const response = await fetch(`${bridgeUrl}/${kind}/status`, {
        headers: { 'x-bridge-token': token },
        signal: controller.signal,
      });
      if (!response.ok) return [];
      const body = (await response.json()) as { available?: boolean };
      return body.available ? catalog : [];
    } catch {
      return [];
    } finally {
      clearTimeout(timer);
    }
  }
}
