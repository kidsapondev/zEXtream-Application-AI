import { Injectable, computed, inject } from '@angular/core';
import { HttpClient, httpResource } from '@angular/common/http';
import { firstValueFrom } from 'rxjs';
import type { AiProviderKey, ChatSessionDto } from '@app/shared-types';
import { AuthStore } from '../../core/auth.store';

@Injectable({ providedIn: 'root' })
export class SessionListStore {
  private readonly http = inject(HttpClient);
  private readonly authStore = inject(AuthStore);

  private readonly sessionsResource = httpResource<ChatSessionDto[]>(() =>
    this.authStore.isAuthenticated() ? '/api/chat/sessions' : undefined,
  );

  readonly sessions = computed(() => this.sessionsResource.value() ?? []);
  readonly isLoading = this.sessionsResource.isLoading;

  async createSession(
    defaultProvider: AiProviderKey,
    defaultModel: string,
  ): Promise<ChatSessionDto> {
    const session = await firstValueFrom(
      this.http.post<ChatSessionDto>('/api/chat/sessions', { defaultProvider, defaultModel }),
    );
    this.sessionsResource.reload();
    return session;
  }

  async renameSession(id: string, title: string): Promise<void> {
    await firstValueFrom(this.http.patch(`/api/chat/sessions/${id}`, { title }));
    this.sessionsResource.reload();
  }

  /** Archiving a session hides it from `listForUser()` — the REST layer already filters `isArchived: false`. */
  async archiveSession(id: string): Promise<void> {
    await firstValueFrom(this.http.patch(`/api/chat/sessions/${id}`, { isArchived: true }));
    this.sessionsResource.reload();
  }

  async updateProviderAndModel(
    id: string,
    defaultProvider: AiProviderKey,
    defaultModel: string,
  ): Promise<void> {
    await firstValueFrom(
      this.http.patch(`/api/chat/sessions/${id}`, {
        defaultProvider,
        defaultModel,
      }),
    );
    this.sessionsResource.reload();
  }

  async deleteSession(id: string): Promise<void> {
    await firstValueFrom(this.http.delete(`/api/chat/sessions/${id}`));
    this.sessionsResource.reload();
  }

  touchLocalOrder() {
    this.sessionsResource.reload();
  }
}
