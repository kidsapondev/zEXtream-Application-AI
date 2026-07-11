import { Socket } from 'socket.io';
import { WsException } from '@nestjs/websockets';
import { BadRequestException, ValidationPipe } from '@nestjs/common';
import { ChatGateway } from './chat.gateway';
import { MAX_ARTIFACT_CONTENT_BYTES } from '../artifacts/artifacts.service';
import { MAX_CHAT_MESSAGE_BYTES } from '../chat/messages.service';
import { ChatSendDto } from './dto/chat-send.dto';
import { ArtifactEditDto } from './dto/artifact-edit.dto';
import { SessionJoinDto } from './dto/session-join.dto';

const VALID_SESSION_ID = '11111111-1111-4111-8111-111111111111';

/**
 * Runs a raw payload through the exact ValidationPipe configuration applied
 * to ChatGateway via @UsePipes (see chat.gateway.ts). Unit tests below call
 * gateway handlers directly and therefore bypass Nest's runtime pipe/guard
 * wiring entirely, so this is the only way to exercise the real DTO
 * validation behavior without standing up a full Nest application + socket
 * connection.
 */
function validateMessageBody<T extends object>(
  metatype: new () => T,
  raw: object,
): Promise<T> {
  const pipe = new ValidationPipe({
    whitelist: true,
    forbidNonWhitelisted: true,
    transform: true,
  });
  return pipe.transform(raw, {
    type: 'body',
    metatype,
    data: '',
  }) as Promise<T>;
}

describe('ChatGateway chat:stop', () => {
  const messagesService = {
    isOwnedByUser: jest.fn(),
  };
  const streamRegistry = {
    stop: jest.fn(),
  };

  const gateway = new ChatGateway(
    {} as never,
    {} as never,
    {} as never,
    messagesService as never,
    {} as never,
    streamRegistry as never,
    {} as never,
    {} as never,
  );

  const client = { data: { userId: 'user-1' } } as unknown as Socket;

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('stops a stream owned by the connected user', async () => {
    messagesService.isOwnedByUser.mockResolvedValue(true);

    await gateway.onChatStop(client, { messageId: 'message-1' });

    expect(messagesService.isOwnedByUser).toHaveBeenCalledWith(
      'message-1',
      'user-1',
    );
    expect(streamRegistry.stop).toHaveBeenCalledWith('message-1');
  });

  it('does not stop a stream owned by another user', async () => {
    messagesService.isOwnedByUser.mockResolvedValue(false);

    await gateway.onChatStop(client, { messageId: 'message-2' });

    expect(streamRegistry.stop).not.toHaveBeenCalled();
  });
});

describe('ChatGateway chat:send failure handling', () => {
  const client = { data: { userId: 'user-1' } } as unknown as Socket;
  const sessionsService = {
    getOwned: jest.fn(),
    touch: jest.fn(),
    setTitleIfDefault: jest.fn(),
  };
  const messagesService = {
    createUserMessage: jest.fn(),
    createPendingAssistantMessage: jest.fn(),
    listForSession: jest.fn(),
    finalizeAssistantMessage: jest.fn(),
  };
  const aiProviderFactory = {
    hasProvider: jest.fn(),
    getProvider: jest.fn(),
  };
  const streamRegistry = {
    register: jest.fn(),
    release: jest.fn(),
    hasActiveStream: jest.fn(),
  };
  const artifactsService = {
    createRevision: jest.fn(),
    listLatestForSession: jest.fn(),
  };
  const providerSettingsService = {
    getApiKeyForRuntime: jest.fn(),
  };
  const emit = jest.fn<(event: string, payload: unknown) => void>();

  const gateway = new ChatGateway(
    {} as never,
    {} as never,
    sessionsService as never,
    messagesService as never,
    aiProviderFactory as never,
    streamRegistry as never,
    artifactsService as never,
    providerSettingsService as never,
  );

  gateway.server = { to: jest.fn(() => ({ emit })) } as never;

  beforeEach(() => {
    jest.clearAllMocks();
    sessionsService.getOwned.mockResolvedValue({
      title: 'New Chat',
      defaultProvider: 'ollama',
      defaultModel: 'test-model',
    });
    sessionsService.touch.mockResolvedValue(undefined);
    sessionsService.setTitleIfDefault.mockResolvedValue(undefined);
    streamRegistry.hasActiveStream.mockReturnValue(false);
    messagesService.createUserMessage.mockResolvedValue({
      id: 'user-message',
      sessionId: 'session-1',
      role: 'user',
      content: 'hello',
    });
    messagesService.createPendingAssistantMessage.mockResolvedValue({
      id: 'assistant-message',
      sessionId: 'session-1',
      role: 'assistant',
      content: '',
    });
    messagesService.listForSession.mockResolvedValue([]);
    artifactsService.listLatestForSession.mockResolvedValue([]);
    messagesService.finalizeAssistantMessage.mockImplementation(
      (
        _id: string,
        content: string,
        streamingStatus: string,
        errorMessage?: string,
      ) =>
        Promise.resolve({
          id: 'assistant-message',
          content,
          streamingStatus,
          errorMessage,
        }),
    );
  });

  it('rejects a disabled provider before persisting the prompt', async () => {
    aiProviderFactory.hasProvider.mockReturnValue(false);

    await expect(
      gateway.onChatSend(client, {
        sessionId: 'session-1',
        content: 'hello',
        provider: 'openai',
      }),
    ).rejects.toBeInstanceOf(WsException);

    expect(messagesService.createUserMessage).not.toHaveBeenCalled();
    expect(
      messagesService.createPendingAssistantMessage,
    ).not.toHaveBeenCalled();
  });

  it('finalizes the assistant message when the provider throws', async () => {
    aiProviderFactory.hasProvider.mockReturnValue(true);
    aiProviderFactory.getProvider.mockReturnValue({
      async *streamChat() {
        await Promise.resolve();
        yield { type: 'token' as const, delta: '' };
        throw new Error('upstream unavailable');
      },
    });
    streamRegistry.register.mockReturnValue(new AbortController());

    await gateway.onChatSend(client, {
      sessionId: 'session-1',
      content: 'hello',
    });

    expect(messagesService.finalizeAssistantMessage).toHaveBeenCalledWith(
      'assistant-message',
      '',
      'error',
      'upstream unavailable',
    );
    expect(streamRegistry.release).toHaveBeenCalledWith('assistant-message');
  });

  it('fails an oversized AI artifact without persisting a partial revision', async () => {
    aiProviderFactory.hasProvider.mockReturnValue(true);
    aiProviderFactory.getProvider.mockReturnValue({
      async *streamChat() {
        yield {
          type: 'token' as const,
          delta: `\`\`\`typescript:src/too-large.ts\n${'a'.repeat(
            MAX_ARTIFACT_CONTENT_BYTES + 1,
          )}`,
        };
        yield { type: 'done' as const, finishReason: 'complete' as const };
      },
    });
    streamRegistry.register.mockReturnValue(new AbortController());

    await gateway.onChatSend(client, {
      sessionId: 'session-1',
      content: 'create a huge file',
    });

    expect(artifactsService.createRevision).not.toHaveBeenCalled();
    expect(messagesService.finalizeAssistantMessage).toHaveBeenCalledWith(
      'assistant-message',
      '',
      'error',
      `Artifact content must not exceed ${MAX_ARTIFACT_CONTENT_BYTES} bytes`,
    );
  });

  it('persists a partial artifact and finalizes as stopped when generation is aborted', async () => {
    aiProviderFactory.hasProvider.mockReturnValue(true);
    aiProviderFactory.getProvider.mockReturnValue({
      async *streamChat() {
        yield {
          type: 'token' as const,
          delta: '```typescript:src/partial.ts\nexport const partial = true;',
        };
        yield { type: 'done' as const, finishReason: 'stopped' as const };
      },
    });
    streamRegistry.register.mockReturnValue(new AbortController());
    artifactsService.createRevision.mockResolvedValue({
      id: 'artifact-partial',
    });

    await gateway.onChatSend(client, {
      sessionId: 'session-1',
      content: 'start a file',
    });

    expect(artifactsService.createRevision).toHaveBeenCalledWith(
      expect.objectContaining({
        filename: 'src/partial.ts',
        content: 'export const partial = true;',
        origin: 'ai',
      }),
    );
    expect(messagesService.finalizeAssistantMessage).toHaveBeenCalledWith(
      'assistant-message',
      '',
      'stopped',
      undefined,
    );
  });

  it('rejects an oversized content payload before any service is called', async () => {
    await expect(
      validateMessageBody(ChatSendDto, {
        sessionId: VALID_SESSION_ID,
        content: 'a'.repeat(MAX_CHAT_MESSAGE_BYTES + 1),
      }),
    ).rejects.toBeInstanceOf(BadRequestException);

    expect(sessionsService.getOwned).not.toHaveBeenCalled();
    expect(messagesService.createUserMessage).not.toHaveBeenCalled();
    expect(aiProviderFactory.hasProvider).not.toHaveBeenCalled();
  });

  it('rejects a provider that is not in the enabled allowlist before any service is called', async () => {
    await expect(
      validateMessageBody(ChatSendDto, {
        sessionId: VALID_SESSION_ID,
        content: 'hello',
        provider: 'gemini' as never,
      }),
    ).rejects.toBeInstanceOf(BadRequestException);

    expect(sessionsService.getOwned).not.toHaveBeenCalled();
    expect(messagesService.createUserMessage).not.toHaveBeenCalled();
  });

  it('rejects a concurrent send when the session already has an active stream', async () => {
    aiProviderFactory.hasProvider.mockReturnValue(true);
    streamRegistry.hasActiveStream.mockReturnValue(true);

    await expect(
      gateway.onChatSend(client, {
        sessionId: 'session-1',
        content: 'hello',
      }),
    ).rejects.toBeInstanceOf(WsException);

    expect(streamRegistry.hasActiveStream).toHaveBeenCalledWith('session-1');
    expect(messagesService.createUserMessage).not.toHaveBeenCalled();
    expect(
      messagesService.createPendingAssistantMessage,
    ).not.toHaveBeenCalled();
  });

  it('rejects claude/openai sends when the user has no configured API key, before persisting the prompt', async () => {
    aiProviderFactory.hasProvider.mockReturnValue(true);
    providerSettingsService.getApiKeyForRuntime.mockResolvedValue(null);

    await expect(
      gateway.onChatSend(client, {
        sessionId: 'session-1',
        content: 'hello',
        provider: 'claude',
      }),
    ).rejects.toBeInstanceOf(WsException);

    expect(providerSettingsService.getApiKeyForRuntime).toHaveBeenCalledWith(
      'user-1',
      'claude',
    );
    expect(messagesService.createUserMessage).not.toHaveBeenCalled();
  });

  it('passes the resolved API key to non-ollama providers', async () => {
    aiProviderFactory.hasProvider.mockReturnValue(true);
    providerSettingsService.getApiKeyForRuntime.mockResolvedValue(
      'decrypted-key',
    );
    const streamChat = jest.fn(function* () {
      yield { type: 'done' as const, finishReason: 'stop' as const };
    });
    aiProviderFactory.getProvider.mockReturnValue({ streamChat });
    streamRegistry.register.mockReturnValue(new AbortController());

    await gateway.onChatSend(client, {
      sessionId: 'session-1',
      content: 'hello',
      provider: 'claude',
    });

    expect(streamChat).toHaveBeenCalledWith(
      expect.objectContaining({ apiKey: 'decrypted-key' }),
    );
  });

  it('does not resolve an API key for ollama sends', async () => {
    aiProviderFactory.hasProvider.mockReturnValue(true);
    const streamChat = jest.fn(function* () {
      yield { type: 'done' as const, finishReason: 'stop' as const };
    });
    aiProviderFactory.getProvider.mockReturnValue({ streamChat });
    streamRegistry.register.mockReturnValue(new AbortController());

    await gateway.onChatSend(client, {
      sessionId: 'session-1',
      content: 'hello',
    });

    expect(providerSettingsService.getApiKeyForRuntime).not.toHaveBeenCalled();
    expect(streamChat).toHaveBeenCalledWith(
      expect.objectContaining({ apiKey: undefined }),
    );
  });

  it('derives and persists a session title from the first message when the title is still the default', async () => {
    aiProviderFactory.hasProvider.mockReturnValue(true);
    aiProviderFactory.getProvider.mockReturnValue({
      *streamChat() {
        yield { type: 'done' as const, finishReason: 'stop' as const };
      },
    });
    streamRegistry.register.mockReturnValue(new AbortController());

    await gateway.onChatSend(client, {
      sessionId: 'session-1',
      content: '  how do   I center a div in CSS using flexbox today?  ',
    });

    expect(sessionsService.setTitleIfDefault).toHaveBeenCalledWith(
      'session-1',
      'how do I center a div in CSS using…',
    );
  });

  it('does not touch the title when the session already has a custom title', async () => {
    sessionsService.getOwned.mockResolvedValue({
      title: 'My custom title',
      defaultProvider: 'ollama',
      defaultModel: 'test-model',
    });
    aiProviderFactory.hasProvider.mockReturnValue(true);
    aiProviderFactory.getProvider.mockReturnValue({
      *streamChat() {
        yield { type: 'done' as const, finishReason: 'stop' as const };
      },
    });
    streamRegistry.register.mockReturnValue(new AbortController());

    await gateway.onChatSend(client, {
      sessionId: 'session-1',
      content: 'hello',
    });

    expect(sessionsService.setTitleIfDefault).not.toHaveBeenCalled();
  });

  it('finalizes the assistant message even if the initiating client disconnects mid-stream', async () => {
    aiProviderFactory.hasProvider.mockReturnValue(true);
    const disconnectingClient = {
      data: { userId: 'user-1' },
      connected: true,
    } as unknown as Socket & { connected: boolean };
    aiProviderFactory.getProvider.mockReturnValue({
      *streamChat() {
        yield { type: 'token' as const, delta: 'hello ' };
        // Simulate the socket that initiated the send dropping mid-stream.
        // ChatGateway must not consult `client` again after this point —
        // every emit goes through `this.server.to(room)`, not `client`.
        disconnectingClient.connected = false;
        yield { type: 'token' as const, delta: 'world' };
        yield { type: 'done' as const, finishReason: 'stop' as const };
      },
    });
    streamRegistry.register.mockReturnValue(new AbortController());

    await gateway.onChatSend(disconnectingClient, {
      sessionId: 'session-1',
      content: 'hello',
    });

    expect(disconnectingClient.connected).toBe(false);
    expect(messagesService.finalizeAssistantMessage).toHaveBeenCalledWith(
      'assistant-message',
      'hello world',
      'complete',
      undefined,
    );
    expect(emit).toHaveBeenCalledWith('chat:message:updated', {
      message: {
        id: 'assistant-message',
        content: 'hello world',
        streamingStatus: 'complete',
        errorMessage: undefined,
      },
    });
  });

  it('rejects a missing sessionId before any service is called', async () => {
    await expect(
      validateMessageBody(ChatSendDto, { content: 'hello' }),
    ).rejects.toBeInstanceOf(BadRequestException);

    expect(sessionsService.getOwned).not.toHaveBeenCalled();
  });
});

describe('ChatGateway message payload validation (DTOs)', () => {
  it('accepts a well-formed chat:send payload and transforms it into a ChatSendDto', async () => {
    const dto = await validateMessageBody(ChatSendDto, {
      sessionId: VALID_SESSION_ID,
      content: 'hello there',
    });

    expect(dto).toBeInstanceOf(ChatSendDto);
    expect(dto.sessionId).toBe(VALID_SESSION_ID);
  });

  it('rejects a non-UUID sessionId', async () => {
    await expect(
      validateMessageBody(ChatSendDto, {
        sessionId: 'not-a-uuid',
        content: 'hello',
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('rejects unknown extra fields on the payload', async () => {
    await expect(
      validateMessageBody(ChatSendDto, {
        sessionId: VALID_SESSION_ID,
        content: 'hello',
        isAdmin: true,
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('rejects a model longer than 200 characters', async () => {
    await expect(
      validateMessageBody(ChatSendDto, {
        sessionId: VALID_SESSION_ID,
        content: 'hello',
        model: 'x'.repeat(201),
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('rejects artifact:edit content larger than MAX_ARTIFACT_CONTENT_BYTES', async () => {
    await expect(
      validateMessageBody(ArtifactEditDto, {
        artifactId: VALID_SESSION_ID,
        content: 'a'.repeat(MAX_ARTIFACT_CONTENT_BYTES + 1),
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('accepts artifact:edit content within MAX_ARTIFACT_CONTENT_BYTES', async () => {
    const dto = await validateMessageBody(ArtifactEditDto, {
      artifactId: VALID_SESSION_ID,
      content: 'export const ok = true;',
    });

    expect(dto).toBeInstanceOf(ArtifactEditDto);
  });

  it('rejects session:join without a sessionId', async () => {
    await expect(
      validateMessageBody(SessionJoinDto, {}),
    ).rejects.toBeInstanceOf(BadRequestException);
  });
});

describe('ChatGateway auth is enforced by the gateway itself, independent of the global HTTP guard', () => {
  // Verified against this Nest version (11.1.28), not assumed: @nestjs/websockets'
  // SocketModule builds its GuardsContextCreator/PipesContextCreator with only the
  // module container, never the app's ApplicationConfig (see
  // node_modules/@nestjs/websockets/socket-module.js#getContextCreator). Both
  // context creators' getGlobalMetadata() short-circuits to [] whenever `config`
  // is undefined, so global providers registered via APP_GUARD/useGlobalPipes in
  // main.ts/auth.module.ts (JwtAuthGuard, ThrottlerGuard, the REST ValidationPipe)
  // are never part of the guards/pipes array @SubscribeMessage handlers run
  // through. ChatGateway's auth is therefore entirely self-contained: manual JWT
  // verification in handleConnection() plus each handler calling this.userId(),
  // which throws WsException when client.data.userId was never set. These tests
  // pin that self-contained behavior directly.
  const sessionsService = { getOwned: jest.fn(), touch: jest.fn() };
  const messagesService = { isOwnedByUser: jest.fn() };
  const streamRegistry = { stop: jest.fn() };
  const artifactsService = { getById: jest.fn() };

  const gateway = new ChatGateway(
    {} as never,
    {} as never,
    sessionsService as never,
    messagesService as never,
    {} as never,
    streamRegistry as never,
    artifactsService as never,
    {} as never,
  );

  const unauthenticatedClient = { data: {} } as unknown as Socket;

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('onSessionJoin throws WsException and never calls sessionsService for an unauthenticated socket', async () => {
    await expect(
      gateway.onSessionJoin(unauthenticatedClient, {
        sessionId: VALID_SESSION_ID,
      }),
    ).rejects.toBeInstanceOf(WsException);

    expect(sessionsService.getOwned).not.toHaveBeenCalled();
  });

  it('onChatStop throws WsException and never calls messagesService for an unauthenticated socket', async () => {
    await expect(
      gateway.onChatStop(unauthenticatedClient, {
        messageId: VALID_SESSION_ID,
      }),
    ).rejects.toBeInstanceOf(WsException);

    expect(messagesService.isOwnedByUser).not.toHaveBeenCalled();
  });

  it('onArtifactEdit throws WsException and never calls sessionsService for an unauthenticated socket', async () => {
    artifactsService.getById.mockResolvedValue({
      id: VALID_SESSION_ID,
      sessionId: VALID_SESSION_ID,
    });

    await expect(
      gateway.onArtifactEdit(unauthenticatedClient, {
        artifactId: VALID_SESSION_ID,
        content: 'x',
      }),
    ).rejects.toBeInstanceOf(WsException);

    expect(sessionsService.getOwned).not.toHaveBeenCalled();
  });
});
