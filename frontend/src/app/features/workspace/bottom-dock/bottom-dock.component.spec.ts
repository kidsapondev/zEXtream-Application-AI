import { ComponentFixture, TestBed } from '@angular/core/testing';
import { describe, expect, it, vi } from 'vitest';
import { signal } from '@angular/core';
import { BottomDockComponent } from './bottom-dock.component';
import { WorkspaceApiService, type WorkspaceStatus } from '../workspace-api.service';
import { WorkspaceStore } from '../workspace.store';

const ENABLED: WorkspaceStatus = {
  available: true,
  root: 'D:\\work',
  execEnabled: true,
  allowedCommands: ['git', 'npm', 'python'],
  maxFileBytes: 256_000,
};

class ApiStub {
  exec = vi.fn().mockResolvedValue({
    command: 'git',
    exitCode: 0,
    stdout: 'on branch main',
    stderr: '',
    timedOut: false,
  });
}

function storeStub(status: WorkspaceStatus | null = ENABLED) {
  return { status: signal(status) };
}

async function mount(
  api: ApiStub,
  status: WorkspaceStatus | null = ENABLED,
): Promise<ComponentFixture<BottomDockComponent>> {
  await TestBed.configureTestingModule({
    imports: [BottomDockComponent],
    providers: [
      { provide: WorkspaceApiService, useValue: api },
      { provide: WorkspaceStore, useValue: storeStub(status) },
    ],
  }).compileComponents();
  const fixture = TestBed.createComponent(BottomDockComponent);
  fixture.detectChanges();
  return fixture;
}

/** Reaches the protected members the template drives; the alternative is asserting on DOM. */
function inner(fixture: ComponentFixture<BottomDockComponent>): any {
  return fixture.componentInstance as any;
}

describe('BottomDockComponent', () => {
  it('splits a typed line into a command and arguments before sending it', async () => {
    const api = new ApiStub();
    const fixture = await mount(api);
    const dock = inner(fixture);

    dock.commandLine.set('git commit -m "two words"');
    await dock.submit();

    expect(api.exec).toHaveBeenCalledWith('git', ['commit', '-m', 'two words'], '');
  });

  it('renders a non-zero exit rather than treating it as a failure', async () => {
    // A failing test suite is exactly what this panel exists to show.
    const api = new ApiStub();
    api.exec.mockResolvedValue({
      command: 'npm',
      exitCode: 1,
      stdout: '2 failing',
      stderr: '',
      timedOut: false,
    });
    const fixture = await mount(api);
    const dock = inner(fixture);

    dock.commandLine.set('npm test');
    await dock.submit();

    const entries = dock.terminal();
    expect(entries.length).toBe(1);
    expect(entries[0].exitCode).toBe(1);
    expect(entries[0].refused).toBeUndefined();
    expect(entries[0].stdout).toContain('2 failing');
  });

  it('refuses a shell pipeline instead of running half of it', async () => {
    // `npm test | grep fail` would otherwise run as npm with `test`, `|` and `grep` as
    // arguments and appear to have worked.
    const api = new ApiStub();
    const fixture = await mount(api);
    const dock = inner(fixture);

    dock.commandLine.set('npm test | grep fail');
    await dock.submit();

    expect(api.exec).not.toHaveBeenCalled();
    expect(dock.terminal()[0].refused).toContain('without a shell');
  });

  it('names the setting to change when exec is switched off', async () => {
    const api = new ApiStub();
    const fixture = await mount(api, { ...ENABLED, execEnabled: false });
    const dock = inner(fixture);

    dock.commandLine.set('git status');
    await dock.submit();

    expect(api.exec).not.toHaveBeenCalled();
    expect(dock.terminal()[0].refused).toContain('BRIDGE_EXEC_ALLOWLIST');
  });

  it('exposes the allowlist so nobody has to discover it by being refused', async () => {
    const fixture = await mount(new ApiStub());

    expect(inner(fixture).allowedCommands()).toEqual(['git', 'npm', 'python']);
  });

  it('surfaces a transport failure as a refusal rather than throwing', async () => {
    const api = new ApiStub();
    api.exec.mockRejectedValue(new Error('bridge unreachable'));
    const fixture = await mount(api);
    const dock = inner(fixture);

    dock.commandLine.set('git status');
    await dock.submit();

    expect(dock.terminal()[0].refused).toContain('bridge unreachable');
    expect(dock.running()).toBe(false);
  });

  it('walks command history with the arrow keys', async () => {
    const api = new ApiStub();
    const fixture = await mount(api);
    const dock = inner(fixture);

    dock.commandLine.set('git status');
    await dock.submit();
    dock.commandLine.set('npm test');
    await dock.submit();

    dock.onKeyDown(new KeyboardEvent('keydown', { key: 'ArrowUp' }));
    expect(dock.commandLine()).toBe('npm test');

    dock.onKeyDown(new KeyboardEvent('keydown', { key: 'ArrowUp' }));
    expect(dock.commandLine()).toBe('git status');

    dock.onKeyDown(new KeyboardEvent('keydown', { key: 'ArrowDown' }));
    expect(dock.commandLine()).toBe('npm test');
  });

  it('ignores a blank submission', async () => {
    const api = new ApiStub();
    const fixture = await mount(api);
    const dock = inner(fixture);

    dock.commandLine.set('   ');
    await dock.submit();

    expect(api.exec).not.toHaveBeenCalled();
    expect(dock.terminal().length).toBe(0);
  });

  it('starts with no problems and no analyser', async () => {
    // Deliberately not faked: nothing in the browser produces diagnostics yet, and an empty
    // list that looks like "your code is clean" would be a lie.
    const fixture = await mount(new ApiStub());

    expect(inner(fixture).problems()).toEqual([]);
    expect(inner(fixture).problemCount()).toBe(0);
  });

  it('appends to the output log for the rest of the IDE', async () => {
    const fixture = await mount(new ApiStub());
    const dock = fixture.componentInstance;

    dock.append('saved src/app.ts');
    dock.append('bridge unreachable', 'error');

    const entries = inner(fixture).output();
    expect(entries.map((entry: { text: string }) => entry.text)).toEqual([
      'saved src/app.ts',
      'bridge unreachable',
    ]);
    expect(entries[1].kind).toBe('error');
  });

  it('clears only the panel that is showing', async () => {
    const api = new ApiStub();
    const fixture = await mount(api);
    const dock = inner(fixture);
    fixture.componentInstance.append('kept');
    dock.commandLine.set('git status');
    await dock.submit();

    dock.select('terminal');
    dock.clearActive();

    expect(dock.terminal()).toEqual([]);
    expect(dock.output().length).toBe(1);
  });
});
