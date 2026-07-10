import { HttpClient } from '@angular/common/http';
import { Component, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Router, RouterLink } from '@angular/router';
import type { ProviderSettingDto } from '@app/shared-types';
import { firstValueFrom } from 'rxjs';
import { AppShellComponent } from '../../design-system/app-shell/app-shell.component';
import { PageHeaderComponent } from '../../design-system/page-header/page-header.component';
import { HairlineCardComponent } from '../../design-system/hairline-card/hairline-card.component';
import { BadgePillComponent } from '../../design-system/badge-pill/badge-pill.component';
import { AuthStore } from '../../core/auth.store';
import { SessionListStore } from '../chat/session-list.store';

@Component({
  selector: 'app-provider-settings',
  imports: [
    FormsModule,
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
  readonly apiKeys = signal<Record<string, string>>({});
  readonly loading = signal(true);
  readonly savingProvider = signal<string | null>(null);
  readonly error = signal<string | null>(null);

  constructor() {
    void this.load();
  }

  async onNewChat() {
    const session = await this.sessionListStore.createSession('ollama', 'qwen2.5-coder:14b');
    await this.router.navigate(['/chat', session.id]);
  }

  async onLogout() {
    await this.authStore.logout();
    await this.router.navigateByUrl('/login');
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

  keyFor(provider: string): string {
    return this.apiKeys()[provider] ?? '';
  }

  setKey(provider: string, value: string): void {
    this.apiKeys.update((keys) => ({ ...keys, [provider]: value }));
  }

  async save(setting: ProviderSettingDto): Promise<void> {
    const apiKey = this.keyFor(setting.provider).trim();
    if (!apiKey) return;
    this.savingProvider.set(setting.provider);
    this.error.set(null);
    try {
      await firstValueFrom(
        this.http.put(`/api/settings/providers/${setting.provider}`, { apiKey }),
      );
      this.setKey(setting.provider, '');
      await this.load();
    } catch {
      this.error.set(`Could not save ${setting.provider} credentials.`);
    } finally {
      this.savingProvider.set(null);
    }
  }

  async remove(setting: ProviderSettingDto): Promise<void> {
    this.savingProvider.set(setting.provider);
    this.error.set(null);
    try {
      await firstValueFrom(this.http.delete(`/api/settings/providers/${setting.provider}`));
      await this.load();
    } catch {
      this.error.set(`Could not remove ${setting.provider} credentials.`);
    } finally {
      this.savingProvider.set(null);
    }
  }
}
