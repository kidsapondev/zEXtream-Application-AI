"""The always-on-screen status row.

Most of this is `render_segments`, a pure function, because the interesting behaviour is
*what gets shown and in what order* rather than how a `Static` paints.
"""

from __future__ import annotations

from textual.app import App, ComposeResult

from local_coder.ui.status_bar import (
    SEPARATOR,
    StatusBar,
    StatusState,
    render_segments,
)


class _Host(App[None]):
    def compose(self) -> ComposeResult:
        yield StatusBar(id="status")


class TestRenderSegments:
    def test_an_empty_state_shows_nothing(self) -> None:
        assert render_segments(StatusState()) == []

    def test_shows_the_facts_in_reading_order(self) -> None:
        state = StatusState(
            path="src/app.py",
            line=12,
            column=5,
            language="python",
            errors=1,
            warnings=2,
            branch="main",
            model="qwen2.5-coder:14b",
            tokens=4409,
            runs=2,
        )

        assert render_segments(state) == [
            "src/app.py",
            "12:5",
            "python",
            "x1 !2",
            "main",
            "qwen2.5-coder:14b",
            "4,409 tok / 2 run",
        ]

    def test_omits_what_has_nothing_to_say(self) -> None:
        # Omission, not placeholders: a bar padded with dashes for every unknown is mostly
        # punctuation, and the eye has to work out which dashes matter.
        segments = render_segments(StatusState(path="a.py", model="m"))

        assert segments == ["a.py", "m"]

    def test_a_message_displaces_everything(self) -> None:
        # It is always the most recent thing that happened; burying it among six standing
        # facts is how it gets missed.
        state = StatusState(path="a.py", model="m", message="saved a.py")

        assert render_segments(state) == ["saved a.py"]

    def test_diagnostics_show_only_the_severities_present(self) -> None:
        assert render_segments(StatusState(errors=3)) == ["x3"]
        assert render_segments(StatusState(warnings=1)) == ["!1"]
        assert render_segments(StatusState(errors=0, warnings=0)) == []

    def test_a_dirty_branch_carries_its_count(self) -> None:
        assert render_segments(StatusState(branch="main", dirty_files=3)) == ["main *3"]

    def test_token_counts_are_grouped_for_reading(self) -> None:
        assert render_segments(StatusState(tokens=1234567, runs=9)) == [
            "1,234,567 tok / 9 run"
        ]

    def test_zero_tokens_is_not_shown(self) -> None:
        # Zero would claim a run happened and was free.
        assert render_segments(StatusState(tokens=0, runs=0)) == []


class TestStatusBar:
    async def test_setting_one_segment_leaves_the_others_alone(self) -> None:
        """The whole reason this widget exists.

        The previous single-`Static` status line lost every other fact each time anything
        wrote to it — opening a file erased the run result, refreshing the tree erased both.
        """
        app = _Host()
        async with app.run_test() as pilot:
            bar = app.query_one("#status", StatusBar)
            bar.set_file("src/app.py", language="python")
            bar.set_model("qwen2.5-coder:14b")
            bar.set_position(4, 9)
            await pilot.pause()

            rendered = str(bar.content)
            assert "src/app.py" in rendered
            assert "qwen2.5-coder:14b" in rendered
            assert "4:9" in rendered
            assert SEPARATOR in rendered

    async def test_a_message_hides_the_facts_until_cleared(self) -> None:
        app = _Host()
        async with app.run_test() as pilot:
            bar = app.query_one("#status", StatusBar)
            bar.set_file("src/app.py", language="python")
            bar.set_message("saved src/app.py")
            await pilot.pause()

            assert str(bar.content) == "saved src/app.py"

            bar.clear_message()
            await pilot.pause()

            assert "python" in str(bar.content)

    async def test_opening_a_file_clears_a_stale_message(self) -> None:
        # Otherwise "saved" stays on screen while the user reads a different file.
        app = _Host()
        async with app.run_test() as pilot:
            bar = app.query_one("#status", StatusBar)
            bar.set_message("saved a.py")
            bar.set_file("b.py", language="python")
            await pilot.pause()

            assert "b.py" in str(bar.content)
            assert "saved" not in str(bar.content)
