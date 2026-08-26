"""The review gate's logic, tested against `FakeBackend` only.

Everything here runs without a model, a subprocess, or a real file. That matters more for
this module than for most: `ReviewSession.revert` is the one code path in the app that
*destroys* work — it writes a remembered snapshot back over whatever is on disk now — and a
test suite that needed a real workspace to exercise it would be a test suite nobody runs
before changing it.

The simulated agent run in these tests writes through `backend.files[...]` directly rather
than through `backend.write_file`, so `backend.called("write_file")` stays clean and can be
asserted on as "what the review gate itself wrote". That is the difference between "accept
does nothing" and "accept happens to write the same bytes back".
"""

from __future__ import annotations

import pytest

from local_coder.diff import LineKind
from local_coder.protocols import AgentError
from local_coder.review import FileChange, ReviewSession


@pytest.fixture
def session(backend) -> ReviewSession:
    return ReviewSession(backend)


class TestSnapshot:
    async def test_records_the_content_a_file_had_before_the_run(self, backend, session) -> None:
        await session.snapshot(["src/app.py"])
        backend.files["src/app.py"] = "def main():\n    return 2\n"

        (change,) = await session.capture(["src/app.py"])

        assert change.before == "def main():\n    return 1\n"
        assert change.after == "def main():\n    return 2\n"

    async def test_a_path_that_cannot_be_read_is_recorded_as_absent(
        self, backend, session
    ) -> None:
        # The whole point of snapshotting a path that does not exist yet: a run that creates
        # `new.py` has to be reviewable too, and the only honest baseline for it is "nothing".
        # Raising here instead would make the caller choose between guarding every path and
        # losing the review for exactly the files the model just invented.
        await session.snapshot(["src/new.py"])
        backend.files["src/new.py"] = "VALUE = 3\n"

        (change,) = await session.capture(["src/new.py"])

        assert change.before is None
        assert change.is_new is True

    async def test_snapshotting_twice_keeps_the_original_baseline(
        self, backend, session
    ) -> None:
        # Two runs in a row, with nothing accepted in between. The second snapshot must not
        # overwrite the first, or the first run's output silently becomes the "before" and
        # the user can no longer get back to what *they* wrote.
        await session.snapshot(["src/util.py"])
        backend.files["src/util.py"] = "VALUE = 99\n"
        await session.snapshot(["src/util.py"])
        backend.files["src/util.py"] = "VALUE = 100\n"

        (change,) = await session.capture(["src/util.py"])

        assert change.before == "VALUE = 2\n"


class TestMarkAbsent:
    async def test_marks_a_path_the_run_created_without_reading_it(
        self, backend, session
    ) -> None:
        # The path could not have been snapshotted before the run — its name did not exist
        # yet. Reading it now would capture the model's own output as the baseline and the
        # diff would come out empty, which is why this records `None` without any I/O.
        backend.files["src/made.py"] = "print(1)\n"
        session.mark_absent(["src/made.py"])

        (change,) = await session.capture(["src/made.py"])

        assert change.before is None
        assert change.is_new is True
        assert backend.called("read_file") == [("src/made.py",)]

    async def test_does_not_overwrite_a_real_snapshot(self, backend, session) -> None:
        await session.snapshot(["src/util.py"])
        session.mark_absent(["src/util.py"])
        backend.files["src/util.py"] = "VALUE = 20\n"

        (change,) = await session.capture(["src/util.py"])

        assert change.before == "VALUE = 2\n"
        assert change.is_new is False


class TestCapture:
    async def test_a_modified_file_becomes_a_pending_change_with_counts(
        self, backend, session
    ) -> None:
        await session.snapshot(["src/app.py"])
        backend.files["src/app.py"] = "def main():\n    return 2\n    # note\n"

        captured = await session.capture(["src/app.py"])

        assert captured == session.pending()
        (change,) = captured
        assert change.path == "src/app.py"
        assert (change.added, change.removed) == (2, 1)
        assert any(line.kind is LineKind.HEADER for line in change.lines)

    async def test_a_new_file_is_all_additions(self, backend, session) -> None:
        await session.snapshot(["notes.md"])
        backend.files["notes.md"] = "one\ntwo\n"

        (change,) = await session.capture(["notes.md"])

        assert change.before is None
        assert change.after == "one\ntwo\n"
        assert (change.added, change.removed) == (2, 0)
        assert [line.text for line in change.lines if line.kind is LineKind.ADDED] == [
            "one",
            "two",
        ]

    async def test_a_file_the_model_touched_but_did_not_change_is_not_pending(
        self, backend, session
    ) -> None:
        # `AgentRun.touched_files` lists successful writes, and a model rewriting a file with
        # byte-identical content counts as one. Showing that as a change to review would train
        # the user to hit accept without reading, which defeats the gate.
        await session.snapshot(["README.md"])
        backend.files["README.md"] = "# Sample\n"

        captured = await session.capture(["README.md"])

        assert captured == ()
        assert session.pending() == ()

    async def test_an_unchanged_file_stops_being_snapshotted(self, backend, session) -> None:
        # Its baseline is dropped along with it: keeping a stale snapshot would let a later,
        # unrelated edit be "reverted" to content from an earlier run.
        await session.snapshot(["README.md"])
        await session.capture(["README.md"])
        backend.files["README.md"] = "# Edited by hand\n"

        assert await session.capture(["README.md"]) == ()

    async def test_a_path_with_no_snapshot_is_skipped_and_reported(
        self, backend, session
    ) -> None:
        # Without a baseline there is no safe answer: the file might be brand new, or it might
        # be one the caller forgot to snapshot, and treating the second as the first would let
        # a revert empty a file full of the user's own work. Skipping and saying so is the
        # only option that cannot destroy anything.
        backend.files["src/app.py"] = "def main():\n    return 7\n"

        captured = await session.capture(["src/app.py"])

        assert captured == ()
        assert any("src/app.py" in problem for problem in session.problems())

    async def test_capturing_again_replaces_the_change_in_place(
        self, backend, session
    ) -> None:
        await session.snapshot(["src/app.py", "src/util.py"])
        backend.files["src/app.py"] = "def main():\n    return 2\n"
        backend.files["src/util.py"] = "VALUE = 20\n"
        await session.capture(["src/app.py", "src/util.py"])

        backend.files["src/app.py"] = "def main():\n    return 3\n"
        await session.capture(["src/app.py"])

        # Order is stable so the panel does not jump under the user between runs.
        assert [change.path for change in session.pending()] == ["src/app.py", "src/util.py"]
        assert session.pending()[0].after == "def main():\n    return 3\n"
        assert session.pending()[0].before == "def main():\n    return 1\n"

    async def test_capture_returns_only_what_this_call_found(self, backend, session) -> None:
        await session.snapshot(["src/app.py", "src/util.py"])
        backend.files["src/app.py"] = "def main():\n    return 2\n"
        await session.capture(["src/app.py"])

        backend.files["src/util.py"] = "VALUE = 20\n"
        captured = await session.capture(["src/util.py"])

        assert [change.path for change in captured] == ["src/util.py"]
        assert len(session.pending()) == 2


class TestAccept:
    async def test_accepting_writes_nothing(self, backend, session) -> None:
        await session.snapshot(["src/app.py"])
        backend.files["src/app.py"] = "def main():\n    return 2\n"
        await session.capture(["src/app.py"])

        await session.accept("src/app.py")

        assert backend.called("write_file") == []
        assert backend.files["src/app.py"] == "def main():\n    return 2\n"
        assert session.pending() == ()

    async def test_accepting_forgets_the_baseline_so_a_later_revert_cannot_undo_it(
        self, backend, session
    ) -> None:
        await session.snapshot(["src/app.py"])
        backend.files["src/app.py"] = "def main():\n    return 2\n"
        await session.capture(["src/app.py"])
        await session.accept("src/app.py")

        await session.revert("src/app.py")

        assert backend.files["src/app.py"] == "def main():\n    return 2\n"
        assert backend.called("write_file") == []

    async def test_accept_all_clears_everything_without_writing(
        self, backend, session
    ) -> None:
        await session.snapshot(["src/app.py", "src/util.py"])
        backend.files["src/app.py"] = "def main():\n    return 2\n"
        backend.files["src/util.py"] = "VALUE = 20\n"
        await session.capture(["src/app.py", "src/util.py"])

        await session.accept_all()

        assert session.pending() == ()
        assert backend.called("write_file") == []

    async def test_accepting_an_unknown_path_is_not_an_error(self, session) -> None:
        await session.accept("nothing/here.py")

        assert session.pending() == ()


class TestRevert:
    async def test_reverting_restores_the_exact_previous_bytes(
        self, backend, session
    ) -> None:
        await session.snapshot(["src/app.py"])
        backend.files["src/app.py"] = "def main():\n    return 2\n"
        await session.capture(["src/app.py"])

        await session.revert("src/app.py")

        assert backend.files["src/app.py"] == "def main():\n    return 1\n"
        assert session.pending() == ()

    async def test_reverting_goes_through_the_backend_not_git(
        self, backend, session
    ) -> None:
        # Stated as a test because it is the design decision most likely to be "simplified"
        # later: the workspace root is frequently not a git repo at all, and when it is, the
        # run's edits sit interleaved with the user's own uncommitted work, so `git checkout`
        # would throw away both.
        await session.snapshot(["src/app.py"])
        backend.files["src/app.py"] = "def main():\n    return 2\n"
        await session.capture(["src/app.py"])

        await session.revert("src/app.py")

        assert backend.called("write_file") == [
            ("src/app.py", "def main():\n    return 1\n")
        ]

    async def test_reverting_a_new_file_empties_it_and_says_it_could_not_delete_it(
        self, backend, session
    ) -> None:
        # There is no delete tool on `CoderBackend`, so the file cannot go away. Emptying it
        # is the closest available outcome and the safe one: the model's unreviewed code stops
        # being importable, runnable, and collectable by pytest immediately, and a zero-byte
        # file is obvious in the tree. Silently leaving generated code on disk after the user
        # pressed "revert" would be the one genuinely bad answer.
        await session.snapshot(["src/new.py"])
        backend.files["src/new.py"] = "import os\n"
        await session.capture(["src/new.py"])

        await session.revert("src/new.py")

        assert backend.files["src/new.py"] == ""
        assert session.pending() == ()
        problems = session.problems()
        assert any("src/new.py" in problem for problem in problems)
        assert any("delete" in problem.lower() for problem in problems)

    async def test_revert_all_restores_every_pending_file(self, backend, session) -> None:
        await session.snapshot(["src/app.py", "src/util.py"])
        backend.files["src/app.py"] = "def main():\n    return 2\n"
        backend.files["src/util.py"] = "VALUE = 20\n"
        await session.capture(["src/app.py", "src/util.py"])

        await session.revert_all()

        assert backend.files["src/app.py"] == "def main():\n    return 1\n"
        assert backend.files["src/util.py"] == "VALUE = 2\n"
        assert session.pending() == ()

    async def test_a_backend_failure_is_reported_and_keeps_the_change_pending(
        self, backend, session
    ) -> None:
        # Nothing here may raise into a Textual message handler: an exception in one would
        # take the whole app down while the file on disk is still wrong. The change stays
        # pending so the user can try again once the backend is healthy.
        await session.snapshot(["src/app.py"])
        backend.files["src/app.py"] = "def main():\n    return 2\n"
        await session.capture(["src/app.py"])
        backend.fail_with = AgentError("mcp server exited")

        await session.revert("src/app.py")

        assert [change.path for change in session.pending()] == ["src/app.py"]
        assert any("mcp server exited" in problem for problem in session.problems())

    async def test_revert_all_keeps_going_after_one_file_fails(
        self, backend, session
    ) -> None:
        await session.snapshot(["src/app.py", "src/util.py"])
        backend.files["src/app.py"] = "def main():\n    return 2\n"
        backend.files["src/util.py"] = "VALUE = 20\n"
        await session.capture(["src/app.py", "src/util.py"])

        original_write = backend.write_file

        async def write_file(path: str, text: str) -> None:
            if path == "src/app.py":
                raise AgentError("path rejected")
            await original_write(path, text)

        backend.write_file = write_file  # type: ignore[method-assign]

        await session.revert_all()

        # The healthy file is restored even though the other one failed; stopping at the first
        # failure would leave the user with a half-reverted run and no way to tell which half.
        assert backend.files["src/util.py"] == "VALUE = 2\n"
        assert [change.path for change in session.pending()] == ["src/app.py"]

    async def test_reverting_an_unknown_path_is_not_an_error(self, backend, session) -> None:
        await session.revert("nothing/here.py")

        assert backend.called("write_file") == []
        assert session.pending() == ()


class TestProblems:
    async def test_problems_start_empty_and_can_be_cleared(self, backend, session) -> None:
        assert session.problems() == ()

        await session.capture(["src/app.py"])  # never snapshotted → one problem
        assert len(session.problems()) == 1

        session.clear_problems()
        assert session.problems() == ()


class TestFileChange:
    def test_is_a_frozen_slotted_dataclass(self) -> None:
        # The app hands these to a widget and keeps them in a list; making them immutable is
        # what lets both hold the same object without one of them editing it under the other.
        change = FileChange(
            path="a.py",
            before="one\n",
            after="two\n",
            lines=(),
            added=1,
            removed=1,
        )
        with pytest.raises(AttributeError):
            change.path = "b.py"  # type: ignore[misc]
        with pytest.raises(AttributeError):
            change.extra = 1  # type: ignore[attr-defined]

    def test_is_new_only_when_there_was_no_previous_content(self) -> None:
        assert FileChange("a.py", None, "x\n", (), 1, 0).is_new is True
        # An empty string is not the same as absent: a file that existed and was empty can be
        # reverted by writing "" back, and must not be reported as created by the run.
        assert FileChange("a.py", "", "x\n", (), 1, 0).is_new is False
