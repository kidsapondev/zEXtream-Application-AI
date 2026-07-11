import { ApplicationRef } from '@angular/core';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import type { ProviderSettingDto } from '@app/shared-types';
import { ProviderCatalogStore } from './provider-catalog.store';
import { AuthStore } from '../../core/auth.store';
import { SocketService } from '../../core/socket.service';

function setting(overrides: Partial<ProviderSettingDto> = {}): ProviderSettingDto {
  return {
    provider: 'ollama',
    requiresApiKey: false,
    configured: true,
    updatedAt: null,
    models: [],
    ...overrides,
  };
}

describe('ProviderCatalogStore', () => {
  const socketService = { connect: vi.fn(() => ({ on: vi.fn(), emit: vi.fn() })), disconnect: vi.fn() };

  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [
        ProviderCatalogStore,
        { provide: SocketService, useValue: socketService },
        provideHttpClient(),
        provideHttpClientTesting(),
      ],
    });
  });

  afterEach(() => {
    TestBed.inject(HttpTestingController).verify();
    TestBed.resetTestingModule();
  });

  it('does not fetch providers while unauthenticated', () => {
    TestBed.inject(ProviderCatalogStore);
    const http = TestBed.inject(HttpTestingController);

    http.expectNone('/api/settings/providers');
  });

  it('filters the catalog down to only configured providers once loaded', async () => {
    TestBed.inject(AuthStore).accessToken.set('token');
    const store = TestBed.inject(ProviderCatalogStore);
    const http = TestBed.inject(HttpTestingController);

    // The httpResource's internal effect dispatches the request asynchronously
    // rather than synchronously — awaiting `whenStable()` here (before the
    // request is flushed) would hang forever since the pending HTTP call
    // itself keeps the app from ever reaching stability.
    await new Promise((resolve) => setTimeout(resolve, 0));

    http.expectOne('/api/settings/providers').flush([
      setting({ provider: 'ollama', requiresApiKey: false, configured: true }),
      setting({ provider: 'claude', requiresApiKey: true, configured: true, models: ['claude-sonnet-5'] }),
      setting({ provider: 'openai', requiresApiKey: true, configured: false, models: ['gpt-5.1'] }),
    ]);
    await TestBed.inject(ApplicationRef).whenStable();

    expect(store.providers()).toHaveLength(3);
    expect(store.configuredProviders().map((p) => p.provider)).toEqual(['ollama', 'claude']);
  });
});
