"""The review gate: what the run changed, and the ability to say no to part of it.

Before this module existed, a run ended with a list of filenames and no way to disagree with
any single one of them. The only undo available was `git checkout`, which is wrong here twice
over: the workspace root is frequently not a git repo at all — it is whatever folder someone
pointed `BRIDGE_WORKSPACE_ROOT` at — and when it is one, the model's edits sit interleaved
with the user's own uncommitted work, so checking a file out throws away both. A run that
produces one good file and one bad one is the normal case, not the edge case, which is what
makes a per-file decision the unit that matters.

So the undo is built here instead: read each file *before* the run, and if the user rejects
what happened to it, write the remembered bytes back through the same backend the model used.
That has three properties git cannot offer — it works with no version control present, it
touches only the files this run touched, and it goes through the sandbox's path containment
like every other write.

Nothing in here raises on an ordinary failure. Every method is called from a Textual message
handler, and an exception in one of those takes the whole app down while the file on disk is
still wrong; failures come back through `problems()` so the caller can put them on screen.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Iterable

from .diff import DiffLine, summarize, unified_diff
from .protocols import AgentError, CoderBackend


@dataclass(frozen=True, slots=True)
class FileChange:
    """One file, as it was and as it is now, with the diff between them.

    Frozen and slotted because the app keeps these in a list and hands the same objects to a
    widget: two owners, no copies, and no way for the renderer to edit what the session is
    holding. `slots=True` additionally makes a typo like `change.paht = ...` an immediate
    AttributeError instead of a silently ignored assignment.

    `before` is `None` when the file did not exist before the run — distinct from `""`, which
    is a file that existed and was empty. The difference decides what revert is even able to
    do, so it cannot be collapsed into one falsy value.
    """

    path: str
    before: str | None
    after: str
    lines: tuple[DiffLine, ...]
    added: int
    removed: int

    @property
    def is_new(self) -> bool:
        return self.before is None


class ReviewSession:
    """Snapshots files before an agent run, then exposes what changed.

    Holds two maps rather than one. `_before` is the undo material — the bytes to write back —
    and `_pending` is what the user has not yet decided about. They come apart in the case
    that matters: a file captured, then accepted, must lose its baseline immediately, or a
    later revert of an unrelated change could resurrect content the user already approved.
    """

    def __init__(self, backend: CoderBackend) -> None:
        self._backend = backend
        self._before: dict[str, str | None] = {}
        # A dict, not a list: replacing a change keeps its original position (dict assignment
        # to an existing key does not move it), which is what stops the review panel jumping
        # around under the user when a second run touches a file from the first.
        self._pending: dict[str, FileChange] = {}
        self._problems: list[str] = []

    # -- before the run ----------------------------------------------------------------

    async def snapshot(self, paths: Iterable[str]) -> None:
        """Remembers the current contents of `paths`.

        A path already snapshotted is left alone: the first baseline wins. Two runs in a row
        with nothing accepted in between would otherwise make the first run's output the
        "before" of the second, and the user could no longer get back to what they wrote —
        which is the exact moment they most want to.
        """
        for path in paths:
            if path in self._before:
                continue
            self._before[path] = await self._read(path)

    def mark_absent(self, paths: Iterable[str]) -> None:
        """Records `paths` as not having existed, without reading anything.

        The wiring problem this solves: a file the run *creates* cannot be snapshotted in
        advance, because nobody — including the model — knows its name until the run is over.
        By then reading it would capture the model's own output as the baseline, and the diff
        would come out empty.

        What the app *can* know cheaply beforehand is which paths exist, from the directory
        listings the tree already has. So after a run, any touched path that was not in that
        listing is new by construction, and this is how the caller says so: mark it, then
        capture it, and the change comes out with `before=None` and an all-additions diff.

        Synchronous and doing no I/O, deliberately — it is a statement about the past, and
        anything it could read now would be the wrong answer. Paths already snapshotted are
        left alone, on the same "first baseline wins" rule as `snapshot`.
        """
        for path in paths:
            self._before.setdefault(path, None)

    async def _read(self, path: str) -> str | None:
        """Contents of `path`, or `None` when it could not be read.

        A file the run is about to create cannot be read now, and that is the common reason to
        land here — the caller is expected to snapshot paths that may not exist yet, because
        a created file has to be reviewable too. Raising instead would force every caller to
        guard each path and would lose the review for precisely the files the model invented.

        The failure is not distinguishable from a genuine read error, and the consequence is
        worth stating: an unreadable-but-existing file would be reported as newly created,
        and its whole content would render as added lines. That is visible before any button
        is pressed — a diff claiming a familiar file is brand new is an obvious red flag — and
        it is the safer direction to be wrong in, because "new" is the state whose revert does
        not overwrite remembered bytes over anything.
        """
        try:
            content = await self._backend.read_file(path)
        except AgentError:
            return None
        return content.text

    # -- after the run -----------------------------------------------------------------

    async def capture(self, paths: Iterable[str]) -> tuple[FileChange, ...]:
        """Diffs `paths` against their snapshots and queues what actually changed.

        Fed from `AgentRun.touched_files`, which lists successful writes — not files that
        differ. A model rewriting a file with byte-identical content counts as a write there,
        and showing that as something to review would teach the user to press accept without
        reading, which is the one outcome that makes this whole module pointless.

        Returns only what this call found, so a caller can report "2 files changed in this
        run" while `pending()` still carries anything undecided from an earlier one.
        """
        captured: list[FileChange] = []

        for path in paths:
            if path not in self._before:
                # No baseline means no safe answer. The file might be brand new, or it might
                # be one the caller forgot to snapshot — and treating the second as the first
                # would let a revert empty a file full of somebody's own work. Skipping and
                # saying so is the only option here that cannot destroy anything.
                self._problems.append(
                    f"{path}: no snapshot from before the run, so it cannot be diffed or "
                    "reverted here — check it by hand."
                )
                continue

            try:
                content = await self._backend.read_file(path)
            except AgentError as error:
                self._problems.append(f"{path}: could not be read after the run — {error}")
                continue

            before = self._before[path]
            after = content.text
            # A file that did not exist is diffed against nothing, which renders as an
            # all-additions diff — the right thing to show for a file the run created.
            before_text = "" if before is None else before

            if before_text == after:
                # Nothing to decide. The baseline goes too: keeping it would let a later,
                # unrelated edit be "reverted" to content from a run that changed nothing.
                self._forget(path)
                continue

            lines = unified_diff(before_text, after, path=path)
            added, removed = summarize(lines)
            change = FileChange(
                path=path,
                before=before,
                after=after,
                lines=lines,
                added=added,
                removed=removed,
            )
            self._pending[path] = change
            captured.append(change)

        return tuple(captured)

    def pending(self) -> tuple[FileChange, ...]:
        """Everything still awaiting a decision, in the order it was captured."""
        return tuple(self._pending.values())

    # -- decisions ---------------------------------------------------------------------

    async def accept(self, path: str) -> None:
        """Keeps the run's version of `path`.

        Writes nothing — the model already wrote it, so accepting is purely the act of
        forgetting how to undo it. Async despite doing no I/O so that the two decisions have
        the same shape at every call site; a handler that awaits one and not the other is one
        refactor away from awaiting neither.

        An unknown path is a silent no-op: a decision arriving twice (a doubled keypress, a
        button pressed while the panel re-renders) must not be an error.
        """
        self._forget(path)

    async def revert(self, path: str) -> None:
        """Puts `path` back the way it was before the run.

        The snapshot is written back **through the backend**, never by shelling out to git —
        see the module docstring for why git is the wrong tool here even when it is present.

        A file the run created cannot be removed: `CoderBackend` exposes no delete, because
        the sandbox on the far side offers none. It is emptied instead, and the fact is
        reported rather than glossed over. Emptying is the right side to err on — unreviewed
        generated code stops being importable, runnable and collectable the moment the user
        says no, and a zero-byte file is obvious in the tree — but it is not a delete, and a
        user who is told nothing would reasonably assume the file was gone.
        """
        change = self._pending.get(path)
        if change is None:
            return

        restored = "" if change.before is None else change.before

        try:
            await self._backend.write_file(path, restored)
        except AgentError as error:
            # The file on disk is still the model's version, so the change stays pending and
            # can be retried once whatever broke is fixed. Dropping it here would leave the
            # user believing they had undone something they had not.
            self._problems.append(f"{path}: could not be reverted — {error}")
            return

        if change.is_new:
            self._problems.append(
                f"{path}: emptied, not removed — the run created this file and the workspace "
                "has no delete tool, so delete it yourself once you are done looking at it."
            )

        self._forget(path)

    async def accept_all(self) -> None:
        for path in tuple(self._pending):
            await self.accept(path)

    async def revert_all(self) -> None:
        """Undoes every pending change, and keeps going when one of them fails.

        Stopping at the first failure would leave a half-reverted run with no indication of
        which half — the worst possible state to hand back to someone who just said "undo all
        of this". Whatever could not be written stays pending and is listed in `problems()`.
        """
        for path in tuple(self._pending):
            await self.revert(path)

    # -- reporting ---------------------------------------------------------------------

    def problems(self) -> tuple[str, ...]:
        """Everything that went wrong or needs saying, oldest first.

        A return value rather than an exception because every caller is a UI event handler:
        these are things to print in the log, not things to abort on. Each message names the
        path it is about, since by the time it is read it will be sitting in a list of other
        lines about other files.
        """
        return tuple(self._problems)

    def clear_problems(self) -> None:
        """Drops the accumulated messages — call after they have been shown."""
        self._problems.clear()

    def _forget(self, path: str) -> None:
        """Removes a path from both the pending list and the undo material."""
        self._pending.pop(path, None)
        self._before.pop(path, None)
