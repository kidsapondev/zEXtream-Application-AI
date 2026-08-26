import {
  ChangeDetectionStrategy,
  Component,
  computed,
  inject,
  signal,
} from '@angular/core';
import { DatePipe } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { WorkspaceApiService } from '../workspace-api.service';
import { WorkspaceStore } from '../workspace.store';
import {
  CommandHistory,
  containsShellSyntax,
  parseCommandLine,
} from './terminal-line';

export type DockTab = 'problems' | 'output' | 'terminal' | 'debug';

export interface OutputEntry {
  at: Date;
  text: string;
  kind: 'info' | 'error';
}

export interface TerminalEntry {
  command: string;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  /** Set instead of the rest when the command never reached the host at all. */
  refused?: string;
}

/**
 * The panel across the bottom: problems, output, terminal, debug console.
 *
 * Three of those four have honest empty states rather than invented content, and that is a
 * design decision worth defending. A Problems tab that shows nothing because no analyser is
 * connected looks identical to one that shows nothing because the code is clean — so it says
 * which. A Debug Console with no debugger behind it is a dead tab that reads as broken, so it
 * says that too. Shipping a convincing-looking panel that cannot do anything is worse than
 * shipping one that admits what it is.
 *
 * The terminal is the tab with real behaviour, and the thing to understand about it is that
 * **there is no shell**. `POST /workspace/exec` spawns an executable directly from an
 * operator-controlled allowlist — that is precisely why a browser is allowed to run commands
 * on the host at all. Everything a shell would do for a typed line is either done here (word
 * splitting, quotes) or refused with an explanation (pipes, redirection, `&&`).
 */
@Component({
  selector: 'app-bottom-dock',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [DatePipe, FormsModule],
  templateUrl: './bottom-dock.component.html',
  styleUrl: './bottom-dock.component.scss',
})
export class BottomDockComponent {
  private readonly api = inject(WorkspaceApiService);
  protected readonly store = inject(WorkspaceStore);

  protected readonly active = signal<DockTab>('terminal');
  protected readonly collapsed = signal(false);

  protected readonly output = signal<readonly OutputEntry[]>([]);
  protected readonly terminal = signal<readonly TerminalEntry[]>([]);
  protected readonly running = signal(false);
  protected readonly commandLine = signal('');

  private readonly history = new CommandHistory();

  /**
   * Diagnostics for the Problems tab.
   *
   * Empty for now and deliberately not faked: the language-server integration lives in the
   * terminal application, and nothing in the browser produces diagnostics yet. Exposed as a
   * signal so wiring one up later is an assignment rather than a rewrite.
   */
  protected readonly problems = signal<readonly { path: string; line: number; message: string; severity: 'error' | 'warning' }[]>(
    [],
  );

  protected readonly problemCount = computed(() => this.problems().length);

  protected readonly execEnabled = computed(
    () => this.store.status()?.execEnabled === true,
  );

  protected readonly allowedCommands = computed(
    () => this.store.status()?.allowedCommands ?? [],
  );

  // -- public surface for the rest of the IDE ------------------------------------------

  /** Appends a line to the Output tab. The store and the AI panel both call this. */
  append(text: string, kind: OutputEntry['kind'] = 'info'): void {
    this.output.update((entries) => [...entries, { at: new Date(), text, kind }]);
  }

  show(tab: DockTab): void {
    this.active.set(tab);
    this.collapsed.set(false);
  }

  // -- tabs ------------------------------------------------------------------------------

  protected select(tab: DockTab): void {
    this.active.set(tab);
  }

  protected toggleCollapsed(): void {
    this.collapsed.update((value) => !value);
  }

  protected clearActive(): void {
    if (this.active() === 'terminal') {
      this.terminal.set([]);
    } else if (this.active() === 'output') {
      this.output.set([]);
    }
  }

  // -- terminal --------------------------------------------------------------------------

  protected onKeyDown(event: KeyboardEvent): void {
    if (event.key === 'ArrowUp') {
      const previous = this.history.previous();
      if (previous !== null) {
        event.preventDefault();
        this.commandLine.set(previous);
      }
      return;
    }
    if (event.key === 'ArrowDown') {
      const next = this.history.next();
      if (next !== null) {
        event.preventDefault();
        this.commandLine.set(next);
      }
    }
  }

  protected async submit(): Promise<void> {
    const line = this.commandLine().trim();
    if (!line || this.running()) {
      return;
    }

    this.history.add(line);
    this.commandLine.set('');

    if (!this.execEnabled()) {
      // Named settings rather than a generic refusal: the operator has to edit a specific
      // variable in a specific file, and "permission denied" sends them looking anywhere else.
      this.pushTerminal({
        command: line,
        exitCode: null,
        stdout: '',
        stderr: '',
        timedOut: false,
        refused:
          'Command execution is switched off. Set BRIDGE_EXEC_ALLOWLIST in host-bridge/.env, ' +
          'then restart the host-bridge process.',
      });
      return;
    }

    if (containsShellSyntax(line)) {
      // Refused rather than run: `npm test | grep fail` would otherwise execute as `npm` with
      // `test`, `|` and `grep` as arguments and look like it worked.
      this.pushTerminal({
        command: line,
        exitCode: null,
        stdout: '',
        stderr: '',
        timedOut: false,
        refused:
          'Pipes, redirection and operators are not available — commands run directly, ' +
          'without a shell. Run one command at a time.',
      });
      return;
    }

    const parsed = parseCommandLine(line);
    if (!parsed) {
      return;
    }

    this.running.set(true);
    try {
      const result = await this.api.exec(parsed.command, parsed.args, '');
      // A non-zero exit is data, not a failure. A test suite exiting 1 is exactly what this
      // panel exists to show, and throwing on it would replace the output with a stack trace.
      this.pushTerminal({
        command: line,
        exitCode: result.exitCode,
        stdout: result.stdout,
        stderr: result.stderr,
        timedOut: result.timedOut,
      });
    } catch (error) {
      this.pushTerminal({
        command: line,
        exitCode: null,
        stdout: '',
        stderr: '',
        timedOut: false,
        refused: error instanceof Error ? error.message : String(error),
      });
    } finally {
      this.running.set(false);
    }
  }

  private pushTerminal(entry: TerminalEntry): void {
    this.terminal.update((entries) => [...entries, entry]);
  }
}
