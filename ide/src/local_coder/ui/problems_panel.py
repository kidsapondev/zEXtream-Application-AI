"""Everything the language server is complaining about, in one list you can jump from.

The panel is deliberately inert, the same way `ReviewPanel` is: it holds no `LspClient`,
sends nothing, and asks nothing. It renders a tuple of `Diagnostic` and posts
`DiagnosticSelected` upward; `app.py` decides what "jump there" means. Keeping the rendering
and the navigation in separate objects is what makes it impossible for a redraw to move the
user's cursor.

Two decisions worth defending, because both are easy to get backwards:

**Worst severity first, per file and across files.** A problems list sorted by path is a list
people read the top of and abandon, and the top is then whichever filename happens to sort
first. Sorting by severity means the thing that stops the program compiling is on line one.

**Severity is legible without colour.** Every row carries a glyph *and* the severity word,
not just a colour. Colour alone fails for a colour-blind reader, in a `NO_COLOR` terminal,
and in a screenshot pasted into a bug report — and severity is the one attribute that decides
whether to act now or later, so it is the worst one to lose.
"""

from __future__ import annotations

from typing import Sequence

from textual import on
from textual.app import ComposeResult
from textual.containers import Vertical
from textual.message import Message
from textual.widgets import Label, ListItem, ListView, Static

from ..lsp import SEVERITIES, Diagnostic, severity_rank

#: Shown when there is nothing wrong. Phrased as a statement rather than left blank: an empty
#: panel is ambiguous between "no problems" and "no language server running", and those need
#: very different reactions from the user.
EMPTY_STATE = "No problems found."

#: One character per severity, ASCII on purpose.
#:
#: The tempting choice is box-drawing or emoji (✖ ⚠ ℹ), and it renders beautifully in the
#: terminal it was tested in and as a replacement box everywhere else. A letter or a
#: punctuation mark has no font coverage problem anywhere, and this is the column a reader
#: scans first.
_GLYPHS: dict[str, str] = {
    "error": "x",
    "warning": "!",
    "info": "i",
    "hint": "?",
}

#: Width of the severity word column, sized to the longest name ("warning").
_SEVERITY_WIDTH = 7


def severity_glyph(severity: str) -> str:
    """The one-character marker for a severity name. Unknown names get a neutral dot."""
    return _GLYPHS.get(severity, "-")


def _counts_phrase(diagnostics: Sequence[Diagnostic]) -> str:
    """"2 errors, 1 warning" — worst severity first, zero counts omitted.

    Pluralised properly rather than with a trailing "(s)": this string appears on every file
    header in the panel, so a small wrongness is repeated down the whole screen.
    """
    parts: list[str] = []
    for name in SEVERITIES:
        count = sum(1 for diagnostic in diagnostics if diagnostic.severity == name)
        if count:
            parts.append(f"{count} {name}{'' if count == 1 else 's'}")
    return ", ".join(parts)


def group_by_file(
    diagnostics: Sequence[Diagnostic],
) -> tuple[tuple[str, tuple[Diagnostic, ...]], ...]:
    """Diagnostics grouped by path, worst file first, worst diagnostic first within it.

    Ties are broken by path between files and by position within one, so the order is total:
    the same input always renders the same way, which matters because the panel is redrawn on
    every keystroke's worth of diagnostics and a list that reshuffles under the cursor is
    unusable.
    """
    by_path: dict[str, list[Diagnostic]] = {}
    for diagnostic in diagnostics:
        by_path.setdefault(diagnostic.path, []).append(diagnostic)

    grouped = [
        (
            path,
            tuple(
                sorted(
                    items,
                    key=lambda item: (
                        severity_rank(item.severity),
                        item.line,
                        item.column,
                    ),
                )
            ),
        )
        for path, items in by_path.items()
    ]
    # A file's rank is its worst diagnostic's rank — already first, because the inner sort
    # put it there.
    grouped.sort(key=lambda entry: (severity_rank(entry[1][0].severity), entry[0]))
    return tuple(grouped)


def file_header(path: str, diagnostics: Sequence[Diagnostic]) -> str:
    """The row that introduces one file's problems: its path and what is in it."""
    return f"{path}  ({_counts_phrase(diagnostics)})"


def diagnostic_row(diagnostic: Diagnostic) -> str:
    """One problem as a single line, indented under its file header.

    `line:column` comes before the message so the positions form a scannable column, and the
    reporting server is named at the end — with two servers attached, "which tool is
    complaining" is the difference between a real type error and a lint opinion.
    """
    glyph = severity_glyph(diagnostic.severity)
    where = f"{diagnostic.line}:{diagnostic.column}"
    row = (
        f"  {glyph} {diagnostic.severity:<{_SEVERITY_WIDTH}} "
        f"{where:>8}  {diagnostic.message}"
    )
    # Only when there is one — an empty "()" is visual noise that reads as missing data.
    return f"{row}  ({diagnostic.source})" if diagnostic.source else row


def summary(diagnostics: Sequence[Diagnostic]) -> str:
    """The status line above the list."""
    if not diagnostics:
        return EMPTY_STATE
    files = {diagnostic.path for diagnostic in diagnostics}
    problem_word = "problem" if len(diagnostics) == 1 else "problems"
    file_word = "file" if len(files) == 1 else "files"
    return (
        f"{len(diagnostics)} {problem_word} in {len(files)} {file_word}"
        f"  ·  {_counts_phrase(diagnostics)}"
    )


class ProblemsPanel(Vertical):
    """A grouped, severity-ordered list of diagnostics that posts a jump target when chosen."""

    DEFAULT_CSS = """
    ProblemsPanel { height: auto; max-height: 24; }

    ProblemsPanel ListView { height: auto; max-height: 18; }

    #problems-status {
        height: 1;
        padding: 0 1;
        color: $text-muted;
    }

    .problems-file-header {
        color: $text-muted;
        text-style: bold;
    }
    """

    class DiagnosticSelected(Message):
        """Posted when a problem row is chosen, so the app can open `path` at `line`.

        Carries the whole `Diagnostic` as well as the three positional fields. The fields are
        lifted out because every handler wants them and `event.line` reads better at the call
        site than `event.diagnostic.line`; the diagnostic itself is kept because a handler
        that wants to put the message in the status bar should not have to look it up again.
        """

        def __init__(self, panel: "ProblemsPanel", diagnostic: Diagnostic) -> None:
            super().__init__()
            self.panel = panel
            self.diagnostic = diagnostic
            self.path = diagnostic.path
            self.line = diagnostic.line
            self.column = diagnostic.column

        @property
        def control(self) -> "ProblemsPanel":
            """What `@on(ProblemsPanel.DiagnosticSelected, "#problems")` matches against."""
            return self.panel

    def __init__(
        self,
        *,
        name: str | None = None,
        id: str | None = None,  # noqa: A002 - Textual's own parameter name
        classes: str | None = None,
        disabled: bool = False,
    ) -> None:
        super().__init__(name=name, id=id, classes=classes, disabled=disabled)
        self._diagnostics: tuple[Diagnostic, ...] = ()
        #: Parallel to the `ListView`'s children, index for index. `None` marks a file-header
        #: row, which must never turn into a `DiagnosticSelected` no matter where the cursor
        #: lands — so "no diagnostic here" has to be representable, not merely absent.
        self._rows: list[Diagnostic | None] = []
        #: Plain-text mirror of what was drawn. A `Static` only renders once it has a real
        #: size, which never happens headlessly, so anything that wants to assert on what the
        #: user saw has to be told separately. Same reasoning as `ReviewPanel.rendered_diff`.
        self.rendered_rows: list[str] = []
        #: True once `compose`'s children exist. The app wires diagnostics in from its own
        #: `on_mount`, which can run before this widget's children are mounted, and a
        #: `query_one` at that moment raises. Named distinctively: `_running` is the obvious
        #: name for a flag like this and is already owned by Textual's `App`, where it is set
        #: True at startup and silently defeats every guard written against it.
        self._view_ready = False

    # -- layout ------------------------------------------------------------------------

    def compose(self) -> ComposeResult:
        yield Static(EMPTY_STATE, id="problems-status", markup=False)
        yield ListView(id="problems-list")

    def on_mount(self) -> None:
        self._view_ready = True
        self._refresh_view()

    # -- state -------------------------------------------------------------------------

    @property
    def diagnostics(self) -> tuple[Diagnostic, ...]:
        """Exactly what was last handed to `show()`, in that order."""
        return self._diagnostics

    def show(self, diagnostics: Sequence[Diagnostic]) -> None:
        """Replaces the whole list.

        Wholesale rather than incrementally, because that is what the protocol gives us:
        `textDocument/publishDiagnostics` is a full replacement per file (see
        `LspClient._handle_notification`), so there is no diff to apply and pretending
        otherwise would only invent a way for the panel to drift from the server.
        """
        self._diagnostics = tuple(diagnostics)
        self._refresh_view()

    def clear(self) -> None:
        """Empties the panel — when the server stops, or the workspace changes."""
        self.show(())

    # -- rendering ---------------------------------------------------------------------

    def _refresh_view(self) -> None:
        groups = group_by_file(self._diagnostics)

        rows: list[Diagnostic | None] = []
        rendered: list[str] = []
        for path, items in groups:
            rows.append(None)
            rendered.append(file_header(path, items))
            for diagnostic in items:
                rows.append(diagnostic)
                rendered.append(diagnostic_row(diagnostic))

        self._rows = rows
        self.rendered_rows = rendered

        # Computed above regardless, so the mirror is correct even before the children exist;
        # only the drawing needs them.
        if not self._view_ready:
            return

        self.query_one("#problems-status", Static).update(summary(self._diagnostics))

        listing = self.query_one("#problems-list", ListView)
        listing.clear()
        listing.extend(
            ListItem(
                # `markup=False` because a diagnostic message is arbitrary text quoting
                # arbitrary source: a message containing `[bold]` or a bare `[` would
                # otherwise be parsed as console markup and either swallow part of the line
                # or raise mid-render.
                Label(text, markup=False),
                classes="problems-file-header" if row is None else None,
            )
            for row, text in zip(rows, rendered)
        )
        # `ListView.index` does not survive a repopulate, and a cursor parked on a header row
        # means the user's first Enter does nothing at all — which reads as a broken panel
        # rather than as a deliberate no-op.
        listing.index = next(
            (index for index, row in enumerate(rows) if row is not None), None
        )

    # -- selection ---------------------------------------------------------------------

    @on(ListView.Selected)
    def _on_list_selected(self, event: ListView.Selected) -> None:
        event.stop()
        listing = self.query_one("#problems-list", ListView)
        index = listing.index
        if index is None or index >= len(self._rows):
            return
        diagnostic = self._rows[index]
        if diagnostic is None:
            # A file header. There is no single line to jump to, so this is a deliberate
            # no-op rather than a guess at "the first problem below it".
            return
        self.post_message(self.DiagnosticSelected(self, diagnostic))
