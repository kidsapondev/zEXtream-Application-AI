---
name: gpu-workspace-coding
description: How the local-GPU coding workspace works in this repo — the Ollama tool-calling loop, the sandboxed host-bridge filesystem/exec API, and how to enable, test, or extend it. Use when working on workspace tools, the Ollama provider's tool loop, host-bridge /workspace/* routes, or when a local model needs new capabilities against real files.
---

# Local-GPU workspace coding

Lets the locally-hosted Ollama model **actually read and write files on the host machine**
instead of only emitting code into the chat transcript. Everything runs on this machine —
no cloud model is involved in this path.

## The pipeline

```
Browser ─ws─> NestJS backend (Docker)
                 └─ OllamaProvider.streamChat()   ← the tool loop lives here
                      ├─ POST host.docker.internal:11434/api/chat  (tools: [...])
                      └─ WorkspaceToolsService.execute()
                           └─ WorkspaceBridgeClient ─http─> host-bridge (host, :4171)
                                                              └─ /workspace/* → real disk
```

The model never touches disk directly. Every file operation is a tool call the backend
executes on its behalf, through a single sandboxed HTTP surface.

## Key files

| File | Role |
|---|---|
| `backend/src/ai/providers/ollama.provider.ts` | The model→tool→model loop. `MAX_TOOL_TURNS` caps it. |
| `backend/src/ai/tools/workspace-tools.service.ts` | Tool schemas, argument coercion, result formatting. `execute()` **never throws**. |
| `backend/src/ai/tools/workspace-bridge.client.ts` | HTTP client for the bridge. `status()` never throws either. |
| `host-bridge/src/workspace.ts` | **The security boundary.** Path resolution + containment checks. |
| `host-bridge/src/workspace-fs.ts` | list/read/write/search implementations. |
| `host-bridge/src/workspace-routes.ts` | zod-validated `/workspace/*` endpoints. |

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

## Model requirements

The Ollama model must report the `tools` capability:

```bash
curl -s localhost:11434/api/tags | grep -o '"capabilities":\[[^]]*\]'
```

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
