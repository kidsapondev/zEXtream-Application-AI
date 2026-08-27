"""The window.

Layout, top to bottom: a title bar, a toolbar of model actions, then a three-column body —
explorer, editor, AI panel — over a bottom dock, with a status bar underneath.

## Async in a Qt window

`CoderBackend` is asyncio all the way down: it drives a subprocess over stdio and every call
is a coroutine. Qt has its own event loop, and the two do not cooperate by default — calling
`asyncio.run` from a slot blocks the UI for the duration, and a naive thread makes every
result arrive on the wrong thread to touch a widget from.

`qasync` resolves it by running Qt's loop *as* the asyncio loop, so `asyncio.ensure_future`
schedules onto the same loop that paints. Every backend call here therefore goes through
`self._spawn`, which starts a task and reports failures rather than letting them vanish into
an un-awaited future — the standard way async work disappears silently in a GUI.

## Why this window is not the terminal app with different paint

It shares everything below the presentation layer — `McpBackend`, `WorkspaceTree`,
`ReviewSession`, `GitRepo`, `Runner`, `LspClient` — and reimplements none of it. What differs
is only what a window can do that a terminal cannot: real buttons, colour-coded file badges,
rounded panels, and a layout that does not have to fit a character grid.
"""

from __future__ import annotations

import asyncio
from pathlib import Path
from typing import Awaitable, Callable

from PySide6.QtCore import Qt
from PySide6.QtGui import QKeySequence, QShortcut
from PySide6.QtWidgets import (
    QComboBox,
    QFrame,
    QHBoxLayout,
    QLabel,
    QLineEdit,
    QMainWindow,
    QPlainTextEdit,
    QPushButton,
    QSplitter,
    QTabWidget,
    QTreeWidget,
    QTreeWidgetItem,
    QVBoxLayout,
    QWidget,
)

from ..protocols import AgentError, CoderBackend, Entry
from ..workspace import WorkspaceTree
from . import palette as p
from .highlighter import Highlighter
from .palette import file_kind, known_languages, language_for
from .widgets import CodeEditor, Pill, badge_icon, folder_icon

#: The five model actions across the toolbar, each a preset instruction rather than a separate
#: feature. Keeping them as data means adding one is a line here, not a new code path.
TOOL_ACTIONS: tuple[tuple[str, str, str], ...] = (
    ("debug", "Debug", "Find and explain bugs in this file, then fix them."),
    ("optimize", "Optimize", "Make this file faster or simpler without changing behaviour."),
    ("translate", "Translate", "Translate this file to another language, preserving behaviour."),
    ("documentation", "Documentation", "Add or improve the documentation in this file."),
    ("generate", "Generate code", "Generate the code described by the comments in this file."),
)

#: Roles on tree items, so a row can carry its path and kind without a parallel dictionary.
PATH_ROLE = Qt.ItemDataRole.UserRole
IS_DIR_ROLE = Qt.ItemDataRole.UserRole + 1
LOADED_ROLE = Qt.ItemDataRole.UserRole + 2


class MainWindow(QMainWindow):
    """The desktop IDE."""

    def __init__(self, backend: CoderBackend, *, model: str | None = None) -> None:
        super().__init__()
        self._backend = backend
        self._tree_model = WorkspaceTree(backend)
        self._model = model
        #: Path to unsaved text, so a tab knows whether it is dirty without asking the widget.
        self._baselines: dict[str, str] = {}
        self._editors: dict[str, CodeEditor] = {}
        self._highlighters: dict[str, Highlighter] = {}

        self.setWindowTitle("Local Coder")
        self.resize(1440, 900)
        self._build()
        self._bind_shortcuts()

    def _bind_shortcuts(self) -> None:
        """Keyboard bindings.

        Save is the one that matters. Without it the window can open a file and edit it and
        offers no way at all to write it back — every change is lost on close, which makes
        the whole editor decorative. It was missing until a walkthrough of the running window
        went looking for it.
        """
        for sequence, handler in (
            ("Ctrl+S", lambda: self._spawn(self.save_active(), "save")),
            ("Ctrl+W", self._close_active_tab),
            ("Ctrl+Q", self.close),
            ("Ctrl+R", lambda: self._spawn(self._load_root(), "reload")),
        ):
            shortcut = QShortcut(QKeySequence(sequence), self)
            shortcut.activated.connect(handler)

    def _close_active_tab(self) -> None:
        index = self._tabs.currentIndex()
        if index >= 0:
            self._on_tab_close(index)

    # -- construction --------------------------------------------------------------------

    def _build(self) -> None:
        root = QWidget()
        root.setObjectName("root")
        layout = QVBoxLayout(root)
        layout.setContentsMargins(0, 0, 0, 0)
        layout.setSpacing(0)

        layout.addWidget(self._build_toolbar())

        body = QSplitter(Qt.Orientation.Horizontal)
        body.addWidget(self._build_explorer())
        body.addWidget(self._build_centre())
        body.addWidget(self._build_ai_panel())
        # Stretch factors rather than fixed widths: the editor is the only column whose useful
        # size depends on the window, and the two side panels have a natural width they should
        # keep when the window grows.
        body.setStretchFactor(0, 0)
        body.setStretchFactor(1, 1)
        body.setStretchFactor(2, 0)
        body.setSizes([300, 800, 340])
        layout.addWidget(body, 1)

        layout.addWidget(self._build_dock())
        layout.addWidget(self._build_status())

        self.setCentralWidget(root)

    def _build_toolbar(self) -> QWidget:
        bar = QFrame()
        bar.setObjectName("toolBar")
        row = QHBoxLayout(bar)
        row.setContentsMargins(14, 8, 14, 8)
        row.setSpacing(6)

        home = QPushButton("⌂")
        home.setObjectName("ghost")
        home.setFixedWidth(46)
        home.setToolTip("Reload the workspace")
        home.clicked.connect(lambda: self._spawn(self._load_root(), "reload"))
        row.addWidget(home)

        separator = QLabel("│")
        separator.setStyleSheet(f"color: {p.HAIRLINE_STRONG};")
        row.addWidget(separator)

        for key, label, instruction in TOOL_ACTIONS:
            button = QPushButton(label)
            button.setObjectName("toolAction")
            button.setToolTip(instruction)
            button.clicked.connect(
                lambda _checked=False, k=key, text=instruction: self._run_action(k, text)
            )
            row.addWidget(button)

        row.addStretch(1)

        self._language_box = QComboBox()
        # Populated from the file-type table rather than typed out here: a hand-maintained
        # list drifts silently, because setCurrentText with a value the box does not contain
        # does nothing and leaves the previous file's language showing.
        self._language_box.addItems(known_languages())
        self._language_box.currentTextChanged.connect(self._on_language_changed)
        row.addWidget(self._language_box)

        return bar

    def _build_explorer(self) -> QWidget:
        panel = QFrame()
        panel.setObjectName("panel")
        column = QVBoxLayout(panel)
        column.setContentsMargins(10, 10, 10, 10)
        column.setSpacing(8)

        controls = QHBoxLayout()
        controls.setSpacing(6)
        create = QPushButton("＋  Create new file")
        create.setObjectName("ghost")
        create.clicked.connect(self._on_create_file)
        controls.addWidget(create, 1)

        search = QPushButton("⌕")
        search.setObjectName("ghost")
        search.setFixedWidth(40)
        search.setToolTip("Search the workspace")
        search.clicked.connect(lambda: self._focus_dock("Search"))
        controls.addWidget(search)
        column.addLayout(controls)

        heading = QLabel("EXPLORER")
        heading.setObjectName("panelTitle")
        column.addWidget(heading)

        self._tree = QTreeWidget()
        self._tree.setObjectName("explorer")
        self._tree.setHeaderHidden(True)
        self._tree.setIndentation(14)
        self._tree.itemExpanded.connect(self._on_expanded)
        self._tree.itemClicked.connect(self._on_item_clicked)
        column.addWidget(self._tree, 1)

        return panel

    def _build_centre(self) -> QWidget:
        centre = QWidget()
        column = QVBoxLayout(centre)
        column.setContentsMargins(0, 0, 0, 0)
        column.setSpacing(0)

        self._tabs = QTabWidget()
        self._tabs.setObjectName("editorTabs")
        self._tabs.setTabsClosable(True)
        self._tabs.setMovable(True)
        self._tabs.tabCloseRequested.connect(self._on_tab_close)
        self._tabs.currentChanged.connect(lambda _index: self._sync_active())
        column.addWidget(self._tabs, 1)

        self._breadcrumb = QLabel("")
        self._breadcrumb.setStyleSheet(
            f"color: {p.TEXT_MUTED}; padding: 6px 12px; background: {p.EDITOR};"
        )
        column.insertWidget(0, self._breadcrumb)

        return centre

    def _build_ai_panel(self) -> QWidget:
        panel = QFrame()
        panel.setObjectName("panel")
        column = QVBoxLayout(panel)
        column.setContentsMargins(12, 12, 12, 12)
        column.setSpacing(10)

        header = QHBoxLayout()
        self._ai_title = QLabel("Ready")
        self._ai_title.setStyleSheet(f"color: {p.TEXT}; font-weight: 600;")
        header.addWidget(self._ai_title, 1)
        self._ai_count = Pill("0")
        header.addWidget(self._ai_count)
        column.addLayout(header)

        self._ai_body = QPlainTextEdit()
        self._ai_body.setObjectName("dockOutput")
        self._ai_body.setReadOnly(True)
        self._ai_body.setPlaceholderText(
            "Pick a toolbar action, or describe a change below. The model runs on this "
            "machine's GPU and edits files directly — every step it takes is listed here."
        )
        column.addWidget(self._ai_body, 1)

        self._ai_task = QLineEdit()
        self._ai_task.setObjectName("terminalInput")
        self._ai_task.setPlaceholderText("Describe a change…")
        self._ai_task.returnPressed.connect(self._on_task_submitted)
        column.addWidget(self._ai_task)

        self._fix_all = QPushButton("Fix all issues")
        self._fix_all.setObjectName("primary")
        self._fix_all.clicked.connect(self._on_task_submitted)
        column.addWidget(self._fix_all)

        return panel

    def _build_dock(self) -> QWidget:
        self._dock = QTabWidget()
        self._dock.setObjectName("dock")
        self._dock.setFixedHeight(200)

        for name in ("Problems", "Output", "Terminal", "Search"):
            view = QPlainTextEdit()
            view.setObjectName("dockOutput")
            view.setReadOnly(True)
            if name == "Problems":
                view.setPlaceholderText(
                    "No analyser is connected yet, so nothing here is being checked."
                )
            elif name == "Terminal":
                view.setPlaceholderText("Command output appears here.")
            self._dock.addTab(view, name)

        return self._dock

    def _build_status(self) -> QWidget:
        bar = QFrame()
        bar.setObjectName("statusBar")
        row = QHBoxLayout(bar)
        row.setContentsMargins(12, 4, 12, 4)
        row.setSpacing(16)

        self._status_left = QLabel("Starting…")
        self._status_left.setStyleSheet(f"color: {p.TEXT_MUTED};")
        row.addWidget(self._status_left)
        row.addStretch(1)

        self._status_right = QLabel("")
        self._status_right.setStyleSheet(f"color: {p.TEXT_MUTED};")
        row.addWidget(self._status_right)

        return bar

    # -- async plumbing ------------------------------------------------------------------

    def _spawn(self, coro: Awaitable[None], label: str) -> None:
        """Runs `coro` on the shared Qt/asyncio loop, reporting failures rather than losing them.

        An un-awaited future that raises is the standard way async work disappears in a GUI:
        nothing happens, nothing is logged, and the button appears to have done nothing at all.
        """
        task = asyncio.ensure_future(coro)

        def done(finished: asyncio.Task[None]) -> None:
            if finished.cancelled():
                return
            error = finished.exception()
            if error is not None:
                self._log(f"{label} failed: {error}", tab="Output")
                self._status_left.setText(str(error))

        task.add_done_callback(done)

    async def start(self) -> None:
        """Loads the workspace. Called once the window is shown."""
        try:
            status = await self._backend.status()
        except AgentError as error:
            self._status_left.setText(str(error))
            return

        if not status.workspace_configured:
            self._status_left.setText(
                "No workspace configured — set BRIDGE_WORKSPACE_ROOT in host-bridge/.env"
            )
            return

        model = self._model or (
            status.tool_capable_models[0] if status.tool_capable_models else "no model"
        )
        self._status_left.setText(f"{status.workspace_root}")
        self._status_right.setText(model)
        await self._load_root()

    # -- explorer ------------------------------------------------------------------------

    async def _load_root(self) -> None:
        self._tree_model.invalidate_all()
        self._tree.clear()
        for entry in await self._tree_model.load(""):
            self._tree.addTopLevelItem(self._make_item(entry))

    def _make_item(self, entry: Entry) -> QTreeWidgetItem:
        item = QTreeWidgetItem([entry.name])
        item.setData(0, PATH_ROLE, entry.path)
        item.setData(0, IS_DIR_ROLE, entry.is_dir)
        item.setData(0, LOADED_ROLE, False)
        # An icon rather than a row widget. setItemWidget would swallow the clicks that open
        # the file - see badge_icon - so the badge has to be part of the item itself.
        item.setIcon(0, folder_icon() if entry.is_dir else badge_icon(entry.name))
        if entry.is_dir:
            # A placeholder child is what gives a collapsed directory its expand arrow without
            # listing it first — the listing is a round trip to a subprocess, so it waits until
            # someone actually opens the folder.
            item.addChild(QTreeWidgetItem(["…"]))
        return item

    def _on_expanded(self, item: QTreeWidgetItem) -> None:
        if item.data(0, LOADED_ROLE) or not item.data(0, IS_DIR_ROLE):
            return
        item.setData(0, LOADED_ROLE, True)
        self._spawn(self._populate(item), "list")

    async def _populate(self, item: QTreeWidgetItem) -> None:
        path = item.data(0, PATH_ROLE)
        entries = await self._tree_model.load(path)
        item.takeChildren()
        for entry in entries:
            item.addChild(self._make_item(entry))

    def _on_item_clicked(self, item: QTreeWidgetItem, _column: int) -> None:
        if item.data(0, IS_DIR_ROLE):
            item.setExpanded(not item.isExpanded())
            return
        path = item.data(0, PATH_ROLE)
        if path:
            self._spawn(self._open(path), "open")

    # -- editor --------------------------------------------------------------------------

    async def _open(self, path: str) -> None:
        if path in self._editors:
            self._tabs.setCurrentWidget(self._editors[path])
            return

        content = await self._backend.read_file(path)
        editor = CodeEditor()
        editor.setPlainText(content.text)
        editor.setReadOnly(content.truncated)
        language = language_for(path)
        self._highlighters[path] = Highlighter(editor.document(), language)
        self._editors[path] = editor
        self._baselines[path] = content.text
        editor.textChanged.connect(lambda p=path: self._on_text_changed(p))

        label = path.rsplit("/", 1)[-1] + (" (ro)" if content.truncated else "")
        index = self._tabs.addTab(editor, label)
        self._tabs.setCurrentIndex(index)
        self._sync_active()

    def _on_text_changed(self, path: str) -> None:
        editor = self._editors.get(path)
        if editor is None:
            return
        dirty = editor.toPlainText() != self._baselines.get(path, "")
        index = self._tabs.indexOf(editor)
        if index >= 0:
            name = path.rsplit("/", 1)[-1]
            self._tabs.setTabText(index, f"● {name}" if dirty else name)

    def _on_tab_close(self, index: int) -> None:
        widget = self._tabs.widget(index)
        for path, editor in list(self._editors.items()):
            if editor is widget:
                if editor.toPlainText() != self._baselines.get(path, ""):
                    # A refusal rather than a prompt: a modal here is one more place to lose an
                    # edit, and ctrl+s costs nothing.
                    self._status_left.setText(f"{path} has unsaved changes — save first")
                    return
                del self._editors[path]
                self._highlighters.pop(path, None)
                self._baselines.pop(path, None)
        self._tabs.removeTab(index)
        self._sync_active()

    def active_path(self) -> str | None:
        widget = self._tabs.currentWidget()
        for path, editor in self._editors.items():
            if editor is widget:
                return path
        return None

    def _sync_active(self) -> None:
        path = self.active_path()
        if path is None:
            self._breadcrumb.setText("")
            return
        parts = path.split("/")
        self._breadcrumb.setText("   ›   ".join(parts))
        self._language_box.setCurrentText(language_for(path))

    def _on_language_changed(self, language: str) -> None:
        path = self.active_path()
        if path and path in self._highlighters:
            self._highlighters[path].set_language(language)

    async def save_active(self) -> None:
        path = self.active_path()
        if path is None:
            return
        editor = self._editors[path]
        await self._backend.write_file(path, editor.toPlainText())
        self._baselines[path] = editor.toPlainText()
        self._on_text_changed(path)
        self._log(f"saved {path}", tab="Output")
        self._status_left.setText(f"saved {path}")

    # -- the model ------------------------------------------------------------------------

    def _run_action(self, key: str, instruction: str) -> None:
        path = self.active_path()
        if path is None:
            self._status_left.setText("Open a file first")
            return
        # Echoed in the status bar as well as in the AI panel. The panel sits on the far side
        # of the window from the button just pressed, and a click with no acknowledgement
        # anywhere near it reads as a click that did not register.
        self._status_left.setText(f"{key}: {path}")
        self._spawn(self._run_task(f"{instruction}\n\nFile: {path}"), key)

    def _on_task_submitted(self) -> None:
        task = self._ai_task.text().strip()
        if not task:
            return
        self._ai_task.clear()
        self._spawn(self._run_task(task), "agent")

    async def _run_task(self, task: str) -> None:
        self._ai_title.setText("Working…")
        self._fix_all.setEnabled(False)
        self._ai_body.appendPlainText(f"▸ {task}\n")
        try:
            run = await self._backend.run_agent(task, model=self._model)
        finally:
            self._fix_all.setEnabled(True)

        for step in run.steps:
            self._ai_body.appendPlainText(f"  {'ok  ' if step.ok else 'FAIL'} {step.summary}")
        if run.answer:
            self._ai_body.appendPlainText(f"\n{run.answer}\n")
        self._ai_count.setText(str(len(run.steps)))
        self._ai_title.setText("Done" if run.succeeded else "Stopped")
        if run.usage:
            self._status_right.setText(
                f"{run.model or self._model or ''}  ·  {run.usage.total:,} tokens"
            )

        # The model wrote straight to disk, so the tree and every open tab are stale now.
        await self._load_root()
        for path in run.touched_files:
            if path in self._editors:
                refreshed = await self._backend.read_file(path)
                self._editors[path].setPlainText(refreshed.text)
                self._baselines[path] = refreshed.text

    # -- dock ----------------------------------------------------------------------------

    def _focus_dock(self, name: str) -> None:
        for index in range(self._dock.count()):
            if self._dock.tabText(index) == name:
                self._dock.setCurrentIndex(index)
                return

    def _log(self, text: str, *, tab: str = "Output") -> None:
        for index in range(self._dock.count()):
            if self._dock.tabText(index) == tab:
                view = self._dock.widget(index)
                if isinstance(view, QPlainTextEdit):
                    view.appendPlainText(text)
                return

    # -- explorer actions -----------------------------------------------------------------

    def _on_create_file(self) -> None:
        self._status_left.setText("Type a path in the task box and ask the model to create it")
        self._ai_task.setFocus()


def kind_of(name: str) -> str:
    """Re-exported for tests, which should not have to reach into `palette`."""
    return file_kind(name).language


__all__ = ["MainWindow", "TOOL_ACTIONS", "kind_of"]
