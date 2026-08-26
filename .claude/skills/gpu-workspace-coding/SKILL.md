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
4. **Write the test first — and prove it is satisfiable.** A delegated task is only as good
   as the test waiting for it. Run the suite yourself against a stub before handing it over.
5. **Review the diff, not the transcript.** `git diff --stat` then read only what changed.
6. **Re-delegate, don't argue.** If the result is wrong, `git checkout` and reissue a
   sharper task — a small model rarely recovers through discussion.

Drive it from any shell with `node scripts/delegate.mjs "<task>"` (see `scripts/README.md`).
An MCP server is only callable once an IDE session starts with it already registered, so the
session that registers it cannot use it — that CLI is the way around that.

### What went wrong the first time, measured

The first real delegation (implement a module against an existing pytest file) failed, and
both causes are worth knowing:

- **The turn cap was too low.** A test-driven loop costs *two* turns per attempt —
  `write_file`, then `run_command pytest` — plus the initial reads. The old cap of 8 bought
  three attempts and cut the run off mid-convergence, not because the model was stuck.
  `MAX_AGENT_TURNS` is now 20 for the MCP loop.
- **The brief was impossible.** Two tests in the spec contradicted each other: one forbade
  any line text starting with `@@`, another required the header line to start with `@@`. No
  model could have passed both. **Run the spec yourself before delegating it.**

What the model actually produced is the useful signal: structure correct (enum, frozen
dataclass, right stdlib call, markers stripped), algorithm wrong (it parsed line numbers out
of each line's *content* instead of counting forward from the hunk header). That is the
characteristic small-model failure — plausible shape, broken reasoning — and it is exactly
what a waiting test catches and a code review of the transcript would not.

### Choosing the model

`/api/tags` reporting the `tools` capability is necessary and not sufficient — see the trap
below. Real weight sizes from the Ollama registry, against a 16 GB card:

| Model | Weights | Fits 16 GB? | Notes |
|---|---|---|---|
| `qwen2.5-coder:14b` | 8.4 GB | yes, easily | Trained for completion/FIM, not agentic loops |
| `devstral:24b` | 13.3 GB | yes, with context headroom | Mistral, built specifically for tool-loop coding |
| `qwen2.5-coder:32b` | 18.5 GB | no — spills to CPU | Strongest of the three, and much slower here |

There is no `qwen2.5-coder:24b`; that line is 0.5/1.5/3/7/14/32b only. Pin the choice with
`MCP_AGENT_MODEL` in `host-bridge/.env` — auto-pick takes the *first* tool-capable model
Ollama lists, which is not the best one.

**Always set `num_ctx`.** Without it Ollama uses the *model's* default, and those defaults
vary enormously. Measured: `devstral:24b` defaults to 131072, whose KV cache took the
resident footprint to 36 GB and forced a 61%/39% CPU/GPU split at ~2.7 tok/s. Pinning 16384
gave 17 GB, 17%/83%, and ~10.4 tok/s — four times faster, same task. Both loops now send it
(`AGENT_NUM_CTX`, `OLLAMA_NUM_CTX`). After changing it, check `ollama ps`, not the clock:
the split is the number that matters.

**Head-to-head on the same task** (implement a module against an existing pytest file):

| Model | Result |
|---|---|
| `qwen2.5-coder:14b` | **Passed.** 5 turns: read spec, read protocols, write, run pytest, green. |
| `devstral:24b` | Failed differently — read both files, wrote a plan, then *ended its turn* without ever calling `write_file`. |

So the bigger, agentic-branded model lost. `devstral` also refuses tool use entirely unless a
system prompt establishes that it has file access (it answers "I can't read files"); with one,
it emits proper structured `tool_calls`, which qwen never does. Neither fact predicted which
one would finish the job. **Benchmark on your actual task before switching** — capability
flags, parameter count, and marketing all failed to.

The delegated module needed a cleanup pass afterwards: correct logic, but three unused
imports and docstrings that were verbatim copies of the task text. Budget for that review;
it is much cheaper than writing the module, but it is not zero.

Two modules have since been delegated successfully with the same recipe (`workspace.py`,
`history.py`) — both in 3–5 turns, both green on the first independent re-run.

### Repetition collapse — the failure that exits 0

`qwen2.5-coder:14b` can fail by *degenerating* rather than by getting the logic wrong: it
emits one enormous unterminated text tool call — one observed case was a ~20 KB `write_file`
blob whose `content` repeated `"tuple from typing import Tuple\ndefaultdict from collections
import defaultdict"` hundreds of times. The call never closes, so text recovery never fires,
the report reads `1 turn(s), 0 tool call(s)` — and **`delegate.mjs` still exits 0**.

Exit status is not a success signal. Check that the file actually changed. The same signature
once landed in a file that was kept: two stray bare-word lines (`tuple`, `type`) sitting at
import level in a delegated module, which parsed and passed its tests.

### Logging

Every delegation writes a transcript. `scripts/delegate.mjs` writes `logs/delegate/<run>.txt`
plus a one-line-per-run `index.txt`; the Textual app writes `logs/ide/<session>.txt`. Both are
gitignored. This is not debug output — a run hands file-writing authority to a model nobody is
watching, and terminal scrollback dies with the window. When a file turns out to be wrong days
later, the transcript is what says whether a model wrote it and under what instruction.

## The third entry point: `ide/`

A Textual terminal IDE (`python -m local_coder`) that is an **MCP client** — it spawns the
same `mcp-main.js` rather than reimplementing anything. That was the load-bearing decision:
the repo already had two tool loops and two copies of the text-tool-call parser, and a third
would also have meant a third path-containment implementation, which is the one piece that
cannot afford a second opinion. See `ide/README.md`.

### Textual 8.2.8 field notes

Paid for one at a time; check here before debugging any of them again.

- **`Static` exposes `.content`, not `.renderable`.**
- **Never name private state `_running` on an `App`** — Textual owns it and sets it True at
  startup, so the guard is permanently closed and swallows work with no error.
- **`RichLog.lines` is empty headless.** Keep your own list if a test must assert on output.
- **A worker started this tick is not yet registered**, so `App.workers.wait_for_complete()`
  can return before it runs. Return the worker and await that.
- **`Tab.label` is parsed as markup.** A literal `[ro]` marker silently disappears — it reads
  as an unknown style tag. Use `(ro)`.
- **`TabbedContent.add_tab` auto-activates the first pane during the `await`**, before the
  calling coroutine resumes. Populate your bookkeeping *before* awaiting, or the first tab's
  activation resolves against state that does not exist yet and `active_path` sticks at None.
- **`Input` does not bind up/down.** For a filter-box-over-a-list (file finder, palette), put
  `up`/`down`/`escape` on the *container*; they bubble there while the Input keeps focus.
- **`ListView.index` is not reset by `clear()`** — set it to 0 after repopulating or Enter
  has nothing to act on. And `ListView`'s own `enter` binding only fires when the ListView
  itself is focused.

### Two traps it hit, both silent

- **`_running` collides with Textual.** `App` already owns that attribute and sets it True
  when the app loop starts, so a guard named `self._running` is permanently true and swallows
  every run without an error. Name private state distinctively in an `App` subclass.
- **dotenv ran after the imports that read env.** `mcp-main.ts` called `loadDotenv(...)` below
  its import block; this package compiles to CommonJS, where the `require`s hoisted from those
  imports run first, so `config.ts` captured an empty environment. It worked only when the
  launcher supplied the variables itself (an IDE's `--env`, or `delegate.mjs`), and reported
  "workspace not configured" for a correctly configured workspace otherwise. The load now
  lives in `host-bridge/src/load-env.ts`, imported first.

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
