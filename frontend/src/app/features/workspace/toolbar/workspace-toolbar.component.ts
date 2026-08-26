import { ChangeDetectionStrategy, Component, input, output } from '@angular/core';
import type { WorkspaceActionName } from '../workspace.store';

interface ToolbarAction {
  name: WorkspaceActionName;
  label: string;
  /** Path `d` attributes, drawn in order into one 24x24 stroke icon. */
  paths: string[];
}

/**
 * Icons live here as raw path data rather than as an icon font or an SVG sprite because the
 * repo has no icon dependency at all — `ds-icon-rail` and the chat components each inline
 * their own `<svg>` the same way. Adding one for five glyphs would be a build-config change
 * three other efforts would have to absorb.
 */
const ACTIONS: readonly ToolbarAction[] = [
  {
    name: 'debug',
    label: 'Debug',
    paths: [
      'M8.5 6.5a3.5 3.5 0 0 1 7 0',
      'M6.5 10.5h11V14a5.5 5.5 0 0 1-11 0z',
      'M3.5 12h3M17.5 12h3M5 7l2.2 1.6M19 7l-2.2 1.6M5 17.5 7.2 16M19 17.5 16.8 16',
    ],
  },
  {
    name: 'optimize',
    label: 'Optimize',
    paths: ['M13.5 2.5 5 13.5h6l-1.5 8L18 10.5h-6z'],
  },
  {
    name: 'translate',
    label: 'Translate',
    paths: [
      'M3.5 12a8.5 8.5 0 1 0 17 0 8.5 8.5 0 1 0-17 0',
      'M3.5 12h17',
      'M12 3.5c2.2 2.3 3.4 5.3 3.4 8.5S14.2 18.2 12 20.5c-2.2-2.3-3.4-5.3-3.4-8.5S9.8 5.8 12 3.5',
    ],
  },
  {
    name: 'documentation',
    label: 'Documentation',
    paths: [
      'M14 3H7.5A2.5 2.5 0 0 0 5 5.5v13A2.5 2.5 0 0 0 7.5 21H17a2 2 0 0 0 2-2V8z',
      'M14 3v5h5',
      'M9 13h6M9 17h4',
    ],
  },
  {
    name: 'generate',
    label: 'Generate code',
    paths: [
      'M10.5 3 12 7.2 16.2 8.7 12 10.2 10.5 14.4 9 10.2 4.8 8.7 9 7.2z',
      'M17.5 14.5l.9 2.3 2.3.9-2.3.9-.9 2.3-.9-2.3-2.3-.9 2.3-.9z',
    ],
  },
];

/**
 * A conservative list, not everything Monaco can highlight.
 *
 * Monaco ships ~90 languages and a picker of 90 is a picker nobody scrolls. These are the
 * ones the file-type table can actually produce plus `plaintext`, so the value shown for an
 * open file is always in the list — a `<select>` whose current value is absent renders blank
 * and looks broken.
 */
export const WORKSPACE_LANGUAGES: readonly string[] = [
  'plaintext',
  'c',
  'cpp',
  'csharp',
  'css',
  'dockerfile',
  'go',
  'html',
  'ini',
  'java',
  'javascript',
  'json',
  'less',
  'markdown',
  'php',
  'powershell',
  'python',
  'ruby',
  'rust',
  'scss',
  'shell',
  'sql',
  'typescript',
  'xml',
  'yaml',
];

/**
 * The top strip: home, the five preset prompts, and the language picker pinned right.
 *
 * Purely presentational — it takes no store and emits `action` instead of running anything.
 * The five buttons are prompts for a model that another panel owns, so a toolbar that called
 * an agent API itself would put a second, non-streaming path into the model beside the chat
 * socket that already drives one.
 */
@Component({
  selector: 'app-workspace-toolbar',
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './workspace-toolbar.component.html',
  styleUrl: './workspace-toolbar.component.scss',
})
export class WorkspaceToolbarComponent {
  /** Monaco language id of the active tab; drives the picker's current value. */
  readonly language = input<string>('plaintext');
  /** Overridable so a sibling panel can swap the list (e.g. for models) without a fork. */
  readonly languages = input<readonly string[]>(WORKSPACE_LANGUAGES);
  /** Name of the file the actions would apply to, shown as the picker's caption. */
  readonly fileName = input<string | null>(null);

  readonly home = output<void>();
  readonly action = output<WorkspaceActionName>();
  readonly languageChange = output<string>();

  protected readonly actions = ACTIONS;

  protected onLanguagePicked(event: Event): void {
    this.languageChange.emit((event.target as HTMLSelectElement).value);
  }
}
