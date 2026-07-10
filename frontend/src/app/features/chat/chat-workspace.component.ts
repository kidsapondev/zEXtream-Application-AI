import { Component, effect, inject, input } from '@angular/core';
import { Router, RouterLink } from '@angular/router';
import { AppShellComponent } from '../../design-system/app-shell/app-shell.component';
import { AuthStore } from '../../core/auth.store';
import { SessionListStore } from './session-list.store';
import { ChatThreadComponent } from './chat-thread/chat-thread.component';
import { ArtifactStore } from '../code-editor/artifact.store';
import { CodeEditorPanelComponent } from '../code-editor/code-editor-panel.component';

@Component({
  selector: 'app-chat-workspace',
  imports: [AppShellComponent, RouterLink, ChatThreadComponent, CodeEditorPanelComponent],
  templateUrl: './chat-workspace.component.html',
  styleUrl: './chat-workspace.component.scss',
})
export class ChatWorkspaceComponent {
  readonly sessionId = input<string | undefined>(undefined);

  protected readonly authStore = inject(AuthStore);
  protected readonly sessionListStore = inject(SessionListStore);
  protected readonly artifactStore = inject(ArtifactStore);
  private readonly router = inject(Router);

  constructor() {
    effect(() => {
      const id = this.sessionId();
      if (id) void this.artifactStore.loadSession(id);
    });
  }

  async onNewChat() {
    const session = await this.sessionListStore.createSession('ollama', 'qwen2.5-coder:14b');
    await this.router.navigate(['/chat', session.id]);
  }

  async onSettings() {
    await this.router.navigateByUrl('/settings/providers');
  }

  async onLogout() {
    await this.authStore.logout();
    await this.router.navigateByUrl('/login');
  }
}
