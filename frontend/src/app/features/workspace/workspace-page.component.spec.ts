import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { WorkspaceStore } from './workspace.store';
import { WorkspacePageComponent } from './workspace-page.component';

/** See the note in `file-explorer.component.spec.ts` — same nullable/`any` problem. */
function pick<T extends Element>(host: { nativeElement: unknown }, selector: string): T {
  const element = (host.nativeElement as HTMLElement).querySelector<T>(selector);
  if (!element) throw new Error(`Nothing matched "${selector}"`);
  return element;
}

function all<T extends Element>(host: { nativeElement: unknown }, selector: string): T[] {
  return Array.from((host.nativeElement as HTMLElement).querySelectorAll<T>(selector));
}

/** Lets the store's await chains run to completion before the next assertion. */
function settle(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

describe('WorkspacePageComponent', () => {
  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [provideRouter([]), provideHttpClient(), provideHttpClientTesting()],
    });
  });

  afterEach(() => {
    TestBed.resetTestingModule();
  });

  it('replaces the tree and the editor with the 503 message, which names the settings to change', async () => {
    const fixture = TestBed.createComponent(WorkspacePageComponent);
    const http = TestBed.inject(HttpTestingController);

    http.expectOne('/api/workspace/status').flush({
      available: true,
      root: '/srv/workspace',
      execEnabled: false,
      allowedCommands: [],
      maxFileBytes: 262_144,
    });
    await settle();

    http
      .expectOne((request) => request.url === '/api/workspace/files')
      .flush(
        {
          statusCode: 503,
          message:
            'The host workspace is not configured. Set WORKSPACE_BRIDGE_URL in the backend ' +
            'environment and BRIDGE_WORKSPACE_ROOT in host-bridge/.env.',
        },
        { status: 503, statusText: 'Service Unavailable' },
      );
    await settle();
    fixture.detectChanges();

    const notice = pick<HTMLElement>(fixture, '.ws__notice-body');
    expect(notice.textContent).toContain('WORKSPACE_BRIDGE_URL');
    expect(notice.textContent).toContain('BRIDGE_WORKSPACE_ROOT');
    // Not an empty tree pretending to be an empty folder.
    expect(all(fixture, '.row').length).toBe(0);
    expect(all(fixture, 'app-monaco-editor').length).toBe(0);
  });

  it('lazily expands a folder from a click in the sidebar', async () => {
    const fixture = TestBed.createComponent(WorkspacePageComponent);
    const http = TestBed.inject(HttpTestingController);

    http.expectOne('/api/workspace/status').flush({
      available: true,
      root: '/srv/workspace',
      execEnabled: false,
      allowedCommands: [],
      maxFileBytes: 262_144,
    });
    await settle();
    http
      .expectOne((request) => request.url === '/api/workspace/files')
      .flush({ path: '', entries: [{ name: 'src', type: 'dir', size: 0 }] });
    await settle();
    fixture.detectChanges();

    expect(all(fixture, '.row').length).toBe(1);
    // Nothing has been fetched for `src` yet, which is the behaviour under test.
    http.verify();

    pick<HTMLButtonElement>(fixture, '.row__main').click();
    await settle();
    http
      .expectOne(
        (request) => request.url === '/api/workspace/files' && request.params.get('path') === 'src',
      )
      .flush({ path: 'src', entries: [{ name: 'app.ts', type: 'file', size: 4 }] });
    await settle();
    fixture.detectChanges();

    expect(all(fixture, '.row').length).toBe(2);
  });

  it('forwards a toolbar action with the active file, without calling any agent endpoint', async () => {
    const fixture = TestBed.createComponent(WorkspacePageComponent);
    const http = TestBed.inject(HttpTestingController);
    const store = TestBed.inject(WorkspaceStore);

    http.expectOne('/api/workspace/status').flush({
      available: true,
      root: '/srv/workspace',
      execEnabled: false,
      allowedCommands: [],
      maxFileBytes: 262_144,
    });
    await settle();
    http
      .expectOne((request) => request.url === '/api/workspace/files')
      .flush({
        path: '',
        entries: [],
      });
    await settle();
    fixture.detectChanges();

    const buttons = all<HTMLButtonElement>(fixture, '.toolbar__action');
    expect(buttons.map((button) => (button.textContent ?? '').trim())).toEqual([
      'Debug',
      'Optimize',
      'Translate',
      'Documentation',
      'Generate code',
    ]);

    buttons[1].click();
    await settle();

    expect(store.lastAction()).toEqual({
      action: 'optimize',
      label: 'Optimize',
      path: null,
      language: 'plaintext',
      content: null,
    });
    // The five buttons are preset prompts for someone else's panel, not backend features.
    http.verify();
  });
});
