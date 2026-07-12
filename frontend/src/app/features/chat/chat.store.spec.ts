import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import type { ChatMessageDto } from '@app/shared-types';
import { ChatStore } from './chat.store';
import { SocketService } from '../../core/socket.service';
import { ToastService } from '../../core/toast.service';

describe('ChatStore', () => {
  const handlers = new Map<string, (payload: unknown) => void>();
  const socket = {
    on: vi.fn((event: string, cb: (payload: unknown) => void) => handlers.set(event, cb)),
    emit: vi.fn(),
  };
  const socketService = {
    connect: vi.fn(() => socket),
    instance: socket,
  };
  const toastService = { show: vi.fn() };

  function emit(event: string, payload: unknown): void {
    handlers.get(event)?.(payload);
  }

  function message(overrides: Partial<ChatMessageDto> = {}): ChatMessageDto {
    return {
      id: 'message-1',
      sessionId: 'session-1',
      role: 'assistant',
      content: 'hello',
      provider: 'ollama',
      model: 'qwen2.5-coder:14b',
      streamingStatus: 'complete',
      errorMessage: null,
      tokenCount: null,
      createdAt: new Date().toISOString(),
      ...overrides,
    };
  }

  beforeEach(() => {
    handlers.clear();
    vi.clearAllMocks();
    TestBed.configureTestingModule({
      providers: [
        ChatStore,
        { provide: SocketService, useValue: socketService },
        { provide: ToastService, useValue: toastService },
        provideHttpClient(),
        provideHttpClientTesting(),
      ],
    });
  });

  afterEach(() => {
    TestBed.resetTestingModule();
  });

  async function loadInitial(
    service: ChatStore,
    http: HttpTestingController,
    sessionId = 'session-1',
    history: ChatMessageDto[] = [],
  ): Promise<void> {
    const loading = service.loadSession(sessionId);
    http.expectOne(`/api/chat/sessions/${sessionId}/messages`).flush(history);
    await loading;
  }

  it('ignores a stale HTTP history response from a previous session', async () => {
    const service = TestBed.inject(ChatStore);
    const http = TestBed.inject(HttpTestingController);

    const first = service.loadSession('session-1');
    const firstRequest = http.expectOne('/api/chat/sessions/session-1/messages');
    const second = service.loadSession('session-2');
    const secondRequest = http.expectOne('/api/chat/sessions/session-2/messages');

    secondRequest.flush([message({ id: 'm2', sessionId: 'session-2' })]);
    firstRequest.flush([message({ id: 'm1', sessionId: 'session-1' })]);
    await Promise.all([first, second]);

    expect(service.currentSessionId()).toBe('session-2');
    expect(service.messages().map((m) => m.id)).toEqual(['m2']);
  });

  it('surfaces a load failure without touching a session switched to in the meantime', async () => {
    const service = TestBed.inject(ChatStore);
    const http = TestBed.inject(HttpTestingController);

    const first = service.loadSession('session-1');
    const firstRequest = http.expectOne('/api/chat/sessions/session-1/messages');
    const second = service.loadSession('session-2');
    const secondRequest = http.expectOne('/api/chat/sessions/session-2/messages');

    secondRequest.flush([message({ id: 'm2', sessionId: 'session-2' })]);
    firstRequest.flush('boom', { status: 500, statusText: 'Server Error' });
    await Promise.all([first, second]);

    expect(service.historyError()).toBeNull();
    expect(service.messages().map((m) => m.id)).toEqual(['m2']);
  });

  it('deduplicates a message that arrives via socket after already being loaded via REST', async () => {
    const service = TestBed.inject(ChatStore);
    const http = TestBed.inject(HttpTestingController);
    await loadInitial(service, http, 'session-1', [message()]);

    emit('chat:message:updated', { message: message({ content: 'hello, updated' }) });

    expect(service.messages()).toHaveLength(1);
    expect(service.messages()[0].content).toBe('hello, updated');
  });

  it('does not duplicate when a created event arrives for a message already in history', async () => {
    const service = TestBed.inject(ChatStore);
    const http = TestBed.inject(HttpTestingController);
    await loadInitial(service, http, 'session-1', [message()]);

    emit('chat:message:created', { message: message() });

    expect(service.messages()).toHaveLength(1);
  });

  it('reports loading state while the history request is in flight', async () => {
    const service = TestBed.inject(ChatStore);
    const http = TestBed.inject(HttpTestingController);

    const loading = service.loadSession('session-1');
    expect(service.isLoadingHistory()).toBe(true);

    http.expectOne('/api/chat/sessions/session-1/messages').flush([]);
    await loading;

    expect(service.isLoadingHistory()).toBe(false);
  });

  it('blocks sending a new message while one is still streaming, but allows stop', async () => {
    const service = TestBed.inject(ChatStore);
    const http = TestBed.inject(HttpTestingController);
    await loadInitial(service, http);
    socket.emit.mockClear();

    emit('chat:message:created', { message: message({ streamingStatus: 'streaming' }) });
    expect(service.isStreaming()).toBe(true);

    service.sendMessage('another message');
    expect(socket.emit).not.toHaveBeenCalledWith('chat:send', expect.anything());

    service.stopGeneration('message-1');
    expect(socket.emit).toHaveBeenCalledWith('chat:stop', { messageId: 'message-1' });
  });

  it('surfaces a WebSocket exception as an error toast', () => {
    TestBed.inject(ChatStore);

    emit('exception', { status: 'error', message: 'AI provider "claude" is not enabled' });

    expect(toastService.show).toHaveBeenCalledWith('AI provider "claude" is not enabled', 'error');
  });

  it('joins array-valued exception messages before toasting them', () => {
    TestBed.inject(ChatStore);

    emit('exception', { message: ['content must be shorter', 'model is required'] });

    expect(toastService.show).toHaveBeenCalledWith(
      'content must be shorter, model is required',
      'error',
    );
  });
});
