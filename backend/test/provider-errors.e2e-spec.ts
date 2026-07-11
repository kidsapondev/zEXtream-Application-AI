import { IncomingMessage, ServerResponse } from 'http';
import http from 'http';
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { App } from 'supertest/types';
import type { Socket } from 'socket.io-client';
import { PrismaService } from '../src/prisma/prisma.service';
import {
  createE2eApp,
  listen,
  registerUser,
  RegisteredUser,
} from './support/test-app';
import { createSocket, sleep, waitForEvent } from './support/ws-client';
import { PROVIDER_ERRORS_MOCK_PORT } from './setup-e2e-provider-errors';

interface ChatMessageLike {
  id: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  streamingStatus: 'pending' | 'streaming' | 'complete' | 'error' | 'stopped';
  errorMessage?: string | null;
}

type MockMode = 'http-error' | 'malformed-then-valid';

/**
 * Real-socket coverage for two OllamaProvider response paths (plan.md Phase
 * 4 test strategy: "Ollama unavailable, HTTP error, malformed stream และ
 * timeout") that, before this file, only had unit-level coverage
 * (ollama.provider.spec.ts) — the "unavailable" (connection refused) case
 * already has full e2e coverage in websocket.e2e-spec.ts, and that was used
 * to justify not duplicating the same downstream finalize-as-'error' path
 * for these two. That justification undersold one of them: a malformed
 * NDJSON line does NOT finalize the message as 'error' (see
 * ollama.provider.ts's stream loop) — it's logged and skipped, and the
 * stream continues. That is a genuinely different code path worth its own
 * real-socket proof, which is what this file adds.
 *
 * Timeout (OLLAMA_CONNECT_TIMEOUT_MS / OLLAMA_STREAM_INACTIVITY_TIMEOUT_MS,
 * 90s / 30s, hardcoded not env-configurable) is deliberately NOT covered
 * here e2e: a real end-to-end wait would add a minute-plus to every test run
 * for a path whose finalize behavior is identical to the HTTP-error case
 * already covered below, and is already exercised with fake timers at the
 * unit level (ollama.provider.spec.ts). Not worth the suite-wide slowdown.
 *
 * Separate Jest project (see jest-e2e.json's "e2e-provider-errors" project
 * and setup-e2e-provider-errors.ts) for the same ConfigModule-freezes-
 * process.env-on-first-import reason documented in chat-stop.e2e-spec.ts
 * and setup-e2e-stop.ts.
 */
describe('Ollama HTTP-error and malformed-stream-line handling (e2e)', () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;
  let baseUrl: string;
  let mockServer: http.Server;
  let mode: MockMode = 'http-error';
  const userIds: string[] = [];
  const sockets: Socket[] = [];

  beforeAll(async () => {
    mockServer = http.createServer(
      (req: IncomingMessage, res: ServerResponse) => {
        if (mode === 'http-error') {
          res.writeHead(500, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: 'model runner crashed' }));
          return;
        }

        // 'malformed-then-valid': a real Ollama /api/chat NDJSON stream, but
        // with one deliberately corrupt line in the middle, followed by a
        // well-formed content chunk and a well-formed done chunk - proves
        // the parser skips the bad line and still delivers the rest.
        res.writeHead(200, { 'content-type': 'application/x-ndjson' });
        res.write('not-json-garbage\n');
        res.write(
          `${JSON.stringify({ message: { role: 'assistant', content: 'hello after garbage' }, done: false })}\n`,
        );
        res.write(`${JSON.stringify({ done: true, done_reason: 'stop' })}\n`);
        res.end();
      },
    );
    await new Promise<void>((resolve) => {
      mockServer.listen(PROVIDER_ERRORS_MOCK_PORT, '127.0.0.1', () =>
        resolve(),
      );
    });

    const created = await createE2eApp();
    app = created.app;
    prisma = created.prisma;
    baseUrl = await listen(app);
  });

  afterEach(async () => {
    for (const socket of sockets.splice(0)) {
      socket.removeAllListeners();
      socket.disconnect();
    }
    if (userIds.length > 0) {
      await prisma.user.deleteMany({
        where: { id: { in: userIds.splice(0) } },
      });
    }
  });

  afterAll(async () => {
    await app.close();
    await new Promise<void>((resolve) => mockServer.close(() => resolve()));
  });

  async function registerAndSession(
    label: string,
  ): Promise<{ user: RegisteredUser; session: { id: string } }> {
    const user = await registerUser(app, label);
    const created = await request(app.getHttpServer())
      .post('/api/chat/sessions')
      .set('Authorization', `Bearer ${user.accessToken}`)
      .send({ defaultProvider: 'ollama', defaultModel: 'test-model' })
      .expect(201);
    return { user, session: created.body as { id: string } };
  }

  function connect(token: string): Socket {
    const socket = createSocket(baseUrl, { token });
    sockets.push(socket);
    socket.connect();
    return socket;
  }

  it('finalizes the message as "error" with the upstream status when Ollama returns a non-2xx response', async () => {
    mode = 'http-error';
    const { user, session } = await registerAndSession('ws-ollama-http-error');
    userIds.push(user.user.id);

    const socket = connect(user.accessToken);
    await waitForEvent(socket, 'connect');
    socket.emit('session:join', { sessionId: session.id });
    await sleep(150);

    socket.emit('chat:send', { sessionId: session.id, content: 'hello' });
    const updated = await waitForEvent<{ message: ChatMessageLike }>(
      socket,
      'chat:message:updated',
      5000,
    );

    expect(updated.message.streamingStatus).toBe('error');
    expect(updated.message.errorMessage).toBe('Ollama returned HTTP 500');
  });

  it('skips a malformed NDJSON line without failing the message, delivering the well-formed content around it', async () => {
    mode = 'malformed-then-valid';
    const { user, session } = await registerAndSession(
      'ws-ollama-malformed-line',
    );
    userIds.push(user.user.id);

    const socket = connect(user.accessToken);
    await waitForEvent(socket, 'connect');
    socket.emit('session:join', { sessionId: session.id });
    await sleep(150);

    const tokenPromise = waitForEvent<{ messageId: string; delta: string }>(
      socket,
      'chat:token',
      5000,
    );
    socket.emit('chat:send', { sessionId: session.id, content: 'hello' });
    const token = await tokenPromise;
    expect(token.delta).toBe('hello after garbage');

    const updated = await waitForEvent<{ message: ChatMessageLike }>(
      socket,
      'chat:message:updated',
      5000,
    );
    expect(updated.message.streamingStatus).toBe('complete');
    expect(updated.message.content).toBe('hello after garbage');
  });
});
