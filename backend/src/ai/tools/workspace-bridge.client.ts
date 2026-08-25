import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

/** Timeout for the metadata-ish endpoints (status/list/read/write/search) — all of these
 *  are single filesystem operations on the host and should return near-instantly; 10s is
 *  generous headroom for a slow disk, not an expectation that they normally take that long. */
const METADATA_TIMEOUT_MS = 10_000;

/**
 * Timeout for `/workspace/exec` specifically. This endpoint runs a real build/test/lint
 * command on the host machine (e.g. `pnpm test`), not a metadata lookup, so it needs an
 * allowance in the same ballpark as the host-bridge's own exec timeout rather than the
 * short window above — 90s gives a typical `pnpm build`/`pnpm test` room to finish before
 * this client gives up on it, while still bounding how long one tool call can hold up a
 * chat turn.
 */
const EXEC_TIMEOUT_MS = 90_000;

export interface WorkspaceStatus {
  available: boolean;
  root: string | null;
  execEnabled: boolean;
  allowedCommands: string[];
  maxFileBytes: number;
}

export interface WorkspaceListEntry {
  name: string;
  type: 'file' | 'dir';
  size: number;
}

export interface WorkspaceListResult {
  path: string;
  entries: WorkspaceListEntry[];
}

export interface WorkspaceReadResult {
  path: string;
  content: string;
  bytes: number;
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
 * Thrown by every `WorkspaceBridgeClient` method except `status()` (see that method's own
 * comment for why it's the one exception) when a request fails, carrying enough
 * information for `WorkspaceToolsService.execute()` to tell the model apart from an
 * operator: `status` is the bridge's own HTTP status (400 bad path, 403 command not
 * allowlisted, 404 not found, 413 too large, 503 not configured on the host) when a
 * response was actually received, or `undefined` when the request never got a response at
 * all (network failure, DNS error, connection refused, or this client requesting a
 * workspace operation while `WORKSPACE_BRIDGE_URL`/`HOST_BRIDGE_TOKEN` isn't set). The
 * distinction matters to the caller: a 4xx is the model's mistake and worth explaining back
 * to it so it can correct itself, while `undefined` means "the bridge itself is
 * unreachable" and no amount of the model retrying with different arguments will help.
 */
export class WorkspaceBridgeError extends Error {
  constructor(
    message: string,
    public readonly status: number | undefined,
  ) {
    super(message);
    this.name = 'WorkspaceBridgeError';
  }
}

/**
 * Typed HTTP client for the host-bridge's `/workspace/*` endpoints — the same host-bridge
 * process ClaudeProvider/OpenAiProvider talk to (see providers/claude.provider.ts), but a
 * different capability: real filesystem/exec access on the deployment host, offered to the
 * locally-hosted Ollama model via WorkspaceToolsService rather than to a CLI subprocess.
 * Gated by its own env var (WORKSPACE_BRIDGE_URL) precisely so a deployment can run the
 * claude/codex bridge without ever granting disk access — see env.validation.ts.
 */
@Injectable()
export class WorkspaceBridgeClient {
  private readonly bridgeUrl?: string;
  private readonly bridgeToken?: string;

  constructor(configService: ConfigService) {
    this.bridgeUrl = configService.get<string>('WORKSPACE_BRIDGE_URL');
    this.bridgeToken = configService.get<string>('HOST_BRIDGE_TOKEN');
  }

  isConfigured(): boolean {
    return Boolean(this.bridgeUrl && this.bridgeToken);
  }

  /**
   * Unlike every other method on this client, `status()` never throws — it resolves to an
   * "unavailable" shape on any failure (bridge unset, unreachable, non-2xx, malformed
   * body), mirroring how `ProviderSettingsService.fetchOllamaModels()`/`fetchBridgeModels()`
   * treat an unreachable provider as "no models" rather than an exception: this method is
   * meant to be polled cheaply (e.g. to decide whether to even advertise workspace tools to
   * the model) and callers shouldn't need a try/catch just to check availability.
   */
  async status(signal?: AbortSignal): Promise<WorkspaceStatus> {
    const fallback: WorkspaceStatus = {
      available: false,
      root: null,
      execEnabled: false,
      allowedCommands: [],
      maxFileBytes: 0,
    };
    if (!this.isConfigured()) return fallback;

    try {
      const response = await this.request(
        'GET',
        '/workspace/status',
        undefined,
        METADATA_TIMEOUT_MS,
        signal,
      );
      if (!response.ok) return fallback;
      return (await response.json()) as WorkspaceStatus;
    } catch {
      return fallback;
    }
  }

  async list(
    body: { path?: string },
    signal?: AbortSignal,
  ): Promise<WorkspaceListResult> {
    return this.post<WorkspaceListResult>(
      '/workspace/list',
      body,
      METADATA_TIMEOUT_MS,
      signal,
    );
  }

  async read(
    body: { path: string },
    signal?: AbortSignal,
  ): Promise<WorkspaceReadResult> {
    return this.post<WorkspaceReadResult>(
      '/workspace/read',
      body,
      METADATA_TIMEOUT_MS,
      signal,
    );
  }

  async write(
    body: { path: string; content: string },
    signal?: AbortSignal,
  ): Promise<WorkspaceWriteResult> {
    return this.post<WorkspaceWriteResult>(
      '/workspace/write',
      body,
      METADATA_TIMEOUT_MS,
      signal,
    );
  }

  async search(
    body: { query: string; path?: string; maxResults?: number },
    signal?: AbortSignal,
  ): Promise<WorkspaceSearchResult> {
    return this.post<WorkspaceSearchResult>(
      '/workspace/search',
      body,
      METADATA_TIMEOUT_MS,
      signal,
    );
  }

  async exec(
    body: { command: string; args?: string[]; cwd?: string },
    signal?: AbortSignal,
  ): Promise<WorkspaceExecResult> {
    // Deliberately EXEC_TIMEOUT_MS, not METADATA_TIMEOUT_MS — see that constant's comment.
    return this.post<WorkspaceExecResult>(
      '/workspace/exec',
      body,
      EXEC_TIMEOUT_MS,
      signal,
    );
  }

  private async post<T>(
    path: string,
    body: unknown,
    timeoutMs: number,
    callerSignal?: AbortSignal,
  ): Promise<T> {
    const response = await this.request(
      'POST',
      path,
      body,
      timeoutMs,
      callerSignal,
    );
    if (!response.ok) {
      throw await this.toError(response);
    }
    return (await response.json()) as T;
  }

  private async request(
    method: 'GET' | 'POST',
    path: string,
    body: unknown,
    timeoutMs: number,
    callerSignal?: AbortSignal,
  ): Promise<Response> {
    if (!this.bridgeUrl || !this.bridgeToken) {
      throw new WorkspaceBridgeError(
        'Workspace bridge is not configured (WORKSPACE_BRIDGE_URL/HOST_BRIDGE_TOKEN unset)',
        undefined,
      );
    }

    const timeoutController = new AbortController();
    const timer = setTimeout(() => timeoutController.abort(), timeoutMs);
    // Combine the caller's own cancellation (e.g. the user hit Stop mid-chat) with this
    // request's own timeout, so either one aborts the fetch — AbortSignal.any() is the
    // standard way to do this without hand-rolling a listener that has to be torn down on
    // both branches.
    const signal = callerSignal
      ? AbortSignal.any([callerSignal, timeoutController.signal])
      : timeoutController.signal;

    try {
      return await fetch(`${this.bridgeUrl}${path}`, {
        method,
        headers: {
          'content-type': 'application/json',
          'x-bridge-token': this.bridgeToken,
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal,
      });
    } catch (err) {
      if (callerSignal?.aborted) {
        throw new WorkspaceBridgeError(
          'Workspace bridge request was cancelled',
          undefined,
        );
      }
      if (timeoutController.signal.aborted) {
        throw new WorkspaceBridgeError(
          `Workspace bridge request to ${path} timed out after ${timeoutMs}ms`,
          undefined,
        );
      }
      throw new WorkspaceBridgeError(
        `Could not reach the workspace bridge: ${(err as Error).message}`,
        undefined,
      );
    } finally {
      clearTimeout(timer);
    }
  }

  private async toError(response: Response): Promise<WorkspaceBridgeError> {
    try {
      const body = (await response.json()) as { error?: string };
      return new WorkspaceBridgeError(
        body.error ?? `Workspace bridge returned HTTP ${response.status}`,
        response.status,
      );
    } catch {
      return new WorkspaceBridgeError(
        `Workspace bridge returned HTTP ${response.status}`,
        response.status,
      );
    }
  }
}
