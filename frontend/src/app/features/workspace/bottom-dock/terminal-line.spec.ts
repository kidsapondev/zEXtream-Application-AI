import {
  CommandHistory,
  containsShellSyntax,
  parseCommandLine,
} from './terminal-line';

describe('parseCommandLine', () => {
  it('splits a plain command from its arguments', () => {
    expect(parseCommandLine('git status')).toEqual({
      command: 'git',
      args: ['status'],
    });
  });

  it('keeps a double-quoted argument whole', () => {
    // The case a naive split(' ') gets wrong on the most ordinary command a developer types:
    // four tokens instead of two, the last two of them garbage.
    expect(parseCommandLine('git commit -m "two words"')).toEqual({
      command: 'git',
      args: ['commit', '-m', 'two words'],
    });
  });

  it('keeps a single-quoted argument whole', () => {
    expect(parseCommandLine("python -c 'print(1)'")).toEqual({
      command: 'python',
      args: ['-c', 'print(1)'],
    });
  });

  it('treats an empty quoted string as a real argument', () => {
    expect(parseCommandLine('git commit -m ""')).toEqual({
      command: 'git',
      args: ['commit', '-m', ''],
    });
  });

  it('honours a backslash escape', () => {
    expect(parseCommandLine('echo a\\ b')).toEqual({
      command: 'echo',
      args: ['a b'],
    });
  });

  it('collapses runs of whitespace', () => {
    expect(parseCommandLine('  npm   run    build  ')).toEqual({
      command: 'npm',
      args: ['run', 'build'],
    });
  });

  it('is null for a blank line', () => {
    expect(parseCommandLine('')).toBeNull();
    expect(parseCommandLine('   ')).toBeNull();
  });
});

describe('containsShellSyntax', () => {
  it.each(['a | b', 'a && b', 'a > out.txt', 'a; b', 'echo $HOME', 'a `b`'])(
    'detects %s',
    (line) => {
      expect(containsShellSyntax(line)).toBe(true);
    },
  );

  it('leaves ordinary commands alone', () => {
    expect(containsShellSyntax('git status')).toBe(false);
    expect(containsShellSyntax('python -m pytest -q')).toBe(false);
  });

  it('is checked on the raw line, before parsing hides the operator', () => {
    // Once parsed, a `|` is an ordinary argument and looks perfectly innocent — which is how
    // "a | b" would end up running as `a` with two arguments and appearing to succeed.
    const line = 'npm test | grep fail';

    expect(containsShellSyntax(line)).toBe(true);
    expect(parseCommandLine(line)?.command).toBe('npm');
  });
});

describe('CommandHistory', () => {
  it('walks backwards through previous commands', () => {
    const history = new CommandHistory();
    history.add('git status');
    history.add('npm test');

    expect(history.previous()).toBe('npm test');
    expect(history.previous()).toBe('git status');
    expect(history.previous()).toBeNull();
  });

  it('walks forwards and ends at a blank line', () => {
    // The blank is the input the user was typing before they started browsing; restoring it
    // is what makes down-arrow an escape hatch rather than a dead end.
    const history = new CommandHistory();
    history.add('a');
    history.add('b');
    history.previous();
    history.previous();

    expect(history.next()).toBe('b');
    expect(history.next()).toBe('');
  });

  it('ignores an immediate repeat but keeps alternating commands', () => {
    const history = new CommandHistory();
    history.add('npm test');
    history.add('npm test');
    history.add('git status');
    history.add('npm test');

    expect(history.items).toEqual(['npm test', 'git status', 'npm test']);
  });

  it('ignores blank submissions', () => {
    const history = new CommandHistory();
    history.add('   ');

    expect(history.items).toEqual([]);
  });

  it('drops the oldest entry past its limit', () => {
    const history = new CommandHistory(2);
    history.add('one');
    history.add('two');
    history.add('three');

    expect(history.items).toEqual(['two', 'three']);
  });

  it('resets the browse position on every submission', () => {
    const history = new CommandHistory();
    history.add('one');
    history.previous();
    history.add('two');

    expect(history.previous()).toBe('two');
  });
});
