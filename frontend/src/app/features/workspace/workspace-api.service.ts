import { HttpClient, HttpErrorResponse, HttpParams } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { Observable, firstValueFrom } from 'rxjs';

/*
 * Response shapes for `/api/workspace/*`.
 *
 * These mirror the interfaces in `backend/src/ai/tools/workspace-bridge.client.ts` and are
 * re-declared here rather than imported from `@app/shared-types` because they aren't in that
 * package: the bridge client owns them server-side and the browser only ever sees them as
 * JSON. If they are ever promoted to the shared package, delete these and import instead —
 * the field names are identical so nothing else has to move.
 */

export interface WorkspaceStatus {
  available: boolean;
  root: string | null;
  execEnabled: boolean;
  allowedCommands: string[];
  maxFileBytes: number;
}

export interface WorkspaceEntry {
  name: string;
  type: 'file' | 'dir';
  size: number;
}

export interface WorkspaceListResult {
  path: string;
  entries: WorkspaceEntry[];
}

export interface WorkspaceReadResult {
  path: string;
  content: string;
  bytes: number;
  /** True when the host cut the file off at `maxFileBytes`. See `WorkspaceTab.readOnly`. */
  truncated: boolean;
}

export interface WorkspaceWriteResult {
  path: string;
  bytes: number;
  created: boolean;
}

export interface WorkspaceSearchMatch {
  path: string;
  line: number;
  text: string;
}

export interface WorkspaceSearchResult {
  matches: WorkspaceSearchMatch[];
  truncated: boolean;
}

export interface WorkspaceExecResult {
  command: string;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

/**
 * A failed workspace call, flattened to a message the UI can print and a status the UI can
 * branch on.
 *
 * The branch that actually matters is 503. Every other failure is a thing the user did (bad
 * path, file too large) or a transient the user can retry, and both are served by showing
 * the message. 503 is different in kind: it means the *operator* never configured a
 * workspace, no amount of retrying or clicking elsewhere will fix it, and the backend's
 * message names the exact two settings to change — so the UI must replace the whole file
 * tree with that message rather than render an empty tree that looks like an empty folder.
 */
export class WorkspaceApiError extends Error {
  constructor(
    message: string,
    readonly status: number | undefined,
  ) {
    super(message);
    this.name = 'WorkspaceApiError';
  }

  get isUnavailable(): boolean {
    return this.status === 503;
  }
}

/**
 * Thin, promise-shaped client for the workspace REST API.
 *
 * Promises rather than Observables because every one of these is a single request whose
 * result is awaited once and written into a signal — the repo's `ChatStore` and
 * `ArtifactStore` already settled on `firstValueFrom` for exactly that pattern, and an
 * Observable that emits once and completes only buys subscription bookkeeping here.
 */
@Injectable({ providedIn: 'root' })
export class WorkspaceApiService {
  private readonly http = inject(HttpClient);

  status(): Promise<WorkspaceStatus> {
    return this.request(this.http.get<WorkspaceStatus>('/api/workspace/status'));
  }

  /** Lists one directory. `path` is workspace-relative; `''` is the workspace root. */
  list(path: string): Promise<WorkspaceListResult> {
    return this.request(
      this.http.get<WorkspaceListResult>('/api/workspace/files', {
        params: new HttpParams().set('path', path),
      }),
    );
  }

  read(path: string): Promise<WorkspaceReadResult> {
    return this.request(
      this.http.get<WorkspaceReadResult>('/api/workspace/file', {
        params: new HttpParams().set('path', path),
      }),
    );
  }

  write(path: string, content: string): Promise<WorkspaceWriteResult> {
    return this.request(
      this.http.post<WorkspaceWriteResult>('/api/workspace/file', { path, content }),
    );
  }

  search(query: string, path = '', maxResults?: number): Promise<WorkspaceSearchResult> {
    let params = new HttpParams().set('query', query).set('path', path);
    if (maxResults !== undefined) params = params.set('maxResults', String(maxResults));
    return this.request(this.http.get<WorkspaceSearchResult>('/api/workspace/search', { params }));
  }

  /**
   * Runs an allowlisted command on the host. Exposed here — and not used by anything in this
   * feature — because the bottom dock's terminal is the caller, and it should not open a
   * second HTTP client against the same routes.
   */
  exec(command: string, args: string[] = [], cwd = ''): Promise<WorkspaceExecResult> {
    return this.request(
      this.http.post<WorkspaceExecResult>('/api/workspace/exec', { command, args, cwd }),
    );
  }

  private async request<T>(source: Observable<T>): Promise<T> {
    try {
      return await firstValueFrom(source);
    } catch (error) {
      throw toWorkspaceApiError(error);
    }
  }
}

/**
 * Nest's exception filter answers `{ statusCode, message, error }`, where `message` is a
 * string for the exceptions this controller throws by hand and a string[] when a DTO's
 * validation pipe rejected the request. Both have to be flattened here, because the caller
 * puts this straight into a banner and `[object Object]` in a banner that is supposed to
 * name two settings files is worse than no banner at all.
 */
function toWorkspaceApiError(error: unknown): WorkspaceApiError {
  if (!(error instanceof HttpErrorResponse)) {
    return new WorkspaceApiError(
      error instanceof Error ? error.message : 'The workspace request failed.',
      undefined,
    );
  }

  const body = error.error as { message?: string | string[] } | string | null;
  const raw = typeof body === 'string' ? body : body?.message;
  const message = Array.isArray(raw) ? raw.join(', ') : raw;

  // `error.status === 0` is the browser failing to reach the server at all; its `message`
  // is a stack-shaped string that would only confuse, so say the plain thing instead.
  if (!message && error.status === 0) {
    return new WorkspaceApiError('Could not reach the server.', undefined);
  }

  return new WorkspaceApiError(
    message || `The workspace request failed (HTTP ${error.status}).`,
    error.status,
  );
}
