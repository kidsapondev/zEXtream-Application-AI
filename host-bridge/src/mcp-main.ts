import path from 'path';
import { config as loadDotenv } from 'dotenv';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createMcpServer } from './mcp/server';

/**
 * stdio entry point for the local-GPU MCP server. An MCP-capable IDE (VS Code, Cursor,
 * Claude Code, JetBrains, Windsurf) spawns `node dist/mcp-main.js` and speaks JSON-RPC to
 * it over stdin/stdout.
 *
 * ## stdout is the protocol
 *
 * Every byte written to stdout is parsed by the client as a JSON-RPC message. One stray
 * line — a `console.log`, a progress bar, a library banner — corrupts the stream and the
 * client drops the connection, usually with an opaque parse error that points nowhere near
 * the actual cause. So: nothing in this process may write to stdout except the transport.
 * Diagnostics go to stderr, which IDEs capture and show as the server's log.
 *
 * The dotenv call below is the concrete instance of that trap: dotenv v17 prints an
 * "injected env (N) from .env" banner to **console.log** by default, which would break
 * every session before the first request. `quiet: true` is load-bearing, not tidiness.
 */

// Explicit path rather than dotenv's default `process.cwd()/.env`: the IDE chooses this
// process's working directory (usually the folder the user has open, not this package), so
// a cwd-relative lookup would silently find nothing and leave BRIDGE_WORKSPACE_ROOT unset.
// `__dirname` is `host-bridge/dist` at runtime, so `..` is the package root — the same
// `host-bridge/.env` the Express server reads and the docs tell users to edit.
// dotenv does not override variables already present in the environment, so an IDE that
// sets them in its own MCP config still wins.
loadDotenv({ path: path.resolve(__dirname, '..', '.env'), quiet: true });

async function main(): Promise<void> {
  const server = createMcpServer();
  const transport = new StdioServerTransport();

  // Close on either signal so the process doesn't outlive the IDE that spawned it and
  // linger holding a stale workspace handle. `close()` ends the transport, which lets the
  // event loop drain and the process exit on its own.
  let shuttingDown = false;
  const shutdown = (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    process.stderr.write(`[local-gpu-coder] received ${signal}, shutting down\n`);
    void server.close().finally(() => process.exit(0));
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  await server.connect(transport);
  process.stderr.write('[local-gpu-coder] MCP server ready on stdio\n');
}

main().catch((err: unknown) => {
  // stderr, never stdout — see the module comment. Exiting non-zero is what makes the IDE
  // show this as a failed server rather than a silently dead one.
  process.stderr.write(`[local-gpu-coder] fatal: ${(err as Error).message}\n`);
  process.exit(1);
});
