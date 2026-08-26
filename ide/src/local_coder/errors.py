"""Turning failures into something a person can act on.

The failures this app hits are almost all environmental — a server that was never built, a
model that is not installed, a workspace root nobody set. None of them are bugs, and all of
them have a specific fix. A stack trace in a TUI is both unreadable and unhelpful, so every
error surfaced to the user goes through here first and comes out as "what happened, and the
command that fixes it".
"""

from __future__ import annotations

from .protocols import AgentError, ModelStatus


def explain(error: BaseException) -> str:
    """One line for the status bar, with the fix where there is one."""
    message = str(error).strip() or error.__class__.__name__

    # Matched on substrings the far side actually produces rather than on exception types:
    # everything crossing the MCP boundary arrives as an AgentError, so the type carries no
    # information and the text is all there is to go on.
    lowered = message.lower()
    if "not found" in lowered and "mcp server" in lowered:
        return f"{message}  ·  fix: pnpm --filter host-bridge build"
    if "bridge_workspace_root" in lowered:
        return f"{message}  ·  fix: set BRIDGE_WORKSPACE_ROOT in host-bridge/.env"
    if "could not run 'node'" in lowered:
        return f"{message}  ·  fix: install Node 24+ and reopen"
    if "timed out" in lowered:
        return f"{message}  ·  the model may still be loading; try again"
    return message


def status_problems(status: ModelStatus) -> list[str]:
    """Everything wrong with the current setup, worst first.

    Returned as a list rather than raised, because the app must still start when the setup is
    broken — showing the problems *is* the useful thing it can do in that state. An empty list
    means the local agent is ready to run.
    """
    problems: list[str] = []
    if not status.workspace_configured:
        problems.append(
            "No workspace: set BRIDGE_WORKSPACE_ROOT in host-bridge/.env, then restart."
        )
    if not status.reachable:
        problems.append("Ollama is not reachable: start it with `ollama serve`.")
    elif not status.tool_capable_models:
        # Reachable but useless is a genuinely different state from unreachable, and the fix
        # is a pull rather than a restart — worth saying so instead of collapsing them.
        problems.append(
            "No installed model supports tool calling: `ollama pull qwen2.5-coder:14b`."
        )
    return problems


def format_agent_error(error: AgentError) -> str:
    return explain(error)
