import { DatePipe } from '@angular/common';
import { Component, inject } from '@angular/core';
import { ArtifactStore } from './artifact.store';
import { MonacoEditorComponent } from './monaco-editor.component';
import { MonacoDiffEditorComponent } from './monaco-diff-editor.component';

@Component({
  selector: 'app-code-editor-panel',
  imports: [DatePipe, MonacoEditorComponent, MonacoDiffEditorComponent],
  templateUrl: './code-editor-panel.component.html',
  styleUrl: './code-editor-panel.component.scss',
})
export class CodeEditorPanelComponent {
  protected readonly artifactStore = inject(ArtifactStore);

  onContentChange(filename: string, content: string) {
    this.artifactStore.editContent(filename, content);
  }

  onSave(filename: string) {
    this.artifactStore.saveContent(filename);
  }
}
