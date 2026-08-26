import { ChangeDetectionStrategy, Component, input, output } from '@angular/core';
import { FileIconComponent } from '../file-icon/file-icon.component';
import { isTabDirty, type WorkspaceTab } from '../workspace.store';

/**
 * The tab strip above the editor.
 *
 * Presentational: it takes the tab list and reports clicks. `WorkspaceStore` owns whether a
 * second click on an open file opens or focuses, because that rule has to hold for the
 * explorer and for anything else that opens a file too — enforcing it here would only cover
 * the one entry point that cannot actually trigger it.
 */
@Component({
  selector: 'app-editor-tabs',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [FileIconComponent],
  templateUrl: './editor-tabs.component.html',
  styleUrl: './editor-tabs.component.scss',
})
export class EditorTabsComponent {
  readonly tabs = input.required<readonly WorkspaceTab[]>();
  readonly activePath = input<string | null>(null);

  readonly select = output<string>();
  readonly close = output<string>();
  readonly create = output<void>();

  protected readonly isDirty = isTabDirty;
}
