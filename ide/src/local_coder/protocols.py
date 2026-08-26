"""Contracts every other module in this package is written against.

This file is deliberately the first thing written and the only place these shapes are
defined. Most of the modules around it are produced by a locally-hosted 14B model working
one file at a time (see `.claude/skills/gpu-workspace-coding/SKILL.md`), and a small model
is far better at filling in a function whose inputs and outputs are already pinned down
than at inventing an interface that several other files must agree with. Every type here
exists so a delegated task can be stated as "implement this signature", not "design this".

Nothing in this module imports Textual, asyncio, or anything else beyond the standard
library's typing support: the UI layer must be replaceable without touching the contracts,
and the tests must be able to import this without a running event loop.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from enum import Enum
from typing import Protocol, Sequence, runtime_checkable

# --------------------------------------------------------------------------------------
# Workspace
# --------------------------------------------------------------------------------------


class EntryKind(str, Enum):
    """Inherits from `str` so a value can be compared to and rendered as a plain string.

    Textual widgets and the MCP wire format both want a string here, and a bare `Enum`
    would force a `.value` at every boundary.
    """

    FILE = "file"
    DIR = "dir"


@dataclass(frozen=True, slots=True)
class Entry:
    """One item in a directory listing.

    `path` is always relative to the workspace root and always uses forward slashes, even
    on Windows. The sandbox on the other side of MCP resolves and validates relative POSIX
    paths; handing it a backslash path is the single easiest way to get a confusing
    rejection, so normalisation happens once, here, rather than at each call site.
    """

    path: str
    name: str
    kind: EntryKind
    size: int = 0

    @property
    def is_dir(self) -> bool:
        return self.kind is EntryKind.DIR


@dataclass(frozen=True, slots=True)
class FileContent:
    """The result of reading one file.

    `truncated` is not cosmetic: the sandbox caps reads at a byte limit, and a caller that
    writes back a file it only partially read would silently destroy the tail. Anything
    that offers an edit must refuse to save while this is True.
    """

    path: str
    text: str
    bytes_read: int
    truncated: bool


@dataclass(frozen=True, slots=True)
class SearchHit:
    path: str
    line: int
    text: str


# --------------------------------------------------------------------------------------
# Agent runs
# --------------------------------------------------------------------------------------


class StopReason(str, Enum):
    DONE = "done"
    MAX_TURNS = "max-turns"
    ERROR = "error"


@dataclass(frozen=True, slots=True)
class AgentStep:
    """One tool call the local model made during a run.

    Kept even when `ok` is False. A failed step is the most useful thing on screen when a
    run goes wrong — it is usually a rejected path or a missing argument, and seeing it is
    what tells the user to restate the task rather than retry it unchanged.
    """

    tool: str
    summary: str
    ok: bool


@dataclass(frozen=True, slots=True)
class AgentRun:
    """The outcome of one `local_code_agent` call.

    `steps` may be non-empty even when `stopped` is ERROR or MAX_TURNS — the model can do
    real work and then fail, and those edits are already on disk. The UI must show the
    steps regardless of the stop reason, or a user will not know what was changed before
    the failure.
    """

    task: str
    answer: str
    steps: Sequence[AgentStep] = field(default_factory=tuple)
    stopped: StopReason = StopReason.DONE
    turns: int = 0
    error: str | None = None

    @property
    def succeeded(self) -> bool:
        return self.stopped is StopReason.DONE and self.error is None

    @property
    def touched_files(self) -> tuple[str, ...]:
        """Paths of successful write steps, in the order they happened.

        Drives the "review these files" prompt after a run. Read-only steps are excluded
        on purpose: the point is what changed, not what was looked at.
        """
        return tuple(
            step.summary.split("(", 1)[1].split(")", 1)[0]
            for step in self.steps
            if step.ok and step.tool == "write_file" and "(" in step.summary
        )


@dataclass(frozen=True, slots=True)
class ModelStatus:
    """What `local_model_status` reports, normalised.

    `tool_capable_models` is separate from `models` because advertising the `tools`
    capability does not mean a model actually emits structured tool calls — verified the
    hard way against qwen2.5-coder:14b, which reports the capability and then emits calls
    as plain text. See `text-tool-call-parser.ts` on the Node side. The UI should show both
    lists so a user can tell "no models installed" apart from "no usable model installed".
    """

    reachable: bool
    workspace_configured: bool
    workspace_root: str | None
    models: tuple[str, ...] = ()
    tool_capable_models: tuple[str, ...] = ()
    exec_enabled: bool = False
    allowed_commands: tuple[str, ...] = ()


# --------------------------------------------------------------------------------------
# The one service boundary
# --------------------------------------------------------------------------------------


class AgentError(RuntimeError):
    """Raised when the far side could not carry out a request at all.

    Deliberately distinct from a *failed* result: a rejected path or a model that gave up
    comes back as data (`AgentRun` with a non-DONE `stopped`, or `ok=False` on a step),
    because the user can act on those. This exception is for the cases where there is no
    result to show — the server died, the handshake failed, the call timed out.
    """


@runtime_checkable
class CoderBackend(Protocol):
    """Everything the UI is allowed to do to the outside world.

    One narrow Protocol rather than a concrete class, for two reasons. Tests substitute an
    in-memory fake and never spawn a subprocess or reach Ollama, which keeps the suite fast
    enough to run on every delegated change. And the real implementation talks to an MCP
    server over stdio today, but that is an implementation detail — nothing in the UI
    should know it, so nothing here mentions MCP, JSON-RPC, or subprocesses.

    Every method is async because the real backend is I/O-bound and Textual runs an event
    loop: a blocking call inside a widget handler freezes the whole interface, and an agent
    run routinely takes minutes.
    """

    async def status(self) -> ModelStatus: ...

    async def list_dir(self, path: str = "") -> tuple[Entry, ...]: ...

    async def read_file(self, path: str) -> FileContent: ...

    async def write_file(self, path: str, text: str) -> None: ...

    async def search(self, query: str, path: str = "") -> tuple[SearchHit, ...]: ...

    async def run_agent(
        self,
        task: str,
        *,
        path: str | None = None,
        model: str | None = None,
    ) -> AgentRun: ...
