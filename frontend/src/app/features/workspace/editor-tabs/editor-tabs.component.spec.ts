import { Component, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import type { WorkspaceTab } from '../workspace.store';
import { EditorTabsComponent } from './editor-tabs.component';

/** See the note in `file-explorer.component.spec.ts` — same nullable/`any` problem. */
function pick<T extends Element>(host: { nativeElement: unknown } | Element, selector: string): T {
  const scope = host instanceof Element ? host : (host.nativeElement as HTMLElement);
  const element = scope.querySelector<T>(selector);
  if (!element) throw new Error(`Nothing matched "${selector}"`);
  return element;
}

function all<T extends Element>(host: { nativeElement: unknown }, selector: string): T[] {
  return Array.from((host.nativeElement as HTMLElement).querySelectorAll<T>(selector));
}

function tab(overrides: Partial<WorkspaceTab> = {}): WorkspaceTab {
  return {
    path: 'src/main.py',
    name: 'main.py',
    language: 'python',
    content: 'print(1)',
    savedContent: 'print(1)',
    bytes: 8,
    truncated: false,
    readOnly: false,
    saving: false,
    error: null,
    ...overrides,
  };
}

@Component({
  imports: [EditorTabsComponent],
  template: `
    <app-editor-tabs
      [tabs]="tabs()"
      [activePath]="activePath()"
      (select)="selected.push($event)"
      (close)="closed.push($event)"
      (create)="createCount = createCount + 1"
    />
  `,
})
class HostComponent {
  readonly tabs = signal<WorkspaceTab[]>([]);
  readonly activePath = signal<string | null>(null);
  readonly selected: string[] = [];
  readonly closed: string[] = [];
  createCount = 0;
}

describe('EditorTabsComponent', () => {
  beforeEach(() => {
    TestBed.configureTestingModule({ imports: [HostComponent] });
  });

  afterEach(() => {
    TestBed.resetTestingModule();
  });

  it('marks the active tab and reports selection and closing separately', () => {
    const fixture = TestBed.createComponent(HostComponent);
    fixture.componentInstance.tabs.set([
      tab(),
      tab({ path: 'a.ts', name: 'a.ts', language: 'typescript' }),
    ]);
    fixture.componentInstance.activePath.set('a.ts');
    fixture.detectChanges();

    const rendered = all<HTMLElement>(fixture, '.tab');
    expect(rendered[1].classList.contains('tab--active')).toBe(true);
    expect(pick(rendered[1], '[role="tab"]').getAttribute('aria-selected')).toBe('true');

    pick<HTMLButtonElement>(rendered[0], '.tab__main').click();
    pick<HTMLButtonElement>(rendered[1], '.tab__close').click();
    fixture.detectChanges();

    // Closing must not also select — the close control is a sibling of the tab button, not
    // nested inside it, so one click produces exactly one intent.
    expect(fixture.componentInstance.selected).toEqual(['src/main.py']);
    expect(fixture.componentInstance.closed).toEqual(['a.ts']);
  });

  it('shows the unsaved dot only while the buffer differs from what was saved', () => {
    const fixture = TestBed.createComponent(HostComponent);
    fixture.componentInstance.tabs.set([tab()]);
    fixture.detectChanges();
    expect(pick(fixture, '.tab').classList.contains('tab--dirty')).toBe(false);

    fixture.componentInstance.tabs.set([tab({ content: 'print(2)' })]);
    fixture.detectChanges();
    expect(pick(fixture, '.tab').classList.contains('tab--dirty')).toBe(true);
  });

  it('flags a read-only tab so a truncated file is visible as such from the strip', () => {
    const fixture = TestBed.createComponent(HostComponent);
    fixture.componentInstance.tabs.set([tab({ truncated: true, readOnly: true })]);
    fixture.detectChanges();

    expect(pick(fixture, '.tab__lock').getAttribute('title')).toContain('truncated');
  });

  it('asks for a new file from the plus button', () => {
    const fixture = TestBed.createComponent(HostComponent);
    fixture.detectChanges();

    pick<HTMLButtonElement>(fixture, '.tabs__add').click();
    expect(fixture.componentInstance.createCount).toBe(1);
  });
});
