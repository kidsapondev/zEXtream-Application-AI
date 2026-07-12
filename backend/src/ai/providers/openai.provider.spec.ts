import { OpenAiProvider } from './openai.provider';
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

describe('OpenAiProvider', () => {
  const originalFetch = global.fetch;

  afterEach(() => {
    global.fetch = originalFetch;
  });

  it('yields an error immediately when no API key is configured, without calling fetch', async () => {
    const provider = new OpenAiProvider(new CircuitBreakerService());
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

    const provider = new OpenAiProvider(new CircuitBreakerService());
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

  it('requests stream_options.include_usage and reports usage from the trailing usage-only chunk', async () => {
    const readImpl = jest
      .fn()
      .mockResolvedValueOnce({
        done: false,
        value: encode(
          'data: {"choices":[{"delta":{"content":"ok"},"finish_reason":"stop"}]}\n\n',
        ),
      })
      .mockResolvedValueOnce({
        done: false,
        value: encode(
          'data: {"choices":[],"usage":{"prompt_tokens":12,"completion_tokens":34}}\n\n' +
            'data: [DONE]\n\n',
        ),
      });
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      body: { getReader: () => createReader(readImpl) },
    }) as never;

    const provider = new OpenAiProvider(new CircuitBreakerService());
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
      {
        type: 'done',
        finishReason: 'stop',
        usage: { inputTokens: 12, outputTokens: 34 },
      },
    ]);

    const [, init] = (global.fetch as jest.Mock).mock.calls[0] as [
      string,
      { body: string },
    ];
    const parsedBody = JSON.parse(init.body) as {
      stream_options?: { include_usage?: boolean };
    };
    expect(parsedBody.stream_options).toEqual({ include_usage: true });
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

    const provider = new OpenAiProvider(new CircuitBreakerService());
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

    const provider = new OpenAiProvider(new CircuitBreakerService());
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

  it('maps a 429 response to a rate-limited error (after exhausting retries)', async () => {
    jest.useFakeTimers();
    try {
      global.fetch = jest.fn().mockResolvedValue({
        ok: false,
        status: 429,
        body: {},
        json: () => Promise.resolve({}),
      }) as never;

      const provider = new OpenAiProvider(new CircuitBreakerService());
      const promise = collect(
        provider.streamChat({
          messages: [{ role: 'user', content: 'hi' }],
          model: 'gpt-5.1',
          apiKey: 'sk-test',
          abortSignal: new AbortController().signal,
        }),
      );
      await jest.runAllTimersAsync();
      const events = await promise;

      expect(events).toEqual([
        { type: 'error', message: 'Rate limited by OpenAI' },
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
        status: 503,
        body: {},
        json: () => Promise.reject(new Error('no body')),
      }) as never;

      const provider = new OpenAiProvider(new CircuitBreakerService());
      const promise = collect(
        provider.streamChat({
          messages: [{ role: 'user', content: 'hi' }],
          model: 'gpt-5.1',
          apiKey: 'sk-test',
          abortSignal: new AbortController().signal,
        }),
      );
      await jest.runAllTimersAsync();
      const events = await promise;

      expect(events).toEqual([
        { type: 'error', message: 'OpenAI is temporarily unavailable' },
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
          'data: {"choices":[{"delta":{"content":"ok"},"finish_reason":"stop"}]}\n\n' +
            'data: [DONE]\n\n',
        ),
      });
      const fetchMock = jest
        .fn()
        .mockResolvedValueOnce({
          ok: false,
          status: 503,
          body: {},
          json: () => Promise.resolve({}),
        })
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          body: { getReader: () => createReader(readImpl) },
        });
      global.fetch = fetchMock as never;

      const provider = new OpenAiProvider(new CircuitBreakerService());
      const promise = collect(
        provider.streamChat({
          messages: [{ role: 'user', content: 'hi' }],
          model: 'gpt-5.1',
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
      circuitBreaker.recordFailure('openai');
    }
    global.fetch = jest.fn() as never;

    const provider = new OpenAiProvider(circuitBreaker);
    const events = await collect(
      provider.streamChat({
        messages: [{ role: 'user', content: 'hi' }],
        model: 'gpt-5.1',
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
      const provider = new OpenAiProvider(circuitBreaker);
      await collect(
        provider.streamChat({
          messages: [{ role: 'user', content: 'hi' }],
          model: 'gpt-5.1',
          apiKey: 'sk-bad',
          abortSignal: new AbortController().signal,
        }),
      );
    }

    expect(circuitBreaker.isOpen('openai')).toBe(false);
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

    const provider = new OpenAiProvider(new CircuitBreakerService());
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
