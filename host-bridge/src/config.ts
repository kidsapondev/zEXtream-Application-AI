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
};
