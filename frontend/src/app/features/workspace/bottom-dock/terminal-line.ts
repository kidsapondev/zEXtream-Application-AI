/**
 * Turning a typed line into a command and its arguments.
 *
 * There is no shell on the other side. `POST /workspace/exec` spawns the executable directly
 * — that is the whole reason the sandbox can offer command execution at all — so nothing
 * expands globs, splits words, or interprets quotes unless this file does it.
 *
 * The consequence worth stating plainly: `git commit -m "two words"` is one command and two
 * arguments, and a naive `split(' ')` turns it into four, the last two of which are garbage.
 * Quote handling here is not a nicety; without it the most ordinary command a developer types
 * silently does the wrong thing.
 */

export interface ParsedCommand {
  command: string;
  args: string[];
}

/**
 * Splits a typed line the way a shell would split a simple one: on whitespace, honouring
 * single and double quotes, with a backslash escaping the next character.
 *
 * Deliberately *not* a shell parser. Pipes, redirection, `&&`, variable expansion and
 * subshells are not supported and are not silently dropped either — `containsShellSyntax`
 * below detects them so the UI can say why they will not work, rather than running half of
 * what was typed. Running `a | b` as the single command `a` with arguments `|` and `b` is
 * the kind of surprise that ends with someone believing a pipeline succeeded.
 */
export function parseCommandLine(line: string): ParsedCommand | null {
  const tokens: string[] = [];
  let current = '';
  let started = false;
  let quote: '"' | "'" | null = null;

  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];

    if (char === '\\' && index + 1 < line.length) {
      current += line[index + 1];
      started = true;
      index += 1;
      continue;
    }

    if (quote) {
      if (char === quote) {
        quote = null;
      } else {
        current += char;
      }
      continue;
    }

    if (char === '"' || char === "'") {
      quote = char;
      // An empty quoted string is still an argument: `git commit -m ""` passes one.
      started = true;
      continue;
    }

    if (/\s/.test(char)) {
      if (started) {
        tokens.push(current);
        current = '';
        started = false;
      }
      continue;
    }

    current += char;
    started = true;
  }

  if (started) {
    tokens.push(current);
  }

  if (tokens.length === 0) {
    return null;
  }
  const [command, ...args] = tokens;
  return { command, args };
}

/** Shell constructs the sandbox cannot honour, so the UI can explain rather than mislead. */
const SHELL_SYNTAX = /[|;&><`$]|\|\||&&/;

export function containsShellSyntax(line: string): boolean {
  // Checked on the raw line rather than on the parsed tokens: by the time it is parsed, a `|`
  // has already become an ordinary argument and looks perfectly innocent.
  return SHELL_SYNTAX.test(line);
}

/**
 * A bounded, de-duplicated command history.
 *
 * De-duplicated only against the immediately previous entry, the way a shell's `ignoredups`
 * behaves: someone re-running the same test command five times in a row wants one entry to
 * scroll back to, but two different commands alternating are both worth keeping.
 */
export class CommandHistory {
  private entries: string[] = [];
  private cursor = 0;

  constructor(private readonly limit = 100) {}

  get items(): readonly string[] {
    return this.entries;
  }

  add(line: string): void {
    const trimmed = line.trim();
    if (!trimmed) {
      return;
    }
    if (this.entries[this.entries.length - 1] !== trimmed) {
      this.entries.push(trimmed);
      if (this.entries.length > this.limit) {
        this.entries.shift();
      }
    }
    // Every submission resets the scrollback position, so the next up-arrow starts from the
    // most recent command rather than from wherever the last browse left off.
    this.cursor = this.entries.length;
  }

  /** The previous command, or `null` at the start of history. */
  previous(): string | null {
    if (this.cursor === 0) {
      return null;
    }
    this.cursor -= 1;
    return this.entries[this.cursor] ?? null;
  }

  /**
   * The next command, or `''` once past the newest — which is the blank input the user was
   * typing before they started browsing, and restoring it is what makes down-arrow feel like
   * an escape hatch rather than a dead end.
   */
  next(): string | null {
    if (this.cursor >= this.entries.length) {
      return null;
    }
    this.cursor += 1;
    return this.cursor >= this.entries.length ? '' : this.entries[this.cursor];
  }
}
