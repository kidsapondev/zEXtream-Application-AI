import { ChangeDetectionStrategy, Component, inject, viewChild } from '@angular/core';
import { Router } from '@angular/router';
import { MonacoEditorComponent } from '../code-editor/monaco-editor.component';
import { BottomDockComponent } from './bottom-dock/bottom-dock.component';
import { EditorTabsComponent } from './editor-tabs/editor-tabs.component';
import { FileExplorerComponent } from './file-explorer/file-explorer.component';
import { FileIconComponent } from './file-icon/file-icon.component';
import { WorkspaceToolbarComponent } from './toolbar/workspace-toolbar.component';
import { WorkspaceStore, type WorkspaceActionName } from './workspace.store';

/**
 * The web IDE's shell: toolbar, explorer, tab strip, breadcrumb, editor.
 *
 * Almost every handler here is a one-line forward into `WorkspaceStore`, which is the
 * intended shape. The child components are presentational and the store is root-provided, so
 * this component owns nothing but the layout — which is what lets a bottom dock and an AI
 * panel be slotted in later by two other efforts without any of the three needing to route
 * state through this one.
 */
@Component({
  selector: 'app-workspace-page',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    WorkspaceToolbarComponent,
    FileExplorerComponent,
    EditorTabsComponent,
    FileIconComponent,
    MonacoEditorComponent,
    BottomDockComponent,
  ],
  templateUrl: './workspace-page.component.html',
  styleUrl: './workspace-page.component.scss',
})
export class WorkspacePageComponent {
  protected readonly store = inject(WorkspaceStore);
  private readonly router = inject(Router);

  private readonly explorer = viewChild(FileExplorerComponent);

  constructor() {
    // Fire-and-forget: `initialize()` is idempotent and writes its own loading/error state
    // into signals the template already renders, so there is nothing here to await.
    void this.store.initialize();
  }

  protected onHome(): void {
    void this.router.navigate(['/chat']);
  }

  protected onAction(action: WorkspaceActionName): void {
    this.store.runAction(action);
  }

  protected onLanguageChange(language: string): void {
    const path = this.store.activePath();
    if (path) this.store.setLanguage(path, language);
  }

  /**
   * The `+` on the tab strip and the "Create new file" button in the sidebar are the same
   * gesture, so `+` drives the explorer's inline name field rather than opening a second,
   * differently-shaped prompt for it.
   */
  protected onCreateRequested(): void {
    this.explorer()?.startCreating();
  }
}
