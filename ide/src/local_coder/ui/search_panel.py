"""WebStorm's "Search Everywhere", the text half: search every file in the workspace for a
substring and jump to any hit.

Unlike `FileFinder`, this is not a keystroke-driven filter over data already in memory —
`CoderBackend.search` is a real call to the far side (in the shipped app, a JSON-RPC round
trip to the sandboxed workspace on the other end of MCP), so searching on every keystroke
would mean firing a request per character typed and racing their replies. Search runs once,
on Enter, and the round trip goes through a Textual worker so it never blocks the event loop —
the same reason `LocalCoderApp._run_agent` in `app.py` is a `@work` method rather than an
awaited call directly in the key handler.
"""

from __future__ import annotations

from textual import on, work
from textual.app import ComposeResult
from textual.containers import Vertical
from textual.message import Message
from textual.widgets import Input, Label, ListItem, ListView, Static
from textual.worker import Worker

from ..errors import explain
from ..protocols import AgentError, CoderBackend, SearchHit


def _summary(hits: tuple[SearchHit, ...]) -> str:
    """"12 matches in 4 files" — or the correctly-pluralised singular, since a count that is
    almost always right reads worse than one that is always right.
    """
    files = {hit.path for hit in hits}
    match_word = "match" if len(hits) == 1 else "matches"
    file_word = "file" if len(files) == 1 else "files"
    return f"{len(hits)} {match_word} in {len(files)} {file_word}"


class SearchPanel(Vertical):
    """Query box, a status/summary line, and the hit list grouped by file."""

    DEFAULT_CSS = """
    SearchPanel { height: auto; max-height: 24; }

    SearchPanel ListView { height: auto; max-height: 18; }

    #search-status {
        height: 1;
        padding: 0 1;
        color: $text-muted;
    }

    .search-file-header {
        color: $text-muted;
        text-style: bold;
    }
    """

    class HitSelected(Message):
        """Posted when a hit row is chosen, so the app can open `path` at `line`."""

        def __init__(self, path: str, line: int) -> None:
            self.path = path
            self.line = line
            super().__init__()

    def __init__(self, backend: CoderBackend, *, id: str | None = None) -> None:
        super().__init__(id=id)
        self._backend = backend
        # Parallel to the `ListView`'s children, index for index. A `None` marks a file-name
        # header row rather than a real hit — those exist purely so the list *reads* as
        # grouped by file, and must never turn into a `HitSelected` message no matter what the
        # cursor lands on, so "no hit here" has to be representable, not just "index missing".
        self._rows: list[SearchHit | None] = []

    def compose(self) -> ComposeResult:
        yield Input(
            placeholder="Search files (plain text, not a regex)…",
            id="search-input",
        )
        yield Static("Type a query and press Enter to search.", id="search-status")
        yield ListView(id="search-results")

    @on(Input.Submitted)
    def _on_submitted(self, event: Input.Submitted) -> Worker[None] | None:
        query = event.value.strip()
        if not query:
            # Deliberately not an error state: an empty box is the normal resting state of
            # this panel, not a mistake the user needs a red message about.
            self._set_status("Type a query and press Enter to search.")
            return None
        return self._run_search(query)

    @work(exclusive=True)
    async def _run_search(self, query: str) -> None:
        """Runs one search and renders it. `exclusive=True` cancels an in-flight search
        rather than letting two race — the box only ever shows the query currently in it, so
        an older, slower search finishing after a newer one would silently show stale results
        for a query the user has already changed.
        """
        self._set_status("Searching…")
        results = self.query_one(ListView)
        await results.clear()
        self._rows = []

        try:
            hits = await self._backend.search(query)
        except AgentError as error:
            self._set_status(explain(error))
            return

        if not hits:
            self._set_status(f'No matches for "{query}".')
            return

        self._set_status(_summary(hits))

        current_path: str | None = None
        for hit in hits:
            if hit.path != current_path:
                results.append(ListItem(Label(hit.path), classes="search-file-header"))
                self._rows.append(None)
                current_path = hit.path
            # `.strip()` because a matched line from a real file routinely carries trailing
            # whitespace or the newline itself, and that would otherwise show as a ragged
            # blank tail on the row instead of the line's actual content.
            results.append(ListItem(Label(f"  {hit.line}: {hit.text.strip()}")))
            self._rows.append(hit)

        results.index = next(
            (index for index, row in enumerate(self._rows) if row is not None), None
        )

    @on(ListView.Selected)
    def _on_list_selected(self, event: ListView.Selected) -> None:
        self._select_current()

    def _select_current(self) -> None:
        results = self.query_one(ListView)
        index = results.index
        if index is None or index >= len(self._rows):
            return
        hit = self._rows[index]
        if hit is None:
            # Landed on a file-name header, not an actual match — there is no line to jump
            # to, so this is a deliberate no-op rather than a guess at "the first hit below
            # it" or some other behaviour nobody asked for.
            return
        self.post_message(self.HitSelected(hit.path, hit.line))

    def _set_status(self, text: str) -> None:
        self.query_one("#search-status", Static).update(text)
