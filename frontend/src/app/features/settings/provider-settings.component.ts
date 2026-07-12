import { HttpClient } from '@angular/common/http';
import { Component, inject, signal } from '@angular/core';
import { Router, RouterLink } from '@angular/router';
import type { ProviderSettingDto } from '@app/shared-types';
import { firstValueFrom } from 'rxjs';
import { AppShellComponent } from '../../design-system/app-shell/app-shell.component';
import { PageHeaderComponent } from '../../design-system/page-header/page-header.component';
import { HairlineCardComponent } from '../../design-system/hairline-card/hairline-card.component';
import { BadgePillComponent } from '../../design-system/badge-pill/badge-pill.component';
import { AuthStore } from '../../core/auth.store';
import { SessionListStore } from '../chat/session-list.store';

const DEFAULT_OLLAMA_MODEL = 'qwen2.5-coder:14b';

/**
 * claude/openai no longer take a per-user API key (see backend
 * ProviderSettingsService's doc comment) — both are gated by a server-wide
 * "host-bridge" that spawns this server's already-logged-in claude/codex CLIs. This
 * page is now read-only status display for all three providers, not a
 * save/remove/test-key form.
 */
@Component({
  selector: 'app-provider-settings',
  imports: [
    RouterLink,
    AppShellComponent,
    PageHeaderComponent,
    HairlineCardComponent,
    BadgePillComponent,
  ],
  templateUrl: './provider-settings.component.html',
  styleUrl: './provider-settings.component.scss',
})
export class ProviderSettingsComponent {
  private readonly http = inject(HttpClient);
  private readonly router = inject(Router);
  protected readonly authStore = inject(AuthStore);
  private readonly sessionListStore = inject(SessionListStore);

  readonly settings = signal<ProviderSettingDto[]>([]);
  readonly loading = signal(true);
  readonly error = signal<string | null>(null);

  constructor() {
    void this.load();
  }

  /**
   * Mirrors the same "skip the picker when there's no real choice" rule as
   * `ChatWorkspaceComponent.onNewChat()`. This page doesn't host the
   * provider/model dialog itself (it's a chat-workspace concern), so once
   * more than Ollama is configured, "+" just lands on `/chat` where the
   * dialog is available instead of guessing a provider here.
   */
  async onNewChat() {
    const configuredCount = this.settings().filter((s) => s.configured).length;
    if (configuredCount <= 1) {
      const session = await this.sessionListStore.createSession('ollama', DEFAULT_OLLAMA_MODEL);
      await this.router.navigate(['/chat', session.id]);
      return;
    }
    await this.router.navigateByUrl('/chat');
  }

  async onLogout() {
    await this.authStore.logout();
    await this.router.navigateByUrl('/login');
  }

  async onAdmin() {
    await this.router.navigateByUrl('/admin');
  }

  async load(): Promise<void> {
    this.loading.set(true);
    this.error.set(null);
    try {
      const settings = await firstValueFrom(
        this.http.get<ProviderSettingDto[]>('/api/settings/providers'),
      );
      this.settings.set(settings);
    } catch {
      this.error.set('Could not load provider settings.');
    } finally {
      this.loading.set(false);
    }
  }
}
