import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { AgentResult, RunOllamaAgentOptions } from '../agent/ollama-agent';
import { createMcpTools, McpTool, McpToolDeps } from './tools';

/**
 * Handlers are called directly rather than through a real stdio transport: spinning up
 * `StdioServerTransport` would test the SDK's JSON-RPC framing (which the SDK already
 * tests) instead of this file's behaviour, and would make every assertion go through a
 * process boundary for nothing. The end-to-end stdio path is covered by the smoke test in
 * the runbook instead.
 */

function toolText(result: { content: unknown[] }): string {
  return (result.content as { type: string; text: string }[])
    .filter((part) => part.type === 'text')
    .map((part) => part.text)
    .join('\n');
}

function findTool(tools: McpTool[], name: string): McpTool {
  const tool = tools.find((candidate) => candidate.name === name);
  if (!tool) throw new Error(`no such tool: ${name}`);
  return tool;
}

const MODELS_WITH_TOOLS = [
  { name: 'qwen2.5-coder:14b', capabilities: ['completion', 'tools', 'insert'], supportsTools: true },
  { name: 'llama3:8b', capabilities: ['completion'], supportsTools: false },
];

describe('createMcpTools', () => {
  let root: string;

  const deps = (overrides: Partial<McpToolDeps> = {}): McpToolDeps => ({
    workspaceRoot: root,
    maxFileBytes: 256_000,
    execAllowlist: [],
    execTimeoutMs: 5_000,
    ollamaBaseUrl: 'http://localhost:11434',
    listModels: async () => MODELS_WITH_TOOLS,
    ...overrides,
  });

  beforeEach(() => {
    root = mkdtempSync(path.join(tmpdir(), 'host-bridge-mcp-'));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('exposes exactly the six documented tool names', () => {
    expect(createMcpTools(deps()).map((tool) => tool.name)).toEqual([
      'local_code_agent',
      'local_workspace_read',
      'local_workspace_write',
      'local_workspace_list',
      'local_workspace_search',
      'local_model_status',
    ]);
  });

  describe('when BRIDGE_WORKSPACE_ROOT is unset', () => {
    const unconfigured = (overrides: Partial<McpToolDeps> = {}) =>
      createMcpTools({
        workspaceRoot: undefined,
        maxFileBytes: 256_000,
        execAllowlist: [],
        execTimeoutMs: 5_000,
        ollamaBaseUrl: 'http://localhost:11434',
        listModels: async () => MODELS_WITH_TOOLS,
        ...overrides,
      });

    it.each([
      ['local_code_agent', { task: 'do a thing' }],
      ['local_workspace_read', { path: 'a.txt' }],
      ['local_workspace_write', { path: 'a.txt', content: 'x' }],
      ['local_workspace_list', {}],
      ['local_workspace_search', { query: 'needle' }],
    ])('%s returns an actionable error naming the env var and the file', async (name, args) => {
      const result = await findTool(unconfigured(), name).handler(args);

      expect(result.isError).toBe(true);
      const text = toolText(result as { content: unknown[] });
      expect(text).toContain('BRIDGE_WORKSPACE_ROOT');
      expect(text).toContain('host-bridge/.env');
    });

    it('local_model_status still works — it is how the user diagnoses exactly this', async () => {
      const result = await findTool(unconfigured(), 'local_model_status').handler({});

      // Informational, never an error result: "not configured" is a successfully
      // delivered answer, and flagging it as a failure would push a calling model into
      // retrying rather than reporting.
      expect(result.isError).toBeUndefined();
      const text = toolText(result as { content: unknown[] });
      expect(text).toContain('configured: NO');
      expect(text).toContain('BRIDGE_WORKSPACE_ROOT');
      expect(text).toContain('qwen2.5-coder:14b');
      expect(text).toContain('tools: YES');
    });

    it('never spawns the agent when the workspace is unset', async () => {
      const runAgent = jest.fn();
      await findTool(unconfigured({ runAgent }), 'local_code_agent').handler({ task: 'x' });
      expect(runAgent).not.toHaveBeenCalled();
    });
  });

  describe('local_workspace_read', () => {
    it('reads a file from the sandbox', async () => {
      writeFileSync(path.join(root, 'hello.txt'), 'hello from the sandbox');

      const result = await findTool(createMcpTools(deps()), 'local_workspace_read').handler({
        path: 'hello.txt',
      });

      expect(result.isError).toBeUndefined();
      const text = toolText(result as { content: unknown[] });
      expect(text).toContain('hello.txt');
      expect(text).toContain('hello from the sandbox');
    });

    it('reports a missing file as a tool error rather than throwing', async () => {
      const result = await findTool(createMcpTools(deps()), 'local_workspace_read').handler({
        path: 'nope.txt',
      });

      expect(result.isError).toBe(true);
      expect(toolText(result as { content: unknown[] })).toContain('Path not found');
    });

    it('rejects a path that escapes the workspace root', async () => {
      const result = await findTool(createMcpTools(deps()), 'local_workspace_read').handler({
        path: '../../../../etc/passwd',
      });

      expect(result.isError).toBe(true);
      expect(toolText(result as { content: unknown[] })).toContain('escapes the workspace root');
    });

    it('flags a truncated read so the caller knows it is partial', async () => {
      writeFileSync(path.join(root, 'big.txt'), 'a'.repeat(100));

      const result = await findTool(
        createMcpTools(deps({ maxFileBytes: 10 })),
        'local_workspace_read',
      ).handler({ path: 'big.txt' });

      expect(toolText(result as { content: unknown[] })).toContain('truncated at 10 bytes');
    });
  });

  describe('local_workspace_write', () => {
    it('writes a file into the sandbox', async () => {
      const result = await findTool(createMcpTools(deps()), 'local_workspace_write').handler({
        path: 'sub/new.txt',
        content: 'written',
      });

      expect(result.isError).toBeUndefined();
      expect(readFileSync(path.join(root, 'sub', 'new.txt'), 'utf8')).toBe('written');
      expect(toolText(result as { content: unknown[] })).toContain('new file');
    });

    it('accepts empty content — an intentionally empty file is a legitimate request', async () => {
      const result = await findTool(createMcpTools(deps()), 'local_workspace_write').handler({
        path: 'empty.txt',
        content: '',
      });

      expect(result.isError).toBeUndefined();
      expect(readFileSync(path.join(root, 'empty.txt'), 'utf8')).toBe('');
    });

    it('rejects a traversal attempt', async () => {
      const result = await findTool(createMcpTools(deps()), 'local_workspace_write').handler({
        path: '../escaped.txt',
        content: 'x',
      });

      expect(result.isError).toBe(true);
      expect(toolText(result as { content: unknown[] })).toContain('escapes the workspace root');
    });
  });

  describe('local_workspace_list', () => {
    it('lists the root when no path is given', async () => {
      mkdirSync(path.join(root, 'src'));
      writeFileSync(path.join(root, 'readme.md'), 'x');

      const result = await findTool(createMcpTools(deps()), 'local_workspace_list').handler({});

      const text = toolText(result as { content: unknown[] });
      expect(text).toContain('src');
      expect(text).toContain('readme.md');
    });

    it('reports an empty directory clearly', async () => {
      mkdirSync(path.join(root, 'empty'));

      const result = await findTool(createMcpTools(deps()), 'local_workspace_list').handler({
        path: 'empty',
      });

      expect(toolText(result as { content: unknown[] })).toContain('(empty directory)');
    });
  });

  describe('local_workspace_search', () => {
    it('finds a match and reports path and line', async () => {
      writeFileSync(path.join(root, 'a.txt'), 'first\nhas a NEEDLE here\nthird');

      const result = await findTool(createMcpTools(deps()), 'local_workspace_search').handler({
        query: 'needle',
      });

      expect(toolText(result as { content: unknown[] })).toContain('a.txt:2:');
    });

    it('says so plainly when there are no matches', async () => {
      writeFileSync(path.join(root, 'a.txt'), 'nothing relevant');

      const result = await findTool(createMcpTools(deps()), 'local_workspace_search').handler({
        query: 'needle',
      });

      expect(result.isError).toBeUndefined();
      expect(toolText(result as { content: unknown[] })).toContain('No matches');
    });
  });

  describe('local_code_agent', () => {
    const agentResult = (overrides: Partial<AgentResult> = {}): AgentResult => ({
      answer: 'I created the file.',
      steps: [
        { tool: 'write_file', args: { path: 'out.txt' }, ok: true, summary: 'write_file(out.txt) → 5 bytes' },
      ],
      turns: 2,
      usage: { inputTokens: 100, outputTokens: 20 },
      stoppedReason: 'done',
      ...overrides,
    });

    it('runs the agent and reports the answer plus every step', async () => {
      const runAgent = jest.fn(async (_options: RunOllamaAgentOptions) => agentResult());

      const result = await findTool(createMcpTools(deps({ runAgent })), 'local_code_agent').handler({
        task: 'create out.txt',
      });

      expect(result.isError).toBeUndefined();
      const text = toolText(result as { content: unknown[] });
      expect(text).toContain('I created the file.');
      expect(text).toContain('Steps:');
      expect(text).toContain('write_file(out.txt)');
      expect(text).toContain('Tokens: 100 in / 20 out.');
    });

    it('picks the first tool-capable model when none is pinned or requested', async () => {
      const runAgent = jest.fn(async (_options: RunOllamaAgentOptions) => agentResult());

      await findTool(createMcpTools(deps({ runAgent })), 'local_code_agent').handler({
        task: 'x',
      });

      expect(runAgent.mock.calls[0][0]).toMatchObject({ model: 'qwen2.5-coder:14b' });
    });

    it('prefers the per-call model over MCP_AGENT_MODEL', async () => {
      const runAgent = jest.fn(async (_options: RunOllamaAgentOptions) => agentResult());

      await findTool(
        createMcpTools(deps({ runAgent, agentModel: 'pinned:7b' })),
        'local_code_agent',
      ).handler({ task: 'x', model: 'explicit:3b' });

      expect(runAgent.mock.calls[0][0]).toMatchObject({ model: 'explicit:3b' });
    });

    it('falls back to MCP_AGENT_MODEL without querying Ollama at all', async () => {
      const runAgent = jest.fn(async (_options: RunOllamaAgentOptions) => agentResult());
      const listModels = jest.fn();

      await findTool(
        createMcpTools(deps({ runAgent, listModels, agentModel: 'pinned:7b' })),
        'local_code_agent',
      ).handler({ task: 'x' });

      expect(runAgent.mock.calls[0][0]).toMatchObject({ model: 'pinned:7b' });
      expect(listModels).not.toHaveBeenCalled();
    });

    it('explains the problem when no installed model supports tool calling', async () => {
      const runAgent = jest.fn();

      const result = await findTool(
        createMcpTools(
          deps({
            runAgent,
            listModels: async () => [
              { name: 'llama3:8b', capabilities: ['completion'], supportsTools: false },
            ],
          }),
        ),
        'local_code_agent',
      ).handler({ task: 'x' });

      expect(result.isError).toBe(true);
      const text = toolText(result as { content: unknown[] });
      expect(text).toContain('tools');
      expect(text).toContain('llama3:8b');
      expect(runAgent).not.toHaveBeenCalled();
    });

    it('scopes the agent to a subdirectory by narrowing its workspace root', async () => {
      mkdirSync(path.join(root, 'packages', 'api'), { recursive: true });
      const runAgent = jest.fn(async (_options: RunOllamaAgentOptions) => agentResult());

      const result = await findTool(createMcpTools(deps({ runAgent })), 'local_code_agent').handler({
        task: 'x',
        path: 'packages/api',
      });

      expect(runAgent.mock.calls[0][0].workspaceRoot).toBe(path.join(root, 'packages', 'api'));
      expect(toolText(result as { content: unknown[] })).toContain('packages/api');
    });

    it('refuses a scope path that escapes the workspace root', async () => {
      const runAgent = jest.fn();

      const result = await findTool(createMcpTools(deps({ runAgent })), 'local_code_agent').handler({
        task: 'x',
        path: '../..',
      });

      expect(result.isError).toBe(true);
      expect(toolText(result as { content: unknown[] })).toContain('escapes the workspace root');
      expect(runAgent).not.toHaveBeenCalled();
    });

    it('reports an agent error run as a tool error', async () => {
      const runAgent = jest.fn(async () =>
        agentResult({ stoppedReason: 'error', error: 'Could not reach Ollama', answer: '', steps: [] }),
      );

      const result = await findTool(createMcpTools(deps({ runAgent })), 'local_code_agent').handler({
        task: 'x',
      });

      expect(result.isError).toBe(true);
      expect(toolText(result as { content: unknown[] })).toContain('Could not reach Ollama');
    });

    it('reports a max-turns run as a normal result — the steps that ran are real work', async () => {
      const runAgent = jest.fn(async () =>
        agentResult({ stoppedReason: 'max-turns', error: 'stopped after 8 rounds' }),
      );

      const result = await findTool(createMcpTools(deps({ runAgent })), 'local_code_agent').handler({
        task: 'x',
      });

      expect(result.isError).toBeUndefined();
      const text = toolText(result as { content: unknown[] });
      expect(text).toContain('Stopped (max-turns)');
      expect(text).toContain('write_file(out.txt)');
    });

    it('never throws when the agent itself throws', async () => {
      const runAgent = jest.fn(async () => {
        throw new Error('unexpected explosion');
      });

      const result = await findTool(createMcpTools(deps({ runAgent })), 'local_code_agent').handler({
        task: 'x',
      });

      expect(result.isError).toBe(true);
      expect(toolText(result as { content: unknown[] })).toContain('unexpected explosion');
    });
  });

  describe('local_model_status', () => {
    it('reports the workspace, exec settings, and per-model tool capability', async () => {
      const result = await findTool(
        createMcpTools(deps({ execAllowlist: ['git', 'pnpm'] })),
        'local_model_status',
      ).handler({});

      const text = toolText(result as { content: unknown[] });
      expect(text).toContain('configured: yes');
      expect(text).toContain(root);
      expect(text).toContain('allowed commands: git, pnpm');
      expect(text).toContain('qwen2.5-coder:14b  [tools: YES]');
      expect(text).toContain('llama3:8b  [tools: no]');
      expect(text).toContain('local_code_agent can use: qwen2.5-coder:14b');
    });

    it('reports exec as disabled when the allowlist is empty', async () => {
      const result = await findTool(createMcpTools(deps()), 'local_model_status').handler({});
      expect(toolText(result as { content: unknown[] })).toContain(
        'enabled: no (set BRIDGE_EXEC_ALLOWLIST',
      );
    });

    it('reports an unreachable Ollama without erroring the tool call', async () => {
      const result = await findTool(
        createMcpTools(
          deps({
            listModels: async () => {
              throw new Error('fetch failed');
            },
          }),
        ),
        'local_model_status',
      ).handler({});

      expect(result.isError).toBeUndefined();
      const text = toolText(result as { content: unknown[] });
      expect(text).toContain('reachable: NO');
      expect(text).toContain('ollama serve');
    });
  });
});
