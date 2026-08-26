"""The review gate's screen half: one changed file at a time, with a decision attached.

The reason this widget exists is that a run used to end with a list of *filenames*. The model
had already written them, the UI said which ones, and the only way to disagree with any of it
was `git checkout` — which throws away the good edits along with the bad ones, and only works
at all when the workspace happens to be a git repo. A run routinely produces one file worth
keeping and one worth undoing, so a per-file decision is the smallest useful unit.

The panel is deliberately inert. It holds no backend, performs no writes, and knows nothing
about snapshots: it renders a `FileChange` and posts `Accepted` or `Reverted` upward, and the
app turns that into a `ReviewSession` call. Keeping the decision and the rendering in separate
objects is what makes it impossible for a redraw to write to disk.
"""

from __future__ import annotations

from typing import Sequence

from rich.text import Text
from textual import on
from textual.app import ComposeResult
from textual.binding import Binding
from textual.containers import Horizontal, Vertical, VerticalScroll
from textual.message import Message
from textual.widgets import Button, Static

from ..diff import DiffLine, LineKind
from ..review import FileChange

#: Width of each line-number column. Four digits covers every file anyone reviews by hand;
#: a longer number simply pushes the row right rather than being truncated, because losing a
#: digit off a line number is worse than losing the alignment of one row.
_NUMBER_WIDTH = 4

#: Colour per diff row. Rich style names, not Textual CSS variables: these are applied to a
#: `Text` object rather than to a widget, and `$accent` means nothing to Rich.
_ROW_STYLES = {
    LineKind.ADDED: "green",
    LineKind.REMOVED: "red",
    LineKind.HEADER: "bold cyan",
    LineKind.CONTEXT: "",
}

_EMPTY_TITLE = "nothing to review"


def gutter_row(line: DiffLine) -> str:
    """One diff line as `<old> <new> <marker> <text>`.

    Both line numbers are shown, which is the whole reason `diff.py` bothers to attach them:
    reviewing an edit means asking "where in the file I had is this", and a single-column
    gutter can only answer that for one side of the change. A blank in a column says the row
    does not exist on that side — an added line has no position in the old file.

    Returned as plain text and kept as plain text by the caller. The widget's own mirror of
    what it drew has to be readable without a terminal, because a headless test cannot read
    anything back out of a Textual widget once it has been rendered.
    """
    old = f"{line.old_line:>{_NUMBER_WIDTH}}" if line.old_line is not None else " " * _NUMBER_WIDTH
    new = f"{line.new_line:>{_NUMBER_WIDTH}}" if line.new_line is not None else " " * _NUMBER_WIDTH
    # `kind.value` is already the conventional diff marker (` `, `+`, `-`, `@`) — see the
    # comment on `LineKind` — so no lookup table is needed to turn a kind into a glyph.
    return f"{old} {new} {line.kind.value} {line.text}"


class ReviewPanel(Vertical):
    """Shows the pending changes from one run, one file at a time."""

    DEFAULT_CSS = """
    ReviewPanel {
        height: 1fr;
    }

    ReviewPanel #review-title {
        height: 1;
        padding: 0 1;
        background: $panel;
        color: $text;
    }

    ReviewPanel #review-body {
        height: 1fr;
    }

    ReviewPanel #review-diff {
        padding: 0 1;
        width: auto;
    }

    ReviewPanel #review-buttons {
        height: 3;
        padding: 0 1;
    }

    ReviewPanel #review-buttons Button {
        margin-right: 1;
        min-width: 10;
    }
    """

    #: Single letters, not chords. They only fire while this panel has focus, and the app's
    #: task box swallows ordinary typing whenever it is focused instead — so there is no
    #: collision with someone describing a task, and no need to spend a ctrl+key on a review.
    BINDINGS = [
        Binding("n", "next_file", "Next file"),
        Binding("p", "previous_file", "Prev file"),
        Binding("a", "accept", "Accept"),
        Binding("r", "revert", "Revert"),
    ]

    can_focus = True

    class _Decision(Message):
        """Base for the two outcomes, so both carry an identical payload.

        Deliberately a sibling relationship rather than `Reverted(Accepted)`: Textual matches
        a handler against a message with `isinstance`, so making one decision a subclass of
        the other would fire the accept handler on every revert — and the failure would be a
        file quietly kept rather than an exception.
        """

        def __init__(self, panel: "ReviewPanel", change: FileChange) -> None:
            super().__init__()
            self.panel = panel
            self.change = change
            #: Lifted out of `change` because every handler wants it and `event.path` reads
            #: better at the call site than `event.change.path`.
            self.path = change.path

        @property
        def control(self) -> "ReviewPanel":
            """What `@on(ReviewPanel.Accepted, "#review")` matches against."""
            return self.panel

    class Accepted(_Decision):
        """The user kept this file's changes. Nothing needs writing — see `ReviewSession`."""

    class Reverted(_Decision):
        """The user rejected this file's changes and wants the pre-run content back."""

    def __init__(
        self,
        *,
        name: str | None = None,
        id: str | None = None,  # noqa: A002 - Textual's own parameter name
        classes: str | None = None,
        disabled: bool = False,
    ) -> None:
        # The four standard widget arguments are forwarded rather than swallowed: the app
        # mounts this by id and may well want a class on it later, and a widget that quietly
        # drops `classes` is debugged from the stylesheet outwards, which takes a while.
        super().__init__(name=name, id=id, classes=classes, disabled=disabled)
        self._files: list[FileChange] = []
        self._cursor = 0
        #: Plain-text mirror of the rows currently on screen.
        #:
        #: The widget cannot be read back: a `Static`'s rendered output only exists once it
        #: has a size, and a `RichLog` is outright empty in a headless test. Anything that
        #: wants to assert on what the user saw has to be told separately, so it is stored.
        self.rendered_diff: list[str] = []
        #: True once `compose`'s children exist. `show()` is normally called from the host's
        #: `on_mount`, which can run before this widget's children have been mounted, and a
        #: `query_one` then raises. Named distinctively on purpose: `_running` looks like the
        #: obvious name for a flag like this and is already owned by Textual's `App`, where it
        #: is set True at startup and silently defeats every guard written against it.
        self._view_ready = False

    # -- layout ------------------------------------------------------------------------

    def compose(self) -> ComposeResult:
        # `markup=False` on both: a diff row is arbitrary source code, and a file containing
        # `[bold]` or a bare `[` would otherwise be parsed as console markup — either
        # swallowing part of the line or raising in the middle of a render.
        yield Static(_EMPTY_TITLE, id="review-title", markup=False)
        with VerticalScroll(id="review-body"):
            yield Static("", id="review-diff", markup=False)
        with Horizontal(id="review-buttons"):
            yield Button("Prev", id="review-prev")
            yield Button("Next", id="review-next")
            yield Button("Accept", id="review-accept", variant="success")
            yield Button("Revert", id="review-revert", variant="error")

    def on_mount(self) -> None:
        self._view_ready = True
        self._refresh_view()

    # -- state -------------------------------------------------------------------------

    @property
    def changes(self) -> tuple[FileChange, ...]:
        """Everything still awaiting a decision here, in the order it was captured."""
        return tuple(self._files)

    @property
    def index(self) -> int:
        """Position of the file on screen. 0 when there is nothing to show."""
        return self._cursor

    @property
    def current(self) -> FileChange | None:
        if 0 <= self._cursor < len(self._files):
            return self._files[self._cursor]
        return None

    def show(self, changes: Sequence[FileChange]) -> None:
        """Replaces what is on screen with `changes`.

        The app calls this after every run and again after every decision, always with
        `ReviewSession.pending()`. That makes it the point where the panel and the session
        re-synchronise, so it has to be safe to call with a list the panel already has.

        The file being looked at is kept in view if it is still in the list, rather than
        resetting to the top. Resetting would mean that reviewing a five-file run sends you
        back to the first file after every accept, which is how a reviewer starts skimming.
        """
        looking_at = self.current.path if self.current is not None else None
        self._files = list(changes)

        position = None
        if looking_at is not None:
            position = next(
                (i for i, change in enumerate(self._files) if change.path == looking_at),
                None,
            )
        # The file is gone (accepted, reverted, or captured away) — hold the same index so the
        # file that took its place is the one presented, and clamp into the shorter list.
        self._cursor = position if position is not None else self._clamped(self._cursor)
        self._refresh_view()

    def clear(self) -> None:
        """Empties the panel — after a revert-all, or when a new run starts."""
        self.show(())

    def _clamped(self, index: int) -> int:
        if not self._files:
            return 0
        return max(0, min(index, len(self._files) - 1))

    def _drop(self, path: str) -> None:
        """Removes a decided file without waiting for the app to answer.

        The app handles `Accepted`/`Reverted` asynchronously — a revert is a write over stdio
        and takes a moment — and a decided file left on screen in the meantime invites a
        second keypress, which would post a duplicate decision for a file that is already
        gone from the session. `show()` re-synchronises afterwards either way, including in
        the case where the revert failed and the change is still pending.
        """
        self._files = [change for change in self._files if change.path != path]
        self._cursor = self._clamped(self._cursor)
        self._refresh_view()

    # -- rendering ---------------------------------------------------------------------

    def _refresh_view(self) -> None:
        change = self.current
        self.rendered_diff = [gutter_row(line) for line in change.lines] if change else []

        # Computed above regardless, so the mirror is correct even before the children exist;
        # only the drawing needs them.
        if not self._view_ready:
            return

        self.query_one("#review-title", Static).update(self._title(change))
        self.query_one("#review-diff", Static).update(self._body(change))

        has_change = change is not None
        self.query_one("#review-prev", Button).disabled = self._cursor <= 0
        self.query_one("#review-next", Button).disabled = self._cursor >= len(self._files) - 1
        # Disabled rather than hidden: the buttons keep their place, and a decision cannot be
        # posted for a file that is no longer here.
        self.query_one("#review-accept", Button).disabled = not has_change
        self.query_one("#review-revert", Button).disabled = not has_change

    def _title(self, change: FileChange | None) -> str:
        if change is None:
            return _EMPTY_TITLE
        # "new file" is called out because it changes what Revert can do: there is no delete
        # tool behind the backend, so reverting a created file empties it instead of removing
        # it. Saying so before the button is pressed is cheaper than explaining it after.
        created = "  (new file)" if change.is_new else ""
        return (
            f"{change.path}{created}  +{change.added} -{change.removed}  "
            f"({self._cursor + 1}/{len(self._files)})"
        )

    def _body(self, change: FileChange | None) -> Text:
        text = Text()
        if change is None:
            return text
        for line, row in zip(change.lines, self.rendered_diff):
            # Trailing newline per row rather than a join, so the final row still ends the
            # line and `str(...).splitlines()` round-trips back to exactly `rendered_diff`.
            text.append(f"{row}\n", style=_ROW_STYLES.get(line.kind, ""))
        return text

    # -- actions -----------------------------------------------------------------------

    def action_next_file(self) -> None:
        """Moves forward one file, stopping at the last one.

        Clamping, not wrapping. A review is a set of files you have to get through, and a list
        that silently loops back to the start removes the only signal that says you are done.
        """
        if self._cursor < len(self._files) - 1:
            self._cursor += 1
            self._refresh_view()

    def action_previous_file(self) -> None:
        if self._cursor > 0:
            self._cursor -= 1
            self._refresh_view()

    def action_accept(self) -> None:
        change = self.current
        if change is None:
            return
        self.post_message(self.Accepted(self, change))
        self._drop(change.path)

    def action_revert(self) -> None:
        change = self.current
        if change is None:
            return
        self.post_message(self.Reverted(self, change))
        self._drop(change.path)

    # -- buttons -----------------------------------------------------------------------
    #
    # Each handler stops the event. A `Button.Pressed` bubbles, and this panel is mounted
    # inside an app that has its own buttons elsewhere; letting a review button reach the app
    # would make every new button in the app a potential silent handler for this one.

    @on(Button.Pressed, "#review-prev")
    def _on_prev(self, event: Button.Pressed) -> None:
        event.stop()
        self.action_previous_file()

    @on(Button.Pressed, "#review-next")
    def _on_next(self, event: Button.Pressed) -> None:
        event.stop()
        self.action_next_file()

    @on(Button.Pressed, "#review-accept")
    def _on_accept(self, event: Button.Pressed) -> None:
        event.stop()
        self.action_accept()

    @on(Button.Pressed, "#review-revert")
    def _on_revert(self, event: Button.Pressed) -> None:
        event.stop()
        self.action_revert()
