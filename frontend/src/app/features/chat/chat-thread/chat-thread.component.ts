import { Component, effect, inject, input, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ChatStore } from '../chat.store';

@Component({
  selector: 'app-chat-thread',
  imports: [FormsModule],
  templateUrl: './chat-thread.component.html',
  styleUrl: './chat-thread.component.scss',
})
export class ChatThreadComponent {
  readonly sessionId = input.required<string>();
  protected readonly chatStore = inject(ChatStore);
  protected draft = signal('');

  constructor() {
    effect(() => {
      const id = this.sessionId();
      void this.chatStore.loadSession(id);
    });
  }

  send() {
    const content = this.draft().trim();
    if (!content) return;
    this.chatStore.sendMessage(content);
    this.draft.set('');
  }

  stop(messageId: string) {
    this.chatStore.stopGeneration(messageId);
  }
}
