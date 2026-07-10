import {
  AfterViewInit,
  Component,
  DestroyRef,
  ElementRef,
  effect,
  inject,
  input,
  viewChild,
} from '@angular/core';
import { loadMonaco } from './monaco-loader';
import type * as Monaco from 'monaco-editor';

@Component({
  selector: 'app-monaco-diff-editor',
  template: `<div #host class="monaco-host"></div>`,
  styles: [
    `
      :host {
        display: block;
        height: 100%;
      }
      .monaco-host {
        height: 100%;
        width: 100%;
      }
    `,
  ],
})
export class MonacoDiffEditorComponent implements AfterViewInit {
  readonly original = input<string>('');
  readonly modified = input<string>('');
  readonly language = input<string>('plaintext');

  private readonly hostRef = viewChild.required<ElementRef<HTMLDivElement>>('host');
  private readonly destroyRef = inject(DestroyRef);

  private diffEditor: Monaco.editor.IStandaloneDiffEditor | null = null;
  private monaco: typeof Monaco | null = null;

  constructor() {
    effect(() => {
      const original = this.original();
      const modified = this.modified();
      const language = this.language();
      const monaco = this.monaco;
      if (!monaco || !this.diffEditor) return;

      this.replaceModels(original, modified, language);
    });
  }

  async ngAfterViewInit() {
    const monaco = await loadMonaco();
    this.monaco = monaco;

    const diffEditor = monaco.editor.createDiffEditor(this.hostRef().nativeElement, {
      automaticLayout: true,
      readOnly: true,
      renderSideBySide: true,
    });
    this.diffEditor = diffEditor;
    this.replaceModels(this.original(), this.modified(), this.language());

    this.destroyRef.onDestroy(() => {
      const models = diffEditor.getModel();
      models?.original.dispose();
      models?.modified.dispose();
      diffEditor.dispose();
    });
  }

  private replaceModels(original: string, modified: string, language: string): void {
    if (!this.monaco || !this.diffEditor) return;
    const previousModels = this.diffEditor.getModel();
    this.diffEditor.setModel({
      original: this.monaco.editor.createModel(original, language),
      modified: this.monaco.editor.createModel(modified, language),
    });
    previousModels?.original.dispose();
    previousModels?.modified.dispose();
  }
}
