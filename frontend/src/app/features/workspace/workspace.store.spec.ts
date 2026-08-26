import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { WorkspaceApiService, type WorkspaceStatus } from './workspace-api.service';
import { WorkspaceStore, isTabDirty } from './workspace.store';

const UNCONFIGURED =
  'The host workspace is not configured. Set WORKSPACE_BRIDGE_URL in the backend ' +
  'environment and BRIDGE_WORKSPACE_ROOT in host-bridge/.env.';

function status(overrides: Partial<WorkspaceStatus> = {}): WorkspaceStatus {
  return {
    available: true,
    root: '/srv/workspace',
    execEnabled: true,
    allowedCommands: ['pnpm'],
    maxFileBytes: 262_144,
    ...overrides,
  };
}

/** Lets every pending microtask in the store's await chains run before we assert. */
function settle(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

describe('WorkspaceStore', () => {
  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [
        WorkspaceStore,
        WorkspaceApiService,
        provideHttpClient(),
        provideHttpClientTesting(),
      ],
    });
  });

  afterEach(() => {
    TestBed.resetTestingModule();
  });

  function http(): HttpTestingController {
    return TestBed.inject(HttpTestingController);
  }

  function expectList(path: string) {
    return http().expectOne(
      (request) => request.url === '/api/workspace/files' && request.params.get('path') === path,
    );
  }

  function expectRead(path: string) {
    return http().expectOne(
      (request) => request.url === '/api/workspace/file' && request.params.get('path') === path,
    );
  }

  /** Boots the store with a root listing of one folder and one file. */
  async function boot(store: WorkspaceStore): Promise<void> {
    const loading = store.initialize();
    http().expectOne('/api/workspace/status').flush(status());
    await settle();
    expectList('').flush({
      path: '',
      entries: [
        { name: 'main.py', type: 'file', size: 40 },
        { name: 'src', type: 'dir', size: 0 },
      ],
    });
    await loading;
  }

  it('lists a directory only when it is expanded, and not again when it is re-expanded', async () => {
    const store = TestBed.inject(WorkspaceStore);
    await boot(store);

    // Directories sort ahead of files, so the root renders `src` first.
    expect(store.rows().map((row) => row.path)).toEqual(['src', 'main.py']);
    // Nothing was fetched for `src` — that is the whole point of lazy expansion.
    http().verify();

    const expanding = store.toggleDirectory('src');
    expect(store.rows().find((row) => row.path === 'src')?.loading).toBe(true);
    expectList('src').flush({
      path: 'src',
      entries: [{ name: 'app.ts', type: 'file', size: 10 }],
    });
    await expanding;

    expect(store.rows().map((row) => row.path)).toEqual(['src', 'src/app.ts', 'main.py']);
    expect(store.rows()[1].depth).toBe(1);

    await store.toggleDirectory('src');
    expect(store.rows().map((row) => row.path)).toEqual(['src', 'main.py']);

    // Re-expanding replays the cached entries rather than spending another host round trip.
    await store.toggleDirectory('src');
    expect(store.rows().map((row) => row.path)).toEqual(['src', 'src/app.ts', 'main.py']);
    http().verify();
  });

  it('makes a truncated file read-only and refuses to save it', async () => {
    const store = TestBed.inject(WorkspaceStore);
    await boot(store);

    const opening = store.openFile('main.py');
    expectRead('main.py').flush({
      path: 'main.py',
      content: 'print(1)',
      bytes: 262_144,
      truncated: true,
    });
    await opening;

    const tab = store.activeTab();
    expect(tab?.truncated).toBe(true);
    expect(tab?.readOnly).toBe(true);

    // Even if something manages to push an edit at it, the buffer must not move — the tail
    // past the byte cap is not in memory and writing this back would delete it.
    store.edit('main.py', 'print(2)');
    expect(store.activeTab()?.content).toBe('print(1)');

    await store.save('main.py');
    http().verify();
  });

  it('reports clean again once an edit is undone back to the loaded content', async () => {
    const store = TestBed.inject(WorkspaceStore);
    await boot(store);

    const opening = store.openFile('main.py');
    expectRead('main.py').flush({
      path: 'main.py',
      content: 'print(1)',
      bytes: 8,
      truncated: false,
    });
    await opening;

    expect(isTabDirty(store.activeTab()!)).toBe(false);

    store.edit('main.py', 'print(2)');
    expect(isTabDirty(store.activeTab()!)).toBe(true);
    expect(store.modifiedPaths().has('main.py')).toBe(true);

    store.edit('main.py', 'print(1)');
    expect(isTabDirty(store.activeTab()!)).toBe(false);
    expect(store.modifiedPaths().has('main.py')).toBe(false);
  });

  it('rebases dirty state on what was written, not on keystrokes made during the save', async () => {
    const store = TestBed.inject(WorkspaceStore);
    await boot(store);

    const opening = store.openFile('main.py');
    expectRead('main.py').flush({ path: 'main.py', content: 'a', bytes: 1, truncated: false });
    await opening;

    store.edit('main.py', 'ab');
    const saving = store.save('main.py');
    const request = http().expectOne('/api/workspace/file');
    expect(request.request.body).toEqual({ path: 'main.py', content: 'ab' });

    // The user keeps typing while the write is in flight.
    store.edit('main.py', 'abc');
    request.flush({ path: 'main.py', bytes: 2, created: false });
    await saving;

    expect(store.activeTab()?.savedContent).toBe('ab');
    expect(store.activeTab()?.content).toBe('abc');
    expect(isTabDirty(store.activeTab()!)).toBe(true);
  });

  it('focuses an already-open file instead of opening a second tab for it', async () => {
    const store = TestBed.inject(WorkspaceStore);
    await boot(store);

    const first = store.openFile('main.py');
    expectRead('main.py').flush({ path: 'main.py', content: 'a', bytes: 1, truncated: false });
    await first;

    const expanding = store.toggleDirectory('src');
    expectList('src').flush({
      path: 'src',
      entries: [{ name: 'app.ts', type: 'file', size: 1 }],
    });
    await expanding;

    const second = store.openFile('src/app.ts');
    expectRead('src/app.ts').flush({
      path: 'src/app.ts',
      content: 'b',
      bytes: 1,
      truncated: false,
    });
    await second;
    expect(store.activePath()).toBe('src/app.ts');

    store.edit('main.py', 'edited');

    // Re-opening the first file must not issue a read, must not add a tab, and must not
    // discard the unsaved buffer by replacing it with what is on disk.
    await store.openFile('main.py');
    http().verify();
    expect(store.tabs().map((tab) => tab.path)).toEqual(['main.py', 'src/app.ts']);
    expect(store.activePath()).toBe('main.py');
    expect(store.activeTab()?.content).toBe('edited');
  });

  it('shows the message rather than an empty tree when the operator never configured a workspace', async () => {
    const store = TestBed.inject(WorkspaceStore);

    const loading = store.initialize();
    http()
      .expectOne('/api/workspace/status')
      .flush(status({ available: false, root: null }));
    await loading;

    expect(store.unavailableMessage()).toBe(UNCONFIGURED);
    expect(store.rows()).toEqual([]);
    // No listing was attempted: the tree is not empty, it is unavailable.
    http().verify();
  });

  it('promotes a 503 from any route to the server wording, over the built-in copy', async () => {
    const store = TestBed.inject(WorkspaceStore);

    const loading = store.initialize();
    http().expectOne('/api/workspace/status').flush(status());
    await settle();
    expectList('').flush(
      { statusCode: 503, message: 'Someone turned it off. Set BRIDGE_WORKSPACE_ROOT.' },
      { status: 503, statusText: 'Service Unavailable' },
    );
    await loading;

    expect(store.unavailableMessage()).toBe('Someone turned it off. Set BRIDGE_WORKSPACE_ROOT.');
    expect(store.isAvailable()).toBe(false);
  });

  it('activates the neighbouring tab when the focused one is closed, and none when the last goes', async () => {
    const store = TestBed.inject(WorkspaceStore);
    await boot(store);

    const first = store.openFile('main.py');
    expectRead('main.py').flush({ path: 'main.py', content: 'a', bytes: 1, truncated: false });
    await first;

    const expanding = store.toggleDirectory('src');
    expectList('src').flush({
      path: 'src',
      entries: [{ name: 'app.ts', type: 'file', size: 1 }],
    });
    await expanding;

    const second = store.openFile('src/app.ts');
    expectRead('src/app.ts').flush({
      path: 'src/app.ts',
      content: 'b',
      bytes: 1,
      truncated: false,
    });
    await second;

    store.closeTab('src/app.ts');
    expect(store.activePath()).toBe('main.py');

    store.closeTab('main.py');
    expect(store.activePath()).toBeNull();
    expect(store.activeTab()).toBeNull();
  });

  it('creates a file inside the selected folder and opens it', async () => {
    const store = TestBed.inject(WorkspaceStore);
    await boot(store);

    const expanding = store.toggleDirectory('src');
    expectList('src').flush({ path: 'src', entries: [] });
    await expanding;
    expect(store.selectedPath()).toBe('src');

    const creating = store.createFile('helper.ts');
    const write = http().expectOne('/api/workspace/file');
    expect(write.request.body).toEqual({ path: 'src/helper.ts', content: '' });
    write.flush({ path: 'src/helper.ts', bytes: 0, created: true });
    await settle();

    expectList('src').flush({
      path: 'src',
      entries: [{ name: 'helper.ts', type: 'file', size: 0 }],
    });
    await settle();

    expectRead('src/helper.ts').flush({
      path: 'src/helper.ts',
      content: '',
      bytes: 0,
      truncated: false,
    });
    await creating;

    expect(store.rows().map((row) => row.path)).toContain('src/helper.ts');
    expect(store.activePath()).toBe('src/helper.ts');
    expect(store.activeTab()?.language).toBe('typescript');
  });

  it('announces a toolbar action with the unsaved buffer of the active file', async () => {
    const store = TestBed.inject(WorkspaceStore);
    await boot(store);

    const opening = store.openFile('main.py');
    expectRead('main.py').flush({
      path: 'main.py',
      content: 'print(1)',
      bytes: 8,
      truncated: false,
    });
    await opening;
    store.edit('main.py', 'print(2)');

    const seen: unknown[] = [];
    const subscription = store.actions.subscribe((request) => seen.push(request));
    store.runAction('debug');
    subscription.unsubscribe();

    expect(seen).toEqual([
      {
        action: 'debug',
        label: 'Debug',
        path: 'main.py',
        language: 'python',
        // Deliberately the edited buffer, not what `read` returned.
        content: 'print(2)',
      },
    ]);
    expect(store.lastAction()?.action).toBe('debug');
  });
});
