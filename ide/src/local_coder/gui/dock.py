"""The bottom dock: problems, output, terminal, search.

Two of these do real work and two tell the truth about not being able to.

The terminal runs commands through the sandbox's allowlist, which is not a shell — see
`command_line.py` for what that costs and what is refused rather than approximated. Search
runs against the workspace and opens a hit at its line.

Problems and Debug are honest empty states. A Problems list that is empty because no analyser
is connected looks identical to one that is empty because the code is clean, so it says which;
shipping a convincing panel that cannot do anything is worse than shipping one that admits
what it is.
"""

from __future__ import annotations

from typing import Awaitable, Callable

from PySide6.QtCore import Qt, Signal
from PySide6.QtWidgets import (
    QLabel,
    QLineEdit,
    QListWidget,
    QListWidgetItem,
    QPlainTextEdit,
    QTabWidget,
    QVBoxLayout,
    QWidget,
)

from ..command_line import CommandHistory, contains_shell_syntax, parse_command_line
from ..protocols import AgentError, CoderBackend
from . import palette as p

#: The role a search row carries its target on, so a double-click can open it.
HIT_ROLE = Qt.ItemDataRole.UserRole


class OutputPane(QPlainTextEdit):
    """A read-only log the rest of the window appends to."""

    def __init__(self, placeholder: str) -> None:
        super().__init__()
        self.setObjectName("dockOutput")
        self.setReadOnly(True)
        self.setPlaceholderText(placeholder)

    def append(self, text: str) -> None:
        self.appendPlainText(text)


class TerminalPane(QWidget):
    """A command line over `CoderBackend.exec`.

    Not a shell and does not pretend to be one. The allowlist is shown rather than discovered
    by being refused, and an operator who has switched execution off is told which setting to
    change instead of watching every command fail one at a time.
    """

    def __init__(self, backend: CoderBackend, spawn: Callable[[Awaitable[None], str], None]) -> None:
        super().__init__()
        self._backend = backend
        self._spawn = spawn
        self._history = CommandHistory()
        self._enabled = False

        column = QVBoxLayout(self)
        column.setContentsMargins(10, 8, 10, 8)
        column.setSpacing(6)

        self._allowed = QLabel("Checking what may be run…")
        self._allowed.setStyleSheet(f"color: {p.TEXT_MUTED};")
        self._allowed.setWordWrap(True)
        column.addWidget(self._allowed)

        self._log = OutputPane("Command output appears here.")
        column.addWidget(self._log, 1)

        self._input = QLineEdit()
        self._input.setObjectName("terminalInput")
        self._input.setPlaceholderText("git status")
        self._input.returnPressed.connect(self._submit)
        self._input.installEventFilter(self)
        column.addWidget(self._input)

    def set_status(self, *, exec_enabled: bool, allowed: tuple[str, ...]) -> None:
        self._enabled = exec_enabled
        if not exec_enabled:
            self._allowed.setText(
                "Command execution is switched off. Set BRIDGE_EXEC_ALLOWLIST in "
                "host-bridge/.env and restart the host-bridge process."
            )
            self._input.setEnabled(False)
            return
        self._allowed.setText(
            "Runs directly, without a shell.  Allowed:  " + "   ".join(allowed)
        )

    def eventFilter(self, watched: object, event: object) -> bool:  # noqa: N802 - Qt's name
        # Up/down browse history. An event filter rather than a QShortcut because the arrows
        # have to be intercepted only while this input has focus — bound globally they would
        # fight the editor and the tree for the same keys.
        from PySide6.QtCore import QEvent
        from PySide6.QtGui import QKeyEvent

        if watched is self._input and isinstance(event, QKeyEvent) and event.type() == QEvent.Type.KeyPress:
            if event.key() == Qt.Key.Key_Up:
                previous = self._history.previous()
                if previous is not None:
                    self._input.setText(previous)
                return True
            if event.key() == Qt.Key.Key_Down:
                following = self._history.next()
                if following is not None:
                    self._input.setText(following)
                return True
        return super().eventFilter(watched, event)

    def _submit(self) -> None:
        line = self._input.text().strip()
        if not line:
            return
        self._history.add(line)
        self._input.clear()
        self._log.append(f"› {line}")

        if not self._enabled:
            self._log.append("  execution is switched off — see above\n")
            return

        if contains_shell_syntax(line):
            # Refused rather than run: `npm test | grep fail` would otherwise execute as npm
            # with three arguments, exit zero, and look like a pipeline that worked.
            self._log.append(
                "  pipes, redirection and operators are not available — commands run "
                "directly, without a shell\n"
            )
            return

        parsed = parse_command_line(line)
        if parsed is None:
            return
        self._spawn(self._run(parsed.command, parsed.args), "exec")

    async def _run(self, command: str, args: tuple[str, ...]) -> None:
        self._input.setEnabled(False)
        try:
            result = await self._backend.exec(command, args)
        except AgentError as error:
            self._log.append(f"  {error}\n")
            return
        finally:
            self._input.setEnabled(True)
            self._input.setFocus()

        if result.stdout:
            self._log.append(result.stdout.rstrip())
        if result.stderr:
            self._log.append(result.stderr.rstrip())
        # A non-zero exit is data, not a failure — a failing test suite is exactly what this
        # panel exists to show.
        timed = " · timed out" if result.timed_out else ""
        self._log.append(f"  exit {result.exit_code if result.exit_code is not None else 'none'}{timed}\n")


class SearchPane(QWidget):
    """Workspace-wide text search. A literal substring, not a regular expression."""

    hit_chosen = Signal(str, int)

    def __init__(self, backend: CoderBackend, spawn: Callable[[Awaitable[None], str], None]) -> None:
        super().__init__()
        self._backend = backend
        self._spawn = spawn

        column = QVBoxLayout(self)
        column.setContentsMargins(10, 8, 10, 8)
        column.setSpacing(6)

        self._input = QLineEdit()
        self._input.setObjectName("terminalInput")
        self._input.setPlaceholderText("Find in workspace…")
        self._input.returnPressed.connect(self._submit)
        column.addWidget(self._input)

        self._summary = QLabel("")
        self._summary.setStyleSheet(f"color: {p.TEXT_MUTED};")
        column.addWidget(self._summary)

        self._results = QListWidget()
        self._results.setStyleSheet("background: transparent; border: none;")
        self._results.itemActivated.connect(self._on_activated)
        self._results.itemClicked.connect(self._on_activated)
        column.addWidget(self._results, 1)

    def focus(self) -> None:
        self._input.setFocus()
        self._input.selectAll()

    def _submit(self) -> None:
        query = self._input.text().strip()
        if not query:
            return
        self._summary.setText("Searching…")
        self._spawn(self._search(query), "search")

    async def _search(self, query: str) -> None:
        self._results.clear()
        try:
            hits = await self._backend.search(query)
        except AgentError as error:
            self._summary.setText(str(error))
            return

        if not hits:
            self._summary.setText(f"No matches for “{query}”.")
            return

        files = {hit.path for hit in hits}
        self._summary.setText(
            f"{len(hits)} match{'es' if len(hits) != 1 else ''} in {len(files)} file"
            f"{'s' if len(files) != 1 else ''}"
        )
        for hit in hits:
            item = QListWidgetItem(f"{hit.path}:{hit.line}   {hit.text.strip()}")
            item.setData(HIT_ROLE, (hit.path, hit.line))
            self._results.addItem(item)

    def _on_activated(self, item: QListWidgetItem) -> None:
        target = item.data(HIT_ROLE)
        if target:
            path, line = target
            self.hit_chosen.emit(path, line)


class Dock(QTabWidget):
    """Holds the four panes and exposes the two the window writes into."""

    hit_chosen = Signal(str, int)

    def __init__(self, backend: CoderBackend, spawn: Callable[[Awaitable[None], str], None]) -> None:
        super().__init__()
        self.setObjectName("dock")
        self.setFixedHeight(210)

        self.problems = OutputPane(
            "No analyser is connected to this window yet, so nothing here is being checked. "
            "Diagnostics currently come from the terminal application's language server."
        )
        self.output = OutputPane("Saves, refreshes and agent runs appear here.")
        self.terminal = TerminalPane(backend, spawn)
        self.search = SearchPane(backend, spawn)
        self.search.hit_chosen.connect(self.hit_chosen)

        self.addTab(self.problems, "Problems")
        self.addTab(self.output, "Output")
        self.addTab(self.terminal, "Terminal")
        self.addTab(self.search, "Search")
        self.setCurrentWidget(self.terminal)

    def show_pane(self, widget: QWidget) -> None:
        self.setCurrentWidget(widget)
