import { ClaudeProvider } from './claude.provider';
import { AiStreamEvent } from '../ai-provider.interface';

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

describe('ClaudeProvider', () => {
  const originalFetch = global.fetch;

  afterEach(() => {
    global.fetch = originalFetch;
  });

  it('yields an error immediately when no API key is configured, without calling fetch', async () => {
    const provider = new ClaudeProvider();
    global.fetch = jest.fn() as never;

    const events = await collect(
      provider.streamChat({
        messages: [{ role: 'user', content: 'hi' }],
        model: 'claude-sonnet-5',
        abortSignal: new AbortController().signal,
      }),
    );

    expect(events).toEqual([
      { type: 'error', message: 'No Claude API key configured' },
    ]);
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it('parses SSE content_block_delta/message_delta/message_stop into token/done events', async () => {
    const readImpl = jest
      .fn()
      .mockResolvedValueOnce({
        done: false,
        value: encode(
          'event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"text":"Hel"}}\n\n' +
            'event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"text":"lo"}}\n\n',
        ),
      })
      .mockResolvedValueOnce({
        done: false,
        value: encode(
          'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"}}\n\n' +
            'event: message_stop\ndata: {"type":"message_stop"}\n\n',
        ),
      });
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      body: { getReader: () => createReader(readImpl) },
    }) as never;

    const provider = new ClaudeProvider();
    const events = await collect(
      provider.streamChat({
        messages: [
          { role: 'system', content: 'be nice' },
          { role: 'user', content: 'hi' },
        ],
        model: 'claude-sonnet-5',
        apiKey: 'sk-test',
        abortSignal: new AbortController().signal,
      }),
    );

    expect(events).toEqual([
      { type: 'token', delta: 'Hel' },
      { type: 'token', delta: 'lo' },
      { type: 'done', finishReason: 'end_turn' },
    ]);

    const [, init] = (global.fetch as jest.Mock).mock.calls[0] as [
      string,
      { headers: Record<string, string>; body: string },
    ];
    expect(init.headers['x-api-key']).toBe('sk-test');
    expect(init.headers['anthropic-version']).toBe('2023-06-01');
    const parsedBody = JSON.parse(init.body) as {
      system?: string;
      messages: unknown[];
    };
    expect(parsedBody.system).toBe('be nice');
    expect(parsedBody.messages).toEqual([{ role: 'user', content: 'hi' }]);
  });

  it('skips a malformed/truncated SSE data frame and continues streaming', async () => {
    const readImpl = jest.fn().mockResolvedValueOnce({
      done: false,
      value: encode(
        'event: content_block_delta\ndata: {not-json\n\n' +
          'event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"text":"ok"}}\n\n' +
          'event: message_stop\ndata: {"type":"message_stop"}\n\n',
      ),
    });
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      body: { getReader: () => createReader(readImpl) },
    }) as never;

    const provider = new ClaudeProvider();
    const events = await collect(
      provider.streamChat({
        messages: [{ role: 'user', content: 'hi' }],
        model: 'claude-sonnet-5',
        apiKey: 'sk-test',
        abortSignal: new AbortController().signal,
      }),
    );

    expect(events).toEqual([
      { type: 'token', delta: 'ok' },
      { type: 'done', finishReason: 'stop' },
    ]);
  });

  it('maps a 401 response to an invalid-API-key error using the upstream message', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: false,
      status: 401,
      body: {},
      json: () => Promise.resolve({ error: { message: 'invalid x-api-key' } }),
    }) as never;

    const provider = new ClaudeProvider();
    const events = await collect(
      provider.streamChat({
        messages: [{ role: 'user', content: 'hi' }],
        model: 'claude-sonnet-5',
        apiKey: 'sk-bad',
        abortSignal: new AbortController().signal,
      }),
    );

    expect(events).toEqual([{ type: 'error', message: 'invalid x-api-key' }]);
  });

  it('maps a 429 response to a rate-limited error', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: false,
      status: 429,
      body: {},
      json: () => Promise.resolve({}),
    }) as never;

    const provider = new ClaudeProvider();
    const events = await collect(
      provider.streamChat({
        messages: [{ role: 'user', content: 'hi' }],
        model: 'claude-sonnet-5',
        apiKey: 'sk-test',
        abortSignal: new AbortController().signal,
      }),
    );

    expect(events).toEqual([
      { type: 'error', message: 'Rate limited by Claude' },
    ]);
  });

  it('maps a 5xx response to a temporarily-unavailable error', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: false,
      status: 529,
      body: {},
      json: () => Promise.reject(new Error('no body')),
    }) as never;

    const provider = new ClaudeProvider();
    const events = await collect(
      provider.streamChat({
        messages: [{ role: 'user', content: 'hi' }],
        model: 'claude-sonnet-5',
        apiKey: 'sk-test',
        abortSignal: new AbortController().signal,
      }),
    );

    expect(events).toEqual([
      { type: 'error', message: 'Claude is temporarily unavailable' },
    ]);
  });

  it('yields a stopped-done event when the caller aborts mid-stream', async () => {
    const controller = new AbortController();
    let rejectSecondRead!: (err: unknown) => void;
    const secondRead = new Promise((_resolve, reject) => {
      rejectSecondRead = reject;
    });
    const readImpl = jest
      .fn()
      .mockResolvedValueOnce({
        done: false,
        value: encode(
          'event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"text":"a"}}\n\n',
        ),
      })
      .mockImplementationOnce(() => secondRead);
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      body: { getReader: () => createReader(readImpl) },
    }) as never;

    const provider = new ClaudeProvider();
    const iterator = provider
      .streamChat({
        messages: [{ role: 'user', content: 'hi' }],
        model: 'claude-sonnet-5',
        apiKey: 'sk-test',
        abortSignal: controller.signal,
      })
      [Symbol.asyncIterator]();

    const first = await iterator.next();
    expect(first.value).toEqual({ type: 'token', delta: 'a' });

    controller.abort();
    rejectSecondRead(
      new DOMException('The operation was aborted.', 'AbortError'),
    );

    const second = await iterator.next();
    expect(second.value).toEqual({ type: 'done', finishReason: 'stopped' });
  });
});
