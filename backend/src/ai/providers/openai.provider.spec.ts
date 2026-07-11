import { OpenAiProvider } from './openai.provider';
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

describe('OpenAiProvider', () => {
  const originalFetch = global.fetch;

  afterEach(() => {
    global.fetch = originalFetch;
  });

  it('yields an error immediately when no API key is configured, without calling fetch', async () => {
    const provider = new OpenAiProvider();
    global.fetch = jest.fn() as never;

    const events = await collect(
      provider.streamChat({
        messages: [{ role: 'user', content: 'hi' }],
        model: 'gpt-5.1',
        abortSignal: new AbortController().signal,
      }),
    );

    expect(events).toEqual([
      { type: 'error', message: 'No OpenAI API key configured' },
    ]);
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it('parses SSE delta content and finish_reason into token/done events, skipping role-only chunks', async () => {
    const readImpl = jest
      .fn()
      .mockResolvedValueOnce({
        done: false,
        value: encode(
          'data: {"choices":[{"delta":{"role":"assistant"}}]}\n\n' +
            'data: {"choices":[{"delta":{"content":"Hel"}}]}\n\n' +
            'data: {"choices":[{"delta":{"content":"lo"}}]}\n\n',
        ),
      })
      .mockResolvedValueOnce({
        done: false,
        value: encode(
          'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n' +
            'data: [DONE]\n\n',
        ),
      });
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      body: { getReader: () => createReader(readImpl) },
    }) as never;

    const provider = new OpenAiProvider();
    const events = await collect(
      provider.streamChat({
        messages: [{ role: 'user', content: 'hi' }],
        model: 'gpt-5.1',
        apiKey: 'sk-test',
        abortSignal: new AbortController().signal,
      }),
    );

    expect(events).toEqual([
      { type: 'token', delta: 'Hel' },
      { type: 'token', delta: 'lo' },
      { type: 'done', finishReason: 'stop' },
    ]);

    const [, init] = (global.fetch as jest.Mock).mock.calls[0] as [
      string,
      { headers: Record<string, string> },
    ];
    expect(init.headers['Authorization']).toBe('Bearer sk-test');
  });

  it('skips a malformed/truncated SSE data line and continues streaming', async () => {
    const readImpl = jest.fn().mockResolvedValueOnce({
      done: false,
      value: encode(
        'data: {not-json\n\n' +
          'data: {"choices":[{"delta":{"content":"ok"}}]}\n\n' +
          'data: [DONE]\n\n',
      ),
    });
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      body: { getReader: () => createReader(readImpl) },
    }) as never;

    const provider = new OpenAiProvider();
    const events = await collect(
      provider.streamChat({
        messages: [{ role: 'user', content: 'hi' }],
        model: 'gpt-5.1',
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
      json: () =>
        Promise.resolve({ error: { message: 'Incorrect API key provided' } }),
    }) as never;

    const provider = new OpenAiProvider();
    const events = await collect(
      provider.streamChat({
        messages: [{ role: 'user', content: 'hi' }],
        model: 'gpt-5.1',
        apiKey: 'sk-bad',
        abortSignal: new AbortController().signal,
      }),
    );

    expect(events).toEqual([
      { type: 'error', message: 'Incorrect API key provided' },
    ]);
  });

  it('maps a 429 response to a rate-limited error', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: false,
      status: 429,
      body: {},
      json: () => Promise.resolve({}),
    }) as never;

    const provider = new OpenAiProvider();
    const events = await collect(
      provider.streamChat({
        messages: [{ role: 'user', content: 'hi' }],
        model: 'gpt-5.1',
        apiKey: 'sk-test',
        abortSignal: new AbortController().signal,
      }),
    );

    expect(events).toEqual([
      { type: 'error', message: 'Rate limited by OpenAI' },
    ]);
  });

  it('maps a 5xx response to a temporarily-unavailable error', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: false,
      status: 503,
      body: {},
      json: () => Promise.reject(new Error('no body')),
    }) as never;

    const provider = new OpenAiProvider();
    const events = await collect(
      provider.streamChat({
        messages: [{ role: 'user', content: 'hi' }],
        model: 'gpt-5.1',
        apiKey: 'sk-test',
        abortSignal: new AbortController().signal,
      }),
    );

    expect(events).toEqual([
      { type: 'error', message: 'OpenAI is temporarily unavailable' },
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
        value: encode('data: {"choices":[{"delta":{"content":"a"}}]}\n\n'),
      })
      .mockImplementationOnce(() => secondRead);
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      body: { getReader: () => createReader(readImpl) },
    }) as never;

    const provider = new OpenAiProvider();
    const iterator = provider
      .streamChat({
        messages: [{ role: 'user', content: 'hi' }],
        model: 'gpt-5.1',
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
