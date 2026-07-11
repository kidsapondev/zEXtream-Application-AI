import { ClaudeProvider } from './claude.provider';
import { AiStreamEvent } from '../ai-provider.interface';
import {
  CircuitBreakerService,
  CIRCUIT_BREAKER_FAILURE_THRESHOLD,
} from '../circuit-breaker.service';

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
    const provider = new ClaudeProvider(new CircuitBreakerService());
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

    const provider = new ClaudeProvider(new CircuitBreakerService());
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

    const provider = new ClaudeProvider(new CircuitBreakerService());
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

    const provider = new ClaudeProvider(new CircuitBreakerService());
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

  it('maps a 429 response to a rate-limited error (after exhausting retries)', async () => {
    jest.useFakeTimers();
    try {
      global.fetch = jest.fn().mockResolvedValue({
        ok: false,
        status: 429,
        body: {},
        json: () => Promise.resolve({}),
      }) as never;

      const provider = new ClaudeProvider(new CircuitBreakerService());
      const promise = collect(
        provider.streamChat({
          messages: [{ role: 'user', content: 'hi' }],
          model: 'claude-sonnet-5',
          apiKey: 'sk-test',
          abortSignal: new AbortController().signal,
        }),
      );
      await jest.runAllTimersAsync();
      const events = await promise;

      expect(events).toEqual([
        { type: 'error', message: 'Rate limited by Claude' },
      ]);
    } finally {
      jest.useRealTimers();
    }
  });

  it('maps a 5xx response to a temporarily-unavailable error (after exhausting retries)', async () => {
    jest.useFakeTimers();
    try {
      global.fetch = jest.fn().mockResolvedValue({
        ok: false,
        status: 529,
        body: {},
        json: () => Promise.reject(new Error('no body')),
      }) as never;

      const provider = new ClaudeProvider(new CircuitBreakerService());
      const promise = collect(
        provider.streamChat({
          messages: [{ role: 'user', content: 'hi' }],
          model: 'claude-sonnet-5',
          apiKey: 'sk-test',
          abortSignal: new AbortController().signal,
        }),
      );
      await jest.runAllTimersAsync();
      const events = await promise;

      expect(events).toEqual([
        { type: 'error', message: 'Claude is temporarily unavailable' },
      ]);
    } finally {
      jest.useRealTimers();
    }
  });

  it('retries a transient failure and succeeds without surfacing an error', async () => {
    jest.useFakeTimers();
    try {
      const readImpl = jest.fn().mockResolvedValueOnce({
        done: false,
        value: encode(
          'event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"text":"ok"}}\n\n' +
            'event: message_stop\ndata: {"type":"message_stop"}\n\n',
        ),
      });
      const fetchMock = jest
        .fn()
        .mockResolvedValueOnce({
          ok: false,
          status: 500,
          body: {},
          json: () => Promise.resolve({}),
        })
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          body: { getReader: () => createReader(readImpl) },
        });
      global.fetch = fetchMock as never;

      const provider = new ClaudeProvider(new CircuitBreakerService());
      const promise = collect(
        provider.streamChat({
          messages: [{ role: 'user', content: 'hi' }],
          model: 'claude-sonnet-5',
          apiKey: 'sk-test',
          abortSignal: new AbortController().signal,
        }),
      );
      await jest.runAllTimersAsync();
      const events = await promise;

      expect(events).toEqual([
        { type: 'token', delta: 'ok' },
        { type: 'done', finishReason: 'stop' },
      ]);
      expect(fetchMock).toHaveBeenCalledTimes(2);
    } finally {
      jest.useRealTimers();
    }
  });

  it('fails fast without calling fetch once the circuit is open', async () => {
    const circuitBreaker = new CircuitBreakerService();
    for (let i = 0; i < CIRCUIT_BREAKER_FAILURE_THRESHOLD; i += 1) {
      circuitBreaker.recordFailure('claude');
    }
    global.fetch = jest.fn() as never;

    const provider = new ClaudeProvider(circuitBreaker);
    const events = await collect(
      provider.streamChat({
        messages: [{ role: 'user', content: 'hi' }],
        model: 'claude-sonnet-5',
        apiKey: 'sk-test',
        abortSignal: new AbortController().signal,
      }),
    );

    expect(events).toHaveLength(1);
    expect(events[0].type).toBe('error');
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it('repeated 401s (a bad key) never open the circuit for other users', async () => {
    const circuitBreaker = new CircuitBreakerService();
    global.fetch = jest.fn().mockResolvedValue({
      ok: false,
      status: 401,
      body: {},
      json: () => Promise.resolve({ error: { message: 'bad key' } }),
    }) as never;

    for (let i = 0; i < CIRCUIT_BREAKER_FAILURE_THRESHOLD + 2; i += 1) {
      const provider = new ClaudeProvider(circuitBreaker);
      await collect(
        provider.streamChat({
          messages: [{ role: 'user', content: 'hi' }],
          model: 'claude-sonnet-5',
          apiKey: 'sk-bad',
          abortSignal: new AbortController().signal,
        }),
      );
    }

    expect(circuitBreaker.isOpen('claude')).toBe(false);
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

    const provider = new ClaudeProvider(new CircuitBreakerService());
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
