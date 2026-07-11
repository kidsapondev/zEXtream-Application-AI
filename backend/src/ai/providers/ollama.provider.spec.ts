import { ConfigService } from '@nestjs/config';
import {
  OLLAMA_CONNECT_TIMEOUT_MS,
  OLLAMA_STREAM_INACTIVITY_TIMEOUT_MS,
  OllamaProvider,
} from './ollama.provider';
import { AiStreamEvent } from '../ai-provider.interface';

const encode = (text: string) => new TextEncoder().encode(text);

function createProvider(): OllamaProvider {
  const configService = {
    getOrThrow: jest.fn().mockReturnValue('http://ollama.local'),
  };
  return new OllamaProvider(configService as unknown as ConfigService);
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

describe('OllamaProvider', () => {
  const originalFetch = global.fetch;

  afterEach(() => {
    global.fetch = originalFetch;
    jest.useRealTimers();
  });

  it('parses NDJSON tokens and terminates on done', async () => {
    const readImpl = jest
      .fn()
      .mockResolvedValueOnce({
        done: false,
        value: encode(
          '{"message":{"role":"assistant","content":"Hel"},"done":false}\n',
        ),
      })
      .mockResolvedValueOnce({
        done: false,
        value: encode(
          '{"message":{"role":"assistant","content":"lo"},"done":false}\n{"done":true,"done_reason":"stop"}\n',
        ),
      });
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      body: { getReader: () => createReader(readImpl) },
    }) as never;

    const provider = createProvider();
    const events = await collect(
      provider.streamChat({
        messages: [{ role: 'user', content: 'hi' }],
        model: 'llama3',
        abortSignal: new AbortController().signal,
      }),
    );

    expect(events).toEqual([
      { type: 'token', delta: 'Hel' },
      { type: 'token', delta: 'lo' },
      { type: 'done', finishReason: 'stop' },
    ]);
  });

  it('skips a malformed/non-JSON line and continues streaming subsequent valid lines', async () => {
    const readImpl = jest
      .fn()
      .mockResolvedValueOnce({
        done: false,
        value: encode(
          'not-json-garbage\n{"message":{"content":"ok"},"done":false}\n',
        ),
      })
      .mockResolvedValueOnce({
        done: false,
        value: encode('{"done":true,"done_reason":"stop"}\n'),
      });
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      body: { getReader: () => createReader(readImpl) },
    }) as never;

    const provider = createProvider();
    const events = await collect(
      provider.streamChat({
        messages: [],
        model: 'llama3',
        abortSignal: new AbortController().signal,
      }),
    );

    // The malformed line is dropped silently; the stream is not failed and
    // the valid token/done that follow it still arrive.
    expect(events).toEqual([
      { type: 'token', delta: 'ok' },
      { type: 'done', finishReason: 'stop' },
    ]);
  });

  it('yields an error event for an upstream HTTP error response', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: false,
      status: 503,
      body: null,
    }) as never;

    const provider = createProvider();
    const events = await collect(
      provider.streamChat({
        messages: [],
        model: 'llama3',
        abortSignal: new AbortController().signal,
      }),
    );

    expect(events).toEqual([
      { type: 'error', message: 'Ollama returned HTTP 503' },
    ]);
  });

  it('yields an error event when the connection cannot be established', async () => {
    global.fetch = jest
      .fn()
      .mockRejectedValue(new Error('connect ECONNREFUSED')) as never;

    const provider = createProvider();
    const events = await collect(
      provider.streamChat({
        messages: [],
        model: 'llama3',
        abortSignal: new AbortController().signal,
      }),
    );

    expect(events).toEqual([
      {
        type: 'error',
        message: 'Could not reach Ollama: connect ECONNREFUSED',
      },
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
        value: encode('{"message":{"content":"a"},"done":false}\n'),
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
        messages: [],
        model: 'llama3',
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

  it('yields an error event when connecting takes longer than the connect timeout', async () => {
    jest.useFakeTimers();
    global.fetch = jest.fn((_url: string, init?: { signal?: AbortSignal }) => {
      return new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => {
          reject(new DOMException('The operation was aborted.', 'AbortError'));
        });
      });
    }) as never;

    const provider = createProvider();
    const iterator = provider
      .streamChat({
        messages: [],
        model: 'llama3',
        abortSignal: new AbortController().signal,
      })
      [Symbol.asyncIterator]();

    const pending = iterator.next();
    await jest.advanceTimersByTimeAsync(OLLAMA_CONNECT_TIMEOUT_MS);
    const result = await pending;

    expect(result.value).toEqual({
      type: 'error',
      message: `Connecting to Ollama timed out after ${OLLAMA_CONNECT_TIMEOUT_MS}ms`,
    });
  });

  it('yields an error event when no token arrives within the stream-inactivity timeout', async () => {
    jest.useFakeTimers();
    let capturedSignal: AbortSignal | undefined;
    const readImpl = jest
      .fn()
      .mockResolvedValueOnce({
        done: false,
        value: encode('{"message":{"content":"a"},"done":false}\n'),
      })
      .mockImplementationOnce(
        () =>
          new Promise((_resolve, reject) => {
            capturedSignal?.addEventListener('abort', () => {
              reject(
                new DOMException('The operation was aborted.', 'AbortError'),
              );
            });
          }),
      );
    global.fetch = jest.fn((_url: string, init?: { signal?: AbortSignal }) => {
      capturedSignal = init?.signal;
      return Promise.resolve({
        ok: true,
        status: 200,
        body: { getReader: () => createReader(readImpl) },
      });
    }) as never;

    const provider = createProvider();
    const iterator = provider
      .streamChat({
        messages: [],
        model: 'llama3',
        abortSignal: new AbortController().signal,
      })
      [Symbol.asyncIterator]();

    const first = await iterator.next();
    expect(first.value).toEqual({ type: 'token', delta: 'a' });

    const pending = iterator.next();
    await jest.advanceTimersByTimeAsync(OLLAMA_STREAM_INACTIVITY_TIMEOUT_MS);
    const second = await pending;

    expect(second.value).toEqual({
      type: 'error',
      message: `Ollama stream timed out after ${OLLAMA_STREAM_INACTIVITY_TIMEOUT_MS}ms of inactivity`,
    });
  });
});
