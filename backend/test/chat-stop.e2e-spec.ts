import { INestApplication } from '@nestjs/common';
import net from 'net';
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
import {
  collectEvents,
  createSocket,
  sleep,
  waitForEvent,
} from './support/ws-client';
import { CHAT_STOP_BLACKHOLE_PORT } from './setup-e2e-stop';

interface ChatMessageLike {
  id: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  streamingStatus: 'pending' | 'streaming' | 'complete' | 'error' | 'stopped';
  errorMessage?: string | null;
}

/**
 * `chat:stop` (plan.md Phase 4 "Tests ที่ต้องเพิ่ม": stop generation of your
 * own message / reject stop for another user's message). This needs a
 * stream that is genuinely still in flight when the stop arrives, which the
 * always-refused Ollama port used by websocket.e2e-spec.ts can't provide —
 * fetch() there fails with ECONNREFUSED in a handful of milliseconds, no
 * window to race a stop against it.
 *
 * This is a *separate Jest project* (see jest-e2e.json's "e2e-stop" project
 * and setup-e2e-stop.ts) rather than another describe block in
 * websocket.e2e-spec.ts, specifically so it gets its own, fresh module
 * registry: `@nestjs/config`'s `ConfigModule.forRoot({ validate })` snapshots
 * `process.env` synchronously the first time `app.module.ts` is imported in
 * a given file's registry, so a single file that built two Nest apps with
 * different `OLLAMA_BASE_URL` values would have the second app silently
 * reuse the first app's already-frozen config (verified empirically while
 * writing this suite — see setup-e2e-stop.ts's doc comment for the full
 * story). A dedicated project sidesteps that: `setup-e2e-stop.ts` sets
 * `OLLAMA_BASE_URL` to a fixed black-hole port *before* this file's own
 * imports ever reach app.module.ts, so the one app instance built below
 * picks it up correctly the normal way.
 *
 * ActiveStreamRegistry's abort mechanics themselves are already covered at
 * the unit level (active-stream-registry.service.spec.ts); this only needs
 * to prove the WS message round-trips into a real 'stopped' finalization.
 */
describe('chat:stop against a slow (hanging) provider (e2e)', () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;
  let baseUrl: string;
  let blackHoleServer: net.Server;
  const userIds: string[] = [];
  const sockets: Socket[] = [];
  // Aborting a fetch() on the client side doesn't reliably make undici tear
  // down the underlying TCP socket in a way this raw server observes as a
  // clean close (no HTTP response was ever framed, so there's no protocol-
  // level signal either side can use to agree the "request" is over) —
  // net.Server#close()'s callback only fires once every accepted socket has
  // closed, so without tracking + force-destroying them ourselves,
  // afterAll's close() call hangs and blows the default Jest hook timeout.
  const openBlackHoleSockets = new Set<net.Socket>();

  beforeAll(async () => {
    blackHoleServer = net.createServer((socket) => {
      openBlackHoleSockets.add(socket);
      socket.on('close', () => openBlackHoleSockets.delete(socket));
      socket.on('error', () => {
        // Ignore ECONNRESET-on-abort noise from the client side aborting mid-request.
      });
      // Accept the TCP connection but never write an HTTP response — the
      // request this backs (OllamaProvider's fetch()) hangs until aborted,
      // which is exactly the "slow provider" this file needs to exercise
      // chat:stop deterministically.
    });
    await new Promise<void>((resolve) => {
      blackHoleServer.listen(CHAT_STOP_BLACKHOLE_PORT, '127.0.0.1', () =>
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
    const closed = new Promise<void>((resolve) =>
      blackHoleServer.close(() => resolve()),
    );
    for (const socket of openBlackHoleSockets) {
      socket.destroy();
    }
    await closed;
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

  it('stops a stream owned by the connecting user, finalizing it as "stopped"', async () => {
    const { user, session } = await registerAndSession('ws-stop-own');
    userIds.push(user.user.id);

    const socket = connect(user.accessToken);
    await waitForEvent(socket, 'connect');
    socket.emit('session:join', { sessionId: session.id });
    await sleep(150);

    const userCreated = waitForEvent<{ message: ChatMessageLike }>(
      socket,
      'chat:message:created',
    );
    socket.emit('chat:send', {
      sessionId: session.id,
      content: 'start something slow',
    });
    await userCreated;
    const assistantCreated = await waitForEvent<{ message: ChatMessageLike }>(
      socket,
      'chat:message:created',
    );
    expect(assistantCreated.message.streamingStatus).toBe('streaming');

    const updatedPromise = waitForEvent<{ message: ChatMessageLike }>(
      socket,
      'chat:message:updated',
      5000,
    );
    socket.emit('chat:stop', { messageId: assistantCreated.message.id });
    const updated = await updatedPromise;

    expect(updated.message.id).toBe(assistantCreated.message.id);
    expect(updated.message.streamingStatus).toBe('stopped');
  });

  it('ignores a chat:stop from a user who does not own the message', async () => {
    const { user: owner, session } = await registerAndSession('ws-stop-owner');
    userIds.push(owner.user.id);
    const { user: attacker } = await registerAndSession('ws-stop-attacker');
    userIds.push(attacker.user.id);

    const ownerSocket = connect(owner.accessToken);
    await waitForEvent(ownerSocket, 'connect');
    ownerSocket.emit('session:join', { sessionId: session.id });
    await sleep(150);

    const attackerSocket = connect(attacker.accessToken);
    await waitForEvent(attackerSocket, 'connect');

    const userCreated = waitForEvent<{ message: ChatMessageLike }>(
      ownerSocket,
      'chat:message:created',
    );
    ownerSocket.emit('chat:send', {
      sessionId: session.id,
      content: 'start something slow',
    });
    await userCreated;
    const assistantCreated = await waitForEvent<{ message: ChatMessageLike }>(
      ownerSocket,
      'chat:message:created',
    );

    const updatedEvents = collectEvents<{ message: ChatMessageLike }>(
      ownerSocket,
      'chat:message:updated',
    );
    attackerSocket.emit('chat:stop', {
      messageId: assistantCreated.message.id,
    });
    await sleep(500); // grace period: a rejected stop is a silent no-op, nothing to await directly
    expect(updatedEvents.events).toHaveLength(0);
    updatedEvents.stop();

    // Clean up for real (via the owner) so the held-open black-hole request
    // doesn't linger past this test.
    const finalUpdate = waitForEvent<{ message: ChatMessageLike }>(
      ownerSocket,
      'chat:message:updated',
      5000,
    );
    ownerSocket.emit('chat:stop', { messageId: assistantCreated.message.id });
    const result = await finalUpdate;
    expect(result.message.streamingStatus).toBe('stopped');
  });
});
