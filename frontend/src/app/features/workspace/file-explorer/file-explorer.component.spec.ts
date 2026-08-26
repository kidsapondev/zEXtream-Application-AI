import { Component, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import type { ExplorerRow } from '../workspace.store';
import { FileExplorerComponent } from './file-explorer.component';

/**
 * `fixture.nativeElement` is `any` (so the generic form of `querySelector` is rejected) and
 * `querySelector` is nullable (so every dereference is too). One helper settles both, and
 * failing loudly on a missing selector beats a `!` that turns a broken template into a
 * confusing null-property error three lines later.
 */
function pick<T extends Element>(host: { nativeElement: unknown } | Element, selector: string): T {
  const scope = host instanceof Element ? host : (host.nativeElement as HTMLElement);
  const element = scope.querySelector<T>(selector);
  if (!element) throw new Error(`Nothing matched "${selector}"`);
  return element;
}

function all<T extends Element>(host: { nativeElement: unknown }, selector: string): T[] {
  return Array.from((host.nativeElement as HTMLElement).querySelectorAll<T>(selector));
}

function row(overrides: Partial<ExplorerRow> = {}): ExplorerRow {
  return {
    path: 'src',
    name: 'src',
    type: 'dir',
    depth: 0,
    expanded: false,
    loading: false,
    error: null,
    ...overrides,
  };
}

@Component({
  imports: [FileExplorerComponent],
  template: `
    <app-file-explorer
      [rows]="rows()"
      [selectedPath]="selectedPath()"
      [modifiedPaths]="modifiedPaths()"
      [error]="error()"
      (toggleDirectory)="toggled.push($event)"
      (openFile)="opened.push($event)"
      (createFile)="created.push($event)"
    />
  `,
})
class HostComponent {
  readonly rows = signal<ExplorerRow[]>([]);
  readonly selectedPath = signal<string | null>(null);
  readonly modifiedPaths = signal<ReadonlySet<string>>(new Set<string>());
  readonly error = signal<string | null>(null);
  readonly toggled: string[] = [];
  readonly opened: string[] = [];
  readonly created: string[] = [];
}

describe('FileExplorerComponent', () => {
  beforeEach(() => {
    TestBed.configureTestingModule({ imports: [HostComponent] });
  });

  afterEach(() => {
    TestBed.resetTestingModule();
  });

  it('asks for a folder to be expanded rather than expanding it itself', () => {
    const fixture = TestBed.createComponent(HostComponent);
    fixture.componentInstance.rows.set([row(), row({ path: 'a.py', name: 'a.py', type: 'file' })]);
    fixture.detectChanges();

    const [folder, file] = all<HTMLButtonElement>(fixture, '.row__main');
    // Collapsed folders advertise it, so a screen reader knows there is something to open.
    expect(folder.getAttribute('aria-expanded')).toBe('false');

    folder.click();
    file.click();
    fixture.detectChanges();

    // The component never adds child rows on its own: the store fetches, then re-renders.
    expect(fixture.componentInstance.toggled).toEqual(['src']);
    expect(fixture.componentInstance.opened).toEqual(['a.py']);
    expect(all(fixture, '.row__main').length).toBe(2);
  });

  it('indents by depth, marks the selected row, dots the modified one and spins the loading one', () => {
    const fixture = TestBed.createComponent(HostComponent);
    fixture.componentInstance.rows.set([
      row({ expanded: true, loading: true }),
      row({ path: 'src/a.py', name: 'a.py', type: 'file', depth: 1 }),
    ]);
    fixture.componentInstance.selectedPath.set('src');
    fixture.componentInstance.modifiedPaths.set(new Set(['src/a.py']));
    fixture.detectChanges();

    const rows = all<HTMLElement>(fixture, '.row');
    expect(rows[0].classList.contains('row--selected')).toBe(true);
    expect(rows[1].style.paddingLeft).toBe('14px');
    expect(rows[0].querySelector('.row__spinner')).not.toBeNull();
    expect(rows[1].querySelector('.row__dot')).not.toBeNull();
  });

  it('filters the visible rows by name without asking the server for anything', () => {
    const fixture = TestBed.createComponent(HostComponent);
    fixture.componentInstance.rows.set([
      row(),
      row({ path: 'src/a.py', name: 'a.py', type: 'file', depth: 1 }),
      row({ path: 'src/b.ts', name: 'b.ts', type: 'file', depth: 1 }),
    ]);
    fixture.detectChanges();

    pick<HTMLButtonElement>(fixture, '.explorer__search').click();
    fixture.detectChanges();

    const filter = pick<HTMLInputElement>(fixture, '.explorer__filter');
    filter.value = 'b.t';
    filter.dispatchEvent(new Event('input'));
    fixture.detectChanges();

    // `.row__name` rather than the button's own text: the button also contains the file
    // icon, whose badge label ("ts") would otherwise be read as part of the file name.
    const names = all<HTMLElement>(fixture, '.row__name').map((element) =>
      (element.textContent ?? '').trim(),
    );
    expect(names).toEqual(['b.ts']);
  });

  it('emits the typed name once and closes the field, ignoring the blur that follows', () => {
    const fixture = TestBed.createComponent(HostComponent);
    fixture.detectChanges();

    pick<HTMLButtonElement>(fixture, '.explorer__new').click();
    fixture.detectChanges();

    const input = pick<HTMLInputElement>(fixture, '.explorer__create-input');
    input.value = 'notes.md';
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }));
    fixture.detectChanges();

    expect(fixture.componentInstance.created).toEqual(['notes.md']);
    expect(all(fixture, '.explorer__create-input').length).toBe(0);
  });

  it('shows the workspace-unavailable message where the tree would be', () => {
    const fixture = TestBed.createComponent(HostComponent);
    fixture.componentInstance.error.set('Set WORKSPACE_BRIDGE_URL in the backend environment.');
    fixture.detectChanges();

    const empty = pick<HTMLElement>(fixture, '.explorer__empty');
    expect(empty.textContent).toContain('WORKSPACE_BRIDGE_URL');
    expect(empty.classList.contains('explorer__empty--error')).toBe(true);
  });
});
