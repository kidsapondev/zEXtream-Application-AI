"""Specification for `local_coder.history`.

The record of what the local model was asked to do in this session, and what came of it.
The UI reads it to fill a history panel; the user reads it to answer "which run touched
that file?".
"""

from __future__ import annotations

from datetime import datetime, timedelta

import pytest

from local_coder.history import HistoryEntry, RunHistory
from local_coder.protocols import AgentRun, AgentStep, StopReason

START = datetime(2026, 8, 26, 9, 0, 0)


def make_run(task: str = "do a thing", *, ok: bool = True, files: tuple[str, ...] = ()) -> AgentRun:
    steps = tuple(
        AgentStep("write_file", f"write_file({name}) -> 10 bytes", ok=True) for name in files
    )
    return AgentRun(
        task=task,
        answer="Done." if ok else "",
        steps=steps,
        stopped=StopReason.DONE if ok else StopReason.MAX_TURNS,
        turns=len(steps) + 1,
    )


class TestRecord:
    def test_returns_the_entry_it_stored(self) -> None:
        history = RunHistory()

        entry = history.record(make_run(), started_at=START, duration_s=12.5)

        assert isinstance(entry, HistoryEntry)
        assert entry.run.task == "do a thing"
        assert entry.started_at == START
        assert entry.duration_s == 12.5

    def test_length_grows_with_each_run(self) -> None:
        history = RunHistory()
        assert len(history) == 0

        history.record(make_run(), started_at=START, duration_s=1.0)
        history.record(make_run(), started_at=START, duration_s=1.0)

        assert len(history) == 2

    def test_entries_are_immutable(self) -> None:
        history = RunHistory()
        entry = history.record(make_run(), started_at=START, duration_s=1.0)

        with pytest.raises((AttributeError, TypeError)):
            entry.duration_s = 99.0  # type: ignore[misc]


class TestOrdering:
    def test_iterates_newest_first(self) -> None:
        # The panel shows the most recent run at the top; putting the ordering here means no
        # widget has to remember to reverse it.
        history = RunHistory()
        history.record(make_run("first"), started_at=START, duration_s=1.0)
        history.record(make_run("second"), started_at=START + timedelta(minutes=1), duration_s=1.0)

        assert [entry.run.task for entry in history] == ["second", "first"]

    def test_latest_is_the_most_recent_run(self) -> None:
        history = RunHistory()
        history.record(make_run("first"), started_at=START, duration_s=1.0)
        history.record(make_run("second"), started_at=START, duration_s=1.0)

        latest = history.latest()
        assert latest is not None
        assert latest.run.task == "second"

    def test_latest_is_none_when_empty(self) -> None:
        assert RunHistory().latest() is None


class TestLimit:
    def test_drops_the_oldest_run_past_the_limit(self) -> None:
        # A long session must not grow without bound; the oldest runs are the least useful.
        history = RunHistory(limit=2)
        history.record(make_run("a"), started_at=START, duration_s=1.0)
        history.record(make_run("b"), started_at=START, duration_s=1.0)
        history.record(make_run("c"), started_at=START, duration_s=1.0)

        assert len(history) == 2
        assert [entry.run.task for entry in history] == ["c", "b"]

    def test_default_limit_is_generous(self) -> None:
        assert RunHistory().limit >= 20


class TestCounts:
    def test_counts_successes_and_failures(self) -> None:
        history = RunHistory()
        history.record(make_run(ok=True), started_at=START, duration_s=1.0)
        history.record(make_run(ok=False), started_at=START, duration_s=1.0)
        history.record(make_run(ok=True), started_at=START, duration_s=1.0)

        assert history.succeeded == 2
        assert history.failed == 1

    def test_counts_are_zero_when_empty(self) -> None:
        history = RunHistory()

        assert history.succeeded == 0
        assert history.failed == 0


class TestTouchedFiles:
    def test_collects_files_across_runs_newest_first(self) -> None:
        history = RunHistory()
        history.record(make_run("a", files=("src/one.py",)), started_at=START, duration_s=1.0)
        history.record(make_run("b", files=("src/two.py",)), started_at=START, duration_s=1.0)

        assert history.touched_files() == ("src/two.py", "src/one.py")

    def test_deduplicates_keeping_the_most_recent_position(self) -> None:
        history = RunHistory()
        history.record(make_run("a", files=("src/one.py",)), started_at=START, duration_s=1.0)
        history.record(
            make_run("b", files=("src/two.py", "src/one.py")), started_at=START, duration_s=1.0
        )

        assert history.touched_files() == ("src/two.py", "src/one.py")

    def test_is_empty_when_nothing_was_written(self) -> None:
        history = RunHistory()
        history.record(make_run(), started_at=START, duration_s=1.0)

        assert history.touched_files() == ()


class TestClear:
    def test_removes_every_entry(self) -> None:
        history = RunHistory()
        history.record(make_run(), started_at=START, duration_s=1.0)

        history.clear()

        assert len(history) == 0
        assert history.latest() is None
        assert history.succeeded == 0
