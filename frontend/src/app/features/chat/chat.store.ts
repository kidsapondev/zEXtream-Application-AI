import { Injectable, inject, signal } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { firstValueFrom } from 'rxjs';
import type { AiProviderKey, ChatMessageDto } from '@app/shared-types';
import { SocketService } from '../../core/socket.service';

@Injectable({ providedIn: 'root' })
export class ChatStore {
  private readonly http = inject(HttpClient);
  private readonly socketService = inject(SocketService);

  readonly messages = signal<ChatMessageDto[]>([]);
  readonly currentSessionId = signal<string | null>(null);

  constructor() {
    const socket = this.socketService.connect();

    socket.on('chat:message:created', ({ message }: { message: ChatMessageDto }) => {
      if (message.sessionId !== this.currentSessionId()) return;
      this.messages.update((list) => [...list, message]);
    });

    socket.on('chat:token', ({ messageId, delta }: { messageId: string; delta: string }) => {
      this.messages.update((list) =>
        list.map((m) => (m.id === messageId ? { ...m, content: m.content + delta } : m)),
      );
    });

    socket.on('chat:message:updated', ({ message }: { message: ChatMessageDto }) => {
      this.messages.update((list) => list.map((m) => (m.id === message.id ? message : m)));
    });
  }

  async loadSession(sessionId: string): Promise<void> {
    const previous = this.currentSessionId();
    if (previous && previous !== sessionId) {
      this.socketService.instance.emit('session:leave', { sessionId: previous });
    }
    this.messages.set([]);
    this.currentSessionId.set(sessionId);
    this.socketService.instance.emit('session:join', { sessionId });

    const history = await firstValueFrom(
      this.http.get<ChatMessageDto[]>(`/api/chat/sessions/${sessionId}/messages`),
    );
    this.messages.set(history);
  }

  sendMessage(content: string, provider?: AiProviderKey, model?: string): void {
    const sessionId = this.currentSessionId();
    if (!sessionId || !content.trim()) return;
    this.socketService.instance.emit('chat:send', { sessionId, content, provider, model });
  }

  stopGeneration(messageId: string): void {
    this.socketService.instance.emit('chat:stop', { messageId });
  }
}
