import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { resolveInWorkspace, workspaceRelative, WorkspaceError } from './workspace';

describe('resolveInWorkspace', () => {
  let root: string;
  let outsideDir: string;

  beforeEach(() => {
    root = mkdtempSync(path.join(tmpdir(), 'host-bridge-ws-'));
    outsideDir = mkdtempSync(path.join(tmpdir(), 'host-bridge-outside-'));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
    rmSync(outsideDir, { recursive: true, force: true });
  });

  it('resolves a plain relative path inside the root', async () => {
    writeFileSync(path.join(root, 'file.txt'), 'hello');
    const resolved = await resolveInWorkspace(root, 'file.txt');
    expect(resolved).toBe(path.join(root, 'file.txt'));
  });

  it('resolves a nested relative path, creating no assumptions about existence', async () => {
    const resolved = await resolveInWorkspace(root, path.join('a', 'b', 'c.txt'));
    expect(resolved).toBe(path.join(root, 'a', 'b', 'c.txt'));
  });

  it('treats "" as the root itself', async () => {
    const resolved = await resolveInWorkspace(root, '');
    expect(resolved).toBe(root);
  });

  it('treats "." as the root itself', async () => {
    const resolved = await resolveInWorkspace(root, '.');
    expect(resolved).toBe(root);
  });

  it('rejects a ".." traversal that escapes the root', async () => {
    await expect(resolveInWorkspace(root, '..')).rejects.toThrow(WorkspaceError);
    await expect(resolveInWorkspace(root, path.join('..', 'secret.txt'))).rejects.toThrow(
      WorkspaceError,
    );
  });

  it('rejects a ".." traversal buried inside an otherwise nested path', async () => {
    await expect(
      resolveInWorkspace(root, path.join('a', '..', '..', 'secret.txt')),
    ).rejects.toThrow(WorkspaceError);
  });

  it('rejects an absolute path', async () => {
    await expect(resolveInWorkspace(root, outsideDir)).rejects.toThrow(WorkspaceError);
  });

  it('rejects a drive-relative Windows path (C:foo)', async () => {
    await expect(resolveInWorkspace(root, 'C:foo')).rejects.toThrow(WorkspaceError);
  });

  it('rejects a UNC-style path', async () => {
    await expect(resolveInWorkspace(root, '\\\\evil-host\\share\\file.txt')).rejects.toThrow(
      WorkspaceError,
    );
  });

  it('rejects a path containing a NUL byte', async () => {
    await expect(resolveInWorkspace(root, 'file.txt\0.png')).rejects.toThrow(WorkspaceError);
  });

  it('throws a 400 WorkspaceError for traversal', async () => {
    await expect(resolveInWorkspace(root, '..')).rejects.toMatchObject({ status: 400 });
  });

  it('throws a 503 WorkspaceError when the root does not exist', async () => {
    const missingRoot = path.join(root, 'does-not-exist-root');
    await expect(resolveInWorkspace(missingRoot, 'file.txt')).rejects.toMatchObject({
      status: 503,
    });
  });

  describe('symlink escape defence', () => {
    it('rejects a symlink inside the root that points outside it', async () => {
      const linkPath = path.join(root, 'escape');
      try {
        symlinkSync(outsideDir, linkPath, 'junction');
      } catch (err) {
        // Creating filesystem symlinks/junctions can require elevated privileges on
        // Windows (SeCreateSymbolicLinkPrivilege) unless Developer Mode is on — skip
        // rather than fail the suite in an environment where that isn't available.
        // eslint-disable-next-line no-console
        console.warn(`Skipping symlink escape test: unable to create symlink (${(err as Error).message})`);
        return;
      }

      await expect(resolveInWorkspace(root, path.join('escape', 'secret.txt'))).rejects.toThrow(
        WorkspaceError,
      );
    });

    it('resolves a symlink that points to somewhere still inside the root', async () => {
      const realDir = path.join(root, 'real');
      mkdirSync(realDir);
      const linkPath = path.join(root, 'link');
      try {
        symlinkSync(realDir, linkPath, 'junction');
      } catch (err) {
        // eslint-disable-next-line no-console
        console.warn(`Skipping in-root symlink test: unable to create symlink (${(err as Error).message})`);
        return;
      }

      await expect(resolveInWorkspace(root, path.join('link', 'file.txt'))).resolves.toBeDefined();
    });
  });
});

describe('workspaceRelative', () => {
  it('returns a forward-slashed path relative to the root', () => {
    const root = path.join('C:', 'ws');
    const abs = path.join(root, 'a', 'b.txt');
    expect(workspaceRelative(root, abs)).toBe('a/b.txt');
  });

  it('returns "." for the root itself', () => {
    const root = path.join('C:', 'ws');
    expect(workspaceRelative(root, root)).toBe('.');
  });
});
