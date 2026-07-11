import { Injectable, computed, inject } from '@angular/core';
import { HttpClient, httpResource } from '@angular/common/http';
import type { ProviderSettingDto } from '@app/shared-types';
import { AuthStore } from '../../core/auth.store';

/**
 * Read-only view of `/api/settings/providers`, shared by the new-chat/model
 * selector and (indirectly, by having the same shape) the provider settings
 * page. Kept separate from `ProviderSettingsComponent`'s own fetch/save flow
 * on purpose — that component owns save/remove mutations and its own error
 * banner; this store only needs the list to decide what a user is allowed to
 * pick when creating a chat session.
 */
@Injectable({ providedIn: 'root' })
export class ProviderCatalogStore {
  private readonly http = inject(HttpClient);
  private readonly authStore = inject(AuthStore);

  private readonly settingsResource = httpResource<ProviderSettingDto[]>(() =>
    this.authStore.isAuthenticated() ? '/api/settings/providers' : undefined,
  );

  readonly providers = computed(() => this.settingsResource.value() ?? []);
  readonly isLoading = this.settingsResource.isLoading;

  /** Providers the current user can actually start a session with right now. */
  readonly configuredProviders = computed(() => this.providers().filter((p) => p.configured));

  reload(): void {
    this.settingsResource.reload();
  }
}
