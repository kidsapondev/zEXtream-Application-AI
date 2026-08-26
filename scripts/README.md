# scripts/delegate.mjs

A command-line driver for the local-GPU coding agent. It spawns
`host-bridge/dist/mcp-main.js` (the same MCP server an IDE would launch) as a subprocess and
speaks JSON-RPC to it directly over stdio, so `local_code_agent` is reachable from any shell
— no IDE session required. This exists because an MCP server only becomes callable when an
IDE starts a session with it registered; a session that just registered the server can't use
it yet, but this script always can.

Full background on the subsystem (the two entry points, the sandbox, the model quirks) is in
[`.claude/skills/gpu-workspace-coding/SKILL.md`](../.claude/skills/gpu-workspace-coding/SKILL.md).
The [delegation playbook](../.claude/skills/gpu-workspace-coding/SKILL.md#delegation-playbook---claude-plans-the-local-model-types)
in there is the real guidance on *how* to delegate well — read it before using this for
anything beyond a quick test.

## Prerequisites

- `host-bridge/dist/mcp-main.js` built (`pnpm --filter host-bridge build`).
- `BRIDGE_WORKSPACE_ROOT` set, in `host-bridge/.env` or the shell environment, to the folder
  the local model may read and write.
- Ollama running with at least one tool-capable model installed. Run `--status` to check.
- **Commit first.** `BRIDGE_WORKSPACE_ROOT` is a real checkout, not a scratch copy — git is
  the only undo button here.

## Usage

```
node scripts/delegate.mjs "<task text>"
node scripts/delegate.mjs --status
node scripts/delegate.mjs --path <subdir> "<task text>"
node scripts/delegate.mjs --model <ollama-model> "<task text>"
node scripts/delegate.mjs --task-file plan.md
```

Or via the root package script: `pnpm delegate -- --status`, `pnpm delegate -- "<task>"`.

| Flag | Meaning |
|---|---|
| `--status` | Calls `local_model_status` instead of delegating a task — is the workspace configured, is Ollama reachable, which models support tool calling. |
| `--path <subdir>` | Scopes the task to a subdirectory of `BRIDGE_WORKSPACE_ROOT`; the local model's paths become relative to it and it cannot see outside it. |
| `--model <name>` | Ollama model to run, e.g. `qwen2.5-coder:14b`. Defaults to `MCP_AGENT_MODEL`, then the first installed model that reports the `tools` capability. |
| `--task-file <file>` | Reads the task text from a file instead of argv — useful for a multi-paragraph spec. |
| `--json` | Prints the raw MCP tool result instead of the formatted step list. |

Exit code is non-zero whenever the tool call itself failed, or the agent stopped for any
reason other than a clean finish (e.g. it hit its turn cap without finishing) — safe to use
in a `&&` chain.

## Examples

Check the setup before delegating anything:

```
node scripts/delegate.mjs --status
```

Hand off a self-contained, mechanical task, scoped to one subdirectory so the model can't
wander into the rest of the checkout:

```
node scripts/delegate.mjs --path ide "Add a .gitignore entry for *.log files."
```

Pin a specific model and read a longer task from a file:

```
node scripts/delegate.mjs --model qwen2.5-coder:14b --task-file scratch/rename-plan.md
```

## When not to use this

The local model behind `local_code_agent` is a 14B model running on a consumer GPU, not a
frontier model. It is genuinely good at bulk mechanical work — boilerplate, repetitive
edits, first-draft scaffolding, cross-file renames with a clear rule — and genuinely bad at
anything that requires holding several steps of reasoning in mind at once. Don't delegate:
architecture decisions, cross-file debugging, anything security-relevant, or any task where
writing the spec precisely enough *is* the hard part — by the time the task text is that
careful, the frontier model doing the reviewing might as well have just written the code.

Review the diff after every run (`git diff --stat`, then read what changed) rather than
trusting the model's own summary of what it did. If the result is wrong, `git checkout` and
re-delegate a sharper task rather than arguing with it across turns — a 14B model rarely
recovers through discussion.
