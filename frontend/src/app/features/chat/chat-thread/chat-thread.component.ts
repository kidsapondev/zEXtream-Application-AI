import {
  Component,
  ElementRef,
  afterRenderEffect,
  effect,
  inject,
  input,
  signal,
  viewChild,
} from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ChatStore } from '../chat.store';

@Component({
  selector: 'app-chat-thread',
  imports: [FormsModule],
  templateUrl: './chat-thread.component.html',
  styleUrl: './chat-thread.component.scss',
})
export class ChatThreadComponent {
  /** How close to the bottom (in px) counts as "already at the bottom" for auto-scroll purposes. */
  private static readonly STICK_TO_BOTTOM_THRESHOLD_PX = 96;

  readonly sessionId = input.required<string>();
  protected readonly chatStore = inject(ChatStore);
  protected draft = signal('');

  private readonly messagesEl = viewChild<ElementRef<HTMLDivElement>>('messagesEl');
  /** Whether the user was scrolled near the bottom before the last update — new messages only auto-scroll if so. */
  private stickToBottom = true;

  constructor() {
    effect(() => {
      const id = this.sessionId();
      this.stickToBottom = true;
      void this.chatStore.loadSession(id);
    });

    afterRenderEffect(() => {
      this.chatStore.messages();
      const el = this.messagesEl()?.nativeElement;
      if (!el || !this.stickToBottom) return;
      el.scrollTop = el.scrollHeight;
    });
  }

  onMessagesScroll(event: Event): void {
    const el = event.target as HTMLDivElement;
    const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    this.stickToBottom = distanceFromBottom < ChatThreadComponent.STICK_TO_BOTTOM_THRESHOLD_PX;
  }

  send() {
    const content = this.draft().trim();
    if (!content || this.chatStore.isStreaming()) return;
    this.chatStore.sendMessage(content);
    this.draft.set('');
  }

  stop(messageId: string) {
    this.chatStore.stopGeneration(messageId);
  }
}
