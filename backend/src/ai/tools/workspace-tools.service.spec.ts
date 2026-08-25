import { WorkspaceToolsService } from './workspace-tools.service';
import {
  WorkspaceBridgeClient,
  WorkspaceBridgeError,
} from './workspace-bridge.client';
import { OllamaToolCall } from './tool.types';

/**
 * Deliberately declared with plain `jest.Mock` *properties* rather than as
 * `jest.Mocked<WorkspaceBridgeClient>`: asserting on `mock.write` off a value typed as
 * the real class trips `@typescript-eslint/unbound-method`, which exists because a class
 * method read without calling it loses its `this`. These are standalone `jest.fn()`s with
 * no `this` to lose, so the rule has nothing to protect here — expressing that in the type
 * is cleaner than disabling the rule at each assertion.
 */
interface BridgeClientMock {
  isConfigured: jest.Mock;
  status: jest.Mock;
  list: jest.Mock;
  read: jest.Mock;
  write: jest.Mock;
  search: jest.Mock;
  exec: jest.Mock;
}

function createBridgeClientMock(
  overrides: Partial<BridgeClientMock> = {},
): BridgeClientMock {
  return {
    isConfigured: jest.fn().mockReturnValue(true),
    status: jest.fn(),
    list: jest.fn(),
    read: jest.fn(),
    write: jest.fn(),
    search: jest.fn(),
    exec: jest.fn(),
    ...overrides,
  };
}

/** The one cast, kept in a single place instead of repeated at every construction site. */
function asClient(mock: BridgeClientMock): WorkspaceBridgeClient {
  return mock as unknown as WorkspaceBridgeClient;
}

function toolCall(name: string, args: unknown): OllamaToolCall {
  return { function: { name, arguments: args as Record<string, unknown> } };
}

describe('WorkspaceToolsService', () => {
  const signal = new AbortController().signal;

  describe('isEnabled', () => {
    it('is false when the underlying bridge client is not configured', () => {
      const bridgeClient = createBridgeClientMock({
        isConfigured: jest.fn().mockReturnValue(false),
      });
      const service = new WorkspaceToolsService(asClient(bridgeClient));

      expect(service.isEnabled()).toBe(false);
    });

    it('is true when the underlying bridge client is configured', () => {
      const bridgeClient = createBridgeClientMock({
        isConfigured: jest.fn().mockReturnValue(true),
      });
      const service = new WorkspaceToolsService(asClient(bridgeClient));

      expect(service.isEnabled()).toBe(true);
    });
  });

  describe('definitions', () => {
    it('returns exactly the five fixed tool names with accurate required arrays', () => {
      const service = new WorkspaceToolsService(
        asClient(createBridgeClientMock()),
      );
      const defs = service.definitions();
      const byName = Object.fromEntries(defs.map((d) => [d.function.name, d]));

      expect(Object.keys(byName).sort()).toEqual([
        'list_files',
        'read_file',
        'run_command',
        'search_files',
        'write_file',
      ]);

      expect(byName.list_files.function.parameters.required).toEqual([]);
      expect(byName.read_file.function.parameters.required).toEqual(['path']);
      expect(byName.write_file.function.parameters.required).toEqual([
        'path',
        'content',
      ]);
      expect(byName.search_files.function.parameters.required).toEqual([
        'query',
      ]);
      expect(byName.run_command.function.parameters.required).toEqual([
        'command',
      ]);
    });
  });

  describe('execute', () => {
    it('returns ok:false listing valid tool names for an unknown tool', async () => {
      const service = new WorkspaceToolsService(
        asClient(createBridgeClientMock()),
      );

      const result = await service.execute(
        toolCall('delete_everything', {}),
        signal,
      );

      expect(result.ok).toBe(false);
      expect(result.content).toContain('Unknown tool');
      expect(result.content).toContain('list_files');
      expect(result.content).toContain('run_command');
    });

    it('returns ok:false naming the missing argument when a required arg is absent', async () => {
      const service = new WorkspaceToolsService(
        asClient(createBridgeClientMock()),
      );

      const result = await service.execute(toolCall('read_file', {}), signal);

      expect(result.ok).toBe(false);
      expect(result.content).toContain('path');
    });

    it('returns ok:false naming the missing argument when a required arg is blank', async () => {
      const service = new WorkspaceToolsService(
        asClient(createBridgeClientMock()),
      );

      const result = await service.execute(
        toolCall('search_files', { query: '   ' }),
        signal,
      );

      expect(result.ok).toBe(false);
      expect(result.content).toContain('query');
    });

    it('surfaces a bridge error to the model as ok:false instead of throwing', async () => {
      const bridgeClient = createBridgeClientMock({
        read: jest
          .fn()
          .mockRejectedValue(
            new WorkspaceBridgeError('path escapes workspace', 400),
          ),
      });
      const service = new WorkspaceToolsService(asClient(bridgeClient));

      const result = await service.execute(
        toolCall('read_file', { path: '../../etc/passwd' }),
        signal,
      );

      expect(result.ok).toBe(false);
      expect(result.content).toContain('path escapes workspace');
    });

    it('does not throw when the bridge call rejects with a plain, non-bridge error', async () => {
      const bridgeClient = createBridgeClientMock({
        list: jest.fn().mockRejectedValue(new Error('boom')),
      });
      const service = new WorkspaceToolsService(asClient(bridgeClient));

      const result = await service.execute(toolCall('list_files', {}), signal);

      expect(result.ok).toBe(false);
      expect(result.content).toContain('boom');
    });

    it('returns ok:true with a sensible summary for a successful write_file', async () => {
      const bridgeClient = createBridgeClientMock({
        write: jest.fn().mockResolvedValue({
          path: 'src/app.ts',
          bytes: 412,
          created: false,
        }),
      });
      const service = new WorkspaceToolsService(asClient(bridgeClient));

      const result = await service.execute(
        toolCall('write_file', {
          path: 'src/app.ts',
          content: 'export const x = 1;',
        }),
        signal,
      );

      expect(result.ok).toBe(true);
      expect(result.summary).toBe('write_file(src/app.ts) → 412 bytes');
      expect(bridgeClient.write).toHaveBeenCalledWith(
        { path: 'src/app.ts', content: 'export const x = 1;' },
        signal,
      );
    });

    it('parses arguments that arrive JSON-string-encoded instead of as an object', async () => {
      const bridgeClient = createBridgeClientMock({
        read: jest.fn().mockResolvedValue({
          path: 'README.md',
          content: 'hello',
          bytes: 5,
          truncated: false,
        }),
      });
      const service = new WorkspaceToolsService(asClient(bridgeClient));

      const call: OllamaToolCall = {
        function: {
          name: 'read_file',
          // Cast through unknown: this deliberately violates the declared
          // Record<string, unknown> type to reproduce the real, observed shape
          // some models emit — the whole arguments object as a JSON string.
          arguments: JSON.stringify({
            path: 'README.md',
          }) as unknown as Record<string, unknown>,
        },
      };

      const result = await service.execute(call, signal);

      expect(result.ok).toBe(true);
      expect(bridgeClient.read).toHaveBeenCalledWith(
        { path: 'README.md' },
        signal,
      );
    });

    it('coerces a non-string argument (e.g. a number) to a string defensively', async () => {
      const bridgeClient = createBridgeClientMock({
        read: jest.fn().mockResolvedValue({
          path: '123',
          content: 'numeric filename',
          bytes: 17,
          truncated: false,
        }),
      });
      const service = new WorkspaceToolsService(asClient(bridgeClient));

      const result = await service.execute(
        toolCall('read_file', { path: 123 }),
        signal,
      );

      expect(result.ok).toBe(true);
      expect(bridgeClient.read).toHaveBeenCalledWith({ path: '123' }, signal);
    });

    it('marks a truncated read_file result with an explicit marker', async () => {
      const bridgeClient = createBridgeClientMock({
        read: jest.fn().mockResolvedValue({
          path: 'big.log',
          content: 'partial content',
          bytes: 20_000,
          truncated: true,
        }),
      });
      const service = new WorkspaceToolsService(asClient(bridgeClient));

      const result = await service.execute(
        toolCall('read_file', { path: 'big.log' }),
        signal,
      );

      expect(result.ok).toBe(true);
      expect(result.content).toContain('[truncated at 20000 bytes]');
      expect(result.summary).toContain('truncated');
    });

    it('renders search_files results as path:line: text lines', async () => {
      const bridgeClient = createBridgeClientMock({
        search: jest.fn().mockResolvedValue({
          matches: [{ path: 'src/app.ts', line: 12, text: 'const x = 1;' }],
          truncated: false,
        }),
      });
      const service = new WorkspaceToolsService(asClient(bridgeClient));

      const result = await service.execute(
        toolCall('search_files', { query: 'const x' }),
        signal,
      );

      expect(result.ok).toBe(true);
      expect(result.content).toBe('src/app.ts:12: const x = 1;');
    });

    it('reports "no matches" plainly when search_files finds nothing', async () => {
      const bridgeClient = createBridgeClientMock({
        search: jest.fn().mockResolvedValue({ matches: [], truncated: false }),
      });
      const service = new WorkspaceToolsService(asClient(bridgeClient));

      const result = await service.execute(
        toolCall('search_files', { query: 'nothing-matches-this' }),
        signal,
      );

      expect(result.ok).toBe(true);
      expect(result.content).toBe('no matches');
    });

    it('truncates run_command stdout/stderr fed to the model beyond the tighter cap', async () => {
      const bridgeClient = createBridgeClientMock({
        exec: jest.fn().mockResolvedValue({
          command: 'pnpm',
          exitCode: 0,
          stdout: 'x'.repeat(5_000),
          stderr: '',
          timedOut: false,
        }),
      });
      const service = new WorkspaceToolsService(asClient(bridgeClient));

      const result = await service.execute(
        toolCall('run_command', { command: 'pnpm', args: ['test'] }),
        signal,
      );

      expect(result.ok).toBe(true);
      expect(result.content).toContain('...[truncated at 4000 chars]');
      expect(result.content.length).toBeLessThan(5_000);
      expect(bridgeClient.exec).toHaveBeenCalledWith(
        { command: 'pnpm', args: ['test'] },
        signal,
      );
    });
  });
});
