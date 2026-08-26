"""Tests for `EditorTabs`, driven headlessly through Textual's Pilot.

Following `test_app.py`'s pattern: boot a tiny host app that mounts the widget under test
against real Textual machinery (no fake, no mock) and drive it through `run_test()`. A widget
this stateful — several `TextArea`s, tab identity, dirty tracking — is worth exercising through
the same message pump the real app uses, not by poking its private dicts directly.
"""

from __future__ import annotations

from textual import on
from textual.app import App, ComposeResult
from textual.widgets import Tab, TabbedContent, TextArea

from local_coder.protocols import FileContent
from local_coder.ui.editor_tabs import EditorTabs


class _Host(App[None]):
    """Mounts `EditorTabs` alone and records the two messages it posts.

    Recording via `@on`, the same decorator style `app.py` uses for `Tree.NodeExpanded`,
    rather than a `MagicMock` — this is a real Textual message pump, and a mock would not
    catch a message posted with the wrong shape or from the wrong sender.
    """

    def __init__(self) -> None:
        super().__init__()
        self.dirtied: list[str] = []
        self.active_changes: list[str | None] = []

    def compose(self) -> ComposeResult:
        yield EditorTabs(id="editor")

    @on(EditorTabs.Dirtied)
    def _record_dirty(self, event: EditorTabs.Dirtied) -> None:
        self.dirtied.append(event.path)

    @on(EditorTabs.ActiveChanged)
    def _record_active(self, event: EditorTabs.ActiveChanged) -> None:
        self.active_changes.append(event.path)


def _content(path: str, text: str, *, truncated: bool = False) -> FileContent:
    return FileContent(path, text, len(text.encode()), truncated=truncated)


class TestOpening:
    async def test_opening_two_files_creates_two_tabs_and_focuses_the_second(self) -> None:
        app = _Host()
        async with app.run_test() as pilot:
            tabs = app.query_one(EditorTabs)
            await tabs.open(_content("a.py", "print(1)\n"))
            await tabs.open(_content("b.py", "print(2)\n"))
            await pilot.pause()

            assert tabs.query_one("#panes", TabbedContent).tab_count == 2
            assert tabs.active_path == "b.py"
            assert tabs.active_text == "print(2)\n"

    async def test_reopening_an_open_path_focuses_instead_of_duplicating(self) -> None:
        app = _Host()
        async with app.run_test() as pilot:
            tabs = app.query_one(EditorTabs)
            await tabs.open(_content("a.py", "one\n"))
            await tabs.open(_content("b.py", "two\n"))
            await pilot.pause()

            await tabs.open(_content("a.py", "one\n"))
            await pilot.pause()

            assert tabs.query_one("#panes", TabbedContent).tab_count == 2
            assert tabs.active_path == "a.py"
            assert tabs.active_text == "one\n"

    async def test_unknown_extension_opens_without_raising(self) -> None:
        # Handing Textual a language it has no parser for raises `LanguageDoesNotExist`; an
        # extension this widget's `_LANGUAGES` map has never heard of must fall through to
        # no highlighting rather than crash the open.
        app = _Host()
        async with app.run_test() as pilot:
            tabs = app.query_one(EditorTabs)
            await tabs.open(_content("notes.xyz", "hello\n"))
            await pilot.pause()

            assert tabs.active_path == "notes.xyz"
            assert app.query_one(TextArea).language is None

    async def test_truncated_file_opens_read_only_and_marked_in_the_label(self) -> None:
        app = _Host()
        async with app.run_test() as pilot:
            tabs = app.query_one(EditorTabs)
            await tabs.open(_content("big.log", "only the head...", truncated=True))
            await pilot.pause()

            assert app.query_one(TextArea).read_only is True
            tab_widget = tabs.query_one("#panes", TabbedContent).query_one(Tab)
            assert "(ro)" in str(tab_widget.label)
            assert "big.log" in str(tab_widget.label)


class TestDirtyTracking:
    async def test_editing_marks_dirty_and_posts_only_on_the_clean_to_dirty_edge(self) -> None:
        app = _Host()
        async with app.run_test() as pilot:
            tabs = app.query_one(EditorTabs)
            await tabs.open(_content("a.py", "one\n"))
            await pilot.pause()
            assert tabs.is_dirty("a.py") is False

            await pilot.press("x")
            await pilot.pause()
            assert tabs.is_dirty("a.py") is True
            assert app.dirtied == ["a.py"]

            # A second keystroke keeps it dirty but must not post `Dirtied` again — that
            # message means "just became dirty", not "is currently dirty".
            await pilot.press("y")
            await pilot.pause()
            assert app.dirtied == ["a.py"]

    async def test_mark_saved_clears_dirty(self) -> None:
        app = _Host()
        async with app.run_test() as pilot:
            tabs = app.query_one(EditorTabs)
            await tabs.open(_content("a.py", "one\n"))
            await pilot.pause()
            await pilot.press("x")
            await pilot.pause()
            assert tabs.is_dirty("a.py") is True

            tabs.mark_saved("a.py")

            assert tabs.is_dirty("a.py") is False
            assert tabs.dirty_paths() == ()

    async def test_dirty_paths_lists_only_the_dirty_ones(self) -> None:
        app = _Host()
        async with app.run_test() as pilot:
            tabs = app.query_one(EditorTabs)
            await tabs.open(_content("a.py", "a\n"))
            await tabs.open(_content("b.py", "b\n"))
            await pilot.pause()
            # b.py was opened last, so it is the active (focused) tab.
            await pilot.press("z")
            await pilot.pause()

            assert tabs.dirty_paths() == ("b.py",)
            assert tabs.is_dirty("a.py") is False

    async def test_undo_back_to_saved_text_reports_clean_again(self) -> None:
        # Dirtiness is tracked by comparing live text against the saved baseline, not a bare
        # flag flipped on the first keystroke — so undoing the only edit must clear it, the
        # same way a graphical editor's unsaved-changes dot behaves.
        app = _Host()
        async with app.run_test() as pilot:
            tabs = app.query_one(EditorTabs)
            await tabs.open(_content("a.py", "one\n"))
            await pilot.pause()
            await pilot.press("x")
            await pilot.pause()
            assert tabs.is_dirty("a.py") is True

            app.query_one(TextArea).undo()
            await pilot.pause()

            assert tabs.is_dirty("a.py") is False


class TestClosing:
    async def test_closing_the_active_tab_picks_a_neighbour(self) -> None:
        app = _Host()
        async with app.run_test() as pilot:
            tabs = app.query_one(EditorTabs)
            await tabs.open(_content("a.py", "a\n"))
            await tabs.open(_content("b.py", "b\n"))
            await tabs.open(_content("c.py", "c\n"))
            await pilot.pause()
            assert tabs.active_path == "c.py"

            tabs.close_active()
            await pilot.pause()

            assert tabs.query_one("#panes", TabbedContent).tab_count == 2
            assert tabs.active_path in ("a.py", "b.py")

    async def test_closing_a_specific_path_by_name(self) -> None:
        app = _Host()
        async with app.run_test() as pilot:
            tabs = app.query_one(EditorTabs)
            await tabs.open(_content("a.py", "a\n"))
            await tabs.open(_content("b.py", "b\n"))
            await pilot.pause()

            tabs.close("a.py")
            await pilot.pause()

            assert tabs.query_one("#panes", TabbedContent).tab_count == 1
            # Closing the inactive tab must not disturb which tab is focused.
            assert tabs.active_path == "b.py"

    async def test_closing_the_last_tab_leaves_nothing_active(self) -> None:
        app = _Host()
        async with app.run_test() as pilot:
            tabs = app.query_one(EditorTabs)
            await tabs.open(_content("a.py", "a\n"))
            await pilot.pause()

            tabs.close_active()
            await pilot.pause()

            assert tabs.active_path is None
            assert tabs.active_text is None
            assert app.active_changes[-1] is None

    async def test_closing_an_unopened_path_is_a_no_op(self) -> None:
        app = _Host()
        async with app.run_test() as pilot:
            tabs = app.query_one(EditorTabs)
            await tabs.open(_content("a.py", "a\n"))
            await pilot.pause()

            tabs.close("never-opened.py")
            await pilot.pause()

            assert tabs.query_one("#panes", TabbedContent).tab_count == 1
            assert tabs.active_path == "a.py"


class TestReload:
    async def test_reload_replaces_text_and_clears_dirty(self) -> None:
        app = _Host()
        async with app.run_test() as pilot:
            tabs = app.query_one(EditorTabs)
            await tabs.open(_content("a.py", "old\n"))
            await pilot.pause()
            await pilot.press("z")
            await pilot.pause()
            assert tabs.is_dirty("a.py") is True

            tabs.reload(_content("a.py", "new\n"))
            await pilot.pause()

            assert tabs.active_text == "new\n"
            assert tabs.is_dirty("a.py") is False

    async def test_reload_updates_the_read_only_marker(self) -> None:
        app = _Host()
        async with app.run_test() as pilot:
            tabs = app.query_one(EditorTabs)
            await tabs.open(_content("a.py", "short\n"))
            await pilot.pause()
            assert app.query_one(TextArea).read_only is False

            tabs.reload(_content("a.py", "short\n", truncated=True))
            await pilot.pause()

            assert app.query_one(TextArea).read_only is True
            tab_widget = tabs.query_one("#panes", TabbedContent).query_one(Tab)
            assert "(ro)" in str(tab_widget.label)
