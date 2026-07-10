import {
  AfterViewInit,
  Component,
  DestroyRef,
  ElementRef,
  effect,
  inject,
  input,
  output,
  viewChild,
} from '@angular/core';
import { loadMonaco } from './monaco-loader';
import type * as Monaco from 'monaco-editor';

@Component({
  selector: 'app-monaco-editor',
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
export class MonacoEditorComponent implements AfterViewInit {
  readonly content = input<string>('');
  readonly language = input<string>('plaintext');
  readonly readOnly = input<boolean>(false);
  readonly contentChange = output<string>();
  readonly saveRequested = output<void>();

  private readonly hostRef = viewChild.required<ElementRef<HTMLDivElement>>('host');
  private readonly destroyRef = inject(DestroyRef);

  private editor: Monaco.editor.IStandaloneCodeEditor | null = null;
  private monaco: typeof Monaco | null = null;
  private applyingExternalValue = false;

  constructor() {
    effect(() => {
      const incomingContent = this.content();
      const editor = this.editor;
      if (!editor) return;
      if (incomingContent === editor.getValue()) return;

      this.applyingExternalValue = true;
      const position = editor.getPosition();
      editor.setValue(incomingContent);
      if (position) editor.setPosition(position);
      this.applyingExternalValue = false;
    });

    effect(() => {
      const incomingLanguage = this.language();
      const editor = this.editor;
      const monaco = this.monaco;
      if (!editor || !monaco) return;
      const model = editor.getModel();
      if (model) monaco.editor.setModelLanguage(model, incomingLanguage);
    });

    effect(() => {
      const readOnly = this.readOnly();
      this.editor?.updateOptions({ readOnly });
    });
  }

  async ngAfterViewInit() {
    const monaco = await loadMonaco();
    this.monaco = monaco;

    const editor = monaco.editor.create(this.hostRef().nativeElement, {
      value: this.content(),
      language: this.language(),
      readOnly: this.readOnly(),
      automaticLayout: true,
      minimap: { enabled: false },
      fontSize: 13,
      scrollBeyondLastLine: false,
    });
    this.editor = editor;

    editor.onDidChangeModelContent(() => {
      if (this.applyingExternalValue) return;
      this.contentChange.emit(editor.getValue());
    });

    editor.addAction({
      id: 'save-artifact',
      label: 'Save artifact',
      keybindings: [monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS],
      run: () => this.saveRequested.emit(),
    });

    this.destroyRef.onDestroy(() => editor.dispose());
  }
}
