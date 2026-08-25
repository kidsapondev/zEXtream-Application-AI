import os from 'os';

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required env var: ${name}`);
  }
  return value;
}

/**
 * The settings shared by *both* host-bridge entry points: the Express server
 * (`index.ts`) and the stdio MCP server (`mcp-main.ts`).
 *
 * Deliberately contains nothing that can throw at import time. The MCP entry point is
 * launched by an IDE (VS Code, Cursor, Claude Code, ...) purely to talk to the local
 * Ollama model against the sandboxed workspace — it never spawns claude/codex and never
 * serves an HTTP port, so forcing an IDE user to invent a `HOST_BRIDGE_TOKEN` and to
 * point `CLAUDE_EXE_PATH`/`CODEX_EXE_PATH` at real executables before the MCP server
 * would even start is a pure obstacle. Those three stay required — but only for the code
 * that actually needs them (see `config` below).
 */
export const workspaceConfig = {
  /**
   * Root directory the `/workspace/*` filesystem/exec API and the MCP tools are sandboxed
   * to. Deliberately `undefined` (never a default like `os.homedir()` or the repo root)
   * when unset — every workspace route and every MCP tool must treat a missing value as
   * "feature disabled", because defaulting it to *some* real path would silently hand a
   * local LLM read/write access to whatever that path happened to be. The operator must
   * opt in explicitly.
   */
  workspaceRoot: process.env.BRIDGE_WORKSPACE_ROOT || undefined,
  /** Caps both `/workspace/read` responses and `/workspace/write` payloads — without a
   * cap, a single read of a huge log file (or a write from a confused model) could blow
   * up response bodies or the process's memory. */
  maxFileBytes: Number(process.env.BRIDGE_MAX_FILE_BYTES ?? 256_000),
  /**
   * Bare command names `/workspace/exec` (and the MCP agent's `run_command` tool) are
   * allowed to spawn (e.g. `git,npm,pnpm`), comma-separated. Empty by default — exec is
   * off unless the operator deliberately lists commands, because unlike the read/write
   * endpoints (bounded to the workspace root) an arbitrary command can reach anywhere the
   * OS user can.
   */
  execAllowlist: (process.env.BRIDGE_EXEC_ALLOWLIST ?? '')
    .split(',')
    .map((cmd) => cmd.trim().toLowerCase())
    .filter((cmd) => cmd.length > 0),
  /** Wall-clock cap per exec invocation — same reasoning as `chatTimeoutMs`: a hung child
   * process must not hold the request (and the event loop) open forever. */
  execTimeoutMs: Number(process.env.BRIDGE_EXEC_TIMEOUT_MS ?? 60_000),
  /**
   * Where the local Ollama daemon lives, as seen *from this process*. Note this is the
   * host's own view (`localhost`), not the backend container's (`host.docker.internal`) —
   * host-bridge runs on the host, so the two entry points here always reach Ollama
   * directly.
   */
  ollamaBaseUrl: process.env.OLLAMA_BASE_URL || 'http://localhost:11434',
  /**
   * Default model for the MCP `local_code_agent` tool. Optional on purpose: when unset the
   * MCP server picks the first model Ollama reports with the `tools` capability, so a user
   * with exactly one tool-capable model installed needs no configuration at all. Set it
   * when several are installed and the pick matters.
   */
  mcpAgentModel: process.env.MCP_AGENT_MODEL || undefined,
};

export const config = {
  port: Number(process.env.PORT ?? 4171),
  /**
   * Shared secret the backend container must send in `x-bridge-token` — without this,
   * anything that can reach this host port could spawn claude/codex on the operator's
   * behalf.
   *
   * This and the two exe paths below are getters rather than plain properties so that
   * merely *importing* this module doesn't throw. That matters because `mcp-main.ts`
   * imports `workspaceConfig` from this same file and needs none of these three. The
   * fail-fast behaviour of the Express server is unchanged: `index.ts` reads
   * `config.bridgeToken` at module scope (`app.use(requireBridgeToken(...))`), so a
   * missing `HOST_BRIDGE_TOKEN` still aborts startup with the identical error before the
   * process ever listens — it just happens one statement later than it used to.
   */
  get bridgeToken(): string {
    return requireEnv('HOST_BRIDGE_TOKEN');
  },
  get claudeExePath(): string {
    return requireEnv('CLAUDE_EXE_PATH');
  },
  get codexExePath(): string {
    return requireEnv('CODEX_EXE_PATH');
  },
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
  // The workspace/exec/Ollama settings are shared verbatim with the MCP entry point, so
  // they live in `workspaceConfig` above and are spread in here rather than duplicated —
  // `config.workspaceRoot`, `config.maxFileBytes`, etc. keep working exactly as before.
  ...workspaceConfig,
};
