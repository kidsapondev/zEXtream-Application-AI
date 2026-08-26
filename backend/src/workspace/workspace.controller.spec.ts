import {
  ForbiddenException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { WorkspaceController } from './workspace.controller';
import { WorkspaceBridgeClient } from '../ai/tools/workspace-bridge.client';
import { WorkspaceToolsService } from '../ai/tools/workspace-tools.service';

/**
 * Property-typed rather than `jest.Mocked<WorkspaceBridgeClient>`: asserting on `bridge.read`
 * off a value typed as the real class trips `@typescript-eslint/unbound-method`, and these
 * are standalone `jest.fn()`s with no `this` to lose.
 */
interface BridgeMock {
  status: jest.Mock;
  list: jest.Mock;
  read: jest.Mock;
  write: jest.Mock;
  search: jest.Mock;
  exec: jest.Mock;
}

const HEALTHY = {
  available: true,
  root: 'D:\\work',
  execEnabled: true,
  allowedCommands: ['git'],
  maxFileBytes: 256_000,
};

function createBridge(overrides: Partial<BridgeMock> = {}): BridgeMock {
  return {
    status: jest.fn().mockResolvedValue(HEALTHY),
    list: jest.fn().mockResolvedValue({ path: '.', entries: [] }),
    read: jest.fn().mockResolvedValue({
      path: 'a.ts',
      content: 'x',
      bytes: 1,
      truncated: false,
    }),
    write: jest
      .fn()
      .mockResolvedValue({ path: 'a.ts', bytes: 1, created: false }),
    search: jest.fn().mockResolvedValue({ matches: [], truncated: false }),
    exec: jest.fn().mockResolvedValue({
      command: 'git',
      exitCode: 0,
      stdout: '',
      stderr: '',
      timedOut: false,
    }),
    ...overrides,
  };
}

function createController(
  bridge: BridgeMock,
  { enabled = true }: { enabled?: boolean } = {},
): WorkspaceController {
  const tools = {
    isEnabled: () => enabled,
  } as unknown as WorkspaceToolsService;
  return new WorkspaceController(
    bridge as unknown as WorkspaceBridgeClient,
    tools,
  );
}

describe('WorkspaceController', () => {
  describe('when the workspace is not configured', () => {
    it('still answers status, since that is where the explanation lives', async () => {
      // Failing this route would hide the very message telling the user what to configure.
      const bridge = createBridge({
        status: jest.fn().mockResolvedValue({ ...HEALTHY, available: false }),
      });

      await expect(
        createController(bridge, { enabled: false }).status(),
      ).resolves.toMatchObject({ available: false });
    });

    it.each([
      ['list', (c: WorkspaceController) => c.list('')],
      ['read', (c: WorkspaceController) => c.read({ path: 'a.ts' })],
      [
        'write',
        (c: WorkspaceController) => c.write({ path: 'a.ts', content: 'x' }),
      ],
      ['search', (c: WorkspaceController) => c.search({ query: 'x' })],
      ['exec', (c: WorkspaceController) => c.exec({ command: 'git' })],
    ])(
      'refuses %s with a message naming both settings',
      async (_name, call) => {
        const controller = createController(createBridge(), { enabled: false });

        await expect(call(controller)).rejects.toBeInstanceOf(
          ServiceUnavailableException,
        );
        await expect(call(controller)).rejects.toThrow(/BRIDGE_WORKSPACE_ROOT/);
      },
    );
  });

  describe('file operations', () => {
    it('lists the root when no path is given', async () => {
      const bridge = createBridge();

      await createController(bridge).list(undefined);

      expect(bridge.list).toHaveBeenCalledWith({ path: '' });
    });

    it('passes the path through untouched', async () => {
      // Deliberately no normalisation here: the host-bridge resolves against the real
      // filesystem, and a second, weaker check would only be a second place to disagree.
      const bridge = createBridge();

      await createController(bridge).read({ path: '../../etc/passwd' });

      expect(bridge.read).toHaveBeenCalledWith({ path: '../../etc/passwd' });
    });

    it('writes the full content', async () => {
      const bridge = createBridge();

      await createController(bridge).write({
        path: 'a.ts',
        content: 'export const x = 1;',
      });

      expect(bridge.write).toHaveBeenCalledWith({
        path: 'a.ts',
        content: 'export const x = 1;',
      });
    });

    it('defaults search scope and leaves maxResults unset when absent', async () => {
      const bridge = createBridge();

      await createController(bridge).search({ query: 'needle' });

      expect(bridge.search).toHaveBeenCalledWith({
        query: 'needle',
        path: '',
        maxResults: undefined,
      });
    });
  });

  describe('exec', () => {
    it('runs an allowlisted command', async () => {
      const bridge = createBridge();

      await createController(bridge).exec({
        command: 'git',
        args: ['status'],
      });

      expect(bridge.exec).toHaveBeenCalledWith({
        command: 'git',
        args: ['status'],
        cwd: '',
      });
    });

    it('reports exec being switched off separately from a refused command', async () => {
      // The two need different fixes from the operator; collapsing them sends the user
      // hunting for the wrong setting.
      const bridge = createBridge({
        status: jest.fn().mockResolvedValue({ ...HEALTHY, execEnabled: false }),
      });
      const controller = createController(bridge);

      await expect(controller.exec({ command: 'git' })).rejects.toBeInstanceOf(
        ForbiddenException,
      );
      await expect(controller.exec({ command: 'git' })).rejects.toThrow(
        /BRIDGE_EXEC_ALLOWLIST/,
      );
      expect(bridge.exec).not.toHaveBeenCalled();
    });
  });
});
