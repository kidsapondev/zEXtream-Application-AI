import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { runOllamaAgent } from './ollama-agent';

const BASE_URL = 'http://localhost:11434';
const MODEL = 'test-model:latest';

/** Builds one `/api/chat` response body in Ollama's non-streaming shape. */
function chatResponse(options: {
  content?: string;
  toolCalls?: { name: string; args: unknown }[];
  promptEvalCount?: number;
  evalCount?: number;
}) {
  return {
    message: {
      role: 'assistant',
      content: options.content ?? '',
      ...(options.toolCalls
        ? {
            tool_calls: options.toolCalls.map((call) => ({
              function: { name: call.name, arguments: call.args },
            })),
          }
        : {}),
    },
    done: true,
    done_reason: 'stop',
    ...(options.promptEvalCount != null ? { prompt_eval_count: options.promptEvalCount } : {}),
    ...(options.evalCount != null ? { eval_count: options.evalCount } : {}),
  };
}

/**
 * Scripts a queue of `/api/chat` responses, one per turn — the same harness shape the
 * backend's `ollama-tool-loop.spec.ts` uses, because a tool loop is only meaningfully
 * testable when successive turns can return different things.
 */
function queueFetch(bodies: unknown[]): jest.Mock {
  const mock = jest.fn(async () => {
    const body = bodies.shift();
    if (body === undefined) {
      throw new Error('fetch called more times than the test scripted responses');
    }
    return {
      ok: true,
      status: 200,
      json: async () => body,
      text: async () => JSON.stringify(body),
    } as unknown as Response;
  });
  global.fetch = mock as unknown as typeof fetch;
  return mock;
}

/** The request body of the Nth `/api/chat` call the agent made. */
function sentBody(mock: jest.Mock, index: number): Record<string, unknown> {
  const init = mock.mock.calls[index][1] as RequestInit;
  return JSON.parse(init.body as string) as Record<string, unknown>;
}

describe('runOllamaAgent', () => {
  let root: string;
  const realFetch = global.fetch;

  const run = (task: string, overrides: Partial<Parameters<typeof runOllamaAgent>[0]> = {}) =>
    runOllamaAgent({
      task,
      model: MODEL,
      baseUrl: BASE_URL,
      workspaceRoot: root,
      maxFileBytes: 256_000,
      execAllowlist: [],
      execTimeoutMs: 5_000,
      ...overrides,
    });

  beforeEach(() => {
    root = mkdtempSync(path.join(tmpdir(), 'host-bridge-agent-'));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
    global.fetch = realFetch;
    jest.restoreAllMocks();
  });

  it('returns a plain answer without calling any tools', async () => {
    const mock = queueFetch([
      chatResponse({ content: 'A promise is an object representing a future value.', promptEvalCount: 12, evalCount: 9 }),
    ]);

    const result = await run('Explain what a promise is.');

    expect(result.stoppedReason).toBe('done');
    expect(result.answer).toContain('future value');
    expect(result.steps).toHaveLength(0);
    expect(result.turns).toBe(1);
    expect(result.usage).toEqual({ inputTokens: 12, outputTokens: 9 });
    expect(mock).toHaveBeenCalledTimes(1);
  });

  it('recovers a tool call the model emitted as plain text instead of tool_calls', async () => {
    // The reproduced behaviour of qwen2.5-coder:14b on Ollama 0.32.15 — see
    // text-tool-call-parser.ts. Without recovery the loop would treat this first turn as
    // the final answer and stop, having touched nothing on disk.
    writeFileSync(path.join(root, 'config.json'), '{"port":3000}');
    const mock = queueFetch([
      chatResponse({
        content: '{"name": "read_file", "arguments": {"path": "config.json"}}',
      }),
      chatResponse({ content: 'The port is 3000.' }),
    ]);

    const result = await run('What port is configured?');

    expect(result.stoppedReason).toBe('done');
    expect(result.steps).toHaveLength(1);
    expect(result.steps[0].tool).toBe('read_file');
    // The raw JSON must never surface as the answer the IDE shows.
    expect(result.answer).not.toContain('"arguments"');
    expect(result.answer).toContain('The port is 3000.');

    // The follow-up turn must carry the call in tool_calls with empty content, or the
    // qwen-family template renders the content branch and hides the call from the model.
    const followUp = sentBody(mock, 1);
    const assistantTurn = (
      followUp.messages as Array<{ role: string; content: string; tool_calls?: unknown[] }>
    ).find((message) => message.role === 'assistant');
    expect(assistantTurn?.content).toBe('');
    expect(assistantTurn?.tool_calls).toHaveLength(1);
  });

  it('treats a genuine JSON answer as prose rather than a tool call', async () => {
    const mock = queueFetch([chatResponse({ content: '{"port": 3000}' })]);

    const result = await run('Show me the config as JSON.');

    expect(result.steps).toHaveLength(0);
    expect(result.answer).toBe('{"port": 3000}');
    expect(mock).toHaveBeenCalledTimes(1);
  });

  it('sends stream: false — the MCP caller has nowhere to put incremental tokens', async () => {
    const mock = queueFetch([chatResponse({ content: 'done' })]);

    await run('anything');

    expect(sentBody(mock, 0).stream).toBe(false);
  });

  it('executes a tool call, feeds the result back, then returns the follow-up answer', async () => {
    writeFileSync(path.join(root, 'notes.txt'), 'the answer is 42');
    const mock = queueFetch([
      chatResponse({ toolCalls: [{ name: 'read_file', args: { path: 'notes.txt' } }] }),
      chatResponse({ content: 'The file says the answer is 42.' }),
    ]);

    const result = await run('What does notes.txt say?');

    expect(result.stoppedReason).toBe('done');
    expect(result.turns).toBe(2);
    expect(result.steps).toHaveLength(1);
    expect(result.steps[0]).toMatchObject({ tool: 'read_file', ok: true });
    expect(result.steps[0].summary).toContain('read_file(notes.txt)');
    expect(result.answer).toContain('42');

    // The tool's output must actually reach the model as a `tool` message on the next turn
    // — that round trip is the whole mechanism.
    const secondTurn = sentBody(mock, 1);
    const messages = secondTurn.messages as { role: string; content: string; tool_name?: string }[];
    const toolMessage = messages.find((message) => message.role === 'tool');
    expect(toolMessage?.tool_name).toBe('read_file');
    expect(toolMessage?.content).toContain('the answer is 42');
  });

  it('writes a real file when the model asks it to', async () => {
    queueFetch([
      chatResponse({
        toolCalls: [{ name: 'write_file', args: { path: 'out/hello.txt', content: 'hi there' } }],
      }),
      chatResponse({ content: 'Created out/hello.txt.' }),
    ]);

    const result = await run('Create out/hello.txt saying "hi there".');

    expect(result.steps[0].ok).toBe(true);
    expect(readFileSync(path.join(root, 'out', 'hello.txt'), 'utf8')).toBe('hi there');
  });

  it('parses arguments that arrive JSON-string-encoded rather than as an object', async () => {
    writeFileSync(path.join(root, 'notes.txt'), 'encoded ok');
    queueFetch([
      // Local models really do emit the whole arguments payload as a string.
      chatResponse({ toolCalls: [{ name: 'read_file', args: '{"path":"notes.txt"}' }] }),
      chatResponse({ content: 'read it' }),
    ]);

    const result = await run('read notes.txt');

    expect(result.steps[0].ok).toBe(true);
    expect(result.steps[0].summary).toContain('notes.txt');
  });

  it('unwraps arguments the model wrapped in the JSON-Schema envelope it was shown', async () => {
    writeFileSync(path.join(root, 'notes.txt'), 'unwrapped ok');
    queueFetch([
      // Observed intermittently from llama3.2:1b on Ollama 0.32.15: the model echoes the
      // schema instead of an instance of it.
      chatResponse({
        toolCalls: [
          {
            name: 'read_file',
            args: { type: 'object', required: ['path'], properties: { path: 'notes.txt' } },
          },
        ],
      }),
      chatResponse({ content: 'read it' }),
    ]);

    const result = await run('read notes.txt');

    expect(result.steps[0].ok).toBe(true);
    expect(result.steps[0].summary).toContain('read_file(notes.txt)');
  });

  it('does not unwrap a plain object that merely has a "properties" key', async () => {
    queueFetch([
      chatResponse({
        toolCalls: [{ name: 'write_file', args: { path: 'a.json', content: '{}', properties: 'x' } }],
      }),
      chatResponse({ content: 'wrote it' }),
    ]);

    const result = await run('write a.json');

    expect(result.steps[0].ok).toBe(true);
    expect(readFileSync(path.join(root, 'a.json'), 'utf8')).toBe('{}');
  });

  it('surfaces a tool failure to the model instead of throwing', async () => {
    const mock = queueFetch([
      chatResponse({ toolCalls: [{ name: 'read_file', args: { path: 'does-not-exist.txt' } }] }),
      chatResponse({ content: 'That file is not there.' }),
    ]);

    const result = await run('Read does-not-exist.txt');

    expect(result.stoppedReason).toBe('done');
    expect(result.steps).toHaveLength(1);
    expect(result.steps[0].ok).toBe(false);
    expect(result.steps[0].summary).toContain('read_file failed');

    // The failure has to be visible to the model as that tool's result, so it can recover
    // on the next turn — that is the entire point of not throwing.
    const messages = sentBody(mock, 1).messages as { role: string; content: string }[];
    const toolMessage = messages.find((message) => message.role === 'tool');
    expect(toolMessage?.content).toContain('Path not found');
  });

  it('rejects a path that escapes the workspace root and reports it as a failed step', async () => {
    const mock = queueFetch([
      chatResponse({
        toolCalls: [{ name: 'read_file', args: { path: '../../../../etc/passwd' } }],
      }),
      chatResponse({ content: 'I cannot read outside the workspace.' }),
    ]);

    const result = await run('Read /etc/passwd');

    expect(result.stoppedReason).toBe('done');
    expect(result.steps[0].ok).toBe(false);
    expect(result.steps[0].summary).toContain('escapes the workspace root');

    const messages = sentBody(mock, 1).messages as { role: string; content: string }[];
    expect(messages.find((message) => message.role === 'tool')?.content).toContain(
      'escapes the workspace root',
    );
  });

  it('refuses run_command when the allowlist is empty, without spawning anything', async () => {
    queueFetch([
      chatResponse({ toolCalls: [{ name: 'run_command', args: { command: 'git', args: ['status'] } }] }),
      chatResponse({ content: 'Exec is off.' }),
    ]);

    const result = await run('Run git status', { execAllowlist: [] });

    expect(result.steps[0].ok).toBe(false);
    expect(result.steps[0].summary).toContain('BRIDGE_EXEC_ALLOWLIST');
  });

  it('refuses a run_command naming a path rather than a bare command name', async () => {
    queueFetch([
      chatResponse({
        toolCalls: [{ name: 'run_command', args: { command: 'C:\\Windows\\System32\\cmd.exe' } }],
      }),
      chatResponse({ content: 'Refused.' }),
    ]);

    const result = await run('Run cmd.exe', { execAllowlist: ['git'] });

    expect(result.steps[0].ok).toBe(false);
    expect(result.steps[0].summary).toContain('bare command name');
  });

  it('caps the loop at maxTurns and returns the steps that ran rather than throwing', async () => {
    writeFileSync(path.join(root, 'loop.txt'), 'x');
    // A model stuck re-reading the same file forever.
    const bodies = Array.from({ length: 10 }, () =>
      chatResponse({ toolCalls: [{ name: 'read_file', args: { path: 'loop.txt' } }] }),
    );
    queueFetch(bodies);

    const result = await run('read loop.txt over and over', { maxTurns: 3 });

    expect(result.stoppedReason).toBe('max-turns');
    expect(result.turns).toBe(3);
    expect(result.steps).toHaveLength(3);
    expect(result.error).toContain('stopped after 3 rounds');
  });

  it('returns stoppedReason "error" when Ollama is unreachable, and does not throw', async () => {
    global.fetch = jest.fn(async () => {
      throw new Error('fetch failed');
    }) as unknown as typeof fetch;

    const result = await run('anything');

    expect(result.stoppedReason).toBe('error');
    expect(result.error).toContain('Could not reach Ollama');
    expect(result.steps).toHaveLength(0);
  });

  it('returns stoppedReason "error" on a non-2xx from Ollama', async () => {
    global.fetch = jest.fn(
      async () =>
        ({
          ok: false,
          status: 404,
          json: async () => ({}),
          text: async () => 'model "nope" not found',
        }) as unknown as Response,
    ) as unknown as typeof fetch;

    const result = await run('anything', { model: 'nope' });

    expect(result.stoppedReason).toBe('error');
    expect(result.error).toContain('HTTP 404');
    expect(result.error).toContain('not found');
  });

  it('sums usage across every turn rather than reporting only the last', async () => {
    writeFileSync(path.join(root, 'a.txt'), 'a');
    queueFetch([
      chatResponse({
        toolCalls: [{ name: 'read_file', args: { path: 'a.txt' } }],
        promptEvalCount: 100,
        evalCount: 10,
      }),
      chatResponse({ content: 'done', promptEvalCount: 200, evalCount: 20 }),
    ]);

    const result = await run('read a.txt');

    expect(result.usage).toEqual({ inputTokens: 300, outputTokens: 30 });
  });

  it('advertises run_command only when exec is actually enabled', async () => {
    const withoutExec = queueFetch([chatResponse({ content: 'ok' })]);
    await run('x', { execAllowlist: [] });
    const toolsWithout = sentBody(withoutExec, 0).tools as { function: { name: string } }[];
    expect(toolsWithout.map((t) => t.function.name)).not.toContain('run_command');

    const withExec = queueFetch([chatResponse({ content: 'ok' })]);
    await run('x', { execAllowlist: ['git'] });
    const toolsWith = sentBody(withExec, 0).tools as { function: { name: string } }[];
    expect(toolsWith.map((t) => t.function.name)).toContain('run_command');
  });

  it('uses the same five tool names as the backend WorkspaceToolsService', async () => {
    const mock = queueFetch([chatResponse({ content: 'ok' })]);
    await run('x', { execAllowlist: ['git'] });
    const tools = sentBody(mock, 0).tools as { function: { name: string } }[];
    expect(tools.map((t) => t.function.name)).toEqual([
      'list_files',
      'read_file',
      'write_file',
      'search_files',
      'run_command',
    ]);
  });

  it('stops immediately when the caller has already aborted', async () => {
    const mock = queueFetch([chatResponse({ content: 'should not be reached' })]);
    const controller = new AbortController();
    controller.abort();

    const result = await run('anything', { signal: controller.signal });

    expect(result.stoppedReason).toBe('error');
    expect(mock).not.toHaveBeenCalled();
  });
});

describe('malformed tool calls', () => {
  // Its own fixtures rather than the outer describe's: this block was added after the fact
  // and sits at module level, where `root` and `run` are not in scope.
  let root: string;
  const realFetch = global.fetch;

  const run = (task: string) =>
    runOllamaAgent({
      task,
      model: MODEL,
      baseUrl: BASE_URL,
      workspaceRoot: root,
      maxFileBytes: 256_000,
      execAllowlist: [],
      execTimeoutMs: 5_000,
    });

  beforeEach(() => {
    root = mkdtempSync(path.join(tmpdir(), 'host-bridge-malformed-'));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
    global.fetch = realFetch;
  });

  // Reproduces a real run: the model wrapped a well-formed-looking call in a ```json fence,
  // but the file content it was writing held a Python """docstring""" whose unescaped quotes
  // terminated the JSON string early. The whole object is unparseable, recovery correctly
  // declines it, and without the retry below the loop treats 4.8 KB of JSON as a final answer
  // and reports success having changed nothing.
  const MALFORMED = [
    '```json',
    '{',
    '  "name": "write_file",',
    '  "arguments": {',
    '    "path": "a.py",',
    '    "content": "def f():\n    """docs"""\n    return 1"',
    '  }',
    '}',
    '```',
  ].join('\n');

  it('tells the model its call was unusable instead of accepting it as the answer', async () => {
    const mock = queueFetch([
      chatResponse({ content: MALFORMED }),
      chatResponse({ toolCalls: [{ name: 'list_files', args: {} }] }),
      chatResponse({ content: 'Done.' }),
    ]);

    const result = await run('write a file');

    expect(result.stoppedReason).toBe('done');
    // The corrective turn happened, and the model went on to make a real call.
    expect(mock).toHaveBeenCalledTimes(3);
    expect(result.steps.map((step) => step.tool)).toEqual([
      '(malformed tool call)',
      'list_files',
    ]);
    expect(result.steps[0].ok).toBe(false);

    const correction = sentBody(mock, 1).messages as Array<{ role: string; content: string }>;
    expect(correction.at(-1)?.role).toBe('user');
    expect(correction.at(-1)?.content).toContain('not a valid tool call');
  });

  it('gives up after the retry budget rather than nagging forever', async () => {
    const mock = queueFetch([
      chatResponse({ content: MALFORMED }),
      chatResponse({ content: MALFORMED }),
      chatResponse({ content: MALFORMED }),
    ]);

    const result = await run('write a file');

    // Two corrections, then the third malformed answer is accepted as final.
    expect(result.stoppedReason).toBe('done');
    expect(mock).toHaveBeenCalledTimes(3);
    expect(result.steps).toHaveLength(2);
  });

  it('leaves an ordinary prose answer alone', async () => {
    // The detector keys on the tool-call *shape*; plain prose must never trigger a retry.
    const mock = queueFetch([chatResponse({ content: 'A promise is a future value.' })]);

    const result = await run('explain promises');

    expect(mock).toHaveBeenCalledTimes(1);
    expect(result.steps).toHaveLength(0);
    expect(result.answer).toContain('future value');
  });
});
