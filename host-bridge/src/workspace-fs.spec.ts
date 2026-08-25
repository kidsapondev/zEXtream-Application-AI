import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { listDir, readFile, searchText, writeFile } from './workspace-fs';
import { WorkspaceError } from './workspace';

const MAX_FILE_BYTES = 256_000;

describe('workspace-fs', () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(path.join(tmpdir(), 'host-bridge-wsfs-'));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  describe('listDir', () => {
    it('lists files and directories, sorted dirs-first then by name', async () => {
      mkdirSync(path.join(root, 'zdir'));
      mkdirSync(path.join(root, 'adir'));
      writeFileSync(path.join(root, 'bfile.txt'), 'x');
      writeFileSync(path.join(root, 'afile.txt'), 'xy');

      const result = await listDir(root, '.');

      expect(result.entries.map((e) => e.name)).toEqual(['adir', 'zdir', 'afile.txt', 'bfile.txt']);
      expect(result.entries.find((e) => e.name === 'afile.txt')?.size).toBe(2);
      expect(result.entries.find((e) => e.name === 'adir')?.type).toBe('dir');
    });

    it('does not recurse into subdirectories', async () => {
      const sub = path.join(root, 'sub');
      mkdirSync(sub);
      writeFileSync(path.join(sub, 'nested.txt'), 'x');

      const result = await listDir(root, '.');
      expect(result.entries).toHaveLength(1);
      expect(result.entries[0].name).toBe('sub');
    });

    it('throws 404 for a missing path', async () => {
      await expect(listDir(root, 'nope')).rejects.toMatchObject({ status: 404 });
    });

    it('throws 400 when the path is a file, not a directory', async () => {
      writeFileSync(path.join(root, 'file.txt'), 'x');
      await expect(listDir(root, 'file.txt')).rejects.toMatchObject({ status: 400 });
    });
  });

  describe('readFile', () => {
    it('reads a small file fully', async () => {
      writeFileSync(path.join(root, 'file.txt'), 'hello world');
      const result = await readFile(root, 'file.txt', MAX_FILE_BYTES);
      expect(result.content).toBe('hello world');
      expect(result.truncated).toBe(false);
      expect(result.bytes).toBe(11);
    });

    it('truncates a file larger than maxFileBytes instead of erroring', async () => {
      writeFileSync(path.join(root, 'big.txt'), 'a'.repeat(100));
      const result = await readFile(root, 'big.txt', 10);
      expect(result.truncated).toBe(true);
      expect(result.bytes).toBe(10);
      expect(result.content).toBe('a'.repeat(10));
    });

    it('throws 404 for a missing file', async () => {
      await expect(readFile(root, 'missing.txt', MAX_FILE_BYTES)).rejects.toMatchObject({
        status: 404,
      });
    });

    it('throws 400 when the path is a directory', async () => {
      mkdirSync(path.join(root, 'dir'));
      await expect(readFile(root, 'dir', MAX_FILE_BYTES)).rejects.toMatchObject({ status: 400 });
    });
  });

  describe('writeFile', () => {
    it('writes a new file and reports created: true', async () => {
      const result = await writeFile(root, 'new.txt', 'content', MAX_FILE_BYTES);
      expect(result.created).toBe(true);
      expect(result.bytes).toBe(7);
    });

    it('overwrites an existing file and reports created: false', async () => {
      writeFileSync(path.join(root, 'existing.txt'), 'old');
      const result = await writeFile(root, 'existing.txt', 'new-content', MAX_FILE_BYTES);
      expect(result.created).toBe(false);
      const readBack = await readFile(root, 'existing.txt', MAX_FILE_BYTES);
      expect(readBack.content).toBe('new-content');
    });

    it('creates parent directories as needed', async () => {
      await writeFile(root, path.join('a', 'b', 'c.txt'), 'nested', MAX_FILE_BYTES);
      const result = await readFile(root, path.join('a', 'b', 'c.txt'), MAX_FILE_BYTES);
      expect(result.content).toBe('nested');
    });

    it('rejects a payload over maxFileBytes with 413', async () => {
      await expect(writeFile(root, 'too-big.txt', 'x'.repeat(20), 10)).rejects.toMatchObject({
        status: 413,
      });
    });

    it('rejects a traversal attempt', async () => {
      await expect(
        writeFile(root, path.join('..', 'escape.txt'), 'x', MAX_FILE_BYTES),
      ).rejects.toBeInstanceOf(WorkspaceError);
    });
  });

  describe('searchText', () => {
    it('finds a case-insensitive substring match and reports the line number', async () => {
      writeFileSync(path.join(root, 'file.txt'), 'first line\nsecond LINE with Needle\nthird');

      const result = await searchText(root, '.', 'needle', 50, MAX_FILE_BYTES);

      expect(result.matches).toHaveLength(1);
      expect(result.matches[0].line).toBe(2);
      expect(result.matches[0].path).toBe('file.txt');
      expect(result.truncated).toBe(false);
    });

    it('skips node_modules', async () => {
      const nm = path.join(root, 'node_modules', 'pkg');
      mkdirSync(nm, { recursive: true });
      writeFileSync(path.join(nm, 'index.js'), 'needle here');
      writeFileSync(path.join(root, 'app.js'), 'no match here');

      const result = await searchText(root, '.', 'needle', 50, MAX_FILE_BYTES);
      expect(result.matches).toHaveLength(0);
    });

    it('respects maxResults and reports truncated: true', async () => {
      const lines = Array.from({ length: 10 }, (_, i) => `needle ${i}`).join('\n');
      writeFileSync(path.join(root, 'many.txt'), lines);

      const result = await searchText(root, '.', 'needle', 3, MAX_FILE_BYTES);
      expect(result.matches).toHaveLength(3);
      expect(result.truncated).toBe(true);
    });

    it('skips binary files (NUL byte in the first 1KB)', async () => {
      const binaryContent = Buffer.concat([Buffer.from('needle'), Buffer.from([0]), Buffer.from('rest')]);
      writeFileSync(path.join(root, 'binary.dat'), binaryContent);

      const result = await searchText(root, '.', 'needle', 50, MAX_FILE_BYTES);
      expect(result.matches).toHaveLength(0);
    });
  });
});
