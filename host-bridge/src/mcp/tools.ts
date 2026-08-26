import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import {
  AgentResult,
  listOllamaModels,
  runOllamaAgent,
  RunOllamaAgentOptions,
} from '../agent/ollama-agent';
import path from 'path';
import { runProcess } from '../process-runner';
import { resolveInWorkspace, WorkspaceError, workspaceRelative } from '../workspace';
import { listDir, readFile, searchText, writeFile } from '../workspace-fs';

/**
 * The MCP tool surface: what an IDE (VS Code, Cursor, Claude Code, JetBrains, Windsurf)
 * sees when it connects to this server over stdio.
 *
 * Tools are built as plain data — `{ name, config, handler }` — rather than registered
 * directly onto an `McpServer` here, for two reasons. It keeps `server.ts` to the ten
 * lines of SDK wiring it should be, and it makes every handler callable straight from a
 * test without standing up a stdio transport and speaking JSON-RPC at it.
 *
 * ## Never write to stdout
 *
 * stdout **is** the MCP transport on a stdio server: the client parses it as a stream of
 * JSON-RPC messages. A single stray `console.log` — or a library that prints a banner, as
 * dotenv v17 does by default — injects a non-JSON line into that stream and the client
 * drops the connection, usually with an opaque parse error. This is the single easiest way
 * to break a stdio MCP server. All diagnostics here go to stderr, which the IDE captures
 * as the server's log and shows to the user.
 */

/** Zod raw shape, i.e. what `McpServer.registerTool` wants for `inputSchema`. Aliased
 * locally rather than imported from the SDK's internals so a future SDK reshuffle can't
 * break this file's types. */
/** Cap on each captured stream. The Express route uses the same figure; this is about
 * keeping one command's output from dominating a JSON-RPC message, not about the model's
 * context, so it is generous. */
const EXEC_OUTPUT_LIMIT = 20_000;

type InputShape = Record<string, z.ZodTypeAny>;

export interface McpTool {
  name: string;
  config: {
    title: string;
    description: string;
    inputSchema: InputShape;
  };
  /** Contractually non-throwing — see `textResult`/`errorResult` below. */
  handler: (args: Record<string, unknown>) => Promise<CallToolResult>;
}

/**
 * Everything the tools need from the environment, passed in rather than read from
 * `config` at call time so tests can drive the handlers against a temp directory and a
 * fake agent without touching `process.env`.
 */
export interface McpToolDeps {
  workspaceRoot?: string;
  maxFileBytes: number;
  execAllowlist: string[];
  execTimeoutMs: number;
  ollamaBaseUrl: string;
  /** `MCP_AGENT_MODEL`, when the operator pinned one. */
  agentModel?: string;
  /** Injectable purely for tests; production always uses the real loop. */
  runAgent?: (options: RunOllamaAgentOptions) => Promise<AgentResult>;
  /** Injectable purely for tests; production always queries the real Ollama. */
  listModels?: (baseUrl: string) => Promise<Awaited<ReturnType<typeof listOllamaModels>>>;
}

const SEARCH_MAX_RESULTS = 50;

function textResult(text: string): CallToolResult {
  return { content: [{ type: 'text', text }] };
}

/**
 * A failure the IDE can render *as a tool result*, not as a transport-level exception.
 * `isError: true` is the MCP way to say "this tool ran and failed": the calling model sees
 * the message and can act on it (fix the path, configure the env var), whereas an
 * unhandled throw out of a handler is a protocol error that tells the user nothing useful
 * and, in the worst case, tears down the stdio session.
 */
function errorResult(text: string): CallToolResult {
  return { content: [{ type: 'text', text }], isError: true };
}

/** Turns whatever a workspace helper threw into a one-line, actionable message.
 * `WorkspaceError` already carries a human-readable reason (bad path, not found,
 * oversized); anything else is an environment failure worth naming verbatim. */
function describeError(err: unknown): string {
  if (err instanceof WorkspaceError) return err.message;
  return (err as Error).message ?? String(err);
}

/**
 * The message every workspace tool returns when the feature was never switched on. Names
 * the variable *and* the file, because "workspace not configured" on its own sends the
 * user hunting: this process is launched by an IDE, so there is no console output they
 * were watching and no obvious place to look.
 */
const NOT_CONFIGURED =
  'The local workspace is not configured. Set BRIDGE_WORKSPACE_ROOT to an absolute path in ' +
  'host-bridge/.env (the folder the local model is allowed to read and write), then restart ' +
  'the MCP server from your IDE. Run local_model_status to check the current configuration.';

/** Coerces a tool argument to a string. The MCP SDK validates against the declared zod
 * schema before the handler runs, so this is belt-and-braces for the optional fields — but
 * the calling model is still an LLM, and a number where a string was declared is a
 * documented real-world occurrence (see `coerceString` in the agent). */
function asString(value: unknown): string | undefined {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return undefined;
}

function asNonEmptyString(value: unknown): string | undefined {
  const str = asString(value);
  if (str === undefined || str.trim() === '') return undefined;
  return str;
}

/**
 * Picks the model `local_code_agent` should run, in priority order:
 *   1. the `model` argument on the call itself (per-task override),
 *   2. `MCP_AGENT_MODEL` (the operator's pinned default),
 *   3. the first model Ollama reports with the `tools` capability.
 *
 * Step 3 exists so a user with exactly one tool-capable model installed needs no
 * configuration at all. There is deliberately **no hardcoded fallback name**: guessing
 * `qwen2.5-coder:14b` (the verified working model on the machine this was built on) would
 * produce a confusing "model not found" from Ollama on every other machine, where the
 * honest error below tells the user exactly what to do.
 *
 * Returns a string on success or an error message on failure — never throws.
 */
async function resolveAgentModel(
  deps: McpToolDeps,
  requested: string | undefined,
): Promise<{ model: string } | { error: string }> {
  if (requested) return { model: requested };
  if (deps.agentModel) return { model: deps.agentModel };

  const listModels = deps.listModels ?? listOllamaModels;
  let models: Awaited<ReturnType<typeof listOllamaModels>>;
  try {
    models = await listModels(deps.ollamaBaseUrl);
  } catch (err) {
    return {
      error:
        `Could not reach Ollama at ${deps.ollamaBaseUrl} to pick a model: ${describeError(err)}. ` +
        'Is `ollama serve` running? Run local_model_status for details.',
    };
  }

  const toolCapable = models.find((model) => model.supportsTools);
  if (toolCapable) return { model: toolCapable.name };

  if (models.length === 0) {
    return {
      error:
        `Ollama at ${deps.ollamaBaseUrl} has no models installed. Install a tool-capable ` +
        'coding model first, e.g. `ollama pull qwen2.5-coder:14b`.',
    };
  }
  return {
    error:
      'None of the installed Ollama models advertise the `tools` capability, which ' +
      'local_code_agent requires in order to call workspace tools. Installed: ' +
      `${models.map((m) => m.name).join(', ')}. Install one that does, e.g. ` +
      '`ollama pull qwen2.5-coder:14b`, or set MCP_AGENT_MODEL in host-bridge/.env.',
  };
}

/** Renders an `AgentResult` as the text block the IDE shows. The step list is not
 * decoration: it is the audit trail of what a model the user cannot see just did to their
 * files, and it is the difference between "the local agent says it worked" and evidence. */
function formatAgentResult(result: AgentResult, model: string, scope: string): string {
  const lines: string[] = [];
  lines.push(`Local agent (${model}) on ${scope} — ${result.turns} turn(s), ${result.steps.length} tool call(s).`);

  if (result.steps.length > 0) {
    lines.push('');
    lines.push('Steps:');
    for (const [index, step] of result.steps.entries()) {
      lines.push(`  ${index + 1}. ${step.ok ? 'ok  ' : 'FAIL'} ${step.summary}`);
    }
  }

  if (result.stoppedReason !== 'done' && result.error) {
    lines.push('');
    lines.push(`Stopped (${result.stoppedReason}): ${result.error}`);
  }

  lines.push('');
  lines.push(result.answer.trim() || '(the model produced no written answer)');

  if (result.usage) {
    lines.push('');
    lines.push(`Tokens: ${result.usage.inputTokens} in / ${result.usage.outputTokens} out.`);
  }

  return lines.join('\n');
}

export function createMcpTools(deps: McpToolDeps): McpTool[] {
  /** Shared guard: every tool except `local_model_status` needs a configured root, and
   * needs to fail the same actionable way when there isn't one. */
  const root = (): string | undefined => deps.workspaceRoot;

  const localCodeAgent: McpTool = {
    name: 'local_code_agent',
    config: {
      title: 'Delegate a coding task to the local GPU model',
      description:
        'Delegate a self-contained coding task to a model running locally on this machine ' +
        '(via Ollama). The local model reads, searches, and writes real files inside a ' +
        'sandboxed workspace folder and reports back what it changed. Use it to hand off ' +
        'bulk or mechanical work — renames across many files, boilerplate, scaffolding, ' +
        'first-draft implementations — that does not need to consume this conversation. ' +
        'The task must be self-contained: the local model sees only the task text and the ' +
        'workspace, not this conversation.',
      inputSchema: {
        task: z
          .string()
          .describe(
            'The complete, self-contained instruction for the local model. Include any ' +
              'context it needs — it cannot see this conversation.',
          ),
        path: z
          .string()
          .optional()
          .describe(
            'Optional subdirectory of the workspace to scope the task to, relative to the ' +
              'workspace root. The local model is confined to this subtree and its paths ' +
              'become relative to it.',
          ),
        model: z
          .string()
          .optional()
          .describe(
            'Optional Ollama model to use, e.g. "qwen2.5-coder:14b". Defaults to ' +
              'MCP_AGENT_MODEL, else the first installed model with the "tools" capability.',
          ),
      },
    },
    handler: async (args) => {
      const workspaceRoot = root();
      if (!workspaceRoot) return errorResult(NOT_CONFIGURED);

      const task = asNonEmptyString(args.task);
      if (task === undefined) {
        return errorResult('local_code_agent requires a non-empty "task" argument.');
      }

      // Scoping narrows the sandbox rather than merely hinting at it: the subdirectory
      // becomes the agent's workspace root, so `resolveInWorkspace` inside the agent
      // confines every path to that subtree. Resolving it here first also means a bogus
      // scope fails immediately with a clear message instead of after a model turn.
      const scopePath = asNonEmptyString(args.path);
      let effectiveRoot = workspaceRoot;
      if (scopePath !== undefined) {
        try {
          effectiveRoot = await resolveInWorkspace(workspaceRoot, scopePath);
        } catch (err) {
          return errorResult(`Cannot scope the task to "${scopePath}": ${describeError(err)}`);
        }
      }

      const picked = await resolveAgentModel(deps, asNonEmptyString(args.model));
      if ('error' in picked) return errorResult(picked.error);

      const runAgent = deps.runAgent ?? runOllamaAgent;
      // `runOllamaAgent` is contractually non-throwing, but a defensive catch here keeps
      // the promise this file makes (never throw out of a handler) independent of that.
      let result: AgentResult;
      try {
        result = await runAgent({
          task,
          model: picked.model,
          baseUrl: deps.ollamaBaseUrl,
          workspaceRoot: effectiveRoot,
          maxFileBytes: deps.maxFileBytes,
          execAllowlist: deps.execAllowlist,
          execTimeoutMs: deps.execTimeoutMs,
        });
      } catch (err) {
        return errorResult(`The local agent failed to run: ${describeError(err)}`);
      }

      const scope = scopePath ? `./${workspaceRelative(workspaceRoot, effectiveRoot)}` : 'the workspace root';
      const text = formatAgentResult(result, picked.model, scope);
      // An `error` run is reported as a tool error so the calling model does not treat a
      // failed delegation as done work; `max-turns` is not — the steps that ran are real
      // and the answer text explains where it stopped.
      return result.stoppedReason === 'error' ? errorResult(text) : textResult(text);
    },
  };

  const localWorkspaceRead: McpTool = {
    name: 'local_workspace_read',
    config: {
      title: 'Read a file from the local workspace',
      description:
        'Read one file from the sandboxed local workspace folder. Path is relative to the ' +
        'workspace root.',
      inputSchema: {
        path: z.string().describe('File path relative to the workspace root.'),
      },
    },
    handler: async (args) => {
      const workspaceRoot = root();
      if (!workspaceRoot) return errorResult(NOT_CONFIGURED);
      const relPath = asNonEmptyString(args.path);
      if (relPath === undefined) {
        return errorResult('local_workspace_read requires a "path" argument.');
      }
      try {
        const result = await readFile(workspaceRoot, relPath, deps.maxFileBytes);
        const header = result.truncated
          ? `${result.path} (truncated at ${result.bytes} bytes)`
          : result.path;
        return textResult(`${header}:\n${result.content}`);
      } catch (err) {
        return errorResult(`Could not read "${relPath}": ${describeError(err)}`);
      }
    },
  };

  const localWorkspaceWrite: McpTool = {
    name: 'local_workspace_write',
    config: {
      title: 'Write a file into the local workspace',
      description:
        'Create or overwrite one file in the sandboxed local workspace folder. Replaces the ' +
        'entire file — pass the complete new content, not a diff. Parent directories are ' +
        'created as needed.',
      inputSchema: {
        path: z.string().describe('File path relative to the workspace root.'),
        content: z.string().describe('The complete new file content.'),
      },
    },
    handler: async (args) => {
      const workspaceRoot = root();
      if (!workspaceRoot) return errorResult(NOT_CONFIGURED);
      const relPath = asNonEmptyString(args.path);
      if (relPath === undefined) {
        return errorResult('local_workspace_write requires a "path" argument.');
      }
      // Blank is legitimate content (an intentionally empty file), so unlike `path` this
      // only rejects a genuinely absent value.
      const content = asString(args.content);
      if (content === undefined) {
        return errorResult('local_workspace_write requires a "content" argument.');
      }
      try {
        const result = await writeFile(workspaceRoot, relPath, content, deps.maxFileBytes);
        return textResult(
          `Wrote ${result.bytes} bytes to ${result.path}${result.created ? ' (new file)' : ''}.`,
        );
      } catch (err) {
        return errorResult(`Could not write "${relPath}": ${describeError(err)}`);
      }
    },
  };

  const localWorkspaceList: McpTool = {
    name: 'local_workspace_list',
    config: {
      title: 'List a directory in the local workspace',
      description:
        'List the files and subdirectories directly inside a directory of the sandboxed ' +
        'local workspace folder. Omit the path to list the workspace root.',
      inputSchema: {
        path: z
          .string()
          .optional()
          .describe('Directory relative to the workspace root. Omit for the root.'),
      },
    },
    handler: async (args) => {
      const workspaceRoot = root();
      if (!workspaceRoot) return errorResult(NOT_CONFIGURED);
      const relPath = asNonEmptyString(args.path) ?? '.';
      try {
        const result = await listDir(workspaceRoot, relPath);
        if (result.entries.length === 0) {
          return textResult(`${result.path}: (empty directory)`);
        }
        const lines = result.entries.map(
          (entry) => `${entry.type === 'dir' ? 'dir ' : 'file'}  ${entry.name}  ${entry.size}`,
        );
        return textResult(`${result.path}:\n${lines.join('\n')}`);
      } catch (err) {
        return errorResult(`Could not list "${relPath}": ${describeError(err)}`);
      }
    },
  };

  const localWorkspaceSearch: McpTool = {
    name: 'local_workspace_search',
    config: {
      title: 'Search the local workspace',
      description:
        'Search file contents in the sandboxed local workspace folder for a literal ' +
        '(case-insensitive) query string. Skips node_modules, .git, dist, build and .next.',
      inputSchema: {
        query: z.string().describe('Literal text to search for. Not a regular expression.'),
        path: z
          .string()
          .optional()
          .describe('Directory relative to the workspace root to restrict the search to.'),
      },
    },
    handler: async (args) => {
      const workspaceRoot = root();
      if (!workspaceRoot) return errorResult(NOT_CONFIGURED);
      const query = asNonEmptyString(args.query);
      if (query === undefined) {
        return errorResult('local_workspace_search requires a non-empty "query" argument.');
      }
      const relPath = asNonEmptyString(args.path) ?? '.';
      try {
        const result = await searchText(
          workspaceRoot,
          relPath,
          query,
          SEARCH_MAX_RESULTS,
          deps.maxFileBytes,
        );
        if (result.matches.length === 0) {
          return textResult(`No matches for "${query}" under ${relPath}.`);
        }
        const lines = result.matches.map((m) => `${m.path}:${m.line}: ${m.text}`);
        return textResult(
          result.truncated ? `${lines.join('\n')}\n...[results truncated]` : lines.join('\n'),
        );
      } catch (err) {
        return errorResult(`Could not search "${relPath}": ${describeError(err)}`);
      }
    },
  };

  /**
   * Runs one allowlisted command in the sandbox.
   *
   * `local_code_agent` has been able to do this all along, but only from inside its own loop —
   * a client had no way to run `git status` or a test suite on its own behalf. That gap is
   * what kept the workbench's git and run panels impossible: both are nothing but structured
   * command output.
   *
   * The safety rules are deliberately identical to the agent's `run_command`, and for the same
   * reasons: a bare command name only (an absolute path or one containing a separator would
   * let a caller name any executable on disk and step around the allowlist entirely), no
   * shell (so metacharacters in the arguments stay inert data rather than becoming a second
   * command), a cwd resolved through the workspace sandbox, and a hard timeout.
   *
   * The output shape below is parsed by clients, so it is fixed rather than prose: the exit
   * code and the stream markers must stay exactly as written.
   */
  const localWorkspaceExec: McpTool = {
    name: 'local_workspace_exec',
    config: {
      title: 'Run an allowlisted command in the local workspace',
      description:
        'Run one command from BRIDGE_EXEC_ALLOWLIST inside the sandboxed workspace folder ' +
        'and return its exit code, stdout and stderr. Bare command names only — no shell, ' +
        'no pipes, no redirection. Use local_model_status to see which commands are allowed.',
      inputSchema: {
        command: z
          .string()
          .describe('Bare command name, e.g. "git" or "python". Not a path.'),
        args: z.array(z.string()).optional().describe('Arguments, already split.'),
        cwd: z
          .string()
          .optional()
          .describe('Directory relative to the workspace root. Omit for the root.'),
      },
    },
    handler: async (args) => {
      const workspaceRoot = root();
      if (!workspaceRoot) return errorResult(NOT_CONFIGURED);

      const command = asNonEmptyString(args.command);
      if (command === undefined) {
        return errorResult('local_workspace_exec requires a non-empty "command" argument.');
      }
      if (command.includes('/') || command.includes('\\') || path.isAbsolute(command)) {
        return errorResult('local_workspace_exec requires a bare command name, not a path.');
      }
      if (deps.execAllowlist.length === 0) {
        return errorResult(
          'Command execution is disabled: no commands are allowlisted. Set ' +
            'BRIDGE_EXEC_ALLOWLIST in host-bridge/.env to enable it.',
        );
      }
      if (!deps.execAllowlist.includes(command.toLowerCase())) {
        return errorResult(
          `"${command}" is not on the exec allowlist (${deps.execAllowlist.join(', ')}).`,
        );
      }

      const commandArgs = Array.isArray(args.args)
        ? args.args.filter((entry): entry is string => typeof entry === 'string')
        : [];
      const relCwd = asNonEmptyString(args.cwd) ?? '.';

      try {
        const resolvedCwd = await resolveInWorkspace(workspaceRoot, relCwd);
        const result = await runProcess(
          command,
          commandArgs,
          resolvedCwd,
          deps.execTimeoutMs,
        );
        const stdout = result.stdout.slice(0, EXEC_OUTPUT_LIMIT);
        const stderr = result.stderr.slice(0, EXEC_OUTPUT_LIMIT);
        return textResult(
          [
            `exit: ${result.code ?? 'none'}`,
            `timed out: ${result.timedOut ? 'yes' : 'no'}`,
            '--- stdout ---',
            stdout,
            '--- stderr ---',
            stderr,
          ].join('\n'),
        );
      } catch (err) {
        return errorResult(`Could not run "${command}": ${describeError(err)}`);
      }
    },
  };

  const localModelStatus: McpTool = {
    name: 'local_model_status',
    config: {
      title: 'Check the local model and workspace setup',
      description:
        'Report whether the local coding agent is usable: whether the sandboxed workspace ' +
        'folder is configured, whether Ollama is reachable, which models are installed and ' +
        'which of them support tool calling, and whether command execution is enabled. Call ' +
        'this first when any other local_* tool reports a configuration problem.',
      inputSchema: {},
    },
    // The one tool that must keep working when nothing is configured — it is precisely how
    // a user diagnoses that state, so guarding it behind the same workspace check as the
    // others would make the diagnostic unreachable exactly when it is needed.
    handler: async () => {
      const lines: string[] = [];
      const workspaceRoot = root();

      lines.push('Workspace:');
      if (workspaceRoot) {
        lines.push(`  configured: yes`);
        lines.push(`  root: ${workspaceRoot}`);
      } else {
        lines.push('  configured: NO');
        lines.push(
          '  fix: set BRIDGE_WORKSPACE_ROOT to an absolute path in host-bridge/.env, then ' +
            'restart the MCP server from your IDE.',
        );
      }
      lines.push(`  max file bytes: ${deps.maxFileBytes}`);

      lines.push('');
      lines.push('Command execution (run_command):');
      if (deps.execAllowlist.length > 0) {
        lines.push(`  enabled: yes`);
        lines.push(`  allowed commands: ${deps.execAllowlist.join(', ')}`);
      } else {
        lines.push('  enabled: no (set BRIDGE_EXEC_ALLOWLIST in host-bridge/.env to enable)');
      }

      lines.push('');
      lines.push(`Ollama (${deps.ollamaBaseUrl}):`);
      const listModels = deps.listModels ?? listOllamaModels;
      try {
        const models = await listModels(deps.ollamaBaseUrl);
        lines.push('  reachable: yes');
        if (models.length === 0) {
          lines.push('  models: none installed (try `ollama pull qwen2.5-coder:14b`)');
        } else {
          lines.push(`  models (${models.length}):`);
          for (const model of models) {
            const toolsNote =
              model.supportsTools === true
                ? 'tools: YES'
                : model.supportsTools === false
                  ? 'tools: no'
                  : 'tools: unknown';
            lines.push(`    ${model.name}  [${toolsNote}]`);
          }
          const capable = models.filter((m) => m.supportsTools).map((m) => m.name);
          lines.push('');
          lines.push(
            capable.length > 0
              ? `  local_code_agent can use: ${capable.join(', ')}`
              : '  local_code_agent CANNOT run: no installed model supports tool calling.',
          );
        }
      } catch (err) {
        lines.push(`  reachable: NO — ${describeError(err)}`);
        lines.push('  fix: start Ollama (`ollama serve`), or set OLLAMA_BASE_URL in host-bridge/.env.');
      }

      lines.push('');
      lines.push(
        deps.agentModel
          ? `Default agent model (MCP_AGENT_MODEL): ${deps.agentModel}`
          : 'Default agent model: not pinned — the first tool-capable model above is used.',
      );

      // Status is informational by definition: "not configured" is a valid, successfully
      // delivered answer, so this never returns isError even when everything is off.
      return textResult(lines.join('\n'));
    },
  };

  return [
    localCodeAgent,
    localWorkspaceRead,
    localWorkspaceWrite,
    localWorkspaceList,
    localWorkspaceSearch,
    localWorkspaceExec,
    localModelStatus,
  ];
}
