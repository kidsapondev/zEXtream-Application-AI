import { ConfigService } from '@nestjs/config';
import { MAX_TOOL_TURNS, OllamaProvider } from './ollama.provider';
import { AiStreamEvent } from '../ai-provider.interface';
import { CircuitBreakerService } from '../circuit-breaker.service';
import { WorkspaceToolsService } from '../tools/workspace-tools.service';
import { OllamaToolDefinition } from '../tools/tool.types';

/**
 * The multi-turn workspace tool loop, kept in its own spec file rather than appended to
 * `ollama.provider.spec.ts`: that file's harness scripts a single `/api/chat` response,
 * while everything here needs a *queue* of responses (one per turn) and an enabled
 * `WorkspaceToolsService`. Two incompatible harnesses in one file would mean every test
 * paying for setup it doesn't use.
 */

const encode = (text: string) => new TextEncoder().encode(text);

function createReader(readImpl: jest.Mock) {
  return { read: readImpl, cancel: jest.fn().mockResolvedValue(undefined) };
}

async function collect(
  iterable: AsyncIterable<AiStreamEvent>,
): Promise<AiStreamEvent[]> {
  const events: AiStreamEvent[] = [];
  for await (const event of iterable) {
    events.push(event);
  }
  return events;
}

const WRITE_TOOL: OllamaToolDefinition = {
  type: 'function',
  function: {
    name: 'write_file',
    description: 'Write a file',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'path' },
        content: { type: 'string', description: 'content' },
      },
      required: ['path', 'content'],
    },
  },
};

function createProvider(workspaceTools: WorkspaceToolsService): OllamaProvider {
  const configService = {
    getOrThrow: jest.fn().mockReturnValue('http://ollama.local'),
  };
  return new OllamaProvider(
    configService as unknown as ConfigService,
    new CircuitBreakerService(),
    workspaceTools,
  );
}

function enabledTools(execute: jest.Mock): WorkspaceToolsService {
  return {
    isEnabled: () => true,
    definitions: () => [WRITE_TOOL],
    systemPrompt: () => 'WORKSPACE POLICY',
    execute,
  } as unknown as WorkspaceToolsService;
}

function disabledTools(): WorkspaceToolsService {
  return {
    isEnabled: () => false,
    definitions: () => [],
    systemPrompt: () => '',
    execute: jest.fn(),
  } as unknown as WorkspaceToolsService;
}

/** Queues one whole NDJSON response body per `/api/chat` call, consumed in order. */
function mockTurns(bodies: string[]): jest.Mock {
  const queue = [...bodies];
  const fetchMock = jest.fn(() => {
    const body = queue.shift() ?? '{"done":true,"done_reason":"stop"}\n';
    let sent = false;
    const readImpl = jest.fn().mockImplementation(() => {
      if (sent) return Promise.resolve({ done: true, value: undefined });
      sent = true;
      return Promise.resolve({ done: false, value: encode(body) });
    });
    return Promise.resolve({
      ok: true,
      status: 200,
      body: { getReader: () => createReader(readImpl) },
    });
  });
  global.fetch = fetchMock as never;
  return fetchMock;
}

function toolCallTurn(path: string, content: string): string {
  const call = {
    message: {
      role: 'assistant',
      content: '',
      tool_calls: [
        { function: { name: 'write_file', arguments: { path, content } } },
      ],
    },
    done: false,
  };
  return `${JSON.stringify(call)}\n{"done":true,"done_reason":"stop"}\n`;
}

/**
 * Reads the JSON body of the first `/api/chat` request. `jest.Mock`'s recorded call
 * arguments are `any`, so the cast is unavoidable — doing it once here keeps it out of
 * the assertions themselves.
 */
function requestBody(fetchMock: jest.Mock): string {
  const [, init] = fetchMock.mock.calls[0] as [string, { body: string }];
  return init.body;
}

/** The first `OllamaToolCall` handed to the mocked `WorkspaceToolsService.execute`. */
function toolCallArg(execute: jest.Mock): unknown {
  const [call] = execute.mock.calls[0] as [unknown];
  return call;
}

function prose(events: AiStreamEvent[]): string {
  return events
    .filter((event): event is { type: 'token'; delta: string } => {
      return event.type === 'token';
    })
    .map((event) => event.delta)
    .join('');
}

function chat(provider: OllamaProvider, content: string) {
  return provider.streamChat({
    messages: [{ role: 'user', content }],
    model: 'qwen2.5-coder:14b',
    abortSignal: new AbortController().signal,
  });
}

describe('OllamaProvider workspace tool loop', () => {
  const originalFetch = global.fetch;

  afterEach(() => {
    global.fetch = originalFetch;
  });

  it('runs a tool call, feeds the result back, and streams the follow-up answer', async () => {
    const execute = jest.fn().mockResolvedValue({
      ok: true,
      content: 'wrote 12 bytes',
      summary: 'write_file(app.ts) -> 12 bytes',
    });
    const fetchMock = mockTurns([
      `${JSON.stringify({
        message: {
          role: 'assistant',
          content: '',
          tool_calls: [
            {
              function: {
                name: 'write_file',
                arguments: { path: 'app.ts', content: 'hello' },
              },
            },
          ],
        },
        done: false,
      })}\n{"done":true,"done_reason":"stop","prompt_eval_count":10,"eval_count":5}\n`,
      '{"message":{"role":"assistant","content":"Done."},"done":false}\n{"done":true,"done_reason":"stop","prompt_eval_count":20,"eval_count":3}\n',
    ]);

    const provider = createProvider(enabledTools(execute));
    const events = await collect(chat(provider, 'write a file'));

    expect(execute).toHaveBeenCalledTimes(1);
    expect(toolCallArg(execute)).toEqual({
      function: {
        name: 'write_file',
        arguments: { path: 'app.ts', content: 'hello' },
      },
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);

    // The tool summary is streamed as prose so the user sees what was touched, and the
    // model's own follow-up text still comes through after it.
    expect(prose(events)).toContain('write_file(app.ts) -> 12 bytes');
    expect(prose(events)).toContain('Done.');

    // Usage is summed across both turns, not taken from the last one alone.
    expect(events.at(-1)).toEqual({
      type: 'done',
      finishReason: 'stop',
      usage: { inputTokens: 30, outputTokens: 8 },
    });
  });

  it('recovers a tool call the model emitted as plain text instead of tool_calls', async () => {
    // The real, reproduced behaviour of qwen2.5-coder:14b on Ollama 0.32.15 — see
    // text-tool-call-parser.ts. `tool_calls` never arrives; the call is bare JSON in
    // `content`, split across chunks the way a real stream delivers it.
    const execute = jest.fn().mockResolvedValue({
      ok: true,
      content: 'name, version, scripts...',
      summary: 'read_file(package.json) -> 812 bytes',
    });
    mockTurns([
      '{"message":{"role":"assistant","content":"{\\"name\\": \\"write_file\\", "},"done":false}\n{"message":{"role":"assistant","content":"\\"arguments\\": {\\"path\\": \\"a.ts\\", \\"content\\": \\"x\\"}}"},"done":false}\n{"done":true,"done_reason":"stop"}\n',
      '{"message":{"role":"assistant","content":"All set."},"done":false}\n{"done":true,"done_reason":"stop"}\n',
    ]);

    const provider = createProvider(enabledTools(execute));
    const events = await collect(chat(provider, 'write a.ts'));

    expect(execute).toHaveBeenCalledTimes(1);
    expect(toolCallArg(execute)).toEqual({
      function: {
        name: 'write_file',
        arguments: { path: 'a.ts', content: 'x' },
      },
    });
    // The raw JSON must never reach the user — only the summary and the real answer.
    expect(prose(events)).not.toContain('"arguments"');
    expect(prose(events)).toContain('read_file(package.json) -> 812 bytes');
    expect(prose(events)).toContain('All set.');
  });

  it('streams a genuine JSON answer as prose rather than swallowing it', async () => {
    // The other side of the same coin: buffered text that turns out not to be a call must
    // still reach the user in full.
    const execute = jest.fn();
    mockTurns([
      '{"message":{"role":"assistant","content":"{\\"port\\": 3000}"},"done":false}\n{"done":true,"done_reason":"stop"}\n',
    ]);

    const provider = createProvider(enabledTools(execute));
    const events = await collect(chat(provider, 'show me the config'));

    expect(execute).not.toHaveBeenCalled();
    expect(prose(events)).toBe('{"port": 3000}');
  });

  it('sends the tool definitions and slots the workspace prompt beside the caller system turn', async () => {
    const fetchMock = mockTurns([
      '{"message":{"role":"assistant","content":"hi"},"done":false}\n{"done":true,"done_reason":"stop"}\n',
    ]);

    const provider = createProvider(enabledTools(jest.fn()));
    await collect(
      provider.streamChat({
        messages: [
          { role: 'system', content: 'BASE' },
          { role: 'user', content: 'hello' },
        ],
        model: 'qwen2.5-coder:14b',
        abortSignal: new AbortController().signal,
      }),
    );

    const sent = JSON.parse(requestBody(fetchMock)) as {
      tools: OllamaToolDefinition[];
      messages: Array<{ role: string; content: string }>;
    };
    expect(sent.tools).toEqual([WRITE_TOOL]);
    expect(sent.messages.map((message) => message.content)).toEqual([
      'BASE',
      'WORKSPACE POLICY',
      'hello',
    ]);
  });

  it('omits the tools field entirely when the workspace is not configured', async () => {
    const fetchMock = mockTurns([
      '{"message":{"role":"assistant","content":"hi"},"done":false}\n{"done":true,"done_reason":"stop"}\n',
    ]);

    const provider = createProvider(disabledTools());
    await collect(chat(provider, 'hello'));

    const sent = JSON.parse(requestBody(fetchMock)) as Record<string, unknown>;
    // Not merely undefined — the key must be absent, since older Ollama builds reject an
    // explicit null `tools` field.
    expect('tools' in sent).toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('surfaces a failed tool call to the model instead of ending the stream', async () => {
    const execute = jest.fn().mockResolvedValue({
      ok: false,
      content: 'Error: path escapes the workspace root',
      summary: 'write_file(../../etc/passwd) -> rejected',
    });
    mockTurns([
      toolCallTurn('../../etc/passwd', 'x'),
      '{"message":{"role":"assistant","content":"Sorry, staying inside the workspace."},"done":false}\n{"done":true,"done_reason":"stop"}\n',
    ]);

    const provider = createProvider(enabledTools(execute));
    const events = await collect(chat(provider, 'escape'));

    expect(events.some((event) => event.type === 'error')).toBe(false);
    expect(prose(events)).toContain('write_file(../../etc/passwd) -> rejected');
    expect(prose(events)).toContain('Sorry, staying inside the workspace.');
  });

  it('gives up with an error once the model exceeds MAX_TOOL_TURNS', async () => {
    const execute = jest.fn().mockResolvedValue({
      ok: true,
      content: 'ok',
      summary: 'write_file(a) -> ok',
    });
    // Every turn asks for another tool call and never produces a final answer.
    const fetchMock = mockTurns(
      Array.from({ length: MAX_TOOL_TURNS + 2 }, () => toolCallTurn('a', 'b')),
    );

    const provider = createProvider(enabledTools(execute));
    const events = await collect(chat(provider, 'loop forever'));

    expect(fetchMock).toHaveBeenCalledTimes(MAX_TOOL_TURNS);
    expect(events.at(-1)).toEqual({
      type: 'error',
      message: `The model kept calling tools without finishing an answer (stopped after ${MAX_TOOL_TURNS} rounds)`,
    });
  });

  it('does not run pending tool calls after the user stops the stream', async () => {
    const execute = jest.fn();
    const stoppedTurn = `${JSON.stringify({
      message: {
        role: 'assistant',
        content: '',
        tool_calls: [
          {
            function: {
              name: 'write_file',
              arguments: { path: 'a', content: 'b' },
            },
          },
        ],
      },
      done: false,
    })}\n{"done":true,"done_reason":"stopped"}\n`;
    mockTurns([stoppedTurn]);

    const provider = createProvider(enabledTools(execute));
    const events = await collect(chat(provider, 'write then stop'));

    expect(execute).not.toHaveBeenCalled();
    expect(events.at(-1)).toEqual({
      type: 'done',
      finishReason: 'stopped',
      usage: undefined,
    });
  });
});
