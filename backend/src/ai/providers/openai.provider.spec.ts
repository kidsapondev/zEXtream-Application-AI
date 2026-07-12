import { ConfigService } from '@nestjs/config';
import { OpenAiProvider } from './openai.provider';
import { AiStreamEvent } from '../ai-provider.interface';
import {
  CircuitBreakerService,
  CIRCUIT_BREAKER_FAILURE_THRESHOLD,
} from '../circuit-breaker.service';

const encode = (text: string) => new TextEncoder().encode(text);

function createProvider(
  configValues: Record<string, string | undefined> = {
    CODEX_BRIDGE_URL: 'http://127.0.0.1:4171',
    HOST_BRIDGE_TOKEN: 'test-bridge-token',
  },
  circuitBreaker: CircuitBreakerService = new CircuitBreakerService(),
): OpenAiProvider {
  const configService = {
    get: jest.fn((key: string) => configValues[key]),
  };
  return new OpenAiProvider(
    configService as unknown as ConfigService,
    circuitBreaker,
  );
}

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

describe('OpenAiProvider (codex host-bridge)', () => {
  const originalFetch = global.fetch;

  afterEach(() => {
    global.fetch = originalFetch;
  });

  it('yields an error immediately when the host-bridge is not configured, without calling fetch', async () => {
    const provider = createProvider({});
    global.fetch = jest.fn() as never;

    const events = await collect(
      provider.streamChat({
        messages: [{ role: 'user', content: 'hi' }],
        model: 'gpt-5.6-sol',
        abortSignal: new AbortController().signal,
      }),
    );

    expect(events).toEqual([
      { type: 'error', message: 'Codex host-bridge is not configured' },
    ]);
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it('POSTs messages/model to /codex/chat with the bridge token header and re-yields its NDJSON events', async () => {
    const readImpl = jest
      .fn()
      .mockResolvedValueOnce({
        done: false,
        value: encode(
          `${JSON.stringify({ type: 'token', delta: 'PONG' })}\n` +
            `${JSON.stringify({ type: 'done', finishReason: 'stop', usage: { inputTokens: 100, outputTokens: 10 } })}\n`,
        ),
      })
      .mockResolvedValueOnce({ done: true, value: undefined });
    const fetchMock = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      body: { getReader: () => createReader(readImpl) },
    });
    global.fetch = fetchMock as never;

    const provider = createProvider();
    const events = await collect(
      provider.streamChat({
        messages: [{ role: 'user', content: 'hi' }],
        model: 'gpt-5.6-sol',
        abortSignal: new AbortController().signal,
      }),
    );

    expect(events).toEqual([
      { type: 'token', delta: 'PONG' },
      {
        type: 'done',
        finishReason: 'stop',
        usage: { inputTokens: 100, outputTokens: 10 },
      },
    ]);

    const [url, init] = fetchMock.mock.calls[0] as [
      string,
      { headers: Record<string, string>; body: string },
    ];
    expect(url).toBe('http://127.0.0.1:4171/codex/chat');
    expect(init.headers['x-bridge-token']).toBe('test-bridge-token');
    expect(JSON.parse(init.body)).toEqual({
      messages: [{ role: 'user', content: 'hi' }],
      model: 'gpt-5.6-sol',
    });
  });

  it('maps a non-ok bridge response to an error and records a circuit-breaker failure', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: false,
      status: 503,
      body: null,
    }) as never;
    const circuitBreaker = new CircuitBreakerService();
    const recordFailureSpy = jest.spyOn(circuitBreaker, 'recordFailure');

    const provider = createProvider(undefined, circuitBreaker);
    const events = await collect(
      provider.streamChat({
        messages: [{ role: 'user', content: 'hi' }],
        model: 'gpt-5.6-sol',
        abortSignal: new AbortController().signal,
      }),
    );

    expect(events).toEqual([
      { type: 'error', message: 'Codex host-bridge returned HTTP 503' },
    ]);
    expect(recordFailureSpy).toHaveBeenCalledWith('openai');
  });

  it('yields an error when the bridge cannot be reached', async () => {
    global.fetch = jest
      .fn()
      .mockRejectedValue(new Error('connect ECONNREFUSED')) as never;

    const provider = createProvider();
    const events = await collect(
      provider.streamChat({
        messages: [{ role: 'user', content: 'hi' }],
        model: 'gpt-5.6-sol',
        abortSignal: new AbortController().signal,
      }),
    );

    expect(events).toEqual([
      {
        type: 'error',
        message: 'Could not reach the Codex host-bridge: connect ECONNREFUSED',
      },
    ]);
  });

  it('fails fast without calling fetch once the circuit is open', async () => {
    const circuitBreaker = new CircuitBreakerService();
    for (let i = 0; i < CIRCUIT_BREAKER_FAILURE_THRESHOLD; i += 1) {
      circuitBreaker.recordFailure('openai');
    }
    global.fetch = jest.fn() as never;

    const provider = createProvider(undefined, circuitBreaker);
    const events = await collect(
      provider.streamChat({
        messages: [{ role: 'user', content: 'hi' }],
        model: 'gpt-5.6-sol',
        abortSignal: new AbortController().signal,
      }),
    );

    expect(events).toHaveLength(1);
    expect(events[0].type).toBe('error');
    expect(global.fetch).not.toHaveBeenCalled();
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
        value: encode(`${JSON.stringify({ type: 'token', delta: 'a' })}\n`),
      })
      .mockImplementationOnce(() => secondRead);
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      body: { getReader: () => createReader(readImpl) },
    }) as never;

    const provider = createProvider();
    const iterator = provider
      .streamChat({
        messages: [{ role: 'user', content: 'hi' }],
        model: 'gpt-5.6-sol',
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
