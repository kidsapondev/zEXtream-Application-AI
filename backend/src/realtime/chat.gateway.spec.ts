import { Socket } from 'socket.io';
import { WsException } from '@nestjs/websockets';
import { ChatGateway } from './chat.gateway';
import { MAX_ARTIFACT_CONTENT_BYTES } from '../artifacts/artifacts.service';

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
  };
  const artifactsService = {
    createRevision: jest.fn(),
    listLatestForSession: jest.fn(),
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
  );

  gateway.server = { to: jest.fn(() => ({ emit })) } as never;

  beforeEach(() => {
    jest.clearAllMocks();
    sessionsService.getOwned.mockResolvedValue({
      defaultProvider: 'ollama',
      defaultModel: 'test-model',
    });
    sessionsService.touch.mockResolvedValue(undefined);
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
});
