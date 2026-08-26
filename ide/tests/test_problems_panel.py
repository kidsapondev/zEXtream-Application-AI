"""Specification for `local_coder.ui.problems_panel`.

Same shape as `test_search_panel.py`: the widget is mounted inside a one-widget host `App`,
because a Textual `Message` posted by a widget that is not running inside an app goes nowhere
and every assertion about it would pass for the wrong reason.

Two things this file deliberately pins beyond "does it show the rows":

* **Order.** A problems list that is not worst-first is a list nobody reads to the bottom of.
  The ordering is a pure function (`group_by_file`) so it can be asserted without a terminal.
* **Severity is legible without colour.** Every row carries a glyph *and* the severity word.
  Colour alone fails for a colour-blind reader, a `NO_COLOR` terminal, and a screenshot in a
  bug report — and it is the one attribute of a diagnostic that decides whether to act now.
"""

from __future__ import annotations

from textual import on
from textual.app import App, ComposeResult
from textual.widgets import Label, ListView, Static

from local_coder.lsp import Diagnostic
from local_coder.ui.problems_panel import (
    ProblemsPanel,
    diagnostic_row,
    file_header,
    group_by_file,
    severity_glyph,
    summary,
)


def _diagnostic(
    path: str = "src/app.py",
    line: int = 1,
    column: int = 1,
    severity: str = "error",
    message: str = "boom",
    source: str = "pyright",
) -> Diagnostic:
    return Diagnostic(path, line, column, severity, message, source)


class _HostApp(App[None]):
    """Mounts a single `ProblemsPanel` and records what it posts."""

    def __init__(self, diagnostics: tuple[Diagnostic, ...] = ()) -> None:
        super().__init__()
        # Named distinctly from the panel's own attribute so an accidental cross-assignment
        # in a future test is visible rather than quietly self-consistent.
        self.initial_diagnostics = diagnostics
        self.selected: list[tuple[str, int, int]] = []

    def compose(self) -> ComposeResult:
        yield ProblemsPanel(id="problems")

    def on_mount(self) -> None:
        self.query_one(ProblemsPanel).show(self.initial_diagnostics)

    @on(ProblemsPanel.DiagnosticSelected)
    def _on_selected(self, event: ProblemsPanel.DiagnosticSelected) -> None:
        self.selected.append((event.path, event.line, event.column))


class TestGrouping:
    def test_files_are_ordered_by_their_worst_severity_first(self) -> None:
        # `a_warning.py` sorts first alphabetically and must still lose to the file that has
        # an actual error in it — the panel exists to answer "what is broken", not "what is
        # first".
        diagnostics = (
            _diagnostic(path="a_warning.py", severity="warning"),
            _diagnostic(path="z_error.py", severity="error"),
        )

        assert [path for path, _ in group_by_file(diagnostics)] == [
            "z_error.py",
            "a_warning.py",
        ]

    def test_files_of_equal_severity_are_ordered_by_path(self) -> None:
        diagnostics = (
            _diagnostic(path="src/z.py"),
            _diagnostic(path="src/a.py"),
        )

        assert [path for path, _ in group_by_file(diagnostics)] == ["src/a.py", "src/z.py"]

    def test_within_a_file_severity_wins_over_line_number(self) -> None:
        diagnostics = (
            _diagnostic(line=90, severity="warning", message="late warning"),
            _diagnostic(line=2, severity="hint", message="early hint"),
            _diagnostic(line=40, severity="error", message="middle error"),
        )

        (_, rows), = group_by_file(diagnostics)

        assert [row.message for row in rows] == [
            "middle error",
            "late warning",
            "early hint",
        ]

    def test_equal_severities_within_a_file_are_ordered_by_position(self) -> None:
        diagnostics = (
            _diagnostic(line=10, column=9, message="second"),
            _diagnostic(line=10, column=2, message="first"),
            _diagnostic(line=3, column=1, message="zeroth"),
        )

        (_, rows), = group_by_file(diagnostics)

        assert [row.message for row in rows] == ["zeroth", "first", "second"]

    def test_no_diagnostics_yields_no_groups(self) -> None:
        assert group_by_file(()) == ()


class TestRendering:
    def test_every_severity_has_its_own_glyph(self) -> None:
        glyphs = [severity_glyph(name) for name in ("error", "warning", "info", "hint")]

        assert len(set(glyphs)) == 4
        assert all(glyph.strip() for glyph in glyphs)

    def test_a_row_names_its_severity_in_words_as_well(self) -> None:
        # The glyph alone is a convention the reader has to learn; the word is not.
        row = diagnostic_row(_diagnostic(severity="warning", line=12, column=5))

        assert "warning" in row
        assert severity_glyph("warning") in row

    def test_a_row_carries_the_position_and_the_message(self) -> None:
        row = diagnostic_row(
            _diagnostic(line=12, column=5, message='"vlaue" is not defined')
        )

        assert "12:5" in row
        assert '"vlaue" is not defined' in row

    def test_a_row_names_the_server_that_reported_it(self) -> None:
        # With two servers attached, "which tool is complaining" is the difference between a
        # real type error and a lint opinion.
        assert "pyright" in diagnostic_row(_diagnostic(source="pyright"))

    def test_a_row_without_a_source_does_not_render_empty_brackets(self) -> None:
        row = diagnostic_row(_diagnostic(source=""))

        assert "()" not in row
        assert row.rstrip() == row.rstrip()

    def test_a_file_header_carries_a_count(self) -> None:
        header = file_header(
            "src/app.py",
            (
                _diagnostic(severity="error"),
                _diagnostic(severity="error"),
                _diagnostic(severity="warning"),
            ),
        )

        assert header.startswith("src/app.py")
        assert "2 errors" in header
        assert "1 warning" in header


class TestSummary:
    def test_an_empty_list_says_so_plainly(self) -> None:
        text = summary(())

        assert "no problems" in text.lower()

    def test_one_problem_is_singular_everywhere(self) -> None:
        assert summary((_diagnostic(),)) == "1 problem in 1 file  ·  1 error"

    def test_counts_files_and_severities(self) -> None:
        diagnostics = (
            _diagnostic(path="a.py", severity="error"),
            _diagnostic(path="a.py", severity="error"),
            _diagnostic(path="b.py", severity="warning"),
        )

        assert summary(diagnostics) == "3 problems in 2 files  ·  2 errors, 1 warning"

    def test_severities_are_listed_worst_first(self) -> None:
        diagnostics = (
            _diagnostic(severity="hint"),
            _diagnostic(severity="error"),
            _diagnostic(severity="info"),
            _diagnostic(severity="warning"),
        )

        tail = summary(diagnostics).split("·")[1]

        assert tail.index("error") < tail.index("warning") < tail.index("info")
        assert tail.index("info") < tail.index("hint")


class TestPanel:
    async def test_the_empty_state_says_there_are_no_problems(self) -> None:
        app = _HostApp()
        async with app.run_test() as pilot:
            await pilot.pause()
            status = str(app.query_one("#problems-status", Static).content)
            rows = len(app.query_one(ListView).children)

        assert "no problems" in status.lower()
        assert rows == 0

    async def test_rows_are_grouped_under_a_header_per_file(self) -> None:
        diagnostics = (
            _diagnostic(path="a.py", line=1, severity="error", message="one"),
            _diagnostic(path="a.py", line=2, severity="error", message="two"),
            _diagnostic(path="b.py", line=3, severity="warning", message="three"),
        )
        app = _HostApp(diagnostics)
        async with app.run_test() as pilot:
            await pilot.pause()
            rendered = [
                str(item.query_one(Label).content)
                for item in app.query_one(ListView).children
            ]

        assert rendered[0].startswith("a.py")
        assert "one" in rendered[1]
        assert "two" in rendered[2]
        assert rendered[3].startswith("b.py")
        assert "three" in rendered[4]

    async def test_the_panel_mirrors_what_it_drew(self) -> None:
        """A `Static`'s rendered output only exists once it has a real size, which never
        happens headlessly — so the panel keeps its own plain-text mirror, exactly as
        `ReviewPanel.rendered_diff` does, and that is what a test can read back.
        """
        diagnostics = (_diagnostic(message="only one"),)
        app = _HostApp(diagnostics)
        async with app.run_test() as pilot:
            await pilot.pause()
            mirror = list(app.query_one(ProblemsPanel).rendered_rows)

        assert len(mirror) == 2
        assert mirror[0].startswith("src/app.py")
        assert "only one" in mirror[1]

    async def test_the_status_line_counts_the_problems(self) -> None:
        diagnostics = (
            _diagnostic(path="a.py"),
            _diagnostic(path="b.py", severity="warning"),
        )
        app = _HostApp(diagnostics)
        async with app.run_test() as pilot:
            await pilot.pause()
            status = str(app.query_one("#problems-status", Static).content)

        assert status == summary(diagnostics)

    async def test_selecting_a_diagnostic_posts_its_path_line_and_column(self) -> None:
        diagnostics = (_diagnostic(path="src/app.py", line=12, column=5),)
        app = _HostApp(diagnostics)
        async with app.run_test() as pilot:
            await pilot.pause()
            rows = app.query_one(ListView)
            # Row 0 is the file header; row 1 is the diagnostic. `ListView`'s own `enter`
            # binding only fires while the list itself is focused.
            rows.index = 1
            rows.focus()
            await pilot.press("enter")
            await pilot.pause()

        assert app.selected == [("src/app.py", 12, 5)]

    async def test_selecting_a_file_header_does_nothing(self) -> None:
        app = _HostApp((_diagnostic(),))
        async with app.run_test() as pilot:
            await pilot.pause()
            rows = app.query_one(ListView)
            rows.index = 0
            rows.focus()
            await pilot.press("enter")
            await pilot.pause()

        assert app.selected == []

    async def test_the_cursor_starts_on_the_first_real_diagnostic(self) -> None:
        """`ListView.index` is not reset by `clear()`, and a cursor parked on a header row
        means the first Enter does nothing at all — which reads as a broken panel.
        """
        app = _HostApp((_diagnostic(path="a.py"), _diagnostic(path="b.py")))
        async with app.run_test() as pilot:
            await pilot.pause()
            index = app.query_one(ListView).index

        assert index == 1

    async def test_showing_again_replaces_the_previous_list(self) -> None:
        app = _HostApp((_diagnostic(path="a.py", message="stale"),))
        async with app.run_test() as pilot:
            await pilot.pause()
            panel = app.query_one(ProblemsPanel)
            panel.show((_diagnostic(path="b.py", message="fresh"),))
            await pilot.pause()
            rendered = "\n".join(panel.rendered_rows)

        assert "fresh" in rendered
        assert "stale" not in rendered
        assert panel.diagnostics == (_diagnostic(path="b.py", message="fresh"),)

    async def test_clear_returns_to_the_empty_state(self) -> None:
        app = _HostApp((_diagnostic(),))
        async with app.run_test() as pilot:
            await pilot.pause()
            panel = app.query_one(ProblemsPanel)
            panel.clear()
            await pilot.pause()
            status = str(app.query_one("#problems-status", Static).content)

        assert panel.diagnostics == ()
        assert panel.rendered_rows == []
        assert "no problems" in status.lower()

    async def test_show_before_mount_does_not_raise(self) -> None:
        """The app wires diagnostics in from its own `on_mount`, which can run before this
        widget's children exist — a `query_one` at that moment raises. The mirror still has
        to be correct, because the redraw happens on mount from stored state.
        """
        panel = ProblemsPanel(id="problems")
        panel.show((_diagnostic(message="early"),))

        assert panel.diagnostics != ()
        assert any("early" in row for row in panel.rendered_rows)

    async def test_a_message_carries_the_diagnostic_it_came_from(self) -> None:
        diagnostics = (_diagnostic(path="src/app.py", line=7, column=3, message="typo"),)
        seen: list[Diagnostic] = []

        class _Host(_HostApp):
            @on(ProblemsPanel.DiagnosticSelected)
            def _capture(self, event: ProblemsPanel.DiagnosticSelected) -> None:
                seen.append(event.diagnostic)

        app = _Host(diagnostics)
        async with app.run_test() as pilot:
            await pilot.pause()
            rows = app.query_one(ListView)
            rows.index = 1
            rows.focus()
            await pilot.press("enter")
            await pilot.pause()

        assert seen == [diagnostics[0]]
