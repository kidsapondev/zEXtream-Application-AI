import { Injectable } from '@nestjs/common';
import {
  OllamaToolCall,
  OllamaToolDefinition,
  ToolExecutionResult,
} from './tool.types';
import {
  WorkspaceBridgeClient,
  WorkspaceBridgeError,
} from './workspace-bridge.client';

/**
 * Second, tighter cap on how much of a tool result is fed back into the model's context,
 * applied on top of whatever the host-bridge itself already truncates at (20k bytes for a
 * file read, per the host-bridge's own `maxFileBytes`/exec-output limits). The host-side
 * cap exists to protect the host-bridge process and the wire; this cap exists to protect
 * the *model's* context window — a 20k-character command dump would by itself burn a large
 * fraction of a local model's context on a single tool result, crowding out the rest of the
 * conversation. Applied independently to stdout and stderr so a command that fails loudly
 * on one stream doesn't starve the other.
 */
const MODEL_OUTPUT_CHAR_LIMIT = 4_000;

/** The five tool names the Ollama provider is written against — see the class doc comment. */
const TOOL_NAMES = [
  'list_files',
  'read_file',
  'write_file',
  'search_files',
  'run_command',
] as const;
type ToolName = (typeof TOOL_NAMES)[number];

/**
 * Coerces a raw tool-call argument to a string, tolerating the two shapes Ollama models
 * have actually been observed to emit for a schema-declared `string` parameter: the
 * correct string, or a bare number/boolean (e.g. a model asked for `read_file` with
 * `path: 123` when the file happened to be named "123.txt", or emitted `content: true` by
 * mistake in a malformed call). This is defensive against real behaviour seen from local
 * models, not a hypothetical — silently rejecting those calls as "missing argument" would
 * make the tool flakier than it needs to be for a mistake that's trivially recoverable.
 */
function coerceString(value: unknown): string | undefined {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }
  return undefined;
}

/**
 * Same defensive coercion as `coerceString`, for the one array-typed parameter
 * (`run_command`'s `args`). Also tolerates a model emitting the array itself as a
 * JSON-encoded string (`args: '["--watch"]'`) — the same "whole argument object came back
 * JSON-encoded" quirk handled in `parseArguments` below, just observed on this one field
 * specifically as well as on the top-level arguments object.
 */
function coerceStringArray(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value
      .map((entry) => coerceString(entry))
      .filter((entry): entry is string => entry !== undefined);
  }
  if (typeof value === 'string') {
    try {
      const parsed: unknown = JSON.parse(value);
      if (Array.isArray(parsed)) return coerceStringArray(parsed);
    } catch {
      // Not JSON — fall through and treat the whole string as a single arg below.
    }
    return value.trim() ? [value] : [];
  }
  return [];
}

/** Truncates model-bound text to `MODEL_OUTPUT_CHAR_LIMIT`, leaving an explicit marker so
 *  the model knows it's looking at a partial result rather than silently losing the tail. */
function truncateForModel(text: string): string {
  if (text.length <= MODEL_OUTPUT_CHAR_LIMIT) return text;
  return `${text.slice(0, MODEL_OUTPUT_CHAR_LIMIT)}\n...[truncated at ${MODEL_OUTPUT_CHAR_LIMIT} chars]`;
}

function ok(content: string, summary: string): ToolExecutionResult {
  return { ok: true, content, summary };
}

function fail(message: string): ToolExecutionResult {
  // Kept short and identical for both `content` and `summary` — a failure is exactly the
  // kind of one-line message that's equally appropriate fed back to the model and shown to
  // the user, unlike a success result where the two audiences want different detail.
  return { ok: false, content: message, summary: message };
}

/**
 * The interface `OllamaProvider` consumes to give the locally-hosted Ollama model real
 * filesystem/exec access to a project workspace on the host machine, via the host-bridge
 * (see `WorkspaceBridgeClient`). Deliberately Ollama-only: `ClaudeProvider`/`OpenAiProvider`
 * already get filesystem access implicitly, because their host-bridge spawns the actual
 * `claude`/`codex` CLI *on* the host, where it can use its own built-in file tools directly
 * — there's nothing for this service to add there. Ollama has no such host-side CLI; it's a
 * model running in a container with no access of its own, so this service is what stands in
 * for "the CLI's built-in tools" for that one provider.
 */
@Injectable()
export class WorkspaceToolsService {
  constructor(private readonly bridgeClient: WorkspaceBridgeClient) {}

  /**
   * True when `WORKSPACE_BRIDGE_URL` + `HOST_BRIDGE_TOKEN` are both set. Cheap/sync —
   * called on every chat turn (to decide whether to advertise tools to the model at all),
   * so it must not do I/O; it only checks that the two env-backed strings are non-empty, it
   * does not verify the bridge is actually reachable (that's `status()`'s job, and it costs
   * a real request, which is why the Ollama provider isn't expected to call it every turn).
   */
  isEnabled(): boolean {
    return this.bridgeClient.isConfigured();
  }

  /** The tool schemas handed to Ollama's `/api/chat` `tools` field. */
  definitions(): OllamaToolDefinition[] {
    return [
      {
        type: 'function',
        function: {
          name: 'list_files',
          description:
            'List the files and subdirectories directly inside a directory of the workspace.',
          parameters: {
            type: 'object',
            properties: {
              path: {
                type: 'string',
                description:
                  'directory relative to the workspace root; omit for the root',
              },
            },
            required: [],
          },
        },
      },
      {
        type: 'function',
        function: {
          name: 'read_file',
          description:
            'Read the full text content of one file in the workspace.',
          parameters: {
            type: 'object',
            properties: {
              path: {
                type: 'string',
                description: 'file path relative to the workspace root',
              },
            },
            required: ['path'],
          },
        },
      },
      {
        type: 'function',
        function: {
          name: 'write_file',
          description:
            'Create or overwrite a file in the workspace with new content.',
          parameters: {
            type: 'object',
            properties: {
              path: {
                type: 'string',
                description: 'file path relative to the workspace root',
              },
              content: {
                type: 'string',
                description:
                  'the COMPLETE new file content, not a diff or a fragment',
              },
            },
            required: ['path', 'content'],
          },
        },
      },
      {
        type: 'function',
        function: {
          name: 'search_files',
          description:
            'Search file contents in the workspace for a literal query string.',
          parameters: {
            type: 'object',
            properties: {
              query: {
                type: 'string',
                description: 'text to search for',
              },
              path: {
                type: 'string',
                description:
                  'directory relative to the workspace root to restrict the search to; omit to search the whole workspace',
              },
            },
            required: ['query'],
          },
        },
      },
      {
        type: 'function',
        function: {
          name: 'run_command',
          description:
            'Run an allowlisted command on the host (e.g. a build, test, or lint command) and return its exit code, stdout, and stderr.',
          parameters: {
            type: 'object',
            properties: {
              command: {
                type: 'string',
                description: 'the command to run, e.g. "pnpm"',
              },
              args: {
                type: 'array',
                description:
                  'command-line arguments, e.g. ["test", "--filter", "backend"]',
                items: { type: 'string' },
              },
            },
            required: ['command'],
          },
        },
      },
    ];
  }

  /** Extra system-prompt text describing the workspace and the tool policy. */
  systemPrompt(): string {
    return [
      "You have real read/write access to a project workspace on the user's machine, " +
        'through the list_files, read_file, write_file, search_files, and run_command tools.',
      'All paths are relative to the workspace root — never assume or invent an absolute path.',
      'Inspect before you change: use list_files and/or read_file to see what is actually ' +
        'there before calling write_file, rather than guessing at existing content.',
      'write_file replaces the ENTIRE file. Always pass the complete new content, not a diff ' +
        'or a partial snippet, or you will destroy the parts of the file you did not intend to touch.',
      'When you show code in your written response (as opposed to using a tool), still use ' +
        "the repository's ```language:path/to/file fenced-block convention so the chat UI " +
        'can render it as an artifact.',
    ].join('\n');
  }

  /**
   * Runs one model-requested tool call. NEVER throws — every failure (unknown tool name,
   * missing/blank argument, or the bridge itself rejecting/erroring the request) comes back
   * as `{ ok: false, ... }` instead, because a failed tool call must let the model see what
   * went wrong and correct itself on its next turn rather than killing the whole chat
   * stream the way an uncaught exception from inside a provider's streamChat() would.
   */
  async execute(
    call: OllamaToolCall,
    signal: AbortSignal,
  ): Promise<ToolExecutionResult> {
    const name = call.function.name;
    if (!this.isToolName(name)) {
      return fail(
        `Unknown tool "${name}". Valid tools are: ${TOOL_NAMES.join(', ')}.`,
      );
    }

    const args = this.parseArguments(call.function.arguments);

    try {
      switch (name) {
        case 'list_files':
          return await this.runListFiles(args, signal);
        case 'read_file':
          return await this.runReadFile(args, signal);
        case 'write_file':
          return await this.runWriteFile(args, signal);
        case 'search_files':
          return await this.runSearchFiles(args, signal);
        case 'run_command':
          return await this.runRunCommand(args, signal);
      }
    } catch (err) {
      if (err instanceof WorkspaceBridgeError) {
        return fail(`${name} failed: ${err.message}`);
      }
      return fail(`${name} failed: ${(err as Error).message}`);
    }
  }

  private isToolName(name: string): name is ToolName {
    return (TOOL_NAMES as readonly string[]).includes(name);
  }

  /**
   * Ollama's documented contract types `function.arguments` as a plain object, but local
   * models have been observed to instead emit the entire arguments payload JSON-encoded as
   * a single string (i.e. `arguments: '{"path":"src/app.ts"}'` rather than
   * `arguments: {"path":"src/app.ts"}`) — handled here rather than trusting the declared
   * type, since that's the real shape seen coming back from the model, not a hypothetical.
   */
  private parseArguments(raw: unknown): Record<string, unknown> {
    if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
      return raw as Record<string, unknown>;
    }
    if (typeof raw === 'string') {
      try {
        const parsed: unknown = JSON.parse(raw);
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
          return parsed as Record<string, unknown>;
        }
      } catch {
        // Not JSON — fall through to "no usable arguments" below.
      }
    }
    return {};
  }

  /** Required-string extraction shared by every handler: missing, non-string-coercible, or
   *  blank (whitespace-only) all count as "missing" for the purposes of the model-facing
   *  error message — a required argument the model sent as `""` is just as unusable as one
   *  it forgot to send. */
  private requireString(
    args: Record<string, unknown>,
    key: string,
  ): string | undefined {
    const value = coerceString(args[key]);
    if (value === undefined || value.trim() === '') return undefined;
    return value;
  }

  private optionalString(
    args: Record<string, unknown>,
    key: string,
  ): string | undefined {
    const value = coerceString(args[key]);
    if (value === undefined || value.trim() === '') return undefined;
    return value;
  }

  private async runListFiles(
    args: Record<string, unknown>,
    signal: AbortSignal,
  ): Promise<ToolExecutionResult> {
    const path = this.optionalString(args, 'path');
    const result = await this.bridgeClient.list({ path }, signal);
    const label = result.path || '(root)';

    if (result.entries.length === 0) {
      return ok(
        `${label}: (empty directory)`,
        `list_files(${label}) → 0 entries`,
      );
    }

    const lines = result.entries.map(
      (entry) => `${entry.type}\t${entry.name}\t${entry.size}`,
    );
    return ok(
      `${label}:\n${lines.join('\n')}`,
      `list_files(${label}) → ${result.entries.length} entries`,
    );
  }

  private async runReadFile(
    args: Record<string, unknown>,
    signal: AbortSignal,
  ): Promise<ToolExecutionResult> {
    const path = this.requireString(args, 'path');
    if (path === undefined)
      return fail('read_file requires a "path" argument.');

    const result = await this.bridgeClient.read({ path }, signal);
    const header = result.truncated
      ? `${result.path} [truncated at ${result.bytes} bytes]`
      : result.path;

    return ok(
      `${header}:\n${result.content}`,
      `read_file(${result.path}) → ${result.bytes} bytes${result.truncated ? ' (truncated)' : ''}`,
    );
  }

  private async runWriteFile(
    args: Record<string, unknown>,
    signal: AbortSignal,
  ): Promise<ToolExecutionResult> {
    const path = this.requireString(args, 'path');
    if (path === undefined)
      return fail('write_file requires a "path" argument.');
    // Deliberately NOT requireString(): that treats a blank value as missing, which is
    // right for `path` but wrong here — writing an empty file (a placeholder, an
    // intentionally truncated file) is a legitimate request, and rejecting it would leave
    // the model with no way to express it. Only a genuinely absent `content` is an error.
    const content = coerceString(args.content);
    if (content === undefined) {
      return fail('write_file requires a "content" argument.');
    }

    const result = await this.bridgeClient.write({ path, content }, signal);
    return ok(
      `Wrote ${result.bytes} bytes to ${result.path}${result.created ? ' (new file)' : ''}.`,
      `write_file(${result.path}) → ${result.bytes} bytes`,
    );
  }

  private async runSearchFiles(
    args: Record<string, unknown>,
    signal: AbortSignal,
  ): Promise<ToolExecutionResult> {
    const query = this.requireString(args, 'query');
    if (query === undefined) {
      return fail('search_files requires a "query" argument.');
    }
    const path = this.optionalString(args, 'path');

    const result = await this.bridgeClient.search({ query, path }, signal);
    if (result.matches.length === 0) {
      return ok('no matches', `search_files("${query}") → 0 matches`);
    }

    const lines = result.matches.map(
      (match) => `${match.path}:${match.line}: ${match.text}`,
    );
    const content = result.truncated
      ? `${lines.join('\n')}\n...[results truncated]`
      : lines.join('\n');

    return ok(
      content,
      `search_files("${query}") → ${result.matches.length} matches`,
    );
  }

  private async runRunCommand(
    args: Record<string, unknown>,
    signal: AbortSignal,
  ): Promise<ToolExecutionResult> {
    const command = this.requireString(args, 'command');
    if (command === undefined) {
      return fail('run_command requires a "command" argument.');
    }
    const cliArgs = coerceStringArray(args.args);

    const result = await this.bridgeClient.exec(
      { command, args: cliArgs },
      signal,
    );

    const stdout = truncateForModel(result.stdout);
    const stderr = truncateForModel(result.stderr);
    const timedOutNote = result.timedOut ? '\n(command timed out)' : '';
    const content =
      `exit code: ${result.exitCode ?? '(none)'}${timedOutNote}\n` +
      `stdout:\n${stdout || '(empty)'}\n` +
      `stderr:\n${stderr || '(empty)'}`;

    const commandLine = [result.command, ...cliArgs].join(' ');
    return ok(
      content,
      `run_command(${commandLine}) → exit ${result.exitCode ?? '(none)'}`,
    );
  }
}
