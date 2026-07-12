import { spawn } from 'child_process';

export interface RunResult {
  stdout: string;
  stderr: string;
  code: number | null;
  timedOut: boolean;
}

/** Spawns `exePath args` in `cwd`, collects stdout/stderr, and kills it if it runs
 * longer than `timeoutMs` — a hung claude.exe/codex.exe must not hold a chat request
 * (and the Node event loop) open forever. */
export function runProcess(
  exePath: string,
  args: string[],
  cwd: string,
  timeoutMs: number,
): Promise<RunResult> {
  return new Promise((resolve) => {
    const child = spawn(exePath, args, { cwd });
    // Neither CLI should ever wait on stdin here — closing it immediately avoids codex's
    // "Reading additional input from stdin..." hang (confirmed by hand: it detects a
    // piped, non-TTY stdin and waits to read it unless explicitly closed).
    child.stdin.end();
    let stdout = '';
    let stderr = '';
    let timedOut = false;

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, timeoutMs);

    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8');
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8');
    });

    child.on('error', (err) => {
      clearTimeout(timer);
      resolve({ stdout, stderr: `${stderr}\n${err.message}`, code: null, timedOut });
    });

    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ stdout, stderr, code, timedOut });
    });
  });
}
