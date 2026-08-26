// MUST be the first import. This package compiles to CommonJS, where every `require` an
// import produces runs before any statement in this module's body — so a dotenv call written
// below the imports would run after `./mcp/server` has already pulled in `./config`, which
// reads `process.env` as it evaluates. See load-env.ts for the failure that caused.
import './load-env';
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
 * Loading the `.env` file is the concrete instance of that trap — dotenv v17 announces
 * itself on **console.log** — which is one of two reasons that load lives in `./load-env`
 * rather than here. The other is import ordering; see that module.
 */

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
