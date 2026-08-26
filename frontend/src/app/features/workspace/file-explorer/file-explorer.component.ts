import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  computed,
  effect,
  input,
  output,
  signal,
  viewChild,
} from '@angular/core';
import { FileIconComponent } from '../file-icon/file-icon.component';
import type { ExplorerRow } from '../workspace.store';

/**
 * The left sidebar: the new-file/search header, the "Explorer" heading with its overflow
 * menu, and the lazily-materialised tree.
 *
 * It renders a *flat* row list rather than recursing over a nested tree. The store already
 * flattens, and the reason it does is the reason this component wants it flat too: a folder
 * that has never been expanded has no children to recurse into, so a nested renderer would
 * need a "children not fetched yet" branch at every level. Depth is a `padding-left`.
 */
@Component({
  selector: 'app-file-explorer',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [FileIconComponent],
  templateUrl: './file-explorer.component.html',
  styleUrl: './file-explorer.component.scss',
})
export class FileExplorerComponent {
  readonly rows = input.required<readonly ExplorerRow[]>();
  readonly selectedPath = input<string | null>(null);
  /** Paths with unsaved edits — drawn as the small dot on the right of a row. */
  readonly modifiedPaths = input<ReadonlySet<string>>(new Set<string>());
  readonly loading = input(false);
  /** Whatever went wrong reading the workspace root, if anything. */
  readonly error = input<string | null>(null);

  readonly toggleDirectory = output<string>();
  readonly openFile = output<string>();
  readonly createFile = output<string>();
  readonly refresh = output<void>();
  readonly collapseAll = output<void>();

  protected readonly menuOpen = signal(false);
  protected readonly creating = signal(false);
  protected readonly searchOpen = signal(false);
  protected readonly filter = signal('');

  /**
   * A name filter over the rows already on screen, not a call to `/workspace/search`.
   *
   * That endpoint greps file *contents* and returns line hits — a different result shape that
   * belongs in a results panel, not spliced into a tree. What the square button beside "new
   * file" is for is finding a file you can already see the folder of, and doing that without
   * a round trip means it filters as you type.
   */
  protected readonly visibleRows = computed<readonly ExplorerRow[]>(() => {
    const needle = this.filter().trim().toLowerCase();
    if (!needle) return this.rows();
    return this.rows().filter((row) => row.name.toLowerCase().includes(needle));
  });

  private readonly newFileInput = viewChild<ElementRef<HTMLInputElement>>('newFileInput');
  private readonly filterInput = viewChild<ElementRef<HTMLInputElement>>('filterInput');

  constructor() {
    // Both inputs only exist while their `@if` is true, so the focus has to happen when the
    // element arrives rather than when the flag flips — the viewChild signal is exactly that
    // moment, and an effect on it needs no timers or lifecycle hooks to catch it.
    effect(() => this.newFileInput()?.nativeElement.focus());
    effect(() => this.filterInput()?.nativeElement.focus());
  }

  /** Depth indentation is suppressed while filtering, where the hierarchy no longer holds. */
  protected indentFor(row: ExplorerRow): number {
    return this.filter().trim() ? 0 : row.depth * 14;
  }

  protected onToggleSearch(): void {
    const next = !this.searchOpen();
    this.searchOpen.set(next);
    if (!next) this.filter.set('');
  }

  protected onFilterInput(event: Event): void {
    this.filter.set((event.target as HTMLInputElement).value);
  }

  /** Public because the tab strip's `+` opens this same inline field. */
  startCreating(): void {
    this.menuOpen.set(false);
    this.creating.set(true);
  }

  protected submitNewFile(input: HTMLInputElement): void {
    const name = input.value.trim();
    this.creating.set(false);
    input.value = '';
    if (name) this.createFile.emit(name);
  }

  protected cancelCreating(input: HTMLInputElement): void {
    input.value = '';
    this.creating.set(false);
  }

  protected onMenuAction(action: 'refresh' | 'collapse' | 'new'): void {
    this.menuOpen.set(false);
    if (action === 'refresh') this.refresh.emit();
    else if (action === 'collapse') this.collapseAll.emit();
    else this.creating.set(true);
  }
}
