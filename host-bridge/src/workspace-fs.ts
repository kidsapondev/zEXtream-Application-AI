import { promises as fs } from 'fs';
import path from 'path';
import { resolveInWorkspace, workspaceRelative, WorkspaceError } from './workspace';

export interface DirEntry {
  name: string;
  type: 'file' | 'dir';
  size: number;
}

export interface ListDirResult {
  path: string;
  entries: DirEntry[];
}

export interface ReadFileResult {
  path: string;
  content: string;
  bytes: number;
  truncated: boolean;
}

export interface WriteFileResult {
  path: string;
  bytes: number;
  created: boolean;
}

export interface SearchMatch {
  path: string;
  line: number;
  text: string;
}

export interface SearchResult {
  matches: SearchMatch[];
  truncated: boolean;
}

// Directories that are never worth walking into for a text search: dependency/build
// output can be enormous (defeating `maxResults` in the worst way — burning the whole
// search budget on node_modules noise before ever reaching the user's own code) and
// `.git` internals aren't meaningful "text" matches at all.
const SEARCH_SKIP_DIRS = new Set(['node_modules', '.git', 'dist', '.next', 'build']);

const DEFAULT_SEARCH_MAX_RESULTS = 50;
const SEARCH_MAX_RESULTS_CAP = 200;
const SEARCH_LINE_TRIM_LENGTH = 300;
// Only the first slice of a file needs sniffing to tell text from binary — a NUL byte
// this early is a reliable binary signal, and reading more than this defeats the point
// of a cheap pre-check before doing real work on the file.
const BINARY_SNIFF_BYTES = 1024;

/** Lists the immediate (non-recursive) children of a workspace directory. */
export async function listDir(root: string, relPath: string): Promise<ListDirResult> {
  const target = await resolveInWorkspace(root, relPath);
  const stat = await statOrThrow(target);
  if (!stat.isDirectory()) {
    throw new WorkspaceError('Path is not a directory', 400);
  }

  const dirents = await fs.readdir(target, { withFileTypes: true });
  const entries: DirEntry[] = await Promise.all(
    dirents.map(async (dirent) => {
      const entryPath = path.join(target, dirent.name);
      const isDir = dirent.isDirectory();
      // A plain dirent doesn't carry size for files, and symlinked entries need a real
      // stat anyway to know what they actually point at — so stat every entry rather
      // than trusting `dirent.isDirectory()` alone for anything but the type label.
      const size = isDir ? 0 : (await fs.stat(entryPath)).size;
      return { name: dirent.name, type: isDir ? 'dir' : 'file', size } as DirEntry;
    }),
  );

  // Directories first, then alphabetical within each group — the conventional shape for
  // a file browser, and a stable order the caller can render without re-sorting.
  entries.sort((a, b) => {
    if (a.type !== b.type) return a.type === 'dir' ? -1 : 1;
    return a.name.localeCompare(b.name);
  });

  return { path: workspaceRelative(root, target), entries };
}

/** Reads a workspace file, capped at `maxFileBytes` (returned truncated rather than
 * erroring — a partial read is more useful to an LLM than a hard failure on a merely
 * large file). */
export async function readFile(
  root: string,
  relPath: string,
  maxFileBytes: number,
): Promise<ReadFileResult> {
  const target = await resolveInWorkspace(root, relPath);
  const stat = await statOrThrow(target);
  if (stat.isDirectory()) {
    throw new WorkspaceError('Path is a directory, not a file', 400);
  }

  const handle = await fs.open(target, 'r');
  try {
    const truncated = stat.size > maxFileBytes;
    const readLength = truncated ? maxFileBytes : stat.size;
    const buffer = Buffer.alloc(readLength);
    await handle.read(buffer, 0, readLength, 0);
    return {
      path: workspaceRelative(root, target),
      content: buffer.toString('utf8'),
      bytes: readLength,
      truncated,
    };
  } finally {
    await handle.close();
  }
}

/** Writes `content` to a workspace file, creating parent directories as needed. Rejects
 * payloads over `maxFileBytes` up front — better to fail fast with a clear 413 than to
 * let an oversized write from a confused model land partially or blow past the same cap
 * `readFile` enforces (a file this endpoint can write but never fully read back would be
 * a confusing, self-inflicted trap). */
export async function writeFile(
  root: string,
  relPath: string,
  content: string,
  maxFileBytes: number,
): Promise<WriteFileResult> {
  const byteLength = Buffer.byteLength(content, 'utf8');
  if (byteLength > maxFileBytes) {
    throw new WorkspaceError(
      `Content is ${byteLength} bytes, exceeding the ${maxFileBytes}-byte limit`,
      413,
    );
  }

  const target = await resolveInWorkspace(root, relPath);

  const created = !(await pathExists(target));

  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, content, 'utf8');

  return { path: workspaceRelative(root, target), bytes: byteLength, created };
}

/**
 * Recursively searches text files under `relPath` for a case-insensitive substring
 * match. Deliberately plain substring, not a caller-supplied regex: a regex from an
 * untrusted source (here, an LLM whose output can itself be steered by content it has
 * read) is a classic ReDoS foot-gun — a pattern like `(a+)+$` can pin a CPU core
 * indefinitely on ordinary input, and there's no safe way to sandbox arbitrary regex
 * execution short of a timeout-and-kill wrapper that substring matching simply doesn't
 * need.
 *
 * `maxFileBytes` is threaded in explicitly (mirroring `writeFile`'s signature) rather
 * than importing `config` into this module — keeps this file's only dependency the
 * `workspace` boundary, so its tests never need to stub the unrelated claude/codex env
 * vars that `config.ts` requires at import time.
 */
export async function searchText(
  root: string,
  relPath: string,
  query: string,
  maxResults: number,
  maxFileBytes: number,
): Promise<SearchResult> {
  const startDir = await resolveInWorkspace(root, relPath);
  const effectiveMax = Math.min(
    maxResults > 0 ? maxResults : DEFAULT_SEARCH_MAX_RESULTS,
    SEARCH_MAX_RESULTS_CAP,
  );
  const needle = query.toLowerCase();

  const matches: SearchMatch[] = [];
  let truncated = false;

  await walk(startDir);

  return { matches, truncated };

  async function walk(dir: string): Promise<void> {
    if (truncated) return;
    const dirents = await fs.readdir(dir, { withFileTypes: true });
    for (const dirent of dirents) {
      if (truncated) return;
      if (dirent.isDirectory()) {
        if (SEARCH_SKIP_DIRS.has(dirent.name)) continue;
        await walk(path.join(dir, dirent.name));
        continue;
      }
      if (!dirent.isFile()) continue;

      const filePath = path.join(dir, dirent.name);
      const stat = await fs.stat(filePath);
      if (stat.size > maxFileBytes) continue;

      await searchFile(filePath);
    }
  }

  async function searchFile(filePath: string): Promise<void> {
    const buffer = await fs.readFile(filePath);
    if (isLikelyBinary(buffer)) return;

    const text = buffer.toString('utf8');
    const lines = text.split(/\r\n|\r|\n/);
    for (let i = 0; i < lines.length; i++) {
      if (matches.length >= effectiveMax) {
        truncated = true;
        return;
      }
      if (lines[i].toLowerCase().includes(needle)) {
        const line = lines[i];
        matches.push({
          path: workspaceRelative(root, filePath),
          line: i + 1,
          text: line.length > SEARCH_LINE_TRIM_LENGTH ? line.slice(0, SEARCH_LINE_TRIM_LENGTH) : line,
        });
      }
    }
  }
}

function isLikelyBinary(buffer: Buffer): boolean {
  const sniffLength = Math.min(buffer.length, BINARY_SNIFF_BYTES);
  for (let i = 0; i < sniffLength; i++) {
    if (buffer[i] === 0) return true;
  }
  return false;
}

async function statOrThrow(target: string) {
  try {
    return await fs.stat(target);
  } catch {
    throw new WorkspaceError('Path not found', 404);
  }
}

async function pathExists(target: string): Promise<boolean> {
  try {
    await fs.stat(target);
    return true;
  } catch {
    return false;
  }
}
