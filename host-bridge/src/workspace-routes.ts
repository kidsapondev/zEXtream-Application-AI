import path from 'path';
import express, { Request, Response } from 'express';
import { z } from 'zod';
import { config } from './config';
import { runProcess } from './process-runner';
import { resolveInWorkspace, WorkspaceError } from './workspace';
import { listDir, readFile, searchText, writeFile } from './workspace-fs';

// `runProcess`'s stdout/stderr accumulate in memory with no cap of their own (fine for a
// short claude/codex reply, less fine for e.g. `git log` on a huge repo or a runaway
// build tool) — trim before it ever reaches a JSON response body.
const EXEC_OUTPUT_TRUNCATE_LENGTH = 20_000;

const listBodySchema = z.object({
  path: z.string().optional(),
});
const readBodySchema = z.object({
  path: z.string(),
});
const writeBodySchema = z.object({
  path: z.string(),
  content: z.string(),
});
const searchBodySchema = z.object({
  query: z.string().min(1, 'query must not be empty'),
  path: z.string().optional(),
  maxResults: z.number().int().positive().optional(),
});
const execBodySchema = z.object({
  command: z.string().min(1, 'command must not be empty'),
  args: z.array(z.string()).optional(),
  cwd: z.string().optional(),
});

/** Every non-status workspace route needs `config.workspaceRoot` to be set, and needs to
 * fail the same way (503, same body shape) when it isn't. Centralising that here means
 * each route body can assume a real root string once this returns non-null, instead of
 * re-deriving the same guard five times. */
function requireWorkspaceRoot(res: Response): string | null {
  if (!config.workspaceRoot) {
    res.status(503).json({
      error: 'Workspace is not configured — set BRIDGE_WORKSPACE_ROOT on the host to enable it',
    });
    return null;
  }
  return config.workspaceRoot;
}

/** Maps a thrown error to an HTTP response. `WorkspaceError` carries its own intended
 * status (400 for a bad path, 404 for missing, 413 for oversized, 503 for a missing
 * root); anything else is a genuine bug or environment failure (disk I/O, permissions),
 * which is a 500 rather than something the caller could have avoided by sending a
 * different request. */
function handleError(res: Response, err: unknown): void {
  if (err instanceof WorkspaceError) {
    res.status(err.status).json({ error: err.message });
    return;
  }
  res.status(500).json({ error: (err as Error).message });
}

/** Formats a zod failure into a single readable string — the default `ZodError` shape is
 * an array of issues, which is correct but not something a caller (or the LLM reading
 * the error to decide what to retry) should have to parse. */
function formatZodError(error: z.ZodError): string {
  return error.issues.map((issue) => `${issue.path.join('.') || 'body'}: ${issue.message}`).join('; ');
}

export function registerWorkspaceRoutes(app: express.Express): void {
  app.get('/workspace/status', (_req: Request, res: Response) => {
    // Unlike every other workspace route, /status must answer even when the feature is
    // off — it's how a caller (or an operator's dashboard) discovers *that* it's off,
    // rather than finding out via a string of 503s from the routes that do the work.
    res.json({
      available: Boolean(config.workspaceRoot),
      root: config.workspaceRoot ?? null,
      execEnabled: config.execAllowlist.length > 0,
      allowedCommands: config.execAllowlist,
      maxFileBytes: config.maxFileBytes,
    });
  });

  app.post('/workspace/list', (req: Request, res: Response) => {
    const root = requireWorkspaceRoot(res);
    if (!root) return;
    const parsed = listBodySchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: formatZodError(parsed.error) });
      return;
    }
    listDir(root, parsed.data.path ?? '.')
      .then((result) => res.json(result))
      .catch((err) => handleError(res, err));
  });

  app.post('/workspace/read', (req: Request, res: Response) => {
    const root = requireWorkspaceRoot(res);
    if (!root) return;
    const parsed = readBodySchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: formatZodError(parsed.error) });
      return;
    }
    readFile(root, parsed.data.path, config.maxFileBytes)
      .then((result) => res.json(result))
      .catch((err) => handleError(res, err));
  });

  app.post('/workspace/write', (req: Request, res: Response) => {
    const root = requireWorkspaceRoot(res);
    if (!root) return;
    const parsed = writeBodySchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: formatZodError(parsed.error) });
      return;
    }
    writeFile(root, parsed.data.path, parsed.data.content, config.maxFileBytes)
      .then((result) => res.json(result))
      .catch((err) => handleError(res, err));
  });

  app.post('/workspace/search', (req: Request, res: Response) => {
    const root = requireWorkspaceRoot(res);
    if (!root) return;
    const parsed = searchBodySchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: formatZodError(parsed.error) });
      return;
    }
    const { query, maxResults } = parsed.data;
    searchText(root, parsed.data.path ?? '.', query, maxResults ?? 0, config.maxFileBytes)
      .then((result) => res.json(result))
      .catch((err) => handleError(res, err));
  });

  app.post('/workspace/exec', (req: Request, res: Response) => {
    const root = requireWorkspaceRoot(res);
    if (!root) return;
    const parsed = execBodySchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: formatZodError(parsed.error) });
      return;
    }
    const { command, args, cwd } = parsed.data;
    const trimmedCommand = command.trim();

    // Reject anything that isn't a bare command name *before* touching the allowlist —
    // `path.isAbsolute('/usr/bin/rm')` or a `..\..\Windows\System32\cmd.exe`-style value
    // would otherwise let a caller name an arbitrary executable on disk and dodge the
    // allowlist entirely by never matching a lowercase entry in it (or worse, matching one
    // coincidentally). A path separator or an absolute path is disqualifying regardless of
    // what the allowlist contains.
    if (
      trimmedCommand.includes('/') ||
      trimmedCommand.includes('\\') ||
      path.isAbsolute(trimmedCommand)
    ) {
      res.status(403).json({ error: 'command must be a bare command name, not a path' });
      return;
    }

    // Case-insensitive allowlist match (config already lowercases its entries) — Windows
    // command lookup is case-insensitive anyway, and requiring exact-case input here would
    // just be a foot-gun with no security benefit.
    const bareCommand = trimmedCommand.toLowerCase();
    if (config.execAllowlist.length === 0 || !config.execAllowlist.includes(bareCommand)) {
      res.status(403).json({ error: `command "${trimmedCommand}" is not on the exec allowlist` });
      return;
    }

    resolveInWorkspace(root, cwd ?? '')
      .then((resolvedCwd) => runProcess(trimmedCommand, args ?? [], resolvedCwd, config.execTimeoutMs))
      .then((result) => {
        res.json({
          command: trimmedCommand,
          exitCode: result.code,
          stdout: result.stdout.slice(0, EXEC_OUTPUT_TRUNCATE_LENGTH),
          stderr: result.stderr.slice(0, EXEC_OUTPUT_TRUNCATE_LENGTH),
          timedOut: result.timedOut,
        });
      })
      .catch((err) => handleError(res, err));
  });
}
