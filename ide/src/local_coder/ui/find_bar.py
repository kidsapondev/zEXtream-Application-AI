"""Find and replace inside whichever `TextArea` this bar is currently pointed at.

Deliberately plain substring search, not regex. `workspace-fs.ts`'s search on the Node side
already made this call for the same reason: a user-supplied pattern handed straight to a
regex engine is a ReDoS foot-gun (catastrophic backtracking on an adversarial or just
unlucky pattern can hang the process), and there is no way to tell a "safe" pattern from a
dangerous one without a timeout or a non-backtracking engine, neither of which this widget
has. Plain `str.find` has no such failure mode — it is linear in the size of the haystack no
matter what the needle looks like.

This widget does not own a `TextArea` — it is handed one via `attach()` and searches whatever
that reference currently points at, so a caller (the orchestrator, wiring this into `app.py`)
can re-point the same find bar at a different tab's editor when the active tab changes, rather
than tearing one down and building another.
"""

from __future__ import annotations

from textual import on
from textual.app import ComposeResult
from textual.binding import Binding
from textual.containers import Horizontal
from textual.message import Message
from textual.reactive import reactive
from textual.widget import Widget
from textual.widgets import Button, Checkbox, Input, Static, TextArea
from textual.widgets.text_area import Location, Selection


class FindBar(Widget):
    """A find/replace toolbar. Mount it once; `attach()` points it at the active editor."""

    DEFAULT_CSS = """
    FindBar {
        height: auto;
        border-top: solid $panel-darken-2;
        padding: 0 1;
    }
    FindBar #find_row { height: 1; }
    FindBar #find_query, FindBar #find_replace { width: 24; }
    FindBar #find_status { width: auto; padding: 0 1; color: $text-muted; }
    """

    BINDINGS = [
        Binding("escape", "close", "Close find bar"),
    ]

    class Closed(Message):
        """Posted when the user dismisses the bar — Escape, or the close button."""

    #: Off by default. Most searches in source code are for an identifier whose exact casing
    #: does not matter to the person searching ("where do I use `readFile`" should also find
    #: `ReadFile`) — a case-sensitive default would make the common search miss real matches
    #: silently, which is worse than an insensitive default occasionally over-matching.
    case_sensitive: reactive[bool] = reactive(False)

    def __init__(self, *, id: str | None = None, classes: str | None = None) -> None:
        super().__init__(id=id, classes=classes)
        self._area: TextArea | None = None
        #: (start, end) `Location` pairs for every current match, in document order.
        #: Recomputed from `_area.document.text` on every call that could plausibly need a
        #: fresh answer (the query changed, the case toggle changed, an edit just happened)
        #: rather than kept incrementally in sync with the document — the document sizes this
        #: app deals with are small enough that a full rescan is cheap, and "recompute from
        #: scratch" cannot drift out of sync with the text the way an incremental patch could.
        self._matches: list[tuple[Location, Location]] = []
        #: Index into `_matches` of the match currently selected in the editor.
        #: -1 means "no current match": nothing has been searched yet, the last search found
        #: nothing, or the query just changed and the search is starting over.
        self._current: int = -1

    def compose(self) -> ComposeResult:
        with Horizontal(id="find_row"):
            yield Input(placeholder="Find", id="find_query")
            yield Input(placeholder="Replace with", id="find_replace")
            yield Checkbox("Aa", id="find_case", tooltip="Case sensitive")
            yield Static("", id="find_status")
            yield Button("Prev", id="find_prev", compact=True)
            yield Button("Next", id="find_next", compact=True)
            yield Button("Replace", id="find_replace_one", compact=True)
            yield Button("Replace All", id="find_replace_all", compact=True)
            yield Button("Close", id="find_close", compact=True)

    # -- public surface ------------------------------------------------------------------

    def attach(self, area: TextArea) -> None:
        """Points the bar at a different `TextArea` (e.g. the app switched tabs).

        Restarts the search rather than trying to carry `_current` across — a match index
        into one file's text means nothing against another file's text, and the two
        `TextArea`s are not guaranteed to even share a query that still makes sense.
        """
        self._area = area
        self._current = -1
        self._recompute_matches()

    def find_next(self) -> bool:
        self._recompute_matches()
        if not self._matches:
            return False
        if self._current == -1 or self._current >= len(self._matches) - 1:
            # Wraps around: past the last match goes back to the first, and "nothing
            # selected yet" also starts at the first — both are "begin a forward search".
            self._current = 0
        else:
            self._current += 1
        self._select_current()
        return True

    def find_previous(self) -> bool:
        self._recompute_matches()
        if not self._matches:
            return False
        if self._current <= 0:
            # Wraps around: before the first match (or nothing selected yet) goes to the
            # last — "begin a backward search" lands at the end of the document, which is
            # the standard find-previous behaviour in every editor this mirrors.
            self._current = len(self._matches) - 1
        else:
            self._current -= 1
        self._select_current()
        return True

    def replace_current(self) -> int:
        """Replaces the currently-selected match. Returns 1 if something was replaced, else 0."""
        if self._area is None or self._area.read_only or self._current == -1:
            return 0
        start, end = self._matches[self._current]
        replacement = self._replacement_text()
        # `TextArea.replace` goes through `edit()`, the same API a keystroke uses, so the
        # substitution lands on the undo stack like any ordinary edit. `load_text` would have
        # produced the same visible result but wipes undo history outright (see its own
        # docstring) — that would make "replace, then change your mind" impossible to recover
        # from with a single `undo()`, unlike every other edit in this editor.
        self._area.replace(replacement, start, end)
        self._recompute_matches()
        # The edit invalidated every match's position, `_current` included — land on
        # whichever match now starts at or after the point that was just edited (the next
        # one "from here"), rather than jumping back to the first match in the document.
        self._current = self._first_match_at_or_after(start)
        self._select_current()
        self._refresh_status()
        return 1

    def replace_all(self) -> int:
        """Replaces every match in the document. Returns how many were replaced."""
        if self._area is None or self._area.read_only:
            return 0
        self._recompute_matches()
        matches = list(self._matches)
        if not matches:
            return 0
        replacement = self._replacement_text()
        # Replaced back-to-front. Each `replace` only shifts text *after* the point it
        # edits, so working from the last match to the first means every match earlier in
        # the list is still at the `Location` this widget already computed for it when its
        # turn comes — no offset bookkeeping needed to account for the length difference
        # between the match and its replacement.
        for start, end in reversed(matches):
            self._area.replace(replacement, start, end)
        self._recompute_matches()
        self._current = -1
        self._refresh_status()
        return len(matches)

    @property
    def match_count(self) -> int:
        return len(self._matches)

    @property
    def status_text(self) -> str:
        """What the status label shows: e.g. "3 of 12", "No matches", or "" with no query."""
        if not self._matches:
            return "No matches" if self._query_text() else ""
        if self._current == -1:
            plural = "" if len(self._matches) == 1 else "es"
            return f"{len(self._matches)} match{plural}"
        return f"{self._current + 1} of {len(self._matches)}"

    # -- internals -------------------------------------------------------------------------

    def watch_case_sensitive(self, case_sensitive: bool) -> None:
        self._current = -1
        self._recompute_matches()

    def _query_text(self) -> str:
        try:
            return self.query_one("#find_query", Input).value
        except Exception:
            # Queried before `compose()` has run (e.g. `attach()` called too early). Treated
            # as "no query yet" rather than propagating — a find bar with nothing typed into
            # it yet is not an error state.
            return ""

    def _replacement_text(self) -> str:
        try:
            return self.query_one("#find_replace", Input).value
        except Exception:
            return ""

    def _recompute_matches(self) -> None:
        matches: list[tuple[Location, Location]] = []
        area = self._area
        query = self._query_text()
        if area is not None and query:
            text = area.document.text
            haystack = text if self.case_sensitive else text.lower()
            needle = query if self.case_sensitive else query.lower()
            start = 0
            while True:
                index = haystack.find(needle, start)
                if index == -1:
                    break
                end = index + len(needle)
                matches.append(
                    (
                        area.document.get_location_from_index(index),
                        area.document.get_location_from_index(end),
                    )
                )
                # Non-overlapping matches, same as every mainstream editor's find/replace —
                # searching "aa" in "aaa" finds one match, not two overlapping ones.
                start = end
        self._matches = matches
        if self._current >= len(matches):
            self._current = len(matches) - 1
        self._refresh_status()

    def _select_current(self) -> None:
        if self._area is None or self._current == -1:
            return
        start, end = self._matches[self._current]
        self._area.selection = Selection(start, end)
        self._area.scroll_cursor_visible()
        self._refresh_status()

    def _first_match_at_or_after(self, location: Location) -> int:
        # `Location` is a plain `(row, column)` tuple, and tuple comparison already sorts by
        # row then column — exactly document order — so this needs no custom key.
        for index, (start, _end) in enumerate(self._matches):
            if start >= location:
                return index
        return -1

    def _refresh_status(self) -> None:
        try:
            self.query_one("#find_status", Static).update(self.status_text)
        except Exception:
            pass

    # -- widget events ---------------------------------------------------------------------

    @on(Input.Changed, "#find_query")
    def _on_query_changed(self, event: Input.Changed) -> None:
        event.stop()
        self._current = -1
        self._recompute_matches()

    @on(Input.Submitted, "#find_query")
    def _on_query_submitted(self, event: Input.Submitted) -> None:
        event.stop()
        self.find_next()

    @on(Checkbox.Changed, "#find_case")
    def _on_case_toggled(self, event: Checkbox.Changed) -> None:
        event.stop()
        self.case_sensitive = event.value

    @on(Button.Pressed, "#find_next")
    def _on_next_pressed(self, event: Button.Pressed) -> None:
        event.stop()
        self.find_next()

    @on(Button.Pressed, "#find_prev")
    def _on_prev_pressed(self, event: Button.Pressed) -> None:
        event.stop()
        self.find_previous()

    @on(Button.Pressed, "#find_replace_one")
    def _on_replace_pressed(self, event: Button.Pressed) -> None:
        event.stop()
        self.replace_current()

    @on(Button.Pressed, "#find_replace_all")
    def _on_replace_all_pressed(self, event: Button.Pressed) -> None:
        event.stop()
        self.replace_all()

    @on(Button.Pressed, "#find_close")
    def _on_close_pressed(self, event: Button.Pressed) -> None:
        event.stop()
        self.post_message(self.Closed())

    def action_close(self) -> None:
        self.post_message(self.Closed())
