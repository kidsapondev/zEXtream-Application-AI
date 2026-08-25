---
name: gpu-workspace-coding
description: How the local-GPU coding workspace works in this repo — the Ollama tool-calling loop, the sandboxed host-bridge filesystem/exec API, and how to enable, test, or extend it. Use when working on workspace tools, the Ollama provider's tool loop, host-bridge /workspace/* routes, or when a local model needs new capabilities against real files.
---

# Local-GPU workspace coding

Lets the locally-hosted Ollama model **actually read and write files on the host machine**
instead of only emitting code into the chat transcript. Everything runs on this machine —
no cloud model is involved in this path.

## Two entry points, one sandbox

**A — Web chat.** The backend drives the loop and streams tokens over WebSocket:

```
Browser ─ws─> NestJS backend (Docker)
                 └─ OllamaProvider.streamChat()   ← the tool loop lives here
                      ├─ POST host.docker.internal:11434/api/chat  (tools: [...])
                      └─ WorkspaceToolsService.execute()
                           └─ WorkspaceBridgeClient ─http─> host-bridge (host, :4171)
                                                              └─ /workspace/* → real disk
```

**B — MCP, from an IDE.** The IDE spawns the server; no backend, no Docker, no token
(stdio + IDE-launch is the trust boundary):

```
IDE ─stdio─> host-bridge/dist/mcp-main.js
                ├─ local_workspace_*  ──────> workspace.ts (same sandbox as A)
                └─ local_code_agent ─http──> OLLAMA_BASE_URL
                     └─ runOllamaAgent()  ← the second, non-streaming loop
```

The model never touches disk directly in either path. Every file operation goes through
`resolveInWorkspace`. Runbook for path B: `docs/local-gpu-agent.md`.

## Delegation playbook — Claude plans, the local model types

The point of path B is token economy: hand bulk mechanical work to the GPU instead of
paying a frontier model to emit it. A 500-line edit costs roughly 12k tokens to write
directly versus under 1k to delegate and review.

**Worth delegating:** boilerplate, cross-file renames, format conversions, repetitive
tests, first-pass scaffolding, mechanical refactors with a clear rule.

**Not worth delegating:** architecture, cross-file debugging, anything security-relevant,
anything where the spec is the hard part.

**How to do it well:**

1. **Commit first.** The workspace is a real checkout; git is the only undo.
2. **One concrete step per call.** "Add field `x` to interface `Y` and update every call
   site" works. "Implement auth" does not.
3. **Name the files.** The local model wastes turns exploring; `path` narrows its root.
4. **Review the diff, not the transcript.** `git diff --stat` then read only what changed.
5. **Re-delegate, don't argue.** If the result is wrong, `git checkout` and reissue a
   sharper task — a 14B model rarely recovers through discussion.

MCP servers load at session start, so a newly registered server is not callable in the
session that registered it.

## Key files

| File | Role |
|---|---|
| `backend/src/ai/providers/ollama.provider.ts` | The model→tool→model loop. `MAX_TOOL_TURNS` caps it. |
| `backend/src/ai/tools/workspace-tools.service.ts` | Tool schemas, argument coercion, result formatting. `execute()` **never throws**. |
| `backend/src/ai/tools/workspace-bridge.client.ts` | HTTP client for the bridge. `status()` never throws either. |
| `host-bridge/src/workspace.ts` | **The security boundary.** Path resolution + containment checks. |
| `host-bridge/src/workspace-fs.ts` | list/read/write/search implementations. |
| `host-bridge/src/workspace-routes.ts` | zod-validated `/workspace/*` endpoints. |
| `host-bridge/src/agent/ollama-agent.ts` | The MCP-side loop. Non-streaming (`stream: false`) — the IDE waits for a result. |
| `host-bridge/src/mcp/tools.ts` | The six MCP tools. Handlers are plain data so tests call them directly. |
| `host-bridge/src/mcp-main.ts` | stdio entry point. **Never log to stdout** — that is the MCP transport. |

`text-tool-call-parser.ts` exists **twice**, in `backend/src/ai/providers/` and
`host-bridge/src/agent/`. Neither package can import the other (Docker vs. host, and
host-bridge's `tsc` is rooted at `src/`), so this is a deliberate twin. **Fix bugs in
both.** Only the backend copy carries the streaming buffer logic.

## Enabling it

Two independent opt-ins, both required — this is deliberate, not redundancy:

1. **Backend** (`.env`): `WORKSPACE_BRIDGE_URL=http://host.docker.internal:4171`
   Unset → the backend sends no `tools` field to Ollama at all and the loop collapses to
   a single ordinary turn.
2. **Host** (`host-bridge/.env`): `BRIDGE_WORKSPACE_ROOT=C:\path\to\workspace`
   Unset → every `/workspace/*` route answers 503.

`run_command` is a *third* opt-in: `BRIDGE_EXEC_ALLOWLIST=git,npm,pnpm`. Empty by default.

Restart the backend container after changing `.env`; restart the host-bridge process after
changing `host-bridge/.env`.

## Invariants — do not break these

- **`WorkspaceToolsService.execute()` must never throw.** A bad path or missing argument
  comes back as `{ ok: false }` so the model can correct itself on the next turn. Throwing
  kills the whole chat stream instead.
- **Never default `BRIDGE_WORKSPACE_ROOT`.** Unset means "feature off", never "some real
  path". Defaulting it to `os.homedir()` or the repo root would silently hand a local LLM
  the whole checkout.
- **Never allowlist a shell** (`cmd`, `powershell`, `bash`, `sh`) in `BRIDGE_EXEC_ALLOWLIST`.
  Exec spawns directly with no shell, so allowlisting one lets any command through as an
  argument to it.
- **Path containment is checked twice**: once on the resolved path, then again on the
  `fs.realpath`'d path, to catch a symlink inside the workspace pointing outside it. Both
  checks use `path.relative`, not `startsWith` string math — win32 case-insensitivity.
- **Tool summaries are streamed as prose**, not a new WebSocket event, so they land in the
  saved transcript as an audit trail of what the model touched.

## Model requirements — and the trap

The Ollama model must report the `tools` capability:

```bash
curl -s localhost:11434/api/tags | grep -o '"capabilities":\[[^]]*\]'
```

**But reporting `tools` is not enough, and this is the single biggest gotcha here.**
Verified by hand against Ollama 0.32.15 + `qwen2.5-coder:14b`: given a correct `tools`
payload, the model produces the right call but emits it as *bare JSON in
`message.content`*:

```json
{"name": "read_file", "arguments": {"path": "backend/package.json"}}
```

That model's Ollama template only parses a call back into `tool_calls` when it is wrapped
in `<tool_call></tool_call>` tags. The wrapper is missing, so `tool_calls` never arrives.
Reproduced with and without a system prompt. **The failure mode is silent** — no error,
the tool loop just never fires and the user sees raw JSON in the chat.

`text-tool-call-parser.ts` exists for exactly this. `runTurn` buffers content whose first
non-whitespace characters could still be a call (`{`, `[`, `<tool_call>`, ```` ```json ````)
and resolves it when the turn ends; anything else streams token-by-token as before. A
normal ```` ``` ```` code fence deliberately does **not** trigger buffering — that is the
common case and must keep streaming.

Recovery is conservative and all-or-nothing: a call is only recovered when its `name`
matches a tool offered on that request, so a model legitimately answering with JSON is
never mistaken for a tool call.

If you swap models, **test the real thing** — do not trust the capability flag:

```bash
curl -s localhost:11434/api/chat -H "Content-Type: application/json" \
  --data-binary @scratch/toolcall.json | head -c 500
```

and check whether the call comes back in `message.tool_calls` or in `message.content`.

`qwen2.5-coder:14b` (Q4_K_M, 32k ctx) is the verified working model here. On a 16 GB card
it loads at roughly 93% GPU / 7% CPU — a long tool loop pushes context up and can spill
further to CPU, so drop `num_ctx` before blaming the loop for being slow.

## Testing

```bash
pnpm --filter backend exec jest src/ai        # tool loop + tool service
pnpm --filter host-bridge test                # sandbox + fs + routes
pnpm --filter backend exec eslint "src/ai/**/*.ts"
```

The tool-loop tests (`ollama-tool-loop.spec.ts`) script a **queue** of `/api/chat`
responses, one per turn. The plain streaming tests (`ollama.provider.spec.ts`) script a
single response — keep the two harnesses in separate files.

## Extending: adding a tool

1. Add the schema to `WorkspaceToolsService.definitions()` with an accurate `required` array.
2. Add a handler + a case in `execute()`. Return `fail(...)`, never throw.
3. Add the endpoint to `workspace-routes.ts` (zod-validated) and the operation to
   `workspace-fs.ts`, routing every caller path through `resolveInWorkspace`.
4. Add the method to `WorkspaceBridgeClient`.
5. Tests on both sides, including at least one path-escape rejection.

Local models mangle arguments routinely: numbers where strings are declared, and the whole
arguments object JSON-encoded as a string. `coerceString` / `parseArguments` already handle
both — reuse them rather than trusting the declared type.
