import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { SessionListStore } from './session-list.store';

describe('SessionListStore', () => {
  beforeEach(() => {
    // `AuthStore.isAuthenticated()` defaults to false (no token set), so the
    // underlying `httpResource` never issues its own GET — these tests only
    // exercise the explicit CRUD methods below.
    TestBed.configureTestingModule({
      providers: [SessionListStore, provideHttpClient(), provideHttpClientTesting()],
    });
  });

  afterEach(() => {
    TestBed.inject(HttpTestingController).verify();
    TestBed.resetTestingModule();
  });

  it('renames a session with a PATCH request', async () => {
    const store = TestBed.inject(SessionListStore);
    const http = TestBed.inject(HttpTestingController);

    const renaming = store.renameSession('session-1', 'New title');
    const req = http.expectOne('/api/chat/sessions/session-1');
    expect(req.request.method).toBe('PATCH');
    expect(req.request.body).toEqual({ title: 'New title' });
    req.flush({});

    await renaming;
  });

  it('archives a session by setting isArchived on the same update endpoint', async () => {
    const store = TestBed.inject(SessionListStore);
    const http = TestBed.inject(HttpTestingController);

    const archiving = store.archiveSession('session-1');
    const req = http.expectOne('/api/chat/sessions/session-1');
    expect(req.request.method).toBe('PATCH');
    expect(req.request.body).toEqual({ isArchived: true });
    req.flush({});

    await archiving;
  });

  it('updates a session provider and model with the same PATCH endpoint', async () => {
    const store = TestBed.inject(SessionListStore);
    const http = TestBed.inject(HttpTestingController);

    const updating = store.updateProviderAndModel('session-1', 'openai', 'gpt-5.1');
    const req = http.expectOne('/api/chat/sessions/session-1');
    expect(req.request.method).toBe('PATCH');
    expect(req.request.body).toEqual({
      defaultProvider: 'openai',
      defaultModel: 'gpt-5.1',
    });
    req.flush({});

    await updating;
  });

  it('deletes a session with a DELETE request', async () => {
    const store = TestBed.inject(SessionListStore);
    const http = TestBed.inject(HttpTestingController);

    const deleting = store.deleteSession('session-1');
    const req = http.expectOne('/api/chat/sessions/session-1');
    expect(req.request.method).toBe('DELETE');
    req.flush({});

    await deleting;
  });

  it('creates a session with the given provider and model', async () => {
    const store = TestBed.inject(SessionListStore);
    const http = TestBed.inject(HttpTestingController);

    const creating = store.createSession('ollama', 'qwen2.5-coder:14b');
    const req = http.expectOne('/api/chat/sessions');
    expect(req.request.method).toBe('POST');
    expect(req.request.body).toEqual({
      defaultProvider: 'ollama',
      defaultModel: 'qwen2.5-coder:14b',
    });
    req.flush({ id: 'session-1' });

    await creating;
  });
});
