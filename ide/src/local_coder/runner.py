"""Run configurations: named commands a user can fire with one click, with a verdict.

The app can already hand the local model a task and watch it write files, but it cannot run
the result — `CoderBackend.exec` runs one allowlisted command and hands back an `ExecResult`,
and nothing upstream of this module turns that into "here are the runnable things in this
workspace" or "did the tests pass". That is what this module is for, in two pieces:

`Runner.discover()` looks at the files actually present — a `pyproject.toml`, a `package.json`
with a `scripts` object — rather than asking the user to hand-configure anything, WebStorm-style
run configurations usually are. And `Runner.run()` executes one of those through the backend and
extracts a pass/fail count from its output, so the panel above this module can show a verdict
instead of a wall of text the user has to read to the end.

Nothing here imports Textual. `RunPanel` is the only thing that should ever construct widgets;
this module is testable — and was written — against `FakeBackend` alone.
"""

from __future__ import annotations

import json
import re
from dataclasses import dataclass
from time import monotonic

from .protocols import AgentError, CoderBackend, Entry, ExecResult

# --------------------------------------------------------------------------------------
# Data
# --------------------------------------------------------------------------------------


@dataclass(frozen=True, slots=True)
class RunConfig:
    """One runnable thing this workspace offers, as `discover()` found it.

    Frozen and slotted, like every other shape in this package (see `protocols.py`): a run
    config is handed from the runner to the panel and back, and neither side should be able
    to mutate the other's copy. `slots=True` also gives it a stable `__eq__`/`__hash__` pair
    for free, which `discover()` leans on to deduplicate without a second data structure.
    """

    name: str
    command: str
    args: tuple[str, ...] = ()
    cwd: str = ""


@dataclass(frozen=True, slots=True)
class RunOutcome:
    """What came of running one `RunConfig` once.

    Keeps the raw `ExecResult` alongside the parsed counts rather than replacing it, because
    the counts are a best-effort extraction and the panel showing "unrecognised output" still
    needs the actual stdout/stderr to display.
    """

    config: RunConfig
    result: ExecResult
    #: `None` means the output carried no recognisable test summary at all — distinct from
    #: `0`, which means a summary was found and it reported zero. Collapsing the two would
    #: make an unparseable jest/pytest upgrade silently look like "everything passed", which
    #: is the one wrong answer a run panel must never give.
    passed: int | None
    failed: int | None
    duration_s: float

    @property
    def ok(self) -> bool:
        """The pass/fail verdict a user reads at a glance.

        A parsed `failed` count is trusted whenever it says anything at all: it is a more
        direct answer to "did a test fail" than a process exit code, which some runners
        return non-zero for reasons unrelated to test outcomes (a coverage gate, a lint step
        appended to the same script) — and it is a signal `discover()`'s two known formats
        both parse the same way, so it is available far more often than it is not.

        When nothing could be parsed (`failed is None`) there is no second opinion to check
        it against, so the process's own exit code is what is left, and `ExecResult.ok`
        already folds the timed-out case into that correctly — a killed process is not a pass
        just because nobody ever printed a failure count.
        """
        if self.failed:
            return False
        return self.result.ok


# --------------------------------------------------------------------------------------
# Output parsing
# --------------------------------------------------------------------------------------
#
# One function covers both formats this repo actually produces, because both settle on the
# same vocabulary in their final summary line:
#
#   pytest:  "14 passed in 0.02s"            "3 failed, 11 passed in 1.2s"
#   jest:    "Tests:       128 passed, 128 total"
#
# Searching for "<N> passed" / "<N> failed" anywhere in the combined output finds both without
# needing to know which tool produced it — which matters because `RunConfig` does not carry a
# "kind" field, and inventing one just to pick a parser would be structure with no use beyond
# this one function.

_NO_TESTS_RAN = re.compile(r"no tests ran")
_PASSED_COUNT = re.compile(r"(\d+)\s+passed")
_FAILED_COUNT = re.compile(r"(\d+)\s+failed")


def _parse_counts(output: str) -> tuple[int | None, int | None]:
    """Pulls `(passed, failed)` out of pytest/jest summary text, or `(None, None)`.

    pytest prints "no tests ran in 0.00s" when a run collects zero tests — no "passed" or
    "failed" token appears anywhere, so the generic search below would return `(None, None)`
    for it exactly as it would for genuinely unrecognisable output. Those are different
    situations: one is a pytest run this code understood and that happened to find nothing,
    the other is output this code has no opinion about at all. The phrase is checked first so
    the first case comes back as `(0, 0)` — a real, if unexciting, answer — rather than being
    swallowed into "unrecognised".
    """
    if _NO_TESTS_RAN.search(output):
        return 0, 0

    passed_match = _PASSED_COUNT.search(output)
    failed_match = _FAILED_COUNT.search(output)
    if passed_match is None and failed_match is None:
        return None, None

    passed = int(passed_match.group(1)) if passed_match else 0
    failed = int(failed_match.group(1)) if failed_match else 0
    return passed, failed


# --------------------------------------------------------------------------------------
# Runner
# --------------------------------------------------------------------------------------


def _pytest_config(root: str) -> RunConfig:
    name = "pytest" if not root else f"pytest ({root})"
    return RunConfig(name=name, command="python", args=("-m", "pytest", "-q"), cwd=root)


def _npm_config(root: str, script: str) -> RunConfig:
    name = f"npm run {script}" if not root else f"npm run {script} ({root})"
    return RunConfig(name=name, command="npm", args=("run", script), cwd=root)


class Runner:
    """Finds what a workspace can run, and runs it through the backend."""

    def __init__(self, backend: CoderBackend) -> None:
        self._backend = backend
        # Oldest first internally — a plain append is the cheapest way to record a run — and
        # reversed on the way out in `history()`, which is the order every reader actually
        # wants (see `RunHistory.__iter__` for the same call elsewhere in this package).
        self._history: list[RunOutcome] = []

    async def discover(self) -> tuple[RunConfig, ...]:
        """Finds runnable configs by looking at files, not by guessing.

        Only the workspace root and its immediate subdirectories are searched — never a
        recursive walk. Every directory look here is a round trip over MCP/stdio to the
        sandboxed backend, and a real checkout can hold thousands of directories; walking all
        of them before the run panel can show a single button would stall the UI for however
        long that walk takes, for a feature whose whole point is a one-click convenience.
        Nested build tooling (a `pyproject.toml` two levels down) simply is not offered —
        better than a UI that is not responsive enough to open.

        A config is only produced when its command is on `status().allowed_commands`: a
        button that is guaranteed to fail the moment it is pressed is worse than no button,
        because it teaches the user this feature does not work instead of that it is not
        configured for this file.
        """
        status = await self._backend.status()
        allowed = set(status.allowed_commands)

        root_entries = await self._backend.list_dir("")
        roots = [""] + [entry.path for entry in root_entries if entry.is_dir]

        configs: list[RunConfig] = []
        configs.extend(await self._configs_in(root_entries, "", allowed))
        for sub in roots[1:]:
            entries = await self._backend.list_dir(sub)
            configs.extend(await self._configs_in(entries, sub, allowed))

        # `RunConfig` is frozen and slotted, so it is hashable — `dict.fromkeys` deduplicates
        # by value while keeping first-seen order, with no second container to keep in sync.
        unique = tuple(dict.fromkeys(configs))
        return tuple(sorted(unique, key=lambda config: config.name))

    async def _configs_in(
        self, entries: tuple[Entry, ...], root: str, allowed: set[str]
    ) -> list[RunConfig]:
        """Configs found in one directory's listing (`entries`), scoped to `root`."""
        files = {entry.name: entry for entry in entries if not entry.is_dir}
        configs: list[RunConfig] = []

        if "pyproject.toml" in files and "python" in allowed:
            configs.append(_pytest_config(root))

        if "package.json" in files and "npm" in allowed:
            configs.extend(await self._npm_configs(files["package.json"].path, root))

        return configs

    async def _npm_configs(self, manifest_path: str, root: str) -> list[RunConfig]:
        try:
            content = await self._backend.read_file(manifest_path)
            data = json.loads(content.text)
        except (AgentError, ValueError):
            # A manifest that cannot be read or does not parse must not take the rest of
            # discovery down with it — the pytest config found in the same directory, and
            # every config found in every other directory, is still worth offering.
            return []

        scripts = data.get("scripts") if isinstance(data, dict) else None
        if not isinstance(scripts, dict):
            return []
        return [_npm_config(root, script) for script in sorted(scripts)]

    async def run(self, config: RunConfig) -> RunOutcome:
        """Runs `config` through the backend and records the outcome.

        A non-zero exit or a timeout is not raised here — `CoderBackend.exec` already hands
        both back as data on `ExecResult` (see its docstring), and `RunOutcome.ok` is exactly
        what turns that into the verdict a run panel shows. Only an inability to run the
        command at all (rejected by the sandbox, MCP call failed) raises `AgentError`, and
        that is left to propagate to the caller — the panel is the layer that decides how to
        tell a user "this could not even start" versus "this ran and failed".
        """
        started = monotonic()
        result = await self._backend.exec(config.command, config.args, cwd=config.cwd)
        duration = monotonic() - started

        passed, failed = _parse_counts(f"{result.stdout}\n{result.stderr}")
        outcome = RunOutcome(
            config=config,
            result=result,
            passed=passed,
            failed=failed,
            duration_s=duration,
        )
        self._history.append(outcome)
        return outcome

    def history(self) -> tuple[RunOutcome, ...]:
        """Every run made through this instance, newest first."""
        return tuple(reversed(self._history))
