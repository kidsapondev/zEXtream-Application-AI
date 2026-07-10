import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import type { CodeArtifactDto } from '@app/shared-types';
import { ArtifactStore } from './artifact.store';
import { SocketService } from '../../core/socket.service';

describe('ArtifactStore', () => {
  const socket = {
    on: vi.fn(),
    emit: vi.fn(),
  };
  const socketService = {
    connect: vi.fn(() => socket),
    instance: socket,
  };

  const artifact: CodeArtifactDto = {
    id: 'artifact-1',
    messageId: 'message-1',
    sessionId: 'session-1',
    filename: 'main.ts',
    language: 'typescript',
    content: 'one',
    revision: 1,
    parentArtifactId: null,
    origin: 'ai',
    createdAt: new Date().toISOString(),
  };

  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    TestBed.configureTestingModule({
      providers: [
        ArtifactStore,
        { provide: SocketService, useValue: socketService },
        provideHttpClient(),
        provideHttpClientTesting(),
      ],
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    TestBed.resetTestingModule();
  });

  async function loadInitial(service: ArtifactStore, http: HttpTestingController): Promise<void> {
    const loading = service.loadSession('session-1');
    http.expectOne('/api/chat/sessions/session-1/artifacts').flush([artifact]);
    await loading;
  }

  it('debounces editor changes into one save with the latest content', async () => {
    const service = TestBed.inject(ArtifactStore);
    const http = TestBed.inject(HttpTestingController);
    await loadInitial(service, http);

    service.editContent('main.ts', 'two');
    service.editContent('main.ts', 'three');
    vi.advanceTimersByTime(499);
    expect(socket.emit).not.toHaveBeenCalled();

    vi.advanceTimersByTime(1);

    expect(socket.emit).toHaveBeenCalledWith('artifact:edit', {
      artifactId: 'artifact-1',
      content: 'three',
    });
  });

  it('flushes a pending edit immediately when explicitly saved', async () => {
    const service = TestBed.inject(ArtifactStore);
    const http = TestBed.inject(HttpTestingController);
    await loadInitial(service, http);

    service.editContent('main.ts', 'saved-now');
    service.saveContent('main.ts');

    expect(socket.emit).toHaveBeenCalledWith('artifact:edit', {
      artifactId: 'artifact-1',
      content: 'saved-now',
    });
  });

  it('ignores a stale HTTP response from a previous session', async () => {
    const service = TestBed.inject(ArtifactStore);
    const http = TestBed.inject(HttpTestingController);
    const first = service.loadSession('session-1');
    const firstRequest = http.expectOne('/api/chat/sessions/session-1/artifacts');
    const second = service.loadSession('session-2');
    const secondRequest = http.expectOne('/api/chat/sessions/session-2/artifacts');

    secondRequest.flush([]);
    firstRequest.flush([artifact]);
    await Promise.all([first, second]);

    expect(service.currentSessionId()).toBe('session-2');
    expect(service.files()).toEqual([]);
  });
});
