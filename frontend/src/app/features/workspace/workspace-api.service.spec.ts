import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { WorkspaceApiError, WorkspaceApiService } from './workspace-api.service';

describe('WorkspaceApiService', () => {
  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [WorkspaceApiService, provideHttpClient(), provideHttpClientTesting()],
    });
  });

  afterEach(() => {
    // `verify()` throws on a leftover request, and a throw here would otherwise skip the
    // reset and cascade into every later test as "module already instantiated".
    try {
      TestBed.inject(HttpTestingController).verify();
    } finally {
      TestBed.resetTestingModule();
    }
  });

  it('sends the workspace-relative path as a query parameter, including the empty root', async () => {
    const api = TestBed.inject(WorkspaceApiService);
    const http = TestBed.inject(HttpTestingController);

    const listing = api.list('');
    http.expectOne('/api/workspace/files?path=').flush({ path: '', entries: [] });
    expect((await listing).entries).toEqual([]);

    const read = api.read('src/main.ts');
    const request = http.expectOne('/api/workspace/file?path=src/main.ts');
    expect(request.request.method).toBe('GET');
    request.flush({ path: 'src/main.ts', content: 'x', bytes: 1, truncated: false });
    expect((await read).content).toBe('x');
  });

  it('omits maxResults from search when the caller did not ask for a cap', async () => {
    const api = TestBed.inject(WorkspaceApiService);
    const http = TestBed.inject(HttpTestingController);

    const withoutCap = api.search('todo');
    http.expectOne('/api/workspace/search?query=todo&path=').flush({
      matches: [],
      truncated: false,
    });
    await withoutCap;

    const withCap = api.search('todo', 'src', 10);
    http
      .expectOne('/api/workspace/search?query=todo&path=src&maxResults=10')
      .flush({ matches: [], truncated: false });
    await withCap;
  });

  it('posts write and exec bodies in the shape the controller binds', async () => {
    const api = TestBed.inject(WorkspaceApiService);
    const http = TestBed.inject(HttpTestingController);

    const write = api.write('notes.md', '# hi');
    const writeRequest = http.expectOne('/api/workspace/file');
    expect(writeRequest.request.method).toBe('POST');
    expect(writeRequest.request.body).toEqual({ path: 'notes.md', content: '# hi' });
    writeRequest.flush({ path: 'notes.md', bytes: 4, created: true });
    expect((await write).created).toBe(true);

    const exec = api.exec('pnpm', ['test'], 'frontend');
    const execRequest = http.expectOne('/api/workspace/exec');
    expect(execRequest.request.body).toEqual({
      command: 'pnpm',
      args: ['test'],
      cwd: 'frontend',
    });
    execRequest.flush({ command: 'pnpm', exitCode: 0, stdout: 'ok', stderr: '', timedOut: false });
    expect((await exec).exitCode).toBe(0);
  });

  it('flags a 503 as unavailable and keeps the server wording that names the settings', async () => {
    const api = TestBed.inject(WorkspaceApiService);
    const http = TestBed.inject(HttpTestingController);

    const listing = api.list('');
    http.expectOne('/api/workspace/files?path=').flush(
      {
        statusCode: 503,
        message:
          'The host workspace is not configured. Set WORKSPACE_BRIDGE_URL in the backend ' +
          'environment and BRIDGE_WORKSPACE_ROOT in host-bridge/.env.',
      },
      { status: 503, statusText: 'Service Unavailable' },
    );

    const error = await listing.catch((e: unknown) => e);
    expect(error).toBeInstanceOf(WorkspaceApiError);
    expect((error as WorkspaceApiError).isUnavailable).toBe(true);
    expect((error as WorkspaceApiError).message).toContain('BRIDGE_WORKSPACE_ROOT');
  });

  it('flattens the string[] message a validation failure produces', async () => {
    const api = TestBed.inject(WorkspaceApiService);
    const http = TestBed.inject(HttpTestingController);

    const read = api.read('..');
    http
      .expectOne('/api/workspace/file?path=..')
      .flush(
        { statusCode: 400, message: ['path must be relative', 'path must not escape the root'] },
        { status: 400, statusText: 'Bad Request' },
      );

    const error = (await read.catch((e: unknown) => e)) as WorkspaceApiError;
    expect(error.status).toBe(400);
    expect(error.isUnavailable).toBe(false);
    expect(error.message).toBe('path must be relative, path must not escape the root');
  });
});
