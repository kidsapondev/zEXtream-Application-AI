"""WebStorm's "Search Everywhere", the file half: type a few scattered letters, jump straight
to a file without clicking down the tree.

An overlay rather than a permanent panel — `Input` on top, a `ListView` of ranked matches
below — because it is meant to be summoned, used for one jump, and gone; the app decides how
it is shown and dismissed (a modal screen, an overlay container, whatever fits the rest of the
layout), this widget only owns the query box and the result list. That split is also why this
module never reads a keyboard shortcut to *open* itself: opening is the app's binding to make,
closing is this widget's `Escape` to report.

Nothing here talks to `CoderBackend` directly. It is handed an already-constructed
`FileIndex` and only ever calls `match()` on it (plus `build()` once, lazily, if nobody has
populated the index yet) — the fuzzy-matching logic itself lives in `file_index.py` precisely
so it can be unit-tested without booting Textual at all.
"""

from __future__ import annotations

from rich.text import Text

from textual import on
from textual.app import ComposeResult
from textual.binding import Binding
from textual.containers import Vertical
from textual.message import Message
from textual.widgets import Input, Label, ListItem, ListView

from ..file_index import FileIndex, Match

#: Applied to every character a `Match` reports as matched. Reverse video rather than a named
#: colour: a colour choice is a design decision that belongs to whoever themes this app, and
#: picking one here would either clash with a theme or need updating every time the theme
#: does. "Bold and reversed" reads as "picked out" against any palette without knowing which
#: one is active — the same reason `_log` in `app.py` sticks to a handful of named styles
#: (`red`, `green`, `yellow`) rather than hex values.
_HIGHLIGHT_STYLE = "bold reverse"


def render_path(path: str, positions: tuple[int, ...]) -> Text:
    """A `rich.text.Text` for one result row with the matched characters picked out.

    Built with `Text.stylize` rather than a markup string (e.g. `f"[bold]{path}[/]"`) on
    purpose: a real file path can legally contain `[` or `]` (rare, but the sandbox does not
    forbid it), and Textual markup parses those literally. Styling a `Text` object sidesteps
    escaping entirely — the characters are never re-interpreted, only annotated.
    """
    text = Text(path)
    for position in positions:
        text.stylize(_HIGHLIGHT_STYLE, position, position + 1)
    return text


class FileFinder(Vertical):
    """The query box and ranked result list. Construct with a `FileIndex`, mount it, done."""

    DEFAULT_CSS = """
    FileFinder {
        height: auto;
        max-height: 20;
    }

    FileFinder ListView {
        height: auto;
        max-height: 16;
    }
    """

    # `up`/`down` are not bound by `Input` (it only binds `left`/`right` for cursor movement
    # within the single line — see Input.BINDINGS), so a press while the query box is focused
    # bubbles past it to whichever ancestor does bind the key. Putting the bindings here,
    # rather than on the `ListView`, is what lets the arrow keys move the selection while
    # typing is still going to the `Input` — exactly the split every "type to filter, arrow to
    # pick" launcher uses, this app's own task Input/RichLog focus split included.
    BINDINGS = [
        Binding("escape", "dismiss_finder", "Close", show=False),
        Binding("up", "move_selection(-1)", "Previous", show=False),
        Binding("down", "move_selection(1)", "Next", show=False),
    ]

    class Selected(Message):
        """Posted when a result is chosen — by Enter or by clicking a row."""

        def __init__(self, path: str) -> None:
            self.path = path
            super().__init__()

    class Dismissed(Message):
        """Posted on Escape. Carries nothing; the app already knows what "dismiss" means."""

    def __init__(self, index: FileIndex, *, id: str | None = None) -> None:
        super().__init__(id=id)
        self._index = index
        # Mirrors what is currently on screen, in on-screen order, so `ListView.index` (a
        # position) can be turned back into a `Match` (a path) without re-querying the index
        # on every selection — the same reason `WorkspaceTree` caches listings rather than
        # re-deriving them from the backend on each read.
        self._matches: tuple[Match, ...] = ()

    def compose(self) -> ComposeResult:
        yield Input(placeholder="Go to file…", id="file-finder-input")
        yield ListView(id="file-finder-results")

    async def on_mount(self) -> None:
        if not self._index.paths():
            # Lazily, not eagerly in `__init__`: building is a recursive walk through the
            # backend (see `FileIndex.build`), and `__init__` cannot be async. Guarded on
            # "index is empty" rather than always building, so an app that already built the
            # index once (say, at startup, before the user ever opens the finder) does not
            # pay for a second walk every time this widget is summoned.
            await self._index.build()
        await self._refresh("")
        self.query_one(Input).focus()

    @on(Input.Changed)
    async def _on_query_changed(self, event: Input.Changed) -> None:
        await self._refresh(event.value)

    async def _refresh(self, query: str) -> None:
        self._matches = self._index.match(query)
        results = self.query_one(ListView)
        await results.clear()
        for match in self._matches:
            results.append(ListItem(Label(render_path(match.path, match.positions))))
        if self._matches:
            # `ListView.clear()` drops the selection along with the old rows; without setting
            # it back explicitly, Enter on a freshly-filtered list would have nothing to act
            # on until the user also pressed an arrow key first.
            results.index = 0

    @on(Input.Submitted)
    def _on_submitted(self, event: Input.Submitted) -> None:
        self._select_current()

    @on(ListView.Selected)
    def _on_list_selected(self, event: ListView.Selected) -> None:
        self._select_current()

    def _select_current(self) -> None:
        results = self.query_one(ListView)
        index = results.index
        if index is None or not self._matches:
            return
        self.post_message(self.Selected(self._matches[index].path))

    def action_dismiss_finder(self) -> None:
        self.post_message(self.Dismissed())

    def action_move_selection(self, delta: int) -> None:
        results = self.query_one(ListView)
        if not self._matches:
            return
        current = results.index if results.index is not None else 0
        # Clamped rather than wrapped: wrapping from the last result back to the first (or
        # vice versa) is a keystroke away from silently jumping to a completely different
        # file, which is a worse failure than the cursor simply stopping at either end.
        results.index = max(0, min(len(self._matches) - 1, current + delta))
