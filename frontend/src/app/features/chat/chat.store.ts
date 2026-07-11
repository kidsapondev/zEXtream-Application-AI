import { Injectable, computed, inject, signal } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { firstValueFrom } from 'rxjs';
import type { AiProviderKey, ChatMessageDto } from '@app/shared-types';
import { SocketService } from '../../core/socket.service';
import { ToastService } from '../../core/toast.service';

@Injectable({ providedIn: 'root' })
export class ChatStore {
  private readonly http = inject(HttpClient);
  private readonly socketService = inject(SocketService);
  private readonly toastService = inject(ToastService);

  readonly messages = signal<ChatMessageDto[]>([]);
  readonly currentSessionId = signal<string | null>(null);
  readonly isLoadingHistory = signal(false);
  readonly historyError = signal<string | null>(null);

  /** True while any message in the current session is still being generated. */
  readonly isStreaming = computed(() =>
    this.messages().some((message) => message.streamingStatus === 'streaming'),
  );

  /** Guards against a stale `loadSession` HTTP response overwriting a session switched to since. */
  private loadGeneration = 0;

  constructor() {
    const socket = this.socketService.connect();

    socket.on('chat:message:created', ({ message }: { message: ChatMessageDto }) => {
      if (message.sessionId !== this.currentSessionId()) return;
      this.upsertMessage(message);
    });

    socket.on('chat:token', ({ messageId, delta }: { messageId: string; delta: string }) => {
      this.messages.update((list) =>
        list.map((m) => (m.id === messageId ? { ...m, content: m.content + delta } : m)),
      );
    });

    socket.on('chat:message:updated', ({ message }: { message: ChatMessageDto }) => {
      this.upsertMessage(message);
    });

    // Gateway-level failures (e.g. rejected before any message was ever created —
    // no API key configured, provider not enabled, a stream already in progress)
    // arrive as a bare WsException with no associated message, so they only
    // ever surface here rather than through a message's `errorMessage`.
    socket.on('exception', (payload: { status?: string; message?: string | string[] }) => {
      const raw = payload?.message;
      const text = Array.isArray(raw) ? raw.join(', ') : raw;
      this.toastService.show(text || 'Something went wrong. Please try again.', 'error');
    });
  }

  async loadSession(sessionId: string): Promise<void> {
    const generation = ++this.loadGeneration;
    const previous = this.currentSessionId();
    if (previous && previous !== sessionId) {
      this.socketService.instance.emit('session:leave', { sessionId: previous });
    }

    this.messages.set([]);
    this.currentSessionId.set(sessionId);
    this.historyError.set(null);
    this.isLoadingHistory.set(true);
    this.socketService.instance.emit('session:join', { sessionId });

    try {
      const history = await firstValueFrom(
        this.http.get<ChatMessageDto[]>(`/api/chat/sessions/${sessionId}/messages`),
      );
      // A later loadSession() call (or navigating away) may have already
      // moved us on — discard this response rather than clobber newer state.
      if (generation !== this.loadGeneration || this.currentSessionId() !== sessionId) return;
      this.messages.set(history);
    } catch {
      if (generation === this.loadGeneration && this.currentSessionId() === sessionId) {
        this.historyError.set('Could not load this conversation.');
      }
    } finally {
      if (generation === this.loadGeneration) this.isLoadingHistory.set(false);
    }
  }

  sendMessage(content: string, provider?: AiProviderKey, model?: string): void {
    const sessionId = this.currentSessionId();
    if (!sessionId || !content.trim() || this.isStreaming()) return;
    this.socketService.instance.emit('chat:send', { sessionId, content, provider, model });
  }

  stopGeneration(messageId: string): void {
    this.socketService.instance.emit('chat:stop', { messageId });
  }

  /** Inserts or replaces a message by id — keys REST history and socket events off the same identity. */
  private upsertMessage(message: ChatMessageDto): void {
    this.messages.update((list) => {
      const index = list.findIndex((m) => m.id === message.id);
      if (index === -1) return [...list, message];
      const next = list.slice();
      next[index] = message;
      return next;
    });
  }
}
