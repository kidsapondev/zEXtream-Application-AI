import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ToolCallback } from '@modelcontextprotocol/sdk/server/mcp.js';
import { workspaceConfig } from '../config';
import { createMcpTools, McpTool, McpToolDeps } from './tools';

/**
 * Builds the MCP server that exposes the local Ollama model — and the sandboxed workspace
 * it can act on — to any MCP-capable IDE.
 *
 * Wiring only: every behaviour lives in `tools.ts`, so this file changes when the SDK
 * changes and for no other reason.
 *
 * Deliberately imports `workspaceConfig`, not `config`, from `../config`: `config` exposes
 * `HOST_BRIDGE_TOKEN`/`CLAUDE_EXE_PATH`/`CODEX_EXE_PATH` as required-env getters for the
 * Express server, and none of those are needed to talk to a local model. An IDE user
 * should not have to invent a bridge token to run this.
 */

export const MCP_SERVER_NAME = 'local-gpu-coder';
export const MCP_SERVER_VERSION = '0.1.0';

/** Instructions the client may show to its model when deciding what this server is for.
 * Worth spending words on: without it an IDE assistant sees six tool names and no reason
 * to prefer delegating to a local model over just doing the work itself. */
const SERVER_INSTRUCTIONS = [
  'This server runs a coding model locally on the user machine (via Ollama) as an ' +
    'additional agent you can delegate to, plus direct read/write access to one sandboxed ' +
    'workspace folder on that machine.',
  'Use local_code_agent to hand off self-contained, mechanical, or bulky work — repetitive ' +
    'edits across files, scaffolding, boilerplate, first drafts — that would otherwise ' +
    'consume this conversation. It runs entirely on the user hardware at no API cost.',
  'The local model cannot see this conversation, so the "task" argument must carry all the ' +
    'context it needs.',
  'Use the local_workspace_* tools when you want to inspect or edit that folder yourself ' +
    'rather than delegate.',
  'If anything reports a configuration problem, call local_model_status — it works even ' +
    'when nothing is configured and says exactly what is missing.',
].join('\n');

/** Env-backed defaults, split out so `createMcpServer` can be called with overrides from a
 * test without going through `process.env`. */
export function mcpToolDepsFromEnv(): McpToolDeps {
  return {
    workspaceRoot: workspaceConfig.workspaceRoot,
    maxFileBytes: workspaceConfig.maxFileBytes,
    execAllowlist: workspaceConfig.execAllowlist,
    execTimeoutMs: workspaceConfig.execTimeoutMs,
    ollamaBaseUrl: workspaceConfig.ollamaBaseUrl,
    agentModel: workspaceConfig.mcpAgentModel,
  };
}

export function createMcpServer(deps: McpToolDeps = mcpToolDepsFromEnv()): McpServer {
  const server = new McpServer(
    { name: MCP_SERVER_NAME, version: MCP_SERVER_VERSION },
    { capabilities: { tools: {} }, instructions: SERVER_INSTRUCTIONS },
  );

  for (const tool of createMcpTools(deps)) {
    registerTool(server, tool);
  }

  return server;
}

/**
 * `registerTool`'s generics tie the callback's argument type to the specific zod shape
 * passed alongside it. That inference is exactly what you want at an individual call site
 * and impossible to preserve while looping over a heterogeneous array, so the cast is
 * confined to this one function rather than sprayed across six registrations. The runtime
 * contract still holds: the SDK validates each call's arguments against that tool's
 * declared `inputSchema` before the handler ever sees them.
 */
function registerTool(server: McpServer, tool: McpTool): void {
  server.registerTool(
    tool.name,
    tool.config,
    tool.handler as unknown as ToolCallback<typeof tool.config.inputSchema>,
  );
}
