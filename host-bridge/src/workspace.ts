import { promises as fs } from 'fs';
import path from 'path';

/** Thrown by every workspace/exec helper so route handlers can map failures to the right
 * HTTP status without each call site having to know the reason (missing root vs.
 * traversal attempt vs. not-found are meaningfully different responses). */
export class WorkspaceError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = 'WorkspaceError';
  }
}

/**
 * Resolves a caller-supplied relative path to an absolute path *proven* to sit inside
 * `root`, or throws `WorkspaceError`. This is the single chokepoint every workspace
 * filesystem/exec operation must go through — get this function wrong and a locally
 * hosted LLM (which we do not fully trust: it can be prompt-injected by content it reads,
 * or simply hallucinate a destructive path) gets read/write/exec access to the whole
 * host instead of the sandboxed folder the operator opted into.
 */
export async function resolveInWorkspace(root: string, relPath: string): Promise<string> {
  // An unset/empty root means the feature is off — callers (workspace-routes.ts) are
  // expected to 503 before reaching here, but we guard anyway so this function is safe
  // to call in isolation (e.g. from tests) without relying on that ordering.
  if (!root) {
    throw new WorkspaceError('Workspace root is not configured', 503);
  }

  // '' and '.' both mean "the workspace root itself" — a very common case (e.g. listing
  // the top-level directory) that shouldn't require callers to special-case it.
  const normalizedInput = relPath === undefined || relPath === null || relPath === '' ? '.' : relPath;

  if (typeof normalizedInput !== 'string') {
    throw new WorkspaceError('Path must be a string', 400);
  }

  // A NUL byte can truncate the string a lower-level OS call sees (a classic
  // path-injection trick — e.g. `foo.txt\0../../secret`), so reject it before any path
  // math trusts the string.
  if (normalizedInput.includes('\0')) {
    throw new WorkspaceError('Path contains a NUL byte', 400);
  }

  // Reject absolute paths outright — `path.resolve(root, '/etc/passwd')` would happily
  // discard `root` and resolve to `/etc/passwd`. This must run before `path.isAbsolute`
  // is trusted on Windows too: `path.isAbsolute` already treats `C:\foo`, `C:/foo`, and
  // `\\server\share` as absolute, so that single check covers the common Windows escape
  // shapes.
  if (path.isAbsolute(normalizedInput)) {
    throw new WorkspaceError('Path must be relative', 400);
  }

  // `path.isAbsolute('C:foo')` is actually *false* on win32 (it's a drive-relative path —
  // "relative to the current directory on drive C:"), so it slips past the check above.
  // It's still an escape vector (Node resolves it against `process.cwd()` on that drive,
  // not against `root`), so reject the `<drive-letter>:` prefix explicitly. Likewise
  // reject a leading `\\` / `//`, which is how a UNC path (`\\host\share\...`) starts even
  // when `path.isAbsolute` doesn't classify the fragment as absolute (e.g. `\\host` alone).
  if (/^[a-zA-Z]:/.test(normalizedInput) || /^[\\/]{2}/.test(normalizedInput)) {
    throw new WorkspaceError('Path must be relative to the workspace root', 400);
  }

  const resolved = path.resolve(root, normalizedInput);

  // The real containment check: how do you get from `root` to `resolved`? If that
  // requires stepping outside `root` first (`relative` starts with `..`) or the two
  // roots don't share a common ancestor at all (Windows: different drive letters, where
  // `path.relative` returns an absolute path), it has escaped. `path.relative` is used
  // instead of `resolved.startsWith(root)` string math because `startsWith` is wrong on
  // win32 in ways that matter here: it is case-sensitive (Windows paths aren't) and it
  // doesn't understand separator boundaries (`C:\ws-evil` would wrongly pass a
  // `startsWith('C:\\ws')` check against root `C:\ws`).
  assertContained(root, resolved);

  // Symlink escape defence: everything above only reasoned about the path *string* —
  // none of it detects a symlink physically sitting inside the workspace whose target
  // points outside it (e.g. `workspace/escape -> C:\Users\operator\Documents`). A
  // request for `escape/secrets.txt` passes every check above (the string never leaves
  // `root`) yet reads a real file elsewhere. `fs.realpath` resolves symlinks to their
  // true target, so re-running the same containment check on the realpath catches this.
  //
  // The target path may not exist yet (this function is also used to resolve write
  // targets before the file is created), so realpath is taken on the deepest *existing*
  // ancestor, not `resolved` itself — realpath throws ENOENT on a path that doesn't
  // exist.
  const existingAncestor = await findExistingAncestor(resolved);
  const realRoot = await realpathOrThrow(root, 503, 'Workspace root does not exist');
  const realExistingAncestor = await realpathOrThrow(
    existingAncestor,
    500,
    'Failed to resolve workspace path',
  );

  // Re-derive what the *real* full resolved path would be: swap the (possibly symlinked)
  // existing-ancestor prefix of `resolved` for its realpath, keeping the not-yet-created
  // remainder (if any) as-is — that remainder can't itself be a symlink since it doesn't
  // exist.
  const remainder = path.relative(existingAncestor, resolved);
  const realResolved = remainder ? path.join(realExistingAncestor, remainder) : realExistingAncestor;

  assertContained(realRoot, realResolved);

  return resolved;
}

/** Throws unless `child` is `root` itself or nested inside it. Shared by both the
 * string-path check and the post-realpath check in `resolveInWorkspace` so the two stay
 * in sync. */
function assertContained(root: string, child: string): void {
  const rel = path.relative(root, child);
  const escapes = rel === '..' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel);
  if (escapes) {
    throw new WorkspaceError('Path escapes the workspace root', 400);
  }
}

/** Walks up from `target` until it finds a path that actually exists on disk (at worst,
 * this terminates at the filesystem root, which always exists). Needed because
 * `fs.realpath` throws on a path that doesn't exist yet, but write targets legitimately
 * name files (and sometimes directories) that haven't been created. */
async function findExistingAncestor(target: string): Promise<string> {
  let current = target;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    try {
      await fs.stat(current);
      return current;
    } catch {
      const parent = path.dirname(current);
      // `path.dirname` of a filesystem root returns itself — if we stop making
      // progress, bail out rather than looping forever.
      if (parent === current) return current;
      current = parent;
    }
  }
}

async function realpathOrThrow(
  target: string,
  status: number,
  message: string,
): Promise<string> {
  try {
    return await fs.realpath(target);
  } catch {
    throw new WorkspaceError(message, status);
  }
}

/** Inverse of the resolve step: turns an absolute path known to be inside `root` back
 * into the forward-slashed, root-relative form the API reports to callers, so responses
 * never leak the host's absolute directory layout. */
export function workspaceRelative(root: string, absPath: string): string {
  const rel = path.relative(root, absPath);
  const normalized = rel.split(path.sep).join('/');
  return normalized === '' ? '.' : normalized;
}
