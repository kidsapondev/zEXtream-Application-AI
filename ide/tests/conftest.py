"""Shared fixtures.

The point of this file is that **no test in this suite starts a subprocess, reaches Ollama,
or touches the real workspace.** Most modules here are written by a locally-hosted 14B model
one file at a time, and the test suite is the only signal that tells it whether a change
worked. That signal has to be fast and deterministic: a suite that takes a minute because it
loads a model into VRAM, or that fails because Ollama happens to be busy, teaches the model
nothing and wastes a delegation round.

`FakeBackend` below implements the whole `CoderBackend` protocol against dictionaries, so a
widget test can assert on what the UI did without anything real happening.
"""

from __future__ import annotations

import pytest

from local_coder.protocols import (
    AgentError,
    AgentRun,
    AgentStep,
    CoderBackend,
    Entry,
    EntryKind,
    FileContent,
    ModelStatus,
    SearchHit,
    StopReason,
)


class FakeBackend:
    """In-memory `CoderBackend`.

    Records every call so tests can assert on the interaction, not just the return value —
    "did the editor actually write?" is the question that matters most here, and a fake that
    only returns canned data cannot answer it.

    Deliberately not a `unittest.mock.MagicMock`: a mock accepts any method name, so a typo
    in a delegated module would pass its test and fail only in the real app. This class
    fails loudly on anything the protocol does not declare.
    """

    def __init__(self, files: dict[str, str] | None = None) -> None:
        self.files: dict[str, str] = dict(files or {})
        self.calls: list[tuple[str, tuple[object, ...]]] = []
        # Set by a test to make the next call raise instead of return, for exercising the
        # error paths that are otherwise unreachable without breaking something real.
        self.fail_with: AgentError | None = None
        self.agent_result: AgentRun | None = None
        self.status_result: ModelStatus | None = None

    def _record(self, name: str, *args: object) -> None:
        if self.fail_with is not None:
            self.calls.append((name, args))
            raise self.fail_with
        self.calls.append((name, args))

    def called(self, name: str) -> list[tuple[object, ...]]:
        """Arguments of every call made to `name`, in order."""
        return [args for called_name, args in self.calls if called_name == name]

    async def status(self) -> ModelStatus:
        self._record("status")
        if self.status_result is not None:
            return self.status_result
        return ModelStatus(
            reachable=True,
            workspace_configured=True,
            workspace_root="/fake/workspace",
            models=("qwen2.5-coder:14b",),
            tool_capable_models=("qwen2.5-coder:14b",),
            exec_enabled=True,
            allowed_commands=("git", "python"),
        )

    async def list_dir(self, path: str = "") -> tuple[Entry, ...]:
        self._record("list_dir", path)
        prefix = f"{path}/" if path else ""
        seen: dict[str, Entry] = {}
        for file_path in sorted(self.files):
            if not file_path.startswith(prefix):
                continue
            remainder = file_path[len(prefix) :]
            head, _, tail = remainder.partition("/")
            if not head:
                continue
            full = f"{prefix}{head}"
            if tail:
                seen.setdefault(full, Entry(full, head, EntryKind.DIR))
            else:
                seen.setdefault(
                    full,
                    Entry(full, head, EntryKind.FILE, len(self.files[file_path].encode())),
                )
        # Directories first, then name — the same order the real backend returns, so a
        # widget test that asserts on ordering stays honest.
        return tuple(
            sorted(seen.values(), key=lambda entry: (not entry.is_dir, entry.name))
        )

    async def read_file(self, path: str) -> FileContent:
        self._record("read_file", path)
        if path not in self.files:
            raise AgentError(f"No such file: {path}")
        text = self.files[path]
        return FileContent(path, text, len(text.encode()), truncated=False)

    async def write_file(self, path: str, text: str) -> None:
        self._record("write_file", path, text)
        self.files[path] = text

    async def search(self, query: str, path: str = "") -> tuple[SearchHit, ...]:
        self._record("search", query, path)
        hits: list[SearchHit] = []
        for file_path, text in sorted(self.files.items()):
            if not file_path.startswith(path):
                continue
            for number, line in enumerate(text.splitlines(), start=1):
                if query.lower() in line.lower():
                    hits.append(SearchHit(file_path, number, line))
        return tuple(hits)

    async def run_agent(
        self,
        task: str,
        *,
        path: str | None = None,
        model: str | None = None,
    ) -> AgentRun:
        self._record("run_agent", task, path, model)
        if self.agent_result is not None:
            return self.agent_result
        return AgentRun(
            task=task,
            answer="Done.",
            steps=(AgentStep("write_file", "write_file(a.py) -> 12 bytes", ok=True),),
            stopped=StopReason.DONE,
            turns=2,
        )


@pytest.fixture
def backend() -> FakeBackend:
    return FakeBackend(
        files={
            "README.md": "# Sample\n",
            "src/app.py": "def main():\n    return 1\n",
            "src/util.py": "VALUE = 2\n",
        }
    )


def test_fake_backend_satisfies_the_protocol() -> None:
    """Guards the fake against protocol drift.

    `CoderBackend` is `runtime_checkable`, so this catches the case where a method is added
    to the protocol and the fake is not updated — which would otherwise show up as a
    confusing failure deep inside an unrelated widget test.
    """
    assert isinstance(FakeBackend(), CoderBackend)
