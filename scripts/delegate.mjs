#!/usr/bin/env node
// scripts/delegate.mjs
//
// A CLI escape hatch for the local-GPU coding agent. `host-bridge/dist/mcp-main.js` is an
// MCP server: it only ever gets a client when an MCP-capable IDE spawns it as part of
// starting a session (see .claude/skills/gpu-workspace-coding/SKILL.md). That means a
// session which just registered the server cannot call it — MCP servers load at session
// start, not on demand. This script is the workaround: it spawns the exact same server as
// a subprocess and speaks JSON-RPC to it directly, so `local_code_agent` (and
// `local_model_status`) are reachable from any shell, right now, no IDE involved.
//
// Zero dependencies, deliberately. The MCP TypeScript SDK is a fine client for a long-lived
// IDE session, but this script makes exactly two requests and one notification per
// invocation — hand-rolling that over stdio is a few dozen lines, not a reason to add a
// dependency to the repo root's package.json.

import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const MCP_MAIN = path.join(REPO_ROOT, 'host-bridge', 'dist', 'mcp-main.js');
const HOST_BRIDGE_ENV = path.join(REPO_ROOT, 'host-bridge', '.env');

// Same env vars mcp-main.ts itself reads (see host-bridge/src/config.ts) — the four that
// govern what local_code_agent is allowed to do. Not the full host-bridge config (PORT,
// HOST_BRIDGE_TOKEN, CLAUDE_EXE_PATH, ...): those belong to the separate Express server and
// the MCP entry point needs none of them (see mcp-main.ts's own comment on this).
const PASSTHROUGH_VARS = [
  'BRIDGE_WORKSPACE_ROOT',
  'OLLAMA_BASE_URL',
  'MCP_AGENT_MODEL',
  'BRIDGE_EXEC_ALLOWLIST',
];

// A local tool loop is slow — cold model load alone can take 90s (see
// OLLAMA_CONNECT_TIMEOUT_MS in ollama-agent.ts) and a multi-step task compounds that across
// several turns — but it is not unbounded. This is a backstop against a model stuck in a
// retry loop against a broken tool call, not a tuning knob for normal runs.
const CALL_TIMEOUT_MS = 15 * 60 * 1000;

// The MCP SDK's Server negotiates down to whichever of SUPPORTED_PROTOCOL_VERSIONS the
// client asked for, and falls back to its own latest if the client's version isn't
// recognised at all (see node_modules/@modelcontextprotocol/sdk's server/index.js
// `_oninitialize`) — so sending the SDK's current LATEST_PROTOCOL_VERSION here just avoids
// an unnecessary fallback on a fresh install. If a future SDK bump introduces a breaking
// change, bump this string too.
const PROTOCOL_VERSION = '2025-11-25';

function fail(message) {
  process.stderr.write(`delegate: ${message}\n`);
  process.exit(1);
}

function printUsage() {
  process.stdout.write(
    [
      'Usage:',
      '  node scripts/delegate.mjs "<task text>"',
      '  node scripts/delegate.mjs --status',
      '  node scripts/delegate.mjs --path <subdir> "<task text>"',
      '  node scripts/delegate.mjs --model <ollama-model> "<task text>"',
      '  node scripts/delegate.mjs --task-file <file>',
      '',
      'Flags:',
      '  --status          Call local_model_status instead of delegating a task.',
      '  --path <subdir>   Scope the task to a subdirectory of BRIDGE_WORKSPACE_ROOT.',
      '  --model <name>    Ollama model to run (defaults to MCP_AGENT_MODEL, then the',
      '                    first installed model with the "tools" capability).',
      '  --task-file <f>   Read the task text from a file instead of argv.',
      '  --json            Print the raw MCP tool result instead of the formatted view.',
      '  -h, --help        Show this message.',
      '',
      'See scripts/README.md for worked examples and when NOT to use this.',
      '',
    ].join('\n'),
  );
}

/** Minimal KEY=VALUE parser for host-bridge/.env — intentionally not `dotenv`. This repo's
 * .env files are flat `KEY=value` lines with `#` comments and the occasional quoted value
 * (see host-bridge/.env.example); nothing here needs interpolation, multiline values, or
 * export syntax, so a few lines of splitting covers the real file. */
function parseEnvFile(content) {
  const vars = {};
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    vars[key] = value;
  }
  return vars;
}

/**
 * Resolves the four passthrough vars from, in priority order, the shell's own environment
 * then host-bridge/.env — the same precedence dotenv itself uses in mcp-main.ts ("dotenv
 * does not override variables already present in the environment"). Reading the file here
 * too (not just leaving it to the child) is what lets this script give an accurate
 * "BRIDGE_WORKSPACE_ROOT is unset" error *before* spawning anything: the child process would
 * also load host-bridge/.env on its own, so checking only `process.env` here would
 * misreport a value that is actually configured.
 */
function resolveEnv() {
  let fileVars = {};
  if (existsSync(HOST_BRIDGE_ENV)) {
    try {
      fileVars = parseEnvFile(readFileSync(HOST_BRIDGE_ENV, 'utf8'));
    } catch (err) {
      // Non-fatal: host-bridge/.env is a convenience default, not the only way to configure
      // this. A shell that already exports everything should still work.
      process.stderr.write(
        `delegate: could not read host-bridge/.env (${err.message}); using the shell environment only.\n`,
      );
    }
  }
  const merged = {};
  for (const key of PASSTHROUGH_VARS) {
    const shellValue = process.env[key];
    merged[key] = shellValue !== undefined && shellValue !== '' ? shellValue : fileVars[key];
  }
  return merged;
}

function parseArgs(argv) {
  const opts = {
    status: false,
    json: false,
    help: false,
    path: undefined,
    model: undefined,
    taskFile: undefined,
    taskParts: [],
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    switch (arg) {
      case '--status':
        opts.status = true;
        break;
      case '--json':
        opts.json = true;
        break;
      case '-h':
      case '--help':
        opts.help = true;
        break;
      case '--path':
        i += 1;
        opts.path = argv[i];
        break;
      case '--model':
        i += 1;
        opts.model = argv[i];
        break;
      case '--task-file':
        i += 1;
        opts.taskFile = argv[i];
        break;
      default:
        opts.taskParts.push(arg);
    }
  }
  return opts;
}

/**
 * Newline-delimited JSON-RPC 2.0 over the child's stdio. A single `data` event on
 * `child.stdout` is not guaranteed to align with message boundaries — a pipe read can split
 * one JSON object across two chunks, or deliver several complete objects in one chunk — so
 * this buffers and splits on `\n` exactly as `readBridgeEvents` does for the host-bridge's
 * own NDJSON stream in backend/src/ai/providers/host-bridge-client.ts. `child.stdout` is
 * never printed raw: every byte on it is protocol, matching the "stdout is the transport"
 * rule documented in mcp-main.ts and tools.ts — printing it directly here would just move
 * the corruption risk from the IDE case to this one.
 */
function createRpcClient(child) {
  let buffer = '';
  const pending = new Map();
  let nextId = 1;

  child.stdout.on('data', (chunk) => {
    buffer += chunk.toString('utf8');
    const lines = buffer.split('\n');
    buffer = lines.pop() ?? '';
    for (const line of lines) {
      if (!line.trim()) continue;
      let message;
      try {
        message = JSON.parse(line);
      } catch {
        // A non-JSON line on stdout would mean the server broke its own "never write to
        // stdout" rule (see tools.ts) or the framing is corrupt; either way there is
        // nothing useful to recover, so drop the line rather than crash the whole call.
        continue;
      }
      if (message.id === undefined || message.id === null) continue; // notification: nothing to resolve
      const waiting = pending.get(message.id);
      if (!waiting) continue;
      pending.delete(message.id);
      if (message.error) {
        waiting.reject(new Error(message.error.message ?? `MCP error ${message.error.code ?? ''}`));
      } else {
        waiting.resolve(message.result);
      }
    }
  });

  // If the server dies mid-call (crash, killed, bad build) nothing will ever satisfy a
  // pending request's promise — without this every such failure would hang until the
  // 15-minute timeout instead of failing immediately with the real reason.
  child.on('exit', (code, signal) => {
    if (pending.size === 0) return;
    const reason = signal ? `signal ${signal}` : `exit code ${code}`;
    for (const { reject } of pending.values()) {
      reject(new Error(`The MCP server process exited unexpectedly (${reason}) before responding.`));
    }
    pending.clear();
  });

  function request(method, params) {
    const id = nextId;
    nextId += 1;
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject });
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    });
  }

  function notify(method, params) {
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method, params })}\n`);
  }

  return { request, notify };
}

/** Renders a CallToolResult the way a human reads at a glance. For `local_code_agent` the
 * server already builds exactly this shape into its one text block — a header line, an "ok
 * /FAIL tool → summary" line per step, a "Stopped (...)" line when the run didn't finish
 * cleanly, then the model's answer (see `formatAgentResult` in host-bridge/src/mcp/tools.ts)
 * — so there is deliberately no re-parsing here beyond deciding the exit code; reformatting
 * text the server already formatted would just be a second place for the two views to
 * drift apart. */
function renderResult(result) {
  const blocks = result.content ?? [];
  return blocks
    .map((block) => (block.type === 'text' ? block.text : `[${block.type} content omitted]`))
    .join('\n');
}

/** True when the run did not reach a normal, clean stop. `isError` covers everything the
 * server itself flags as a tool failure (bad path, unreachable Ollama, ...). It deliberately
 * does NOT cover `local_code_agent` hitting its turn cap: `formatAgentResult` reports
 * `max-turns` as ordinary text, not `isError`, because the steps that ran are real work
 * worth seeing (see the comment in tools.ts on that exact choice) — but from a shell script
 * hitting the turn cap is still "did not finish", so it must still fail the exit code for
 * `&&` chaining to mean anything. The one place that fact is visible from here is the literal
 * "Stopped (...)" line `formatAgentResult` writes for every non-`done` outcome. */
function isUnsuccessful(result, renderedText) {
  if (result.isError) return true;
  return /^Stopped \(/m.test(renderedText);
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));

  if (opts.help || (opts.taskParts.length === 0 && !opts.status && !opts.taskFile)) {
    printUsage();
    process.exit(opts.help ? 0 : 1);
  }

  if (!existsSync(MCP_MAIN)) {
    fail(
      `MCP server not built: ${MCP_MAIN} does not exist.\n` +
        '  Run: pnpm --filter host-bridge build',
    );
  }

  const env = resolveEnv();

  let toolName;
  let toolArgs;
  if (opts.status) {
    toolName = 'local_model_status';
    toolArgs = {};
  } else {
    // Unlike local_model_status (designed to work even when nothing is configured — see
    // tools.ts), local_code_agent needs a real workspace root. Catching this here, before a
    // child process is even spawned, turns "the model never touched a tool and the server
    // said NOT_CONFIGURED" into a message this script's own caller sees immediately.
    if (!env.BRIDGE_WORKSPACE_ROOT) {
      fail(
        'BRIDGE_WORKSPACE_ROOT is not set (checked the shell environment and host-bridge/.env).\n' +
          '  Set it to an absolute path the local model may read and write, e.g. in host-bridge/.env:\n' +
          '    BRIDGE_WORKSPACE_ROOT=C:\\path\\to\\a\\workspace\n' +
          '  Then re-run, or check the rest of the setup with: node scripts/delegate.mjs --status',
      );
    }

    let task;
    if (opts.taskFile) {
      try {
        task = readFileSync(path.resolve(opts.taskFile), 'utf8');
      } catch (err) {
        fail(`Could not read --task-file "${opts.taskFile}": ${err.message}`);
      }
    } else {
      task = opts.taskParts.join(' ');
    }
    if (!task || !task.trim()) {
      fail('No task text given. Pass it as an argument, or via --task-file.');
    }

    toolName = 'local_code_agent';
    toolArgs = { task };
    if (opts.path) toolArgs.path = opts.path;
    if (opts.model) toolArgs.model = opts.model;
  }

  const childEnv = { ...process.env };
  for (const key of PASSTHROUGH_VARS) {
    if (env[key] === undefined) delete childEnv[key];
    else childEnv[key] = env[key];
  }

  // stderr: 'inherit' — the server's stderr is its log channel (see mcp-main.ts), and a
  // human running this from a shell wants to see "[local-gpu-coder] MCP server ready on
  // stdio" and any Ollama connection trouble live, not buffered and replayed after the
  // fact. stdout: 'pipe' — it is the JSON-RPC transport and must never reach the terminal
  // unparsed.
  const child = spawn(process.execPath, [MCP_MAIN], {
    stdio: ['pipe', 'pipe', 'inherit'],
    env: childEnv,
  });

  let childExited = false;
  child.on('exit', () => {
    childExited = true;
  });

  // Belt-and-braces cleanup so an interrupted run (Ctrl+C, a killed parent shell, the
  // 15-minute timeout) never leaves `node dist/mcp-main.js` running in the background,
  // still holding whatever model Ollama loaded for it in VRAM. `'exit'` covers every normal
  // path out of `main()`; the signal handlers cover the case where the process is torn down
  // before that point is ever reached.
  const killChild = () => {
    if (!childExited) {
      try {
        child.kill();
      } catch {
        // Already gone — nothing to do.
      }
    }
  };
  process.on('exit', killChild);
  process.on('SIGINT', () => {
    killChild();
    process.exit(130);
  });
  process.on('SIGTERM', () => {
    killChild();
    process.exit(143);
  });

  const spawnError = await new Promise((resolve) => {
    child.once('error', resolve);
    child.once('spawn', () => resolve(undefined));
  });
  if (spawnError) {
    fail(`Could not launch "${process.execPath} ${MCP_MAIN}": ${spawnError.message}`);
  }

  const rpc = createRpcClient(child);

  // `setTimeout`'s handle must be cleared once the real call settles, win or lose — an
  // un-cleared timer is a pending event, and Node keeps the process alive for as long as
  // any timer is pending. Without this the CLI would sit alive (holding the child open too,
  // since `killChild` only runs after this `try` finishes) for up to the full 15 minutes on
  // every single invocation, timeout or not.
  let timeoutHandle;
  const timeoutPromise = new Promise((_, reject) => {
    timeoutHandle = setTimeout(
      () => reject(new Error(`Timed out after ${CALL_TIMEOUT_MS / 60_000} minutes waiting for the local agent.`)),
      CALL_TIMEOUT_MS,
    );
  });

  try {
    await Promise.race([
      (async () => {
        await rpc.request('initialize', {
          protocolVersion: PROTOCOL_VERSION,
          capabilities: {},
          clientInfo: { name: 'zextream-delegate-cli', version: '0.1.0' },
        });
        // No response expected — per the MCP spec this is a notification, and the server
        // only starts accepting `tools/call` after it arrives.
        rpc.notify('notifications/initialized', {});

        const result = await rpc.request('tools/call', { name: toolName, arguments: toolArgs });

        if (opts.json) {
          process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
        } else {
          process.stdout.write(`${renderResult(result)}\n`);
        }

        process.exitCode = isUnsuccessful(result, renderResult(result)) ? 1 : 0;
      })(),
      timeoutPromise,
    ]);
  } catch (err) {
    process.stderr.write(`delegate: ${err.message}\n`);
    process.exitCode = 1;
  } finally {
    clearTimeout(timeoutHandle);
    killChild();
  }
}

main();
