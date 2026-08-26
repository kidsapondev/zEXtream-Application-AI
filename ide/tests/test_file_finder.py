"""Specification for `local_coder.ui.file_finder`.

Driven through Textual's headless `Pilot`, inside a tiny host `App` defined here — the same
pattern `test_app.py` uses — rather than through the real `LocalCoderApp`: this widget owns
one narrow job (query in, ranked path out) and should be testable without booting the whole
three-pane layout. The index is built against `FakeBackend`, never a real file or subprocess.
"""

from __future__ import annotations

from textual import on
from textual.app import App, ComposeResult
from textual.widgets import Input, Label, ListView

from local_coder.file_index import FileIndex
from local_coder.ui.file_finder import FileFinder, render_path


class _HostApp(App[None]):
    """Mounts a single `FileFinder` and records the messages it posts.

    A real app would show the finder as an overlay on top of other panes and remove it again
    on `Dismissed`; none of that stacking logic belongs to the widget under test, so the host
    here just listens.
    """

    def __init__(self, index: FileIndex) -> None:
        super().__init__()
        self._index = index
        self.selected_path: str | None = None
        self.dismiss_count = 0

    def compose(self) -> ComposeResult:
        yield FileFinder(self._index, id="finder")

    @on(FileFinder.Selected)
    def _on_selected(self, event: FileFinder.Selected) -> None:
        self.selected_path = event.path

    @on(FileFinder.Dismissed)
    def _on_dismissed(self, event: FileFinder.Dismissed) -> None:
        self.dismiss_count += 1


class TestRenderPath:
    """The highlighting helper, tested directly — no widget, no event loop needed."""

    def test_highlights_exactly_the_matched_positions(self) -> None:
        text = render_path("app.py", (0, 1, 2))

        # Every span covers one character and carries the highlight style; nothing outside
        # the given positions is styled at all.
        assert [(span.start, span.end) for span in text.spans] == [(0, 1), (1, 2), (2, 3)]
        assert all(span.style == "bold reverse" for span in text.spans)

    def test_no_positions_means_no_styling(self) -> None:
        text = render_path("app.py", ())

        assert text.spans == []

    def test_scattered_positions_highlight_only_those_characters(self) -> None:
        text = render_path("local_coder/app.py", (0, 2, 12))

        assert [(span.start, span.end) for span in text.spans] == [(0, 1), (2, 3), (12, 13)]

    def test_plain_text_is_unchanged(self) -> None:
        text = render_path("src/app.py", (0,))

        assert text.plain == "src/app.py"


class TestOpening:
    async def test_opens_showing_results_for_an_empty_query(self, backend) -> None:
        index = FileIndex(backend)
        app = _HostApp(index)
        async with app.run_test() as pilot:
            await pilot.pause()

            results = app.query_one(ListView)
            assert len(results.children) > 0
            # The empty-query view is not just "some rows" — it must be every indexed path,
            # since nothing has been typed to narrow it down yet.
            assert len(results.children) == len(index.paths())

    async def test_builds_the_index_itself_if_nobody_built_it_first(self, backend) -> None:
        index = FileIndex(backend)
        assert index.paths() == ()  # confirms nothing pre-built it

        app = _HostApp(index)
        async with app.run_test() as pilot:
            await pilot.pause()

            assert index.paths() != ()

    async def test_does_not_rebuild_an_already_built_index(self, backend) -> None:
        index = FileIndex(backend)
        await index.build()
        before = len(backend.called("list_dir"))

        app = _HostApp(index)
        async with app.run_test() as pilot:
            await pilot.pause()

            assert len(backend.called("list_dir")) == before

    async def test_the_query_box_starts_focused(self, backend) -> None:
        index = FileIndex(backend)
        app = _HostApp(index)
        async with app.run_test() as pilot:
            await pilot.pause()

            assert isinstance(app.focused, Input)


class TestFiltering:
    async def test_typing_narrows_the_results(self, backend) -> None:
        backend.files = {"README.md": "x", "src/app.py": "x", "src/util.py": "x"}
        index = FileIndex(backend)
        app = _HostApp(index)
        async with app.run_test() as pilot:
            await pilot.pause()
            await pilot.press(*"app")
            await pilot.pause()

            results = app.query_one(ListView)
            labels = [str(item.query_one(Label).content) for item in results.children]

        assert labels == ["src/app.py"]

    async def test_a_query_matching_nothing_leaves_the_list_empty(self, backend) -> None:
        backend.files = {"README.md": "x"}
        index = FileIndex(backend)
        app = _HostApp(index)
        async with app.run_test() as pilot:
            await pilot.pause()
            await pilot.press(*"zzz")
            await pilot.pause()

            results = app.query_one(ListView)
            assert len(results.children) == 0

    async def test_result_labels_carry_the_highlight_spans(self, backend) -> None:
        backend.files = {"app.py": "x"}
        index = FileIndex(backend)
        app = _HostApp(index)
        async with app.run_test() as pilot:
            await pilot.pause()
            await pilot.press(*"app")
            await pilot.pause()

            label = app.query_one(ListView).children[0].query_one(Label)
            # House style note: Static (Label's base class) exposes `.content`, not
            # `.renderable` — reading the wrong attribute here would silently see nothing.
            content = label.content

        assert content.plain == "app.py"
        assert len(content.spans) == 3


class TestSelecting:
    async def test_enter_posts_selected_with_the_top_ranked_path(self, backend) -> None:
        backend.files = {"README.md": "x", "src/app.py": "x"}
        index = FileIndex(backend)
        app = _HostApp(index)
        async with app.run_test() as pilot:
            await pilot.pause()
            await pilot.press(*"app")
            await pilot.pause()
            await pilot.press("enter")
            await pilot.pause()

        assert app.selected_path == "src/app.py"

    async def test_arrow_down_then_enter_selects_the_second_result(self, backend) -> None:
        backend.files = {f"app{n}.py": "x" for n in range(3)}
        index = FileIndex(backend)
        app = _HostApp(index)
        async with app.run_test() as pilot:
            await pilot.pause()
            # All three paths score identically for "app" (same shape, same length up to the
            # trailing digit), so ties fall back to path text — a deterministic, known order.
            await pilot.press(*"app")
            await pilot.pause()
            results = app.query_one(ListView)
            expected_second = index.match("app")[1].path

            await pilot.press("down")
            await pilot.press("enter")
            await pilot.pause()

        assert app.selected_path == expected_second

    async def test_arrow_up_does_not_move_past_the_first_result(self, backend) -> None:
        backend.files = {"a.py": "x", "b.py": "x"}
        index = FileIndex(backend)
        app = _HostApp(index)
        async with app.run_test() as pilot:
            await pilot.pause()
            await pilot.press("up")  # already at the top; must clamp, not raise or wrap
            await pilot.press("enter")
            await pilot.pause()

        assert app.selected_path == index.match("")[0].path

    async def test_escape_posts_dismissed(self, backend) -> None:
        index = FileIndex(backend)
        app = _HostApp(index)
        async with app.run_test() as pilot:
            await pilot.pause()
            await pilot.press("escape")
            await pilot.pause()

        assert app.dismiss_count == 1
        assert app.selected_path is None
