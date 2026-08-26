"""Multiple open files, each in its own tab, each with its own `TextArea`.

The app used to hold exactly one open file (`app.py`'s old `_open_path` / `#editor`
single-widget setup) — editing a second file meant losing your place in the first, with no
warning if the first one was unsaved. `EditorTabs` replaces that with several files open at
once, each remembering its own cursor, selection, undo history and dirty state, because those
all live inside the `TextArea` instance itself and `TextArea` instances are not shared here.

Built on `textual.widgets.TabbedContent` rather than a hand-rolled tab strip. That widget
already solves the two hardest parts of this correctly: closing the active tab picks a
sensible neighbour on its own (`Tabs.remove_tab`'s `_next_active`), and it posts
`TabbedContent.TabActivated` / `TabbedContent.Cleared` both when a user clicks a tab and when
`.active` is set programmatically — which is exactly the one signal this widget needs to keep
its own `ActiveChanged` message honest without duplicating Textual's tab-switching logic.
"""

from __future__ import annotations

from pathlib import Path

from textual import on
from textual.app import ComposeResult
from textual.message import Message
from textual.widget import Widget
from textual.widgets import TabbedContent, TabPane, TextArea

from ..protocols import FileContent

#: Extension to tree-sitter language name. Deliberately a second copy of `app.py`'s
#: `_LANGUAGES`, not an import of it: `ui/__init__.py` states the rule for this package —
#: widgets never import from `app.py`, only the other way round — so that each widget stays
#: testable on its own without booting the whole application. Keep the two maps in sync by
#: hand if a language is added; there is no single source of truth to import from without
#: breaking that direction.
_LANGUAGES = {
    ".py": "python",
    ".ts": "typescript",
    ".js": "javascript",
    ".json": "json",
    ".md": "markdown",
    ".html": "html",
    ".css": "css",
    ".yaml": "yaml",
    ".yml": "yaml",
    ".toml": "toml",
    ".sql": "sql",
}


def _language_for(path: str) -> str | None:
    return _LANGUAGES.get(Path(path).suffix.lower())


def _display_name(path: str) -> str:
    # `protocols.py`'s `FileContent.path` contract guarantees forward slashes even on
    # Windows ("the sandbox on the other side of MCP resolves and validates relative POSIX
    # paths"), so a plain rsplit is exact here — no need for `pathlib`, which on this
    # platform would also have to worry about drive letters and backslashes that this path
    # shape never contains.
    return path.rsplit("/", 1)[-1]


def _tab_label(path: str, *, dirty: bool, truncated: bool) -> str:
    # Plain ASCII markers, not a Unicode bullet: this app runs in whatever terminal the user
    # already has open (see the Windows/PowerShell environment this repo is developed in),
    # and a glyph missing from that terminal's font renders as a box or a blank rather than
    # failing loudly — "*" degrades to nothing worse than itself everywhere.
    #
    # The read-only marker deliberately uses parentheses, not square brackets: a `Tab`'s
    # label goes through `Content.from_text`, which parses `[...]` as Rich/Textual markup —
    # "(ro)" was originally "[ro]" and it silently vanished from the rendered label, with no
    # error, because `[ro]` parsed as an unrecognised markup tag rather than literal text.
    marker = "* " if dirty else ""
    suffix = " (ro)" if truncated else ""
    return f"{marker}{_display_name(path)}{suffix}"


class EditorTabs(Widget):
    """Owns every open file. One `TabPane` per path, one `TextArea` per pane.

    Everything keyed by `path`, per the brief: "the full path is the identity, since two
    directories can hold the same file name." `TabPane` ids can't just *be* the path — a
    Textual DOM id has to be a valid CSS-style identifier and a path contains `/` and `.`,
    both illegal there — so this widget hands out its own synthetic ids (`tab-1`, `tab-2`,
    ...) and keeps the id <-> path mapping itself.
    """

    class Dirtied(Message):
        """Posted exactly once per clean-to-dirty transition, not on every keystroke after.

        Observed while building this: `TextArea` posts `Changed` on *every* edit, including
        the one that happens to leave the document back at its saved text (e.g. type a
        character then undo, or select-all-and-retype the same content). Reposting on every
        one of those would make this message useless as a "should I show an unsaved-changes
        indicator" signal — a listener wants to know the moment it *becomes* true, not a
        running commentary. Dirtiness itself is tracked by comparing the live text against
        the baseline captured at open/reload/save, so it self-corrects if the user types and
        then undoes back to a clean state; only the transition into "dirty" is announced.
        """

        def __init__(self, path: str) -> None:
            self.path = path
            super().__init__()

    class ActiveChanged(Message):
        """Posted whenever the focused tab changes — by a click, by `open`, or by a close
        that hands focus to a neighbour. `path` is `None` once the last tab is closed.
        """

        def __init__(self, path: str | None) -> None:
            self.path = path
            super().__init__()

    def __init__(self, *, id: str | None = None, classes: str | None = None) -> None:
        super().__init__(id=id, classes=classes)
        self._id_by_path: dict[str, str] = {}
        self._path_by_id: dict[str, str] = {}
        self._areas: dict[str, TextArea] = {}
        self._path_by_area: dict[TextArea, str] = {}
        #: Text as of the last open/reload/save — the yardstick `is_dirty` compares against.
        #: Comparing text rather than keeping a plain bool as the only source of truth is
        #: what makes "undo your way back to saved" correctly report clean again, the same
        #: way a graphical editor's unsaved-changes dot behaves.
        self._baseline: dict[str, str] = {}
        self._truncated: dict[str, bool] = {}
        self._dirty: dict[str, bool] = {}
        self._active_path: str | None = None
        #: Counter behind the synthetic `tab-N` ids. Never reused even after a tab closes —
        #: reusing a number would let a `TabbedContent.TabActivated` message that was already
        #: in flight for a just-closed tab get misread as referring to a brand new one.
        self._next_id = 0

    def compose(self) -> ComposeResult:
        yield TabbedContent(id="panes")

    # -- public surface ------------------------------------------------------------------

    async def open(self, content: FileContent) -> None:
        path = content.path
        tabs = self.query_one("#panes", TabbedContent)

        if path in self._id_by_path:
            # Already open: focus it rather than opening a second tab on the same file,
            # which would immediately desync — two `TextArea`s editing one path with no way
            # to reconcile which one is "right".
            tabs.active = self._id_by_path[path]
            self._areas[path].focus()
            return

        area = TextArea(content.text, read_only=content.truncated)
        try:
            area.language = _language_for(path)
        except Exception:
            # Mirrors `app.py`'s `_open`: handing Textual a language name it has no
            # tree-sitter parser for raises, and a missing highlighter is a far smaller
            # problem for the user than a crash on open.
            area.language = None

        pane_id = self._new_id()
        pane = TabPane(
            _tab_label(path, dirty=False, truncated=content.truncated),
            area,
            id=pane_id,
        )

        # Bookkeeping is populated *before* the `await` below, not after. `Tabs.add_tab`
        # auto-activates a tab added while the tab bar was empty, and it does that from
        # inside the coroutine `add_pane` awaits — so for the very first tab ever opened, the
        # `TabbedContent.TabActivated` message can already be delivered to
        # `_on_tab_activated`, below, while this call is suspended at the `await` and before
        # a single line after it has run. Populating the dicts afterwards left that first
        # activation looking up a path that was not registered yet, resolving to `None`, and
        # then had nothing left to correct it: the follow-up `tabs.active = pane_id` assignment
        # is a no-op once `.active` already equals `pane_id`, so `_active_path` stayed `None`
        # forever. Populating first means the lookup succeeds no matter when the message
        # lands.
        self._id_by_path[path] = pane_id
        self._path_by_id[pane_id] = path
        self._areas[path] = area
        self._path_by_area[area] = path
        self._baseline[path] = content.text
        self._truncated[path] = content.truncated
        self._dirty[path] = False

        await tabs.add_pane(pane)

        # For every tab after the first, `add_tab` does *not* auto-activate — the previously
        # active tab stays showing — so this assignment is what actually switches focus to a
        # newly opened file. For the first tab it is a harmless no-op (see above).
        tabs.active = pane_id
        area.focus()

    def close(self, path: str) -> None:
        pane_id = self._id_by_path.pop(path, None)
        if pane_id is None:
            # Closing a path that was never open (already closed, or a stale caller) is not
            # an error worth surfacing — there is nothing left to do.
            return
        del self._path_by_id[pane_id]
        area = self._areas.pop(path)
        del self._path_by_area[area]
        del self._baseline[path]
        del self._truncated[path]
        del self._dirty[path]
        # Not awaited: `close` is declared synchronous in the required surface, and
        # `AwaitComplete` already schedules the underlying coroutines via `asyncio.gather` at
        # construction time, so the removal proceeds regardless. `Tabs.remove_tab` is what
        # picks the "sensible neighbour" — see its `_next_active` — and posts the activation
        # change that `_on_tab_activated` below turns into `ActiveChanged`.
        self.query_one("#panes", TabbedContent).remove_pane(pane_id)

    def close_active(self) -> None:
        if self._active_path is not None:
            self.close(self._active_path)

    @property
    def active_path(self) -> str | None:
        return self._active_path

    @property
    def active_text(self) -> str | None:
        if self._active_path is None:
            return None
        return self._areas[self._active_path].text

    @property
    def active_area(self) -> TextArea | None:
        """The focused tab's editor widget, for callers that need the widget itself.

        `FindBar` operates on a `TextArea` directly — it moves the selection and edits through
        that widget's own API so undo keeps working. Handing it text would not be enough, and
        letting it dig through this widget's internals would freeze them as public.
        """
        if self._active_path is None:
            return None
        return self._areas.get(self._active_path)

    def is_dirty(self, path: str) -> bool:
        return self._dirty.get(path, False)

    def dirty_paths(self) -> tuple[str, ...]:
        return tuple(path for path, dirty in self._dirty.items() if dirty)

    def mark_saved(self, path: str) -> None:
        if path not in self._areas:
            return
        self._baseline[path] = self._areas[path].text
        self._dirty[path] = False
        self._relabel(path)

    def reload(self, content: FileContent) -> None:
        """Replaces a tab's text from disk — used after an external change, not a save.

        `load_text` clears the `TextArea`'s own undo history, which is correct here: the
        edits it remembers refer to a version of the file this call is about to discard, and
        letting a user "undo" past that boundary would resurrect text that no longer matches
        what is on disk.
        """
        path = content.path
        area = self._areas.get(path)
        if area is None:
            return
        self._baseline[path] = content.text
        self._truncated[path] = content.truncated
        area.read_only = content.truncated
        area.load_text(content.text)
        self._dirty[path] = False
        # Called directly rather than left to the `TextArea.Changed` message `load_text`
        # posts: that handler only relabels on a dirty *transition*, but a reload can change
        # the truncated flag on a tab that was already clean, and the read-only marker in the
        # label has to track that even when the dirty marker does not move at all.
        self._relabel(path)

    # -- internals -------------------------------------------------------------------------

    def _new_id(self) -> str:
        self._next_id += 1
        return f"tab-{self._next_id}"

    def _relabel(self, path: str) -> None:
        pane_id = self._id_by_path.get(path)
        if pane_id is None:
            return
        label = _tab_label(path, dirty=self._dirty[path], truncated=self._truncated[path])
        self.query_one("#panes", TabbedContent).get_tab(pane_id).label = label

    @on(TabbedContent.TabActivated)
    def _on_tab_activated(self, event: TabbedContent.TabActivated) -> None:
        # Fires both for a user click on the tab bar and for the reactive assignment `open`
        # makes to `tabs.active` — see the long comment on `TabbedContent._watch_active` /
        # `_on_tabs_tab_activated` in Textual: both routes converge on this same message, so
        # this one handler is the single place `_active_path` needs to be kept honest.
        event.stop()
        path = self._path_by_id.get(event.pane.id or "")
        if path == self._active_path:
            return
        self._active_path = path
        if path is not None:
            # Without this, switching tabs (by click or by a neighbour picked after a close)
            # leaves keyboard focus wherever it happened to be, and a user who starts typing
            # edits nothing until they click into the newly-visible editor — exactly the kind
            # of small friction this phase exists to remove.
            self._areas[path].focus()
        self.post_message(self.ActiveChanged(path))

    @on(TabbedContent.Cleared)
    def _on_cleared(self, event: TabbedContent.Cleared) -> None:
        # Posted when the last pane is removed. `Tabs.remove_tab` has no "next" tab to hand
        # activation to in that case, so it never posts `TabActivated` at all — this is the
        # only signal that the tab strip has gone from one tab to none.
        event.stop()
        if self._active_path is not None:
            self._active_path = None
            self.post_message(self.ActiveChanged(None))

    @on(TextArea.Changed)
    def _on_text_changed(self, event: TextArea.Changed) -> None:
        event.stop()
        path = self._path_by_area.get(event.text_area)
        if path is None:
            # A stray message for a `TextArea` this widget no longer tracks — the tab was
            # closed while a `Changed` it posted (e.g. from a `load_text` during `reload`)
            # was still in the message queue. Nothing to update.
            return
        was_dirty = self._dirty.get(path, False)
        now_dirty = event.text_area.text != self._baseline.get(path)
        self._dirty[path] = now_dirty
        if now_dirty != was_dirty:
            self._relabel(path)
            if now_dirty:
                self.post_message(self.Dirtied(path))
