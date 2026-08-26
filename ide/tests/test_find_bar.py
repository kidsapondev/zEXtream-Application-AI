"""Tests for `FindBar`, driven headlessly through Textual's Pilot.

Same shape as `test_editor_tabs.py`: a tiny host app mounts the widget under test next to a
real `TextArea` and drives it through `run_test()`, so these tests exercise the same
`TextArea.replace` / `Selection` / `Document` machinery the real app will use, not a stand-in
for it.
"""

from __future__ import annotations

from textual.app import App, ComposeResult
from textual.widgets import TextArea

from local_coder.ui.find_bar import FindBar


class _Host(App[None]):
    """Mounts a `TextArea` and a `FindBar` attached to it on startup."""

    def __init__(self, text: str) -> None:
        super().__init__()
        self._text = text

    def compose(self) -> ComposeResult:
        yield TextArea(self._text, id="area")
        yield FindBar(id="find")

    async def on_mount(self) -> None:
        self.query_one(FindBar).attach(self.query_one("#area", TextArea))


async def _set_query(find_bar: FindBar, pilot, text: str) -> None:
    """Types `text` into the find bar's query field the way a user would.

    Going through the actual `Input` rather than poking a private attribute means these
    tests exercise the same `Input.Changed` path a real keypress triggers.
    """
    query_input = find_bar.query_one("#find_query")
    query_input.focus()
    query_input.value = ""
    await pilot.pause()
    for char in text:
        await pilot.press(char)
    await pilot.pause()


async def _set_replacement(find_bar: FindBar, pilot, text: str) -> None:
    replace_input = find_bar.query_one("#find_replace")
    replace_input.focus()
    replace_input.value = ""
    await pilot.pause()
    for char in text:
        await pilot.press(char)
    await pilot.pause()


class TestMatching:
    async def test_match_count_reflects_the_query(self) -> None:
        app = _Host("cat sat on the cat mat\n")
        async with app.run_test() as pilot:
            find_bar = app.query_one(FindBar)
            await _set_query(find_bar, pilot, "cat")
            await pilot.pause()

            assert find_bar.match_count == 2

    async def test_case_insensitive_by_default(self) -> None:
        app = _Host("Cat cat CAT\n")
        async with app.run_test() as pilot:
            find_bar = app.query_one(FindBar)
            await _set_query(find_bar, pilot, "cat")
            await pilot.pause()

            assert find_bar.match_count == 3

    async def test_case_sensitive_toggle_narrows_matches(self) -> None:
        app = _Host("Cat cat CAT\n")
        async with app.run_test() as pilot:
            find_bar = app.query_one(FindBar)
            find_bar.case_sensitive = True
            await _set_query(find_bar, pilot, "cat")
            await pilot.pause()

            assert find_bar.match_count == 1

    async def test_no_matches_is_zero_not_an_error(self) -> None:
        app = _Host("nothing to see here\n")
        async with app.run_test() as pilot:
            find_bar = app.query_one(FindBar)
            await _set_query(find_bar, pilot, "xyz")
            await pilot.pause()

            assert find_bar.match_count == 0
            assert find_bar.find_next() is False
            assert find_bar.find_previous() is False


class TestNavigation:
    async def test_find_next_selects_each_match_in_order(self) -> None:
        area_text = "one two one three one\n"
        app = _Host(area_text)
        async with app.run_test() as pilot:
            find_bar = app.query_one(FindBar)
            area = app.query_one("#area", TextArea)
            await _set_query(find_bar, pilot, "one")
            await pilot.pause()

            assert find_bar.find_next() is True
            first_start = area.selection.start
            assert area.selected_text == "one"

            assert find_bar.find_next() is True
            second_start = area.selection.start

            # Three occurrences of "one" in the text; two calls to find_next from a fresh
            # search must land on the first and then the second, not select the same one
            # twice.
            assert area.selected_text == "one"
            assert second_start != first_start

    async def test_find_next_wraps_around_at_the_end(self) -> None:
        app = _Host("a b a\n")
        async with app.run_test() as pilot:
            find_bar = app.query_one(FindBar)
            await _set_query(find_bar, pilot, "a")
            await pilot.pause()

            assert find_bar.match_count == 2
            find_bar.find_next()  # -> match 1 of 2
            find_bar.find_next()  # -> match 2 of 2
            assert "2 of 2" in find_bar.status_text
            find_bar.find_next()  # wraps back to match 1 of 2
            assert "1 of 2" in find_bar.status_text

    async def test_find_previous_wraps_around_at_the_start(self) -> None:
        app = _Host("a b a\n")
        async with app.run_test() as pilot:
            find_bar = app.query_one(FindBar)
            await _set_query(find_bar, pilot, "a")
            await pilot.pause()

            find_bar.find_previous()  # nothing selected yet -> wraps to the last match
            assert "2 of 2" in find_bar.status_text
            find_bar.find_previous()
            assert "1 of 2" in find_bar.status_text

    async def test_status_reports_position_as_n_of_m(self) -> None:
        app = _Host("x x x\n")
        async with app.run_test() as pilot:
            find_bar = app.query_one(FindBar)
            await _set_query(find_bar, pilot, "x")
            await pilot.pause()

            find_bar.find_next()
            assert find_bar.status_text == "1 of 3"
            find_bar.find_next()
            assert find_bar.status_text == "2 of 3"


class TestReplace:
    async def test_replace_current_uses_the_replacement_text(self) -> None:
        app = _Host("hello world\n")
        async with app.run_test() as pilot:
            find_bar = app.query_one(FindBar)
            area = app.query_one("#area", TextArea)
            await _set_query(find_bar, pilot, "world")
            await _set_replacement(find_bar, pilot, "there")
            find_bar.find_next()

            count = find_bar.replace_current()

            assert count == 1
            assert area.text == "hello there\n"

    async def test_replace_current_with_no_match_does_nothing(self) -> None:
        app = _Host("hello world\n")
        async with app.run_test() as pilot:
            find_bar = app.query_one(FindBar)
            area = app.query_one("#area", TextArea)
            await _set_query(find_bar, pilot, "xyz")
            await _set_replacement(find_bar, pilot, "there")

            count = find_bar.replace_current()

            assert count == 0
            assert area.text == "hello world\n"

    async def test_replace_leaves_undo_working(self) -> None:
        app = _Host("hello world\n")
        async with app.run_test() as pilot:
            find_bar = app.query_one(FindBar)
            area = app.query_one("#area", TextArea)
            await _set_query(find_bar, pilot, "world")
            await _set_replacement(find_bar, pilot, "there")
            find_bar.find_next()
            find_bar.replace_current()
            assert area.text == "hello there\n"

            # `replace_current` must go through `TextArea`'s own edit API (`replace`/`edit`)
            # rather than `load_text`, which clears undo history outright — that is the only
            # way a single `undo()` call can put the original word back.
            area.undo()
            await pilot.pause()

            assert area.text == "hello world\n"

    async def test_replace_all_replaces_every_match_and_returns_the_count(self) -> None:
        app = _Host("cat sat on the cat mat, cat!\n")
        async with app.run_test() as pilot:
            find_bar = app.query_one(FindBar)
            area = app.query_one("#area", TextArea)
            await _set_query(find_bar, pilot, "cat")
            await _set_replacement(find_bar, pilot, "dog")

            count = find_bar.replace_all()

            assert count == 3
            assert area.text == "dog sat on the dog mat, dog!\n"
            assert find_bar.match_count == 0

    async def test_replace_refuses_a_read_only_area(self) -> None:
        # A read-only `TextArea` means the tab is a truncated file (see `FileContent.truncated`
        # in protocols.py) — writing it back would silently destroy the part that was never
        # read. Find/replace must respect that the same way saving does.
        app = _Host("cat sat\n")
        async with app.run_test() as pilot:
            find_bar = app.query_one(FindBar)
            area = app.query_one("#area", TextArea)
            area.read_only = True
            await _set_query(find_bar, pilot, "cat")
            await _set_replacement(find_bar, pilot, "dog")

            assert find_bar.replace_current() == 0
            assert find_bar.replace_all() == 0
            assert area.text == "cat sat\n"

    async def test_replace_all_with_no_matches_returns_zero(self) -> None:
        app = _Host("hello world\n")
        async with app.run_test() as pilot:
            find_bar = app.query_one(FindBar)
            area = app.query_one("#area", TextArea)
            await _set_query(find_bar, pilot, "xyz")
            await _set_replacement(find_bar, pilot, "abc")

            count = find_bar.replace_all()

            assert count == 0
            assert area.text == "hello world\n"


class TestAttachAndClose:
    async def test_attach_recomputes_matches_against_the_new_area(self) -> None:
        app = _Host("apple\n")
        async with app.run_test() as pilot:
            find_bar = app.query_one(FindBar)
            other_area = TextArea("apple apple apple\n")
            await app.mount(other_area)
            await _set_query(find_bar, pilot, "apple")
            await pilot.pause()
            assert find_bar.match_count == 1

            find_bar.attach(other_area)
            await pilot.pause()

            assert find_bar.match_count == 3

    async def test_closed_message_is_posted(self) -> None:
        posted: list[bool] = []

        class Host(App[None]):
            def compose(self) -> ComposeResult:
                yield TextArea("hello\n", id="area")
                yield FindBar(id="find")

            async def on_mount(self) -> None:
                self.query_one(FindBar).attach(self.query_one("#area", TextArea))

            def on_find_bar_closed(self, event: FindBar.Closed) -> None:
                posted.append(True)

        app = Host()
        async with app.run_test() as pilot:
            find_bar = app.query_one(FindBar)
            find_bar.query_one("#find_close").press()
            await pilot.pause()

        assert posted == [True]
