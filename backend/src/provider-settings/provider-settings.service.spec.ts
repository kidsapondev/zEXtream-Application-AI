import { ConfigService } from '@nestjs/config';
import { ProviderSettingsService } from './provider-settings.service';

function createService(configValues: Record<string, string | undefined>) {
  const configService = {
    get: jest.fn((key: string) => configValues[key]),
  };
  return new ProviderSettingsService(configService as unknown as ConfigService);
}

describe('ProviderSettingsService', () => {
  const originalFetch = global.fetch;

  afterEach(() => {
    global.fetch = originalFetch;
  });

  describe('ollama', () => {
    it('reports the live models pulled on the Ollama instance as configured', async () => {
      global.fetch = jest.fn().mockResolvedValue({
        ok: true,
        json: () =>
          Promise.resolve({
            models: [{ name: 'qwen2.5-coder:14b' }, { name: 'llama3' }],
          }),
      }) as never;
      const service = createService({
        OLLAMA_BASE_URL: 'http://localhost:11434',
      });

      const settings = await service.list();

      const ollama = settings.find((s) => s.provider === 'ollama')!;
      expect(ollama.models).toEqual(['qwen2.5-coder:14b', 'llama3']);
      expect(ollama.configured).toBe(true);
      expect(ollama.requiresApiKey).toBe(false);
      const [url, init] = (global.fetch as jest.Mock).mock.calls[0] as [
        string,
        { signal: AbortSignal },
      ];
      expect(url).toBe('http://localhost:11434/api/tags');
      expect(init.signal).toBeInstanceOf(AbortSignal);
    });

    it('reports unconfigured with an empty model list when Ollama is unreachable', async () => {
      global.fetch = jest
        .fn()
        .mockRejectedValue(new Error('ECONNREFUSED')) as never;
      const service = createService({
        OLLAMA_BASE_URL: 'http://localhost:11434',
      });

      const settings = await service.list();

      const ollama = settings.find((s) => s.provider === 'ollama')!;
      expect(ollama.models).toEqual([]);
      expect(ollama.configured).toBe(false);
    });

    it('reports unconfigured when OLLAMA_BASE_URL is unset, without calling fetch', async () => {
      global.fetch = jest.fn() as never;
      const service = createService({});

      const available = await service.isProviderAvailable('ollama');

      expect(available).toBe(false);
      expect(global.fetch).not.toHaveBeenCalled();
    });
  });

  describe('claude/openai (host-bridge)', () => {
    it('reports claude configured with its fixed alias catalog when the bridge confirms it is logged in', async () => {
      global.fetch = jest.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ available: true }),
      }) as never;
      const service = createService({
        CLAUDE_BRIDGE_URL: 'http://127.0.0.1:4171',
        HOST_BRIDGE_TOKEN: 'test-token',
      });

      const available = await service.isProviderAvailable('claude');

      expect(available).toBe(true);
      expect(global.fetch).toHaveBeenCalledWith(
        'http://127.0.0.1:4171/claude/status',
        expect.objectContaining({
          headers: { 'x-bridge-token': 'test-token' },
        }),
      );
    });

    it('reports openai (codex) unconfigured when the bridge reports the CLI is not logged in', async () => {
      global.fetch = jest.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ available: false }),
      }) as never;
      const service = createService({
        CODEX_BRIDGE_URL: 'http://127.0.0.1:4171',
        HOST_BRIDGE_TOKEN: 'test-token',
      });

      const settings = await service.list();

      const openai = settings.find((s) => s.provider === 'openai')!;
      expect(openai.models).toEqual([]);
      expect(openai.configured).toBe(false);
      expect(openai.requiresApiKey).toBe(false);
    });

    it('reports unconfigured when the bridge URL or token is unset, without calling fetch', async () => {
      global.fetch = jest.fn() as never;
      const service = createService({ HOST_BRIDGE_TOKEN: 'test-token' });

      const available = await service.isProviderAvailable('claude');

      expect(available).toBe(false);
      expect(global.fetch).not.toHaveBeenCalled();
    });

    it('reports unconfigured when the bridge itself is unreachable', async () => {
      global.fetch = jest
        .fn()
        .mockRejectedValue(new Error('ECONNREFUSED')) as never;
      const service = createService({
        CODEX_BRIDGE_URL: 'http://127.0.0.1:4171',
        HOST_BRIDGE_TOKEN: 'test-token',
      });

      const available = await service.isProviderAvailable('openai');

      expect(available).toBe(false);
    });
  });

  describe('caching', () => {
    it('does not re-fetch within the cache window for the same provider', async () => {
      const fetchMock = jest.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ models: [{ name: 'llama3' }] }),
      });
      global.fetch = fetchMock as never;
      const service = createService({
        OLLAMA_BASE_URL: 'http://localhost:11434',
      });

      await service.isProviderAvailable('ollama');
      await service.isProviderAvailable('ollama');

      expect(fetchMock).toHaveBeenCalledTimes(1);
    });
  });
});
