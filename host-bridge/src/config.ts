import os from 'os';

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required env var: ${name}`);
  }
  return value;
}

export const config = {
  port: Number(process.env.PORT ?? 4171),
  /** Shared secret the backend container must send in `x-bridge-token` — without this,
   * anything that can reach this host port could spawn claude/codex on the operator's
   * behalf. */
  bridgeToken: requireEnv('HOST_BRIDGE_TOKEN'),
  claudeExePath: requireEnv('CLAUDE_EXE_PATH'),
  codexExePath: requireEnv('CODEX_EXE_PATH'),
  /**
   * Working directory for every spawned claude/codex invocation. Deliberately outside
   * this (or any) git repo and free of any CLAUDE.md/AGENTS.md — end users' chat
   * messages must never inherit this repo's (or any other project's) instructions,
   * memory, or file access.
   */
  neutralCwd: process.env.BRIDGE_NEUTRAL_CWD ?? os.tmpdir(),
  /** Wall-clock cap per CLI invocation — these agent harnesses have no built-in
   * response-time SLA, and a hung child process must not hold a chat request open
   * forever. */
  chatTimeoutMs: Number(process.env.BRIDGE_CHAT_TIMEOUT_MS ?? 120_000),
  /**
   * Root directory the `/workspace/*` filesystem/exec API is sandboxed to. Deliberately
   * `undefined` (never a default like `os.homedir()` or the repo root) when unset — every
   * workspace route must treat a missing value as "feature disabled", because defaulting
   * it to *some* real path would silently hand a local LLM read/write access to whatever
   * that path happened to be. The operator must opt in explicitly.
   */
  workspaceRoot: process.env.BRIDGE_WORKSPACE_ROOT || undefined,
  /** Caps both `/workspace/read` responses and `/workspace/write` payloads — without a
   * cap, a single read of a huge log file (or a write from a confused model) could blow
   * up response bodies or the process's memory. */
  maxFileBytes: Number(process.env.BRIDGE_MAX_FILE_BYTES ?? 256_000),
  /**
   * Bare command names `/workspace/exec` is allowed to spawn (e.g. `git,npm,pnpm`),
   * comma-separated. Empty by default — exec is off unless the operator deliberately
   * lists commands, because unlike the read/write endpoints (bounded to the workspace
   * root) an arbitrary command can reach anywhere the OS user can.
   */
  execAllowlist: (process.env.BRIDGE_EXEC_ALLOWLIST ?? '')
    .split(',')
    .map((cmd) => cmd.trim().toLowerCase())
    .filter((cmd) => cmd.length > 0),
  /** Wall-clock cap per `/workspace/exec` invocation — same reasoning as `chatTimeoutMs`:
   * a hung child process must not hold the request (and the event loop) open forever. */
  execTimeoutMs: Number(process.env.BRIDGE_EXEC_TIMEOUT_MS ?? 60_000),
};
