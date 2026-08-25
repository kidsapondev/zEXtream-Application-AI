import path from 'path';
import { runProcess } from '../process-runner';
import { resolveInWorkspace, WorkspaceError } from '../workspace';
import { listDir, readFile, searchText, writeFile } from '../workspace-fs';
import { parseTextToolCalls } from './text-tool-call-parser';

/**
 * The local-GPU coding agent, packaged for a request/response caller.
 *
 * This is the **non-streaming sibling** of `backend/src/ai/providers/ollama.provider.ts`.
 * The backend's loop exists to feed a live WebSocket: it sets `stream: true`, forwards
 * every token to the browser as it arrives, and narrates tool calls into the transcript.
 * This loop's caller is an MCP client (an IDE) that issued one `tools/call` request and is
 * blocked waiting for one result — there is no channel to forward tokens down and nothing
 * that could render them mid-flight, so it sets `stream: false` and returns the finished
 * answer plus a structured record of every step. Same model, same five tools, same turn
 * cap; different transport shape.
 *
 * The two loops must not drift on tool *names* or *argument names*: a user can point both
 * paths at the same workspace, and a model that learned `read_file(path)` from one must
 * not meet `readFile(file)` in the other.
 */

/** One executed tool call, in the order it ran. Surfaced to the IDE so a human can audit
 * what the local model actually touched, rather than trusting its prose summary. */
export interface AgentStep {
  tool: string;
  args: Record<string, unknown>;
  ok: boolean;
  summary: string;
}

export interface AgentResult {
  answer: string;
  steps: AgentStep[];
  turns: number;
  usage?: { inputTokens: number; outputTokens: number };
  stoppedReason: 'done' | 'max-turns' | 'error';
  error?: string;
}

export interface RunOllamaAgentOptions {
  task: string;
  model: string;
  baseUrl: string;
  workspaceRoot: string;
  maxFileBytes: number;
  execAllowlist: string[];
  execTimeoutMs: number;
  maxTurns?: number;
  signal?: AbortSignal;
}

/**
 * Hard cap on model -> tool -> model round trips within a single agent run. Same value and
 * same reasoning as `MAX_TOOL_TURNS` in `ollama.provider.ts`: a local model that
 * misunderstands a tool result can otherwise loop on it forever (re-reading the same file,
 * retrying the same failing write), and every round trip is a full prompt re-evaluation on
 * the GPU — so an unbounded loop doesn't just hang the request, it pins the card. Eight is
 * enough for a realistic "look around, read two files, write one, verify" sequence while
 * still terminating quickly when the model is stuck.
 */
export const MAX_AGENT_TURNS = 8;

/**
 * Time Ollama is allowed to take before it starts answering. Matches
 * `OLLAMA_CONNECT_TIMEOUT_MS` in the backend provider, and for the same measured reason:
 * Ollama only loads a model into RAM/VRAM on its first request (or after an idle unload),
 * and a 14B Q4 model (~14.6GB) reproducibly missed a 10s connect timeout on cold load
 * before answering normally once warm. A shorter budget here would misreport "still
 * loading the model" as "Ollama is unreachable" on the first MCP call of every session.
 */
export const OLLAMA_CONNECT_TIMEOUT_MS = 90_000;

/**
 * Total wall-clock budget for one `/api/chat` turn. The backend can afford to separate
 * "still connecting" from "stalled mid-stream" because it reads a stream and rearms a
 * short inactivity timer on every chunk. With `stream: false` there are no intermediate
 * chunks at all — `fetch` resolves only once the model has finished generating — so
 * connect time and generation time are indistinguishable from here and one budget has to
 * cover both. It must therefore be comfortably larger than the cold-load window above,
 * not equal to it, or a cold load would consume the entire allowance and leave nothing
 * for the actual answer.
 */
export const OLLAMA_TURN_TIMEOUT_MS = 300_000;

/** Second, tighter cap on how much of a tool result is fed back into the model's context,
 * on top of whatever `maxFileBytes`/exec truncation already applied. The workspace caps
 * protect this process and the wire; this one protects the *model's* context window — a
 * 20k-character command dump would by itself burn a large fraction of a local model's
 * context on a single tool result. Mirrors `MODEL_OUTPUT_CHAR_LIMIT` in the backend's
 * `WorkspaceToolsService`. */
const MODEL_OUTPUT_CHAR_LIMIT = 4_000;

/** `runProcess` accumulates stdout/stderr in memory with no cap of its own; trim before it
 * goes any further. Mirrors `EXEC_OUTPUT_TRUNCATE_LENGTH` in `workspace-routes.ts`. */
const EXEC_OUTPUT_TRUNCATE_LENGTH = 20_000;

const SEARCH_MAX_RESULTS = 50;

/** The five tool names the backend's `WorkspaceToolsService` defines, repeated verbatim.
 * Renaming one here without renaming it there silently splits the two agents'
 * vocabularies. */
const TOOL_NAMES = [
  'list_files',
  'read_file',
  'write_file',
  'search_files',
  'run_command',
] as const;
type ToolName = (typeof TOOL_NAMES)[number];

/** The names `parseTextToolCalls` will accept when recovering a call from plain text. Kept
 *  identical to the offered tools on purpose — a name outside this set stays prose. */
const RECOVERABLE_TOOL_NAMES: Set<string> = new Set(TOOL_NAMES);

interface OllamaToolCall {
  function: { name: string; arguments: unknown };
}

interface OllamaMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  tool_calls?: OllamaToolCall[];
  /** Which tool produced this `role: 'tool'` message. */
  tool_name?: string;
}

interface OllamaChatResponse {
  message?: { role: string; content?: string; tool_calls?: OllamaToolCall[] };
  done_reason?: string;
  prompt_eval_count?: number;
  eval_count?: number;
}

export interface OllamaModelInfo {
  name: string;
  capabilities: string[];
  /** `undefined` when the capability list could not be determined at all — meaningfully
   * different from a confident `false`, since the fix differs (retry/upgrade Ollama vs.
   * install a tool-capable model). */
  supportsTools?: boolean;
}

interface ToolOutcome {
  ok: boolean;
  /** Fed back to the model as the tool's output. */
  content: string;
  /** One line, shown to the human in the IDE. */
  summary: string;
}

interface ToolContext {
  workspaceRoot: string;
  maxFileBytes: number;
  execAllowlist: string[];
  execTimeoutMs: number;
}

function ok(content: string, summary: string): ToolOutcome {
  return { ok: true, content, summary };
}

function fail(message: string): ToolOutcome {
  return { ok: false, content: message, summary: message };
}

/**
 * Coerces a raw tool-call argument to a string, tolerating the shapes local models have
 * actually been observed to emit for a schema-declared `string` parameter: the correct
 * string, or a bare number/boolean. Same behaviour as the backend's `coerceString` — this
 * is defensive against real observed behaviour, not a hypothetical, and rejecting those
 * calls as "missing argument" would make the tool flakier than it needs to be over a
 * trivially recoverable mistake.
 */
function coerceString(value: unknown): string | undefined {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return undefined;
}

/** Same defensive coercion for `run_command`'s one array-typed parameter, including the
 * case where the model JSON-encodes the array itself (`args: '["--watch"]'`). */
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
      // Not JSON — fall through and treat the whole string as one argument.
    }
    return value.trim() ? [value] : [];
  }
  return [];
}

/**
 * Ollama types `function.arguments` as a plain object, but local models have been observed
 * to emit the whole payload JSON-encoded as a single string
 * (`arguments: '{"path":"src/app.ts"}'`). Handled here rather than trusting the declared
 * type — same reasoning as the backend's `parseArguments`.
 */
function parseArguments(raw: unknown): Record<string, unknown> {
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    return unwrapSchemaEnvelope(raw as Record<string, unknown>);
  }
  if (typeof raw === 'string') {
    try {
      const parsed: unknown = JSON.parse(raw);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return unwrapSchemaEnvelope(parsed as Record<string, unknown>);
      }
    } catch {
      // Not JSON — fall through to "no usable arguments".
    }
  }
  return {};
}

/**
 * Undoes a third observed mangling: the model echoes back the *JSON Schema* it was shown
 * instead of an instance of it, wrapping the real arguments in the schema's own envelope —
 * `{"type":"object","required":["path"],"properties":{"path":"src/app.ts"}}` where
 * `{"path":"src/app.ts"}` was wanted. Seen intermittently from `llama3.2:1b` on Ollama
 * 0.32.15; without this, every such call fails as "missing required argument" and the
 * model usually repeats the same mistake, burning the whole turn budget.
 *
 * The match is deliberately narrow — `properties` must be a plain object *and* be
 * accompanied by `type: 'object'` — so a tool that legitimately takes an argument named
 * `properties` is not silently unwrapped out from under itself.
 */
function unwrapSchemaEnvelope(args: Record<string, unknown>): Record<string, unknown> {
  const { properties, type } = args;
  if (
    type === 'object' &&
    properties &&
    typeof properties === 'object' &&
    !Array.isArray(properties)
  ) {
    return properties as Record<string, unknown>;
  }
  return args;
}

/** Missing, non-string-coercible, and blank all count as "missing": a required argument
 * the model sent as `""` is just as unusable as one it forgot. */
function requireArg(args: Record<string, unknown>, key: string): string | undefined {
  const value = coerceString(args[key]);
  if (value === undefined || value.trim() === '') return undefined;
  return value;
}

function optionalArg(args: Record<string, unknown>, key: string): string | undefined {
  return requireArg(args, key);
}

function truncateForModel(text: string): string {
  if (text.length <= MODEL_OUTPUT_CHAR_LIMIT) return text;
  return `${text.slice(0, MODEL_OUTPUT_CHAR_LIMIT)}\n...[truncated at ${MODEL_OUTPUT_CHAR_LIMIT} chars]`;
}

/** The tool schemas handed to Ollama's `/api/chat` `tools` field. Kept in lockstep with
 * `WorkspaceToolsService.definitions()` — see the module doc comment. */
export function agentToolDefinitions(execEnabled: boolean): unknown[] {
  const definitions: unknown[] = [
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
              description: 'directory relative to the workspace root; omit for the root',
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
        description: 'Read the full text content of one file in the workspace.',
        parameters: {
          type: 'object',
          properties: {
            path: { type: 'string', description: 'file path relative to the workspace root' },
          },
          required: ['path'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'write_file',
        description: 'Create or overwrite a file in the workspace with new content.',
        parameters: {
          type: 'object',
          properties: {
            path: { type: 'string', description: 'file path relative to the workspace root' },
            content: {
              type: 'string',
              description: 'the COMPLETE new file content, not a diff or a fragment',
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
        description: 'Search file contents in the workspace for a literal query string.',
        parameters: {
          type: 'object',
          properties: {
            query: { type: 'string', description: 'text to search for' },
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
  ];

  // Only advertise `run_command` when the operator has actually allowlisted something.
  // Offering a tool whose every invocation is guaranteed to be refused wastes turns from a
  // small model's very limited budget: it tries it, gets a refusal, and often tries again.
  if (execEnabled) {
    definitions.push({
      type: 'function',
      function: {
        name: 'run_command',
        description:
          'Run an allowlisted command on the host (e.g. a build, test, or lint command) and return its exit code, stdout, and stderr.',
        parameters: {
          type: 'object',
          properties: {
            command: { type: 'string', description: 'the command to run, e.g. "pnpm"' },
            args: {
              type: 'array',
              description: 'command-line arguments, e.g. ["test", "--filter", "backend"]',
              items: { type: 'string' },
            },
          },
          required: ['command'],
        },
      },
    });
  }

  return definitions;
}

/** System prompt for an agent run. Deliberately close to the backend's
 * `WorkspaceToolsService.systemPrompt()`, minus the chat-UI artifact-fence instruction
 * (there is no chat UI here) and plus the "you have been delegated to" framing an MCP
 * caller needs. */
export function agentSystemPrompt(execEnabled: boolean): string {
  const lines = [
    'You are a coding agent running locally on the user machine. Another AI assistant, ' +
      'working inside the user IDE, has delegated a task to you.',
    'You have real read/write access to a project workspace through the list_files, ' +
      'read_file, write_file, and search_files tools.',
    'All paths are relative to the workspace root — never assume or invent an absolute path.',
    'Inspect before you change: use list_files and/or read_file to see what is actually ' +
      'there before calling write_file, rather than guessing at existing content.',
    'write_file replaces the ENTIRE file. Always pass the complete new content, not a diff ' +
      'or a partial snippet, or you will destroy the parts of the file you did not intend to touch.',
    'When the task is done, stop calling tools and reply with a short plain-text report of ' +
      'what you changed and why.',
  ];
  if (execEnabled) {
    lines.splice(
      2,
      0,
      'You can also run allowlisted commands with run_command (e.g. to build or test your work).',
    );
  }
  return lines.join('\n');
}

/**
 * Runs one model-requested tool call **in-process**.
 *
 * Note what is deliberately absent: an HTTP hop. The backend's copy of this logic talks to
 * the host-bridge Express app over `http://host.docker.internal:4171` and authenticates
 * with `HOST_BRIDGE_TOKEN`, because it runs inside a Docker container and the network is
 * the boundary it has to cross. This process has no such gap to cross — the IDE spawned it
 * directly on the same machine, as the same OS user, and **its stdio pipe is the trust
 * boundary**. Anything that can write to that pipe is already running code as this user.
 * Looping back out to localhost HTTP would add a port to secure, a token for the IDE user
 * to invent, and a second process to keep running, and would buy exactly no isolation.
 *
 * The security boundary that *does* matter is unchanged and shared: every caller-supplied
 * path still goes through `resolveInWorkspace`, and exec still obeys the same allowlist
 * rules as the HTTP route.
 *
 * NEVER throws — every failure comes back as `{ ok: false }` so the model can see what
 * went wrong and correct itself on the next turn, exactly as
 * `WorkspaceToolsService.execute()` guarantees.
 */
export async function executeAgentTool(
  name: string,
  rawArgs: unknown,
  ctx: ToolContext,
): Promise<ToolOutcome> {
  if (!(TOOL_NAMES as readonly string[]).includes(name)) {
    return fail(`Unknown tool "${name}". Valid tools are: ${TOOL_NAMES.join(', ')}.`);
  }
  const args = parseArguments(rawArgs);

  try {
    switch (name as ToolName) {
      case 'list_files': {
        const relPath = optionalArg(args, 'path') ?? '.';
        const result = await listDir(ctx.workspaceRoot, relPath);
        const label = result.path || '(root)';
        if (result.entries.length === 0) {
          return ok(`${label}: (empty directory)`, `list_files(${label}) → 0 entries`);
        }
        const lines = result.entries.map((e) => `${e.type}\t${e.name}\t${e.size}`);
        return ok(
          `${label}:\n${lines.join('\n')}`,
          `list_files(${label}) → ${result.entries.length} entries`,
        );
      }
      case 'read_file': {
        const relPath = requireArg(args, 'path');
        if (relPath === undefined) return fail('read_file requires a "path" argument.');
        const result = await readFile(ctx.workspaceRoot, relPath, ctx.maxFileBytes);
        const header = result.truncated
          ? `${result.path} [truncated at ${result.bytes} bytes]`
          : result.path;
        return ok(
          `${header}:\n${result.content}`,
          `read_file(${result.path}) → ${result.bytes} bytes${result.truncated ? ' (truncated)' : ''}`,
        );
      }
      case 'write_file': {
        const relPath = requireArg(args, 'path');
        if (relPath === undefined) return fail('write_file requires a "path" argument.');
        // Deliberately not `requireArg`: that treats blank as missing, which is right for
        // `path` but wrong here — writing an empty file is a legitimate request, and
        // rejecting it would leave the model no way to express it.
        const content = coerceString(args.content);
        if (content === undefined) return fail('write_file requires a "content" argument.');
        const result = await writeFile(ctx.workspaceRoot, relPath, content, ctx.maxFileBytes);
        return ok(
          `Wrote ${result.bytes} bytes to ${result.path}${result.created ? ' (new file)' : ''}.`,
          `write_file(${result.path}) → ${result.bytes} bytes`,
        );
      }
      case 'search_files': {
        const query = requireArg(args, 'query');
        if (query === undefined) return fail('search_files requires a "query" argument.');
        const relPath = optionalArg(args, 'path') ?? '.';
        const result = await searchText(
          ctx.workspaceRoot,
          relPath,
          query,
          SEARCH_MAX_RESULTS,
          ctx.maxFileBytes,
        );
        if (result.matches.length === 0) {
          return ok('no matches', `search_files("${query}") → 0 matches`);
        }
        const lines = result.matches.map((m) => `${m.path}:${m.line}: ${m.text}`);
        return ok(
          result.truncated ? `${lines.join('\n')}\n...[results truncated]` : lines.join('\n'),
          `search_files("${query}") → ${result.matches.length} matches`,
        );
      }
      case 'run_command': {
        const command = requireArg(args, 'command');
        if (command === undefined) return fail('run_command requires a "command" argument.');
        const cliArgs = coerceStringArray(args.args);
        return await runAllowlistedCommand(command, cliArgs, optionalArg(args, 'cwd'), ctx);
      }
    }
  } catch (err) {
    if (err instanceof WorkspaceError) {
      return fail(`${name} failed: ${err.message}`);
    }
    return fail(`${name} failed: ${(err as Error).message}`);
  }
}

/**
 * Exec, under exactly the rules `/workspace/exec` enforces in `workspace-routes.ts` —
 * deliberately re-stated rather than relaxed, because this path has no bridge token in
 * front of it and is therefore the *more* exposed of the two, not the less.
 */
async function runAllowlistedCommand(
  command: string,
  cliArgs: string[],
  cwd: string | undefined,
  ctx: ToolContext,
): Promise<ToolOutcome> {
  const trimmed = command.trim();

  // Reject anything that isn't a bare command name *before* touching the allowlist — an
  // absolute path or a `..\..\Windows\System32\cmd.exe`-style value would otherwise let a
  // caller name an arbitrary executable on disk and dodge the allowlist entirely by never
  // matching a lowercase entry in it (or worse, matching one coincidentally).
  if (trimmed.includes('/') || trimmed.includes('\\') || path.isAbsolute(trimmed)) {
    return fail('run_command requires a bare command name, not a path.');
  }

  // An empty allowlist means exec is switched off entirely, reported as such rather than
  // as "this particular command isn't allowed" — the two need different fixes from the
  // operator, and a model told the latter will simply try a different command.
  if (ctx.execAllowlist.length === 0) {
    return fail(
      'run_command is disabled: no commands are allowlisted. Set BRIDGE_EXEC_ALLOWLIST in host-bridge/.env to enable it.',
    );
  }
  // Case-insensitive match (the allowlist is already lowercased by config) — Windows
  // command lookup is case-insensitive anyway.
  if (!ctx.execAllowlist.includes(trimmed.toLowerCase())) {
    return fail(
      `run_command refused: "${trimmed}" is not on the exec allowlist (${ctx.execAllowlist.join(', ')}).`,
    );
  }

  const resolvedCwd = await resolveInWorkspace(ctx.workspaceRoot, cwd ?? '');
  // No shell: `runProcess` spawns the executable directly, so shell metacharacters in the
  // arguments are inert data rather than a second command.
  const result = await runProcess(trimmed, cliArgs, resolvedCwd, ctx.execTimeoutMs);

  const stdout = truncateForModel(result.stdout.slice(0, EXEC_OUTPUT_TRUNCATE_LENGTH));
  const stderr = truncateForModel(result.stderr.slice(0, EXEC_OUTPUT_TRUNCATE_LENGTH));
  const timedOutNote = result.timedOut ? '\n(command timed out)' : '';
  const commandLine = [trimmed, ...cliArgs].join(' ');

  return ok(
    `exit code: ${result.code ?? '(none)'}${timedOutNote}\n` +
      `stdout:\n${stdout || '(empty)'}\n` +
      `stderr:\n${stderr || '(empty)'}`,
    `run_command(${commandLine}) → exit ${result.code ?? '(none)'}`,
  );
}

/**
 * Lists the models Ollama has installed, with their capabilities.
 *
 * Recent Ollama builds include `capabilities` directly in `/api/tags`; older ones do not,
 * and for those the capability list has to be fetched per model from `/api/show`. Both are
 * handled so `local_model_status` gives the same answer either way — the `tools`
 * capability is precisely what decides whether `local_code_agent` can work at all, so
 * "unknown" is a much worse answer here than one extra request per installed model.
 *
 * Throws on an unreachable Ollama; callers decide how to report that.
 */
export async function listOllamaModels(
  baseUrl: string,
  signal?: AbortSignal,
): Promise<OllamaModelInfo[]> {
  const response = await fetch(`${baseUrl}/api/tags`, { signal });
  if (!response.ok) {
    throw new Error(`Ollama returned HTTP ${response.status} from /api/tags`);
  }
  const body = (await response.json()) as {
    models?: { name?: string; model?: string; capabilities?: unknown }[];
  };

  const entries = body.models ?? [];
  return Promise.all(
    entries.map(async (entry) => {
      const name = entry.name ?? entry.model ?? '(unnamed)';
      if (Array.isArray(entry.capabilities)) {
        const capabilities = entry.capabilities.filter((c): c is string => typeof c === 'string');
        return { name, capabilities, supportsTools: capabilities.includes('tools') };
      }
      try {
        const show = await fetch(`${baseUrl}/api/show`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ model: name }),
          signal,
        });
        if (!show.ok) return { name, capabilities: [], supportsTools: undefined };
        const shown = (await show.json()) as { capabilities?: unknown };
        const capabilities = Array.isArray(shown.capabilities)
          ? shown.capabilities.filter((c): c is string => typeof c === 'string')
          : [];
        return { name, capabilities, supportsTools: capabilities.includes('tools') };
      } catch {
        // One model failing to describe itself must not fail the whole listing — the other
        // models' capabilities are still useful, and `supportsTools: undefined` says
        // honestly that this one could not be determined.
        return { name, capabilities: [], supportsTools: undefined };
      }
    }),
  );
}

/**
 * Runs the local model to a final answer, executing workspace tools it asks for along the
 * way. NEVER throws: every failure mode — Ollama unreachable, HTTP error, malformed
 * response, turn cap exceeded, caller abort — comes back as an `AgentResult` carrying a
 * `stoppedReason` and whatever steps did run. An MCP tool handler that threw would surface
 * to the IDE as a protocol-level failure with none of the partial work visible, which is
 * strictly worse than a result saying "I got this far, then stopped because X".
 */
export async function runOllamaAgent(options: RunOllamaAgentOptions): Promise<AgentResult> {
  const {
    task,
    model,
    baseUrl,
    workspaceRoot,
    maxFileBytes,
    execAllowlist,
    execTimeoutMs,
    signal,
  } = options;
  const maxTurns = options.maxTurns ?? MAX_AGENT_TURNS;
  const execEnabled = execAllowlist.length > 0;
  const ctx: ToolContext = { workspaceRoot, maxFileBytes, execAllowlist, execTimeoutMs };
  const tools = agentToolDefinitions(execEnabled);

  const steps: AgentStep[] = [];
  let messages: OllamaMessage[] = [
    { role: 'system', content: agentSystemPrompt(execEnabled) },
    { role: 'user', content: task },
  ];

  // Usage is summed across every turn, not taken from the last one: each tool round trip is
  // a separate full evaluation on the GPU, and reporting only the final turn would make a
  // six-tool-call answer look as cheap as a one-liner. Same reasoning as the backend's.
  let inputTokens = 0;
  let outputTokens = 0;
  let sawUsage = false;
  let answer = '';
  let turns = 0;

  const finish = (stoppedReason: AgentResult['stoppedReason'], error?: string): AgentResult => ({
    answer,
    steps,
    turns,
    usage: sawUsage ? { inputTokens, outputTokens } : undefined,
    stoppedReason,
    ...(error ? { error } : {}),
  });

  for (let turn = 0; turn < maxTurns; turn += 1) {
    if (signal?.aborted) {
      return finish('error', 'Cancelled by the caller.');
    }

    turns = turn + 1;

    let response: OllamaChatResponse;
    try {
      response = await chatOnce(baseUrl, model, messages, tools, signal);
    } catch (err) {
      return finish('error', (err as Error).message);
    }

    const content = response.message?.content ?? '';

    // Text-encoded tool-call recovery. See text-tool-call-parser.ts: the model this
    // machine runs emits its calls as bare JSON in `content` and never populates
    // `tool_calls`, so without this the loop would treat the very first tool call as the
    // final answer and stop, having touched nothing.
    let calls = response.message?.tool_calls ?? [];
    let recoveredFromText = false;
    if (calls.length === 0 && content.trim() !== '') {
      const recovered = parseTextToolCalls(content, RECOVERABLE_TOOL_NAMES);
      if (recovered.length > 0) {
        calls = recovered;
        recoveredFromText = true;
      }
    }

    // Recovered JSON is a call, not prose — reporting it as part of the answer would show
    // the user the raw tool call they were never meant to see.
    if (content && !recoveredFromText) {
      // Accumulated across turns rather than overwritten: models routinely narrate ("Let me
      // check the config first...") in the same turn they emit a tool call, and discarding
      // that leaves a confusing gap between the recorded steps and the final report.
      answer = answer ? `${answer}\n\n${content}` : content;
    }
    if (response.prompt_eval_count != null && response.eval_count != null) {
      sawUsage = true;
      inputTokens += response.prompt_eval_count;
      outputTokens += response.eval_count;
    }

    if (calls.length === 0) {
      return finish('done');
    }

    // Content must be empty when tool_calls are present: the qwen-family template renders
    // `<tool_call>` only in the `else` branch of its content check, so echoing the recovered
    // JSON back as content would hide the calls from the model on the next turn.
    messages = [
      ...messages,
      {
        role: 'assistant',
        content: recoveredFromText ? '' : content,
        tool_calls: calls,
      },
    ];

    for (const call of calls) {
      if (signal?.aborted) {
        return finish('error', 'Cancelled by the caller.');
      }
      const name = call.function?.name ?? '(unnamed)';
      const parsedArgs = parseArguments(call.function?.arguments);
      const outcome = await executeAgentTool(name, call.function?.arguments, ctx);
      steps.push({ tool: name, args: parsedArgs, ok: outcome.ok, summary: outcome.summary });

      // A failed tool call is fed back as that tool's *result*, not raised — the model gets
      // to read the error and correct itself on the next turn (fix the path, supply the
      // missing argument), which is the entire point of running a tool loop.
      messages = [
        ...messages,
        { role: 'tool', content: truncateForModel(outcome.content), tool_name: name },
      ];
    }
  }

  // Out of turns. Deliberately a normal result, not a throw: the model may well have done
  // real, useful work in those turns (the `steps` record exactly what), and the caller needs
  // to see it in order to decide whether to re-delegate or take over.
  return finish(
    'max-turns',
    `The model kept calling tools without finishing an answer (stopped after ${maxTurns} rounds).`,
  );
}

/**
 * One `/api/chat` request with `stream: false`. Throws a readable Error on any failure;
 * `runOllamaAgent` is the only caller and converts that into `stoppedReason: 'error'`.
 */
async function chatOnce(
  baseUrl: string,
  model: string,
  messages: OllamaMessage[],
  tools: unknown[],
  signal?: AbortSignal,
): Promise<OllamaChatResponse> {
  const timeoutController = new AbortController();
  const timer = setTimeout(() => timeoutController.abort(), OLLAMA_TURN_TIMEOUT_MS);
  const combined = signal
    ? AbortSignal.any([signal, timeoutController.signal])
    : timeoutController.signal;

  try {
    const response = await fetch(`${baseUrl}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model,
        messages,
        tools,
        // Request/response, not a stream: the MCP caller is blocked on one `tools/call`
        // and has nowhere to put incremental tokens. See the module doc comment.
        stream: false,
      }),
      signal: combined,
    });

    if (!response.ok) {
      const detail = await response.text().catch(() => '');
      throw new Error(
        `Ollama returned HTTP ${response.status}${detail ? `: ${detail.slice(0, 500)}` : ''}`,
      );
    }
    return (await response.json()) as OllamaChatResponse;
  } catch (err) {
    if (signal?.aborted) throw new Error('Cancelled by the caller.');
    if (timeoutController.signal.aborted) {
      throw new Error(
        `Ollama did not answer within ${OLLAMA_TURN_TIMEOUT_MS}ms ` +
          `(a cold model load alone can take up to ${OLLAMA_CONNECT_TIMEOUT_MS}ms before generation starts)`,
      );
    }
    throw new Error(`Could not reach Ollama at ${baseUrl}: ${(err as Error).message}`);
  } finally {
    clearTimeout(timer);
  }
}
