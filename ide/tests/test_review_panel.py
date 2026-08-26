"""The review panel, driven headlessly through Textual's Pilot.

The host app below exists only in this file. Mounting the panel inside a one-widget `App` is
what makes the messages testable at all — a Textual `Message` only goes anywhere once the
widget is running inside an app, so a panel constructed in isolation would post into nothing
and every assertion here would pass for the wrong reason.

Two Textual facts this file leans on, both learned the hard way in this repo: `Static` exposes
its content as `.content`, not `.renderable`, and a `RichLog` holds no lines at all until it
has been laid out with a real size — which never happens headlessly. The panel therefore keeps
its own plain-text mirror of the diff (`rendered_diff`) and that is what gets asserted on.
"""

from __future__ import annotations

import pytest
from textual import on
from textual.app import App, ComposeResult
from textual.widgets import Button, Static

from local_coder.diff import DiffLine, LineKind
from local_coder.review import FileChange, ReviewSession
from local_coder.ui.review_panel import ReviewPanel, gutter_row


@pytest.fixture
async def changes(backend) -> tuple[FileChange, ...]:
    """Two real changes: one edit to an existing file, one file created by the run."""
    session = ReviewSession(backend)
    await session.snapshot(["src/app.py", "src/new.py"])
    backend.files["src/app.py"] = "def main():\n    return 2\n"
    backend.files["src/new.py"] = "VALUE = 3\n"
    return await session.capture(["src/app.py", "src/new.py"])


class ReviewHost(App[None]):
    """Minimal app whose only job is to own a `ReviewPanel` and record what it posts."""

    def __init__(self, panel_changes: tuple[FileChange, ...] = ()) -> None:
        super().__init__()
        # Not named `_changes`/`changes`: this is the app, and keeping the panel's own
        # attribute names distinct from the host's makes an accidental cross-assignment in a
        # future test obvious rather than silently self-consistent.
        self.initial_changes = panel_changes
        self.seen: list[tuple[str, str]] = []

    def compose(self) -> ComposeResult:
        yield ReviewPanel(id="review")

    def on_mount(self) -> None:
        self.query_one(ReviewPanel).show(self.initial_changes)

    @on(ReviewPanel.Accepted)
    def _accepted(self, event: ReviewPanel.Accepted) -> None:
        self.seen.append(("accepted", event.path))

    @on(ReviewPanel.Reverted)
    def _reverted(self, event: ReviewPanel.Reverted) -> None:
        self.seen.append(("reverted", event.path))


class TestGutterRow:
    """The gutter is the reason `diff.py` attaches numbers to lines at all."""

    def test_a_context_row_carries_both_line_numbers(self) -> None:
        assert gutter_row(DiffLine(LineKind.CONTEXT, "x", 3, 5)) == "   3    5   x"

    def test_an_added_row_has_no_old_number(self) -> None:
        # The blank is deliberate and load-bearing: a reader scanning the left column sees
        # exactly which lines exist in the file they started with.
        assert gutter_row(DiffLine(LineKind.ADDED, "y", None, 7)) == "        7 + y"

    def test_a_removed_row_has_no_new_number(self) -> None:
        assert gutter_row(DiffLine(LineKind.REMOVED, "z", 9, None)) == "   9      - z"

    def test_a_header_row_has_neither(self) -> None:
        row = gutter_row(DiffLine(LineKind.HEADER, "@@ -1 +1 @@ a.py"))
        assert row.lstrip() == "@ @@ -1 +1 @@ a.py"


class TestShowing:
    async def test_shows_the_first_change_with_its_path_and_counts(self, changes) -> None:
        app = ReviewHost(changes)
        async with app.run_test() as pilot:
            await pilot.pause()
            panel = app.query_one(ReviewPanel)
            title = str(app.query_one("#review-title", Static).content)

        assert panel.current is not None
        assert panel.current.path == "src/app.py"
        assert "src/app.py" in title
        assert "1/2" in title
        assert "+1" in title and "-1" in title

    async def test_renders_every_diff_line_into_its_own_row(self, changes) -> None:
        app = ReviewHost(changes)
        async with app.run_test() as pilot:
            await pilot.pause()
            panel = app.query_one(ReviewPanel)
            rows = list(panel.rendered_diff)

            assert rows == [gutter_row(line) for line in changes[0].lines]
            assert any(row.endswith("    return 2") and " + " in row for row in rows)
            assert any(row.endswith("    return 1") and " - " in row for row in rows)
            # Whatever the widget shows must be the same text the mirror records, or the
            # mirror is testing itself instead of the panel. Asserted inside the `run_test`
            # block on purpose: once it exits, the screen is torn down and every `query_one`
            # raises NoMatches — which reads exactly like a widget that was never mounted.
            assert str(app.query_one("#review-diff", Static).content).splitlines() == rows

    async def test_a_created_file_is_flagged_as_new(self, changes) -> None:
        app = ReviewHost(changes)
        async with app.run_test() as pilot:
            await pilot.pause()
            app.query_one(ReviewPanel).action_next_file()
            await pilot.pause()
            title = str(app.query_one("#review-title", Static).content)

        assert "src/new.py" in title
        assert "new" in title.lower()

    async def test_with_nothing_to_review_it_says_so_and_disables_its_buttons(self) -> None:
        app = ReviewHost(())
        async with app.run_test() as pilot:
            await pilot.pause()
            panel = app.query_one(ReviewPanel)
            title = str(app.query_one("#review-title", Static).content)
            accept = app.query_one("#review-accept", Button)

        assert panel.current is None
        assert panel.rendered_diff == []
        assert "nothing to review" in title.lower()
        # A disabled button is what stops an accept being posted for a change that no longer
        # exists — the panel is left mounted between runs, not removed.
        assert accept.disabled is True


class TestNavigating:
    async def test_next_and_previous_move_through_the_changes(self, changes) -> None:
        app = ReviewHost(changes)
        async with app.run_test() as pilot:
            await pilot.pause()
            panel = app.query_one(ReviewPanel)

            panel.action_next_file()
            await pilot.pause()
            assert panel.index == 1
            assert panel.current is not None and panel.current.path == "src/new.py"

            panel.action_previous_file()
            await pilot.pause()
            assert panel.index == 0
            assert panel.current is not None and panel.current.path == "src/app.py"

    async def test_navigation_stops_at_the_ends_instead_of_wrapping(self, changes) -> None:
        # Clamping rather than wrapping: holding the key down at the end of a two-file review
        # would otherwise silently put the user back on the first file, and a review where you
        # cannot tell whether you have seen everything is not a review.
        app = ReviewHost(changes)
        async with app.run_test() as pilot:
            await pilot.pause()
            panel = app.query_one(ReviewPanel)

            panel.action_previous_file()
            await pilot.pause()
            assert panel.index == 0

            panel.action_next_file()
            panel.action_next_file()
            panel.action_next_file()
            await pilot.pause()
            assert panel.index == 1

    async def test_navigating_an_empty_panel_does_nothing(self) -> None:
        app = ReviewHost(())
        async with app.run_test() as pilot:
            await pilot.pause()
            panel = app.query_one(ReviewPanel)
            panel.action_next_file()
            panel.action_previous_file()
            await pilot.pause()

            assert panel.index == 0
            assert panel.current is None


class TestActions:
    async def test_accepting_posts_the_path_upward(self, changes) -> None:
        app = ReviewHost(changes)
        async with app.run_test() as pilot:
            await pilot.pause()
            app.query_one(ReviewPanel).action_accept()
            await pilot.pause()

            assert app.seen == [("accepted", "src/app.py")]

    async def test_reverting_posts_the_path_upward(self, changes) -> None:
        app = ReviewHost(changes)
        async with app.run_test() as pilot:
            await pilot.pause()
            app.query_one(ReviewPanel).action_revert()
            await pilot.pause()

            assert app.seen == [("reverted", "src/app.py")]

    async def test_the_panel_never_writes_anything_itself(self, backend, changes) -> None:
        # The panel holds no backend at all, and this is the assertion that keeps it that way:
        # deciding what a decision *means* belongs to the session, and putting a write behind a
        # button that also owns the rendering is how a UI ends up destroying a file on a redraw.
        app = ReviewHost(changes)
        async with app.run_test() as pilot:
            await pilot.pause()
            panel = app.query_one(ReviewPanel)
            panel.action_revert()
            panel.action_accept()
            await pilot.pause()

        assert backend.called("write_file") == []

    async def test_a_decided_file_leaves_the_panel_and_the_next_one_appears(
        self, changes
    ) -> None:
        app = ReviewHost(changes)
        async with app.run_test() as pilot:
            await pilot.pause()
            panel = app.query_one(ReviewPanel)
            panel.action_accept()
            await pilot.pause()

            # Optimistic: the app handles the message asynchronously and will re-show what is
            # still pending, but leaving the decided file on screen until then invites a second
            # keypress and a duplicate message.
            assert [change.path for change in panel.changes] == ["src/new.py"]
            assert panel.current is not None and panel.current.path == "src/new.py"
            assert str(app.query_one("#review-title", Static).content).count("1/1") == 1

    async def test_deciding_the_last_change_empties_the_panel(self, changes) -> None:
        app = ReviewHost(changes)
        async with app.run_test() as pilot:
            await pilot.pause()
            panel = app.query_one(ReviewPanel)
            panel.action_accept()
            panel.action_accept()
            await pilot.pause()

            assert panel.current is None
            assert app.seen == [("accepted", "src/app.py"), ("accepted", "src/new.py")]
            assert "nothing to review" in str(
                app.query_one("#review-title", Static).content
            ).lower()

    async def test_the_accept_button_does_the_same_thing_as_the_action(
        self, changes
    ) -> None:
        app = ReviewHost(changes)
        async with app.run_test() as pilot:
            await pilot.pause()
            app.query_one("#review-accept", Button).press()
            await pilot.pause()

            assert app.seen == [("accepted", "src/app.py")]

    async def test_the_revert_button_does_the_same_thing_as_the_action(
        self, changes
    ) -> None:
        app = ReviewHost(changes)
        async with app.run_test() as pilot:
            await pilot.pause()
            app.query_one("#review-revert", Button).press()
            await pilot.pause()

            assert app.seen == [("reverted", "src/app.py")]

    async def test_acting_on_an_empty_panel_posts_nothing(self) -> None:
        app = ReviewHost(())
        async with app.run_test() as pilot:
            await pilot.pause()
            panel = app.query_one(ReviewPanel)
            panel.action_accept()
            panel.action_revert()
            await pilot.pause()

            assert app.seen == []


class TestReshowing:
    async def test_showing_again_keeps_the_file_the_user_was_looking_at(
        self, changes
    ) -> None:
        # The app re-shows `session.pending()` after every decision and after every run. If
        # that reset the position to the top, reviewing a five-file run would mean scrolling
        # back to where you were after each accept.
        app = ReviewHost(changes)
        async with app.run_test() as pilot:
            await pilot.pause()
            panel = app.query_one(ReviewPanel)
            panel.action_next_file()
            await pilot.pause()

            panel.show(changes)
            await pilot.pause()

            assert panel.index == 1
            assert panel.current is not None and panel.current.path == "src/new.py"

    async def test_showing_a_shorter_list_clamps_the_position(self, changes) -> None:
        app = ReviewHost(changes)
        async with app.run_test() as pilot:
            await pilot.pause()
            panel = app.query_one(ReviewPanel)
            panel.action_next_file()
            await pilot.pause()

            panel.show(changes[:1])
            await pilot.pause()

            assert panel.index == 0
            assert panel.current is not None and panel.current.path == "src/app.py"

    async def test_clearing_removes_everything(self, changes) -> None:
        app = ReviewHost(changes)
        async with app.run_test() as pilot:
            await pilot.pause()
            panel = app.query_one(ReviewPanel)
            panel.clear()
            await pilot.pause()

            assert panel.changes == ()
            assert panel.current is None
            assert panel.rendered_diff == []
