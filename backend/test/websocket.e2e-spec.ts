import { INestApplication } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import request from 'supertest';
import { App } from 'supertest/types';
import type { Socket } from 'socket.io-client';
import { PrismaService } from '../src/prisma/prisma.service';
import { MAX_CHAT_MESSAGE_BYTES } from '../src/chat/messages.service';
import { ProviderSettingsService } from '../src/provider-settings/provider-settings.service';
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
  waitForDisconnectOrError,
  waitForEvent,
} from './support/ws-client';

interface ChatMessageLike {
  id: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  streamingStatus: 'pending' | 'streaming' | 'complete' | 'error' | 'stopped';
  errorMessage?: string | null;
}

/**
 * Real Socket.IO integration tests (plan.md Phase 4 "Tests ที่ต้องเพิ่ม" and
 * Test strategy → Integration tests → "Socket.IO connection/join/send/stop/edit").
 * Unlike chat.gateway.spec.ts (unit tests that call gateway handlers directly
 * with every dependency mocked), everything here drives a real socket.io-client
 * against a real, listening Nest application and a real Postgres — see
 * backend/test/support/test-app.ts and ws-client.ts for the shared harness.
 *
 * OLLAMA_BASE_URL is set (see setup-e2e.ts) to a port nothing listens on, so
 * every `chat:send` in the main app below deterministically fails fast with a
 * "Could not reach Ollama" error — this is the real, unmocked error path an
 * unreachable/misconfigured provider produces in production, not a stand-in
 * for a real model response. The one thing that genuinely needs a *slow*
 * (not merely absent) upstream — chat:stop actually aborting an in-flight
 * request — gets its own app instance further down, pointed at a black-hole
 * TCP server that accepts the connection but never responds.
 */
describe('WebSocket / Socket.IO integration (e2e)', () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;
  let baseUrl: string;
  const createdUserIds: string[] = [];
  const sockets: Socket[] = [];

  beforeAll(async () => {
    ({ app, prisma } = await createE2eApp());
    baseUrl = await listen(app);
  });

  afterEach(async () => {
    for (const socket of sockets.splice(0)) {
      socket.removeAllListeners();
      socket.disconnect();
    }
    if (createdUserIds.length > 0) {
      await prisma.user.deleteMany({
        where: { id: { in: createdUserIds.splice(0) } },
      });
    }
  });

  afterAll(async () => {
    await app.close();
  });

  async function registerAndSession(
    targetApp: INestApplication<App>,
    label: string,
  ): Promise<{ user: RegisteredUser; session: { id: string } }> {
    const user = await registerUser(targetApp, label);
    const created = await request(targetApp.getHttpServer())
      .post('/api/chat/sessions')
      .set('Authorization', `Bearer ${user.accessToken}`)
      .send({ defaultProvider: 'ollama', defaultModel: 'test-model' })
      .expect(201);
    return { user, session: created.body as { id: string } };
  }

  function connect(token?: string | null): Socket {
    const socket = createSocket(baseUrl, { token });
    sockets.push(socket);
    socket.connect();
    return socket;
  }

  describe('connection auth', () => {
    it('accepts a connection with a valid access token', async () => {
      const { user } = await registerAndSession(app, 'ws-conn-valid');
      createdUserIds.push(user.user.id);

      const socket = connect(user.accessToken);
      await waitForEvent(socket, 'connect');

      expect(socket.connected).toBe(true);
    });

    it('disconnects a connection with no token at all', async () => {
      const socket = connect(undefined);

      await waitForDisconnectOrError(socket);

      expect(socket.connected).toBe(false);
    });

    it('disconnects a connection with a malformed/garbage token', async () => {
      const socket = connect('this-is-not-a-jwt');

      await waitForDisconnectOrError(socket);

      expect(socket.connected).toBe(false);
    });

    it('disconnects a connection with an expired (but otherwise well-formed) token', async () => {
      const { user } = await registerAndSession(app, 'ws-conn-expired');
      createdUserIds.push(user.user.id);
      const jwtService = app.get(JwtService);
      const configService = app.get(ConfigService);
      const expiredToken = jwtService.sign(
        { sub: user.user.id, email: user.user.email },
        {
          secret: configService.getOrThrow<string>('JWT_ACCESS_SECRET'),
          expiresIn: -10,
        },
      );

      const socket = connect(expiredToken);

      await waitForDisconnectOrError(socket);
      expect(socket.connected).toBe(false);
    });

    it('connects a guest (valid token) but rejects session:join with an error, same as GuestBlockGuard on REST', async () => {
      const guest = await registerUser(app, 'ws-conn-guest', {
        role: 'guest',
      });
      createdUserIds.push(guest.user.id);
      const created = await request(app.getHttpServer())
        .post('/api/chat/sessions')
        .set('Authorization', `Bearer ${guest.accessToken}`)
        .send({ defaultProvider: 'ollama', defaultModel: 'test-model' });
      // A guest can't create a session either (REST is guarded too), so join
      // against a session id that just doesn't belong to them — the point of
      // this test is that the *guest check* rejects it, not ownership.
      const sessionId =
        created.status === 201
          ? (created.body as { id: string }).id
          : '11111111-1111-4111-8111-111111111111';

      const socket = connect(guest.accessToken);
      await waitForEvent(socket, 'connect');
      expect(socket.connected).toBe(true); // connects fine — see handleConnection's doc comment

      const errorPromise = waitForEvent(socket, 'exception');
      socket.emit('session:join', { sessionId });
      const error = (await errorPromise) as { message?: string };
      expect(error.message).toMatch(/pending activation/i);
    });
  });

  describe('session:join', () => {
    it('joining your own session adds the socket to the room, verified by receiving its own subsequent broadcast; a socket that never joined does not', async () => {
      const { user, session } = await registerAndSession(app, 'ws-join-own');
      createdUserIds.push(user.user.id);

      const joined = connect(user.accessToken);
      await waitForEvent(joined, 'connect');
      joined.emit('session:join', { sessionId: session.id });

      const notJoined = connect(user.accessToken);
      await waitForEvent(notJoined, 'connect');

      await sleep(150); // let the join land before triggering a broadcast

      const joinedCreated = collectEvents<{ message: ChatMessageLike }>(
        joined,
        'chat:message:created',
      );
      const notJoinedCreated = collectEvents<{ message: ChatMessageLike }>(
        notJoined,
        'chat:message:created',
      );

      joined.emit('chat:send', { sessionId: session.id, content: 'hello' });
      await waitForEvent(joined, 'chat:message:updated', 5000);

      joinedCreated.stop();
      notJoinedCreated.stop();

      expect(joinedCreated.events.length).toBeGreaterThanOrEqual(1);
      expect(notJoinedCreated.events).toHaveLength(0);
    });

    it('rejects joining a session owned by a different user', async () => {
      const { session: ownerSession } = await registerAndSession(
        app,
        'ws-join-owner',
      );
      const { user: attacker } = await registerAndSession(
        app,
        'ws-join-attacker',
      );
      createdUserIds.push(attacker.user.id);

      const socket = connect(attacker.accessToken);
      await waitForEvent(socket, 'connect');

      const exceptionPromise = waitForEvent(socket, 'exception');
      socket.emit('session:join', { sessionId: ownerSession.id });

      await expect(exceptionPromise).resolves.toBeDefined();
    });
  });

  describe('chat:send full sequence (Ollama unreachable)', () => {
    it('emits created(user) -> created(assistant, streaming) -> updated(assistant, error) with no token events', async () => {
      const { user, session } = await registerAndSession(
        app,
        'ws-send-unreachable',
      );
      createdUserIds.push(user.user.id);

      const socket = connect(user.accessToken);
      await waitForEvent(socket, 'connect');
      socket.emit('session:join', { sessionId: session.id });
      await sleep(150);

      const tokenEvents = collectEvents<{ messageId: string; delta: string }>(
        socket,
        'chat:token',
      );
      const userCreated = waitForEvent<{ message: ChatMessageLike }>(
        socket,
        'chat:message:created',
      );

      socket.emit('chat:send', {
        sessionId: session.id,
        content: 'hello there',
      });

      const userMessage = await userCreated;
      expect(userMessage.message.role).toBe('user');
      expect(userMessage.message.content).toBe('hello there');

      const assistantMessage = await waitForEvent<{
        message: ChatMessageLike;
      }>(socket, 'chat:message:created');
      expect(assistantMessage.message.role).toBe('assistant');
      expect(assistantMessage.message.streamingStatus).toBe('streaming');

      const updated = await waitForEvent<{ message: ChatMessageLike }>(
        socket,
        'chat:message:updated',
        5000,
      );
      tokenEvents.stop();

      expect(updated.message.id).toBe(assistantMessage.message.id);
      expect(updated.message.streamingStatus).toBe('error');
      expect(updated.message.errorMessage).toMatch(/Could not reach Ollama/);
      expect(tokenEvents.events).toHaveLength(0);
    });
  });

  describe('payload validation over a real socket (not the unit-mocked pipe)', () => {
    it('rejects an oversized chat:send content with an exception event and persists nothing', async () => {
      const { user, session } = await registerAndSession(app, 'ws-oversized');
      createdUserIds.push(user.user.id);
      const socket = connect(user.accessToken);
      await waitForEvent(socket, 'connect');

      const exceptionPromise = waitForEvent(socket, 'exception');
      socket.emit('chat:send', {
        sessionId: session.id,
        content: 'a'.repeat(MAX_CHAT_MESSAGE_BYTES + 1),
      });
      await expect(exceptionPromise).resolves.toBeDefined();

      const messages = await prisma.message.findMany({
        where: { sessionId: session.id },
      });
      expect(messages).toHaveLength(0);
    });

    it('rejects a non-UUID sessionId', async () => {
      const { user } = await registerAndSession(app, 'ws-bad-uuid');
      createdUserIds.push(user.user.id);
      const socket = connect(user.accessToken);
      await waitForEvent(socket, 'connect');

      const exceptionPromise = waitForEvent(socket, 'exception');
      socket.emit('chat:send', { sessionId: 'not-a-uuid', content: 'hi' });
      await expect(exceptionPromise).resolves.toBeDefined();
    });

    it('rejects a chat:send payload with unknown extra fields (forbidNonWhitelisted)', async () => {
      const { user, session } = await registerAndSession(
        app,
        'ws-extra-fields',
      );
      createdUserIds.push(user.user.id);
      const socket = connect(user.accessToken);
      await waitForEvent(socket, 'connect');

      const exceptionPromise = waitForEvent(socket, 'exception');
      socket.emit('chat:send', {
        sessionId: session.id,
        content: 'hi',
        isAdmin: true,
      });
      await expect(exceptionPromise).resolves.toBeDefined();
    });
  });

  describe('same-socket identity switch (backend equivalent of logout, then login as a different user)', () => {
    it('a reconnected socket authenticates as the new user and loses access to the previous session, per SocketService.setAccessToken', async () => {
      const { user: userA, session: sessionA } = await registerAndSession(
        app,
        'ws-identity-a',
      );
      createdUserIds.push(userA.user.id);
      const { user: userB, session: sessionB } = await registerAndSession(
        app,
        'ws-identity-b',
      );
      createdUserIds.push(userB.user.id);

      const socket = connect(userA.accessToken);
      await waitForEvent(socket, 'connect');
      socket.emit('session:join', { sessionId: sessionA.id });
      await sleep(150);

      // Mirrors SocketService.setAccessToken(): same Socket instance, new
      // auth resolver, disconnect + reconnect (not a fresh client object).
      socket.auth = (cb: (data: { token: string }) => void) =>
        cb({ token: userB.accessToken });
      socket.disconnect();
      socket.connect();
      await waitForEvent(socket, 'connect');

      // Now authenticated as B: A's session must be rejected...
      const rejected = waitForEvent(socket, 'exception');
      socket.emit('session:join', { sessionId: sessionA.id });
      await expect(rejected).resolves.toBeDefined();

      // ...while B's own session still works.
      socket.emit('session:join', { sessionId: sessionB.id });
      await sleep(150);
      const created = waitForEvent<{ message: ChatMessageLike }>(
        socket,
        'chat:message:created',
        5000,
      );
      socket.emit('chat:send', { sessionId: sessionB.id, content: 'hi as B' });
      const event = await created;
      expect(event.message.role).toBe('user');
    });
  });

  describe('provider runtime gating (claude/openai require a per-user configured key)', () => {
    it('rejects chat:send for a provider the connected user has not configured a key for', async () => {
      const { user, session } = await registerAndSession(
        app,
        'ws-provider-no-key',
      );
      createdUserIds.push(user.user.id);

      const socket = connect(user.accessToken);
      await waitForEvent(socket, 'connect');
      socket.emit('session:join', { sessionId: session.id });
      await sleep(150);

      // The session itself defaults to 'ollama' (which needs no key and so
      // passes session creation's own gate — see ChatSessionsService.create()).
      // This test targets the separate, second gate in ChatGateway.onChatSend
      // that applies when a send explicitly asks for a different provider —
      // exactly the path a user with no claude/openai key configured hits by
      // switching providers mid-conversation via the frontend's model picker.
      const exceptionPromise = waitForEvent<{
        status: string;
        message: string;
      }>(socket, 'exception');
      socket.emit('chat:send', {
        sessionId: session.id,
        content: 'hello',
        provider: 'claude',
      });

      const exception = await exceptionPromise;
      expect(exception.message).toMatch(
        /Configure an API key for claude before starting a session with it/,
      );

      const messages = await prisma.message.findMany({
        where: { sessionId: session.id },
      });
      expect(messages).toHaveLength(0);
    });

    it("a key configured for one user is never usable by a different user's chat:send", async () => {
      const FIXTURE_KEY = 'fixture-fake-claude-key-not-a-real-credential';
      const { user: owner } = await registerAndSession(
        app,
        'ws-provider-key-owner',
      );
      createdUserIds.push(owner.user.id);
      // A real encrypted credential row via the actual service (same
      // encrypt/decrypt path production uses), not a real Anthropic key —
      // this test never reaches the point of actually calling out to Claude,
      // since the user under test (`other`, below) is rejected before that.
      await app
        .get(ProviderSettingsService)
        .upsertApiKey(owner.user.id, 'claude', FIXTURE_KEY);

      const { user: other, session: otherSession } = await registerAndSession(
        app,
        'ws-provider-key-other',
      );
      createdUserIds.push(other.user.id);

      const socket = connect(other.accessToken);
      await waitForEvent(socket, 'connect');
      socket.emit('session:join', { sessionId: otherSession.id });
      await sleep(150);

      const exceptionPromise = waitForEvent<{
        status: string;
        message: string;
      }>(socket, 'exception');
      socket.emit('chat:send', {
        sessionId: otherSession.id,
        content: 'hello from a user with no key of their own',
        provider: 'claude',
      });

      const exception = await exceptionPromise;
      expect(exception.message).toMatch(
        /Configure an API key for claude before starting a session with it/,
      );
      // The fixture key must never appear anywhere in what the client receives.
      expect(JSON.stringify(exception)).not.toContain(FIXTURE_KEY);

      const messages = await prisma.message.findMany({
        where: { sessionId: otherSession.id },
      });
      expect(messages).toHaveLength(0);

      // Confirms the fixture credential really was usable for its actual
      // owner (the gate is per-user, not "nobody's key ever validates in
      // tests") — checked via the existence-only hasApiKey(), not by
      // actually decrypting/streaming, so this never touches the network.
      const ownerHasKey = await app
        .get(ProviderSettingsService)
        .hasApiKey(owner.user.id, 'claude');
      expect(ownerHasKey).toBe(true);
    });
  });

  describe('server-restart reconciliation', () => {
    it('reconcileStuckMessages flips a message stuck in "streaming" (simulated crash mid-stream) to "error" on next session load', async () => {
      const { user, session } = await registerAndSession(app, 'ws-reconcile');
      createdUserIds.push(user.user.id);

      const stuck = await prisma.message.create({
        data: {
          sessionId: session.id,
          role: 'assistant',
          content: 'partial output before the crash...',
          provider: 'ollama',
          model: 'test-model',
          streamingStatus: 'streaming',
        },
      });

      const response = await request(app.getHttpServer())
        .get(`/api/chat/sessions/${session.id}/messages`)
        .set('Authorization', `Bearer ${user.accessToken}`)
        .expect(200);

      const messages = response.body as ChatMessageLike[];
      const reconciled = messages.find((m) => m.id === stuck.id);
      expect(reconciled).toBeDefined();
      expect(reconciled?.streamingStatus).toBe('error');
      expect(reconciled?.errorMessage).toBe('Generation was interrupted.');
    });
  });

  describe('artifact:edit (real socket, not the unit-mocked gateway)', () => {
    async function seedArtifact(
      sessionId: string,
      overrides: { filename?: string; content?: string } = {},
    ) {
      const message = await prisma.message.create({
        data: {
          sessionId,
          role: 'assistant',
          content: 'Created a file.',
          streamingStatus: 'complete',
        },
      });
      return prisma.codeArtifact.create({
        data: {
          sessionId,
          messageId: message.id,
          filename: overrides.filename ?? 'src/index.ts',
          language: 'typescript',
          content: overrides.content ?? 'export const value = 1;',
          revision: 1,
          origin: 'ai',
        },
      });
    }

    it('creates a new revision and broadcasts artifact:created to everyone in the session room', async () => {
      const { user, session } = await registerAndSession(
        app,
        'ws-artifact-edit',
      );
      createdUserIds.push(user.user.id);
      const artifact = await seedArtifact(session.id);

      const socket = connect(user.accessToken);
      await waitForEvent(socket, 'connect');
      socket.emit('session:join', { sessionId: session.id });
      await sleep(150);

      const createdPromise = waitForEvent<{
        artifact: {
          id: string;
          revision: number;
          content: string;
          origin: string;
        };
      }>(socket, 'artifact:created');
      socket.emit('artifact:edit', {
        artifactId: artifact.id,
        content: 'export const value = 2;',
      });

      const { artifact: updated } = await createdPromise;
      expect(updated.revision).toBe(2);
      expect(updated.content).toBe('export const value = 2;');
      expect(updated.origin).toBe('user');

      const revisions = await prisma.codeArtifact.findMany({
        where: { sessionId: session.id, filename: 'src/index.ts' },
        orderBy: { revision: 'asc' },
      });
      expect(revisions).toHaveLength(2);
    });

    it('rejects artifact:edit for an artifact in a session the connected user does not own, and creates no revision', async () => {
      const { user: owner, session: ownerSession } = await registerAndSession(
        app,
        'ws-artifact-edit-owner',
      );
      createdUserIds.push(owner.user.id);
      const { user: attacker } = await registerAndSession(
        app,
        'ws-artifact-edit-attacker',
      );
      createdUserIds.push(attacker.user.id);
      const artifact = await seedArtifact(ownerSession.id, {
        filename: 'src/secret.ts',
        content: 'export const secret = 42;',
      });

      const socket = connect(attacker.accessToken);
      await waitForEvent(socket, 'connect');

      const exceptionPromise = waitForEvent(socket, 'exception');
      socket.emit('artifact:edit', {
        artifactId: artifact.id,
        content: 'export const secret = "stolen";',
      });

      await expect(exceptionPromise).resolves.toBeDefined();

      const revisions = await prisma.codeArtifact.findMany({
        where: { sessionId: ownerSession.id, filename: 'src/secret.ts' },
      });
      expect(revisions).toHaveLength(1);
      expect(revisions[0].content).toBe('export const secret = 42;');
    });
  });
});
