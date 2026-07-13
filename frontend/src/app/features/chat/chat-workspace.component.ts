import { Component, computed, effect, inject, input, signal } from '@angular/core';
import { HttpErrorResponse } from '@angular/common/http';
import { Router } from '@angular/router';
import type { AiProviderKey, ChatSessionDto } from '@app/shared-types';
import { AppShellComponent } from '../../design-system/app-shell/app-shell.component';
import { AuthStore } from '../../core/auth.store';
import { SocketService } from '../../core/socket.service';
import { ToastService } from '../../core/toast.service';
import { SessionListStore } from './session-list.store';
import { ProviderCatalogStore } from './provider-catalog.store';
import { SessionListItemComponent } from './session-list-item/session-list-item.component';
import { ChatThreadComponent } from './chat-thread/chat-thread.component';
import { NewSessionDialogComponent } from './new-session-dialog/new-session-dialog.component';
import { ArtifactStore } from '../code-editor/artifact.store';
import { CodeEditorPanelComponent } from '../code-editor/code-editor-panel.component';

@Component({
  selector: 'app-chat-workspace',
  imports: [
    AppShellComponent,
    SessionListItemComponent,
    ChatThreadComponent,
    CodeEditorPanelComponent,
    NewSessionDialogComponent,
  ],
  templateUrl: './chat-workspace.component.html',
  styleUrl: './chat-workspace.component.scss',
})
export class ChatWorkspaceComponent {
  readonly sessionId = input<string | undefined>(undefined);

  protected readonly authStore = inject(AuthStore);
  protected readonly sessionListStore = inject(SessionListStore);
  protected readonly providerCatalogStore = inject(ProviderCatalogStore);
  protected readonly artifactStore = inject(ArtifactStore);
  protected readonly socketService = inject(SocketService);
  private readonly toastService = inject(ToastService);
  private readonly router = inject(Router);

  protected readonly showNewSessionDialog = signal(false);
  protected readonly sessionBeingReconfigured = signal<ChatSessionDto | null>(null);

  /** The full session record for the currently open chat — used to show its
   * provider/model in the chat header and to seed the "switch model" dialog. */
  protected readonly currentSession = computed(() =>
    this.sessionListStore.sessions().find((s) => s.id === this.sessionId()),
  );

  constructor() {
    effect(() => {
      const id = this.sessionId();
      if (id) void this.artifactStore.loadSession(id);
    });
  }

  /**
   * If exactly one provider is currently usable, there's no real choice to
   * make — skip the dialog and create the session immediately (with that
   * provider's first live model, e.g. Ollama's `models` from `/api/tags`)
   * to keep "+" a single click for the common case. Once more than one
   * provider is available, "+" opens the picker so the user can choose.
   */
  async onNewChat() {
    const configured = this.providerCatalogStore.configuredProviders();
    if (configured.length === 0) {
      this.toastService.show('No AI provider is currently available.', 'error');
      return;
    }
    if (configured.length === 1) {
      const [only] = configured;
      await this.createSession(only.provider, only.models[0]);
      return;
    }
    this.showNewSessionDialog.set(true);
  }

  async onCreateSession(choice: { provider: AiProviderKey; model: string }) {
    const session = this.sessionBeingReconfigured();
    if (session) {
      try {
        await this.sessionListStore.updateProviderAndModel(
          session.id,
          choice.provider,
          choice.model,
        );
        this.toastService.show('Chat provider updated.', 'success');
        this.onCancelNewSession();
      } catch (err) {
        const message =
          err instanceof HttpErrorResponse && typeof err.error?.message === 'string'
            ? err.error.message
            : 'Could not update this chat provider. Please try again.';
        this.toastService.show(message, 'error');
      }
      return;
    }
    await this.createSession(choice.provider, choice.model);
  }

  onCancelNewSession() {
    this.showNewSessionDialog.set(false);
    this.sessionBeingReconfigured.set(null);
  }

  onChangeSessionProvider(session: ChatSessionDto): void {
    this.sessionBeingReconfigured.set(session);
    this.showNewSessionDialog.set(true);
  }

  private async createSession(provider: AiProviderKey, model: string) {
    try {
      const session = await this.sessionListStore.createSession(provider, model);
      this.showNewSessionDialog.set(false);
      await this.router.navigate(['/chat', session.id]);
    } catch (err) {
      // The backend rejects claude/openai session creation with a clear
      // BadRequestException message (e.g. "Configure an API key for claude
      // before starting a session with it") when the user's key is missing
      // or was removed since the picker loaded stale `configured` state.
      const message =
        err instanceof HttpErrorResponse && typeof err.error?.message === 'string'
          ? err.error.message
          : 'Could not start a new chat. Please try again.';
      this.toastService.show(message, 'error');
    }
  }

  async onSettings() {
    await this.router.navigateByUrl('/settings/providers');
  }

  async onAdmin() {
    await this.router.navigateByUrl('/admin');
  }

  async onLogout() {
    await this.authStore.logout();
    await this.router.navigateByUrl('/login');
  }

  protected providerLabel(provider: AiProviderKey): string {
    switch (provider) {
      case 'ollama':
        return 'Ollama';
      case 'claude':
        return 'Claude';
      case 'openai':
        return 'OpenAI';
    }
  }
}
