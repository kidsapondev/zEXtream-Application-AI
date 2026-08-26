"""The application: a terminal IDE whose "write the code" button is a model on this GPU.

Panes: a workspace tree, tabbed editors with find/replace, and a bottom dock carrying the
agent log, the review gate, and project search. A file finder overlays the lot on demand.

This module owns the wiring and the failure paths, deliberately. The widgets under `ui/` are
small and independently tested; what needs one place to see the whole picture is how they fail
*together* — a run that half-finished and left files changed, a revert that could not be
written back, a tree that is stale the instant the model touches disk.

The rule the layout is built around: **nothing the model writes reaches the user's tree
without passing the review gate first.** Everything else here is an editor.
"""

from __future__ import annotations

import asyncio
import os
from datetime import datetime
from pathlib import Path
from time import monotonic

from textual import on, work
from textual.app import App, ComposeResult
from textual.binding import Binding
from textual.containers import Horizontal, Vertical
from textual.widgets import (
    Footer,
    Header,
    Input,
    RichLog,
    Static,
    TabbedContent,
    TabPane,
    TextArea,
    Tree,
)
from textual.widgets.tree import TreeNode
from textual.worker import Worker

from .editor_commands import comment_prefix, duplicate_lines, move_lines, toggle_comment
from .errors import explain, status_problems
from .file_index import FileIndex
from .git import GitRepo
from .history import RunHistory
from .lsp import Diagnostic, LspClient, language_id_for
from .mcp_client import McpBackend
from .protocols import AgentError, CoderBackend, Entry
from .review import ReviewSession
from .runner import Runner
from .ui.editor_tabs import EditorTabs
from .ui.file_finder import FileFinder
from .ui.find_bar import FindBar
from .ui.git_panel import GitPanel
from .ui.problems_panel import ProblemsPanel
from .ui.review_panel import ReviewPanel
from .ui.run_panel import RunPanel
from .ui.search_panel import SearchPanel
from .theme import LOCAL_CODER_EDITOR_THEME, LOCAL_CODER_THEME
from .workspace import WorkspaceTree

#: Language servers tried on startup, first one present wins. Deliberately a short list of
#: the servers this repo's own languages need rather than a registry: an IDE that silently
#: spawns whatever it finds on PATH is a surprise nobody asked for, and each entry here is a
#: process this app is responsible for cleaning up.
#:
#: None of these is installed by default. That is the normal state, not a fault — the app
#: reports it once in the log with the install command and carries on without code
#: intelligence, because everything else it does still works.
LANGUAGE_SERVERS: tuple[tuple[str, ...], ...] = (
    ("pyright-langserver", "--stdio"),
    ("basedpyright-langserver", "--stdio"),
)


class LocalCoderApp(App[None]):
    """The whole app. Construct with a backend; `main()` builds the real one."""

    CSS = """
    /* One spacing rhythm throughout: panels breathe with a single column of padding, and
       separation is carried by a hairline rule rather than by gaps. In a terminal, empty
       rows are expensive — a gap costs a line of code you could have been reading. */

    Screen { layout: vertical; background: $background; }

    #body { height: 1fr; }

    #tree {
        width: 34;
        background: $surface;
        border-right: solid $panel;
        padding: 0 1;
        scrollbar-size-vertical: 1;
    }
    #tree:focus-within { border-right: solid $primary; }

    #editor-area { width: 1fr; background: $surface; }
    #editor { height: 1fr; }

    #find { display: none; height: auto; }
    #find.visible { display: block; }

    /* The finder floats over the editor rather than displacing it: it is a transient lookup,
       and reflowing the whole layout for it makes the file you were reading jump. */
    #finder {
        display: none;
        layer: overlay;
        width: 70%;
        max-width: 90;
        offset: 15% 6;
        background: $panel;
        border: round $primary;
        padding: 0 1;
    }
    #finder.visible { display: block; }

    #dock {
        height: 18;
        border-top: solid $panel;
        background: $surface;
    }
    #dock:focus-within { border-top: solid $primary; }

    #task {
        border: none;
        background: $boost;
        padding: 0 1;
    }
    #log {
        height: 1fr;
        padding: 0 1;
        background: $surface;
        scrollbar-size-vertical: 1;
    }

    /* The status line is the one row always on screen, so it gets the panel colour to read
       as chrome rather than as content, and its segments are separated by a middot instead
       of by borders — a border here would draw more attention than anything it contains. */
    #status {
        height: 1;
        padding: 0 1;
        background: $panel;
        color: $text-muted;
    }

    Tabs { background: $surface; }
    Tab { padding: 0 2; }

    Tree > .tree--guides { color: $panel; }
    Tree > .tree--guides-selected { color: $primary; }
    """

    BINDINGS = [
        Binding("ctrl+q", "quit", "Quit"),
        Binding("ctrl+s", "save", "Save"),
        Binding("ctrl+p", "find_file", "Go to file"),
        Binding("ctrl+f", "toggle_find", "Find"),
        Binding("ctrl+w", "close_tab", "Close tab"),
        Binding("ctrl+l", "focus_task", "Task"),
        # Editing. `ctrl+/` is what every editor uses for comment toggling, but many
        # terminals deliver it as ctrl+underscore instead of a distinct key — both are bound
        # so the muscle memory works wherever the app is run.
        Binding("ctrl+slash,ctrl+underscore", "toggle_comment", "Comment", show=False),
        Binding("ctrl+d", "duplicate_line", "Duplicate", show=False),
        Binding("alt+up", "move_line_up", "Move up", show=False),
        Binding("alt+down", "move_line_down", "Move down", show=False),
        Binding("f12", "goto_definition", "Definition", show=False),
        Binding("ctrl+r", "refresh", "Refresh", show=False),
    ]

    def __init__(
        self,
        backend: CoderBackend,
        *,
        model: str | None = None,
        log_file: Path | None = None,
    ) -> None:
        super().__init__()
        self._backend = backend
        self._tree_model = WorkspaceTree(backend)
        self._index = FileIndex(backend)
        self._review = ReviewSession(backend)
        self._git = GitRepo(backend)
        self._runner = Runner(backend)
        self._history = RunHistory()
        #: Started on mount when a language server is actually installed, and `None` for the
        #: whole session otherwise. Everything that touches it is guarded — code intelligence
        #: is the one feature here that is genuinely optional, and an app that refuses to open
        #: because pyright is missing would be worse than one without completion.
        self._lsp: LspClient | None = None
        self._model = model
        #: Guards a second run while one is in flight. The model holds the GPU for the whole
        #: run, so a concurrent second run would queue behind the first and look like a hang.
        #:
        #: Named `_agent_busy` rather than the obvious `_running`: Textual's `App` already owns
        #: that name and sets it True once the app loop starts, so the obvious name both
        #: clobbers framework state and makes the guard permanently true — which silently
        #: swallowed every run until it was found.
        self._agent_busy = False
        #: Plain-text mirror of the on-screen log. `RichLog` only holds rendered lines once it
        #: has been laid out, so headless tests see nothing in it; and a run hands file-writing
        #: authority to a model, so what it was asked and what it did has to outlive the
        #: terminal window — which is what `log_file` is for.
        self._log_lines: list[str] = []
        self._log_file = log_file

    # -- layout ------------------------------------------------------------------------

    def compose(self) -> ComposeResult:
        yield Header(show_clock=False)
        with Horizontal(id="body"):
            yield Tree("workspace", id="tree")
            with Vertical(id="editor-area"):
                yield EditorTabs(id="editor")
                yield FindBar(id="find")
        with TabbedContent(id="dock"):
            with TabPane("Agent", id="tab-agent"):
                yield Input(
                    placeholder="Describe a change and press Enter — the local model makes it",
                    id="task",
                )
                yield RichLog(id="log", markup=True, wrap=True)
                yield ReviewPanel(id="review")
            with TabPane("Problems", id="tab-problems"):
                yield ProblemsPanel(id="problems")
            with TabPane("Run", id="tab-run"):
                yield RunPanel(self._runner, id="run")
            with TabPane("Git", id="tab-git"):
                yield GitPanel(self._git, id="git")
            with TabPane("Search", id="tab-search"):
                yield SearchPanel(self._backend, id="search")
        yield Static("starting…", id="status")
        yield Footer()

    async def on_mount(self) -> None:
        self.title = "Local Coder"
        # Registered and selected here rather than set as a class attribute: `register_theme`
        # needs a live app, and selecting a theme the app does not know raises.
        self.register_theme(LOCAL_CODER_THEME)
        self.theme = LOCAL_CODER_THEME.name
        tree = self.query_one("#tree", Tree)
        tree.show_root = False
        tree.root.data = ""
        await self._check_status()
        await self._populate(tree.root, "")
        tree.root.expand()
        self.query_one("#task", Input).focus()
        await self._start_language_server()

    async def on_unmount(self) -> None:
        # The language server is a child process holding an index of the whole workspace in
        # memory. Leaving it running past the session would strand it with no parent to stop
        # it — the same reason `McpBackend.close()` is not optional.
        if self._lsp is not None:
            await self._lsp.close()
            self._lsp = None

    # -- code intelligence -----------------------------------------------------------------

    async def _start_language_server(self) -> None:
        """Starts the first installed language server, or explains that there is none.

        Failure here is reported once and then dropped: a missing server is the default state
        on a fresh machine, and repeating the complaint on every file open would bury the log
        the agent panel needs.
        """
        root = await self._workspace_root()
        if root is None:
            return
        for command in LANGUAGE_SERVERS:
            client = LspClient(
                command,
                root,
                on_diagnostics=self._on_diagnostics,
                on_log=lambda line: None,
            )
            try:
                await client.start()
            except AgentError:
                continue
            self._lsp = client
            self._log(f"language server: {command[0]}", style="dim")
            return
        self._log(
            "No language server found — no completion or diagnostics. "
            "Install one with: npm install -g pyright",
            style="dim",
        )

    async def _workspace_root(self) -> Path | None:
        try:
            status = await self._backend.status()
        except AgentError:
            return None
        return Path(status.workspace_root) if status.workspace_root else None

    def _on_diagnostics(self, _path: str, _diagnostics: tuple[Diagnostic, ...]) -> None:
        """Called from the LSP client's reader task whenever the server republishes.

        Repaints from the client's full store rather than from the one file in the callback:
        the panel shows every open file's problems at once, and a server that clears a file's
        diagnostics sends an *empty* list for it, which only reads correctly as "remove these"
        when the whole set is redrawn.
        """
        if self._lsp is None:
            return
        self.query_one("#problems", ProblemsPanel).show(self._lsp.diagnostics())

    # -- status & logging ----------------------------------------------------------------

    async def _check_status(self) -> None:
        try:
            status = await self._backend.status()
        except AgentError as error:
            self._set_status(explain(error))
            self._log(explain(error), style="red")
            return

        problems = status_problems(status)
        for problem in problems:
            self._log(problem, style="yellow")
        if problems:
            self._set_status("setup incomplete — see the log")
            return

        model = self._model or (
            status.tool_capable_models[0] if status.tool_capable_models else "?"
        )
        self.sub_title = f"{model} · {status.workspace_root or ''}"
        self._set_status("ready")

    def _set_status(self, text: str) -> None:
        self.query_one("#status", Static).update(text)

    @property
    def session_log(self) -> str:
        """Everything written to the log this session, markup stripped."""
        return "\n".join(self._log_lines)

    def _log(self, text: str, *, style: str = "") -> None:
        self._log_lines.append(text)
        self.query_one("#log", RichLog).write(f"[{style}]{text}[/]" if style else text)
        if self._log_file is None:
            return
        try:
            self._log_file.parent.mkdir(parents=True, exist_ok=True)
            with self._log_file.open("a", encoding="utf-8") as handle:
                handle.write(f"{datetime.now().isoformat(timespec='seconds')}  {text}\n")
        except OSError:
            # A log that cannot be written must never take the session down with it.
            self._log_file = None

    # -- tree --------------------------------------------------------------------------

    async def _populate(self, node: TreeNode[Entry], path: str) -> None:
        node.remove_children()
        try:
            entries = await self._tree_model.load(path)
        except AgentError as error:
            self._set_status(explain(error))
            return
        for entry in entries:
            if entry.is_dir:
                # `allow_expand` with no children is what makes expansion lazy: a directory is
                # only listed when someone opens it, so startup costs one round trip however
                # deep the tree is.
                node.add(f"{entry.name}/", data=entry, allow_expand=True)
            else:
                node.add_leaf(entry.name, data=entry)

    @on(Tree.NodeExpanded)
    async def _on_expand(self, event: Tree.NodeExpanded[Entry]) -> None:
        node = event.node
        if node.children:
            return
        entry = node.data
        if isinstance(entry, Entry) and entry.is_dir:
            await self._populate(node, entry.path)

    @on(Tree.NodeSelected)
    async def _on_select(self, event: Tree.NodeSelected[Entry]) -> None:
        entry = event.node.data
        if not isinstance(entry, Entry) or entry.is_dir:
            return
        await self.open_path(entry.path)

    async def open_path(self, path: str, *, line: int | None = None) -> None:
        """Opens `path` in a tab, optionally putting the cursor on `line` (1-based)."""
        editor = self.query_one("#editor", EditorTabs)
        try:
            content = await self._backend.read_file(path)
        except AgentError as error:
            self._set_status(explain(error))
            return

        await editor.open(content)
        if self._lsp is not None and not content.truncated:
            # A truncated read is deliberately not opened with the server: it would be told
            # the file ends where the byte cap did, and every diagnostic past that point would
            # be wrong in a way nothing on screen explains.
            try:
                await self._lsp.did_open(path, content.text, language_id_for(path))
            except AgentError as error:
                self._log(explain(error), style="dim")
        if line is not None:
            area = editor.active_area
            if area is not None:
                area.cursor_location = (max(line - 1, 0), 0)
        if content.truncated:
            self._set_status(f"{path} — truncated at {content.bytes_read} bytes, read-only")
        else:
            self._set_status(path)

    # -- editor ------------------------------------------------------------------------

    @on(EditorTabs.ActiveChanged)
    def _on_active_changed(self, event: EditorTabs.ActiveChanged) -> None:
        # The find bar edits one TextArea; re-point it whenever the focused tab changes, or a
        # search would keep operating on a file the user is no longer looking at.
        editor = self.query_one("#editor", EditorTabs)
        area = editor.active_area
        if area is not None:
            self.query_one("#find", FindBar).attach(area)
        if event.path:
            self._set_status(event.path)

    @on(EditorTabs.Dirtied)
    def _on_dirtied(self, event: EditorTabs.Dirtied) -> None:
        self._set_status(f"{event.path} — modified")
        self._sync_document(event.path)

    @work(exclusive=False, group="lsp-sync")
    async def _sync_document(self, path: str) -> None:
        """Tells the language server what the buffer now says.

        A worker because `Dirtied` arrives from a synchronous event handler and the client's
        own debounce is an await. Not `exclusive`: two files can be edited in quick succession
        and cancelling the first file's sync would leave the server holding stale text for it
        indefinitely.
        """
        if self._lsp is None:
            return
        editor = self.query_one("#editor", EditorTabs)
        text = editor.active_text if editor.active_path == path else None
        if text is None:
            return
        try:
            await self._lsp.did_change(path, text)
        except AgentError:
            # A server that died mid-session must not turn every keystroke into an error
            # message; the problems panel simply stops updating.
            return

    # -- panels ------------------------------------------------------------------------

    @on(ProblemsPanel.DiagnosticSelected)
    async def _on_diagnostic_selected(
        self, event: ProblemsPanel.DiagnosticSelected
    ) -> None:
        await self.open_path(event.path, line=event.line)

    @on(GitPanel.FileSelected)
    async def _on_git_file_selected(self, event: GitPanel.FileSelected) -> None:
        await self.open_path(event.path)

    @on(GitPanel.Committed)
    def _on_committed(self, event: GitPanel.Committed) -> None:
        self._log(f"committed: {event.summary}", style="green")
        self._set_status(event.summary)

    @on(RunPanel.Finished)
    def _on_run_finished(self, event: RunPanel.Finished) -> None:
        outcome = event.outcome
        counts = ""
        if outcome.passed is not None or outcome.failed is not None:
            counts = f" · {outcome.passed or 0} passed, {outcome.failed or 0} failed"
        self._log(
            f"{outcome.config.name}: {'ok' if outcome.ok else 'FAILED'}"
            f" in {outcome.duration_s:.1f}s{counts}",
            style="green" if outcome.ok else "red",
        )

    def action_toggle_find(self) -> None:
        find = self.query_one("#find", FindBar)
        editor = self.query_one("#editor", EditorTabs)
        area = editor.active_area
        if area is None:
            self._set_status("open a file first")
            return
        find.attach(area)
        find.add_class("visible")
        find.query_one(Input).focus()

    @on(FindBar.Closed)
    def _on_find_closed(self, _event: FindBar.Closed) -> None:
        self.query_one("#find", FindBar).remove_class("visible")
        area = self.query_one("#editor", EditorTabs).active_area
        if area is not None:
            area.focus()

    def action_close_tab(self) -> None:
        editor = self.query_one("#editor", EditorTabs)
        path = editor.active_path
        if path is None:
            return
        if editor.is_dirty(path):
            # Deliberately a refusal rather than a prompt: a modal here would be one more
            # place to lose an edit, and pressing ctrl+s then ctrl+w costs nothing.
            self._set_status(f"{path} has unsaved changes — ctrl+s first")
            return
        editor.close_active()

    async def action_save(self) -> None:
        editor = self.query_one("#editor", EditorTabs)
        path = editor.active_path
        text = editor.active_text
        if path is None or text is None:
            self._set_status("nothing to save")
            return
        try:
            await self._backend.write_file(path, text)
        except AgentError as error:
            self._set_status(explain(error))
            return
        editor.mark_saved(path)
        self._tree_model.invalidate(_parent_of(path))
        self._set_status(f"saved {path}")

    async def action_refresh(self) -> None:
        self._tree_model.invalidate_all()
        self._index.invalidate()
        tree = self.query_one("#tree", Tree)
        await self._populate(tree.root, "")
        tree.root.expand()
        self._set_status("tree refreshed")

    # -- navigation --------------------------------------------------------------------

    def action_find_file(self) -> None:
        """Opens the fuzzy file finder, mounting it the first time it is asked for.

        Mounted lazily because it builds a full recursive file index on mount, which is a
        round trip per directory — paying that at startup would delay the first paint for
        something most sessions never use.
        """
        try:
            finder = self.query_one("#finder", FileFinder)
        except Exception:
            finder = FileFinder(self._index, id="finder")
            self.mount(finder)
        finder.add_class("visible")
        finder.query_one(Input).focus()

    @on(FileFinder.Selected)
    async def _on_file_selected(self, event: FileFinder.Selected) -> None:
        self._dismiss_finder()
        await self.open_path(event.path)

    @on(FileFinder.Dismissed)
    def _on_finder_dismissed(self, _event: FileFinder.Dismissed) -> None:
        self._dismiss_finder()

    def _dismiss_finder(self) -> None:
        try:
            self.query_one("#finder", FileFinder).remove_class("visible")
        except Exception:
            return
        self.query_one("#task", Input).focus()

    @on(SearchPanel.HitSelected)
    async def _on_hit_selected(self, event: SearchPanel.HitSelected) -> None:
        await self.open_path(event.path, line=event.line)

    def action_focus_task(self) -> None:
        self.query_one("#dock", TabbedContent).active = "tab-agent"
        self.query_one("#task", Input).focus()

    # -- editing -----------------------------------------------------------------------

    def _selected_lines(self) -> tuple[TextArea, str, int, int] | None:
        """The active editor plus the 0-based line range the selection covers.

        `None` when no file is open or the tab is read-only. Every editing command routes
        through here so the read-only case — a file truncated by the byte cap, where saving
        would destroy the tail — is refused in exactly one place.
        """
        editor = self.query_one("#editor", EditorTabs)
        area = editor.active_area
        path = editor.active_path
        if area is None or path is None:
            self._set_status("open a file first")
            return None
        if area.read_only:
            self._set_status("this file is read-only")
            return None
        start, end = area.selection
        return area, path, start[0], end[0]

    def _replace_all(self, area: TextArea, text: str, cursor_line: int) -> None:
        """Swaps the whole buffer, keeping the cursor on a sensible line.

        Whole-document replacement rather than a targeted edit because these commands are
        defined as text-to-text transforms (see `editor_commands`), and reconstructing the
        minimal edit from the result would be a second implementation of diff to maintain.
        The cost is one undo entry per command, which is what a user expects anyway: ctrl+z
        after a line move should undo the move, not part of it.
        """
        area.load_text(text)
        line = max(0, min(cursor_line, area.document.line_count - 1))
        area.move_cursor((line, 0))

    def action_toggle_comment(self) -> None:
        selected = self._selected_lines()
        if selected is None:
            return
        area, path, start, end = selected
        if comment_prefix(path) is None:
            self._set_status("no line comment known for this file type")
            return
        self._replace_all(area, toggle_comment(area.text, start, end, path), start)

    def action_duplicate_line(self) -> None:
        selected = self._selected_lines()
        if selected is None:
            return
        area, _path, start, end = selected
        text, cursor = duplicate_lines(area.text, start, end)
        self._replace_all(area, text, cursor)

    def action_move_line_up(self) -> None:
        self._move_lines(-1)

    def action_move_line_down(self) -> None:
        self._move_lines(1)

    def _move_lines(self, delta: int) -> None:
        selected = self._selected_lines()
        if selected is None:
            return
        area, _path, start, end = selected
        text, new_start, _new_end = move_lines(area.text, start, end, delta)
        self._replace_all(area, text, new_start)

    @work(exclusive=True, group="lsp-definition")
    async def action_goto_definition(self) -> None:
        """Jumps to where the symbol under the cursor is defined."""
        if self._lsp is None:
            self._set_status("no language server — install one with: npm install -g pyright")
            return
        editor = self.query_one("#editor", EditorTabs)
        area = editor.active_area
        path = editor.active_path
        if area is None or path is None:
            return

        line, column = area.cursor_location
        try:
            location = await self._lsp.definition(path, line + 1, column + 1)
        except AgentError as error:
            self._set_status(explain(error))
            return
        if location is None:
            self._set_status("no definition found")
            return

        # A definition often lands outside the workspace — pyright resolves stdlib symbols
        # into its bundled typeshed stubs, which the sandbox will refuse to read and rightly
        # so. Reporting where it went is more useful than an error about a path the user
        # never typed.
        if Path(location.path).is_absolute() or location.path.startswith(".."):
            self._set_status(f"defined outside the workspace: {location.path}")
            return
        await self.open_path(location.path, line=location.line)

    # -- delegation --------------------------------------------------------------------

    def on_input_submitted(self, event: Input.Submitted) -> None:
        if event.input.id == "task":
            self.action_run_task()

    def action_run_task(self) -> Worker[None] | None:
        """Hands whatever is in the task box to the local model.

        Split out from the Enter handler so it can be driven by a binding or a test without
        depending on key routing — Textual's headless `run_test()` does not deliver Enter to a
        focused Input reliably, and a run being unreachable in tests is worse than a method.

        Returns the worker so a caller can await the run. `App.workers.wait_for_complete()` is
        not a substitute: it resolves against workers already registered, and one started in
        the same tick is not registered yet.
        """
        box = self.query_one("#task", Input)
        task = box.value.strip()
        if not task:
            return None
        if self._agent_busy:
            self._set_status("a run is already in flight")
            return None
        box.value = ""
        return self._run_agent(task)

    def _review_candidates(self) -> tuple[str, ...]:
        """Files worth snapshotting before a run.

        The honest constraint: nothing can know which files a run will touch until it has
        touched them, and reading a file *after* the run captures the model's own output as
        the baseline — which would render the diff empty and the revert useless. So the
        baseline has to be taken in advance, and the only sane scope is what the user has
        actually looked at: every open tab, plus every file in a directory already listed in
        the tree. That is bounded by browsing, not by repository size.

        Anything the run touches outside that set is reported by `ReviewSession.problems()`
        rather than guessed at — guessing a baseline could revert a file over the user's own
        work.
        """
        paths: list[str] = list(self.query_one("#editor", EditorTabs).dirty_paths())
        paths.extend(
            entry.path
            for cached in self._tree_model.cached_listings()
            for entry in cached
            if not entry.is_dir
        )
        editor = self.query_one("#editor", EditorTabs)
        if editor.active_path:
            paths.append(editor.active_path)
        return tuple(dict.fromkeys(paths))

    @work(exclusive=True)
    async def _run_agent(self, task: str) -> None:
        """Runs the local model, then routes what it wrote into the review gate.

        A worker rather than an awaited call: a run takes minutes, and blocking the event loop
        for that long would freeze the interface — including the log that is meant to show
        progress.
        """
        self._agent_busy = True
        self._set_status("the local model is working…")
        self._log(f"▸ {task}", style="bold")

        known = self._review_candidates()
        await self._review.snapshot(known)

        started_at = datetime.now()
        started = monotonic()
        try:
            run = await self._backend.run_agent(task, model=self._model)
        except AgentError as error:
            self._agent_busy = False
            self._set_status(explain(error))
            self._log(explain(error), style="red")
            return

        duration = monotonic() - started
        for step in run.steps:
            self._log(
                f"  {'ok  ' if step.ok else 'FAIL'} {step.summary}",
                style="green" if step.ok else "red",
            )
        if run.answer:
            self._log(run.answer, style="dim")
        if run.error:
            self._log(f"stopped ({run.stopped.value}): {run.error}", style="yellow")

        self._history.record(run, started_at=started_at, duration_s=duration)
        self._agent_busy = False

        # A path the run touched that was not in the pre-run set never existed, so its
        # baseline is "absent" — recorded without I/O, since reading it now would pick up the
        # model's own output.
        created = [path for path in run.touched_files if path not in known]
        self._review.mark_absent(created)
        await self._review.capture(run.touched_files)
        self._show_review()

        # The model wrote straight to disk, so anything cached is stale exactly now. Done
        # before the summary because refreshing sets its own status line, and running it last
        # would replace the run's outcome with "tree refreshed".
        await self.action_refresh()

        self._set_status(
            f"{'done' if run.succeeded else 'stopped'} in {duration:.0f}s · "
            f"{len(run.steps)} tool call(s) · {self._history.succeeded} ok / "
            f"{self._history.failed} failed this session"
        )

    def _show_review(self) -> None:
        pending = self._review.pending()
        self.query_one("#review", ReviewPanel).show(pending)
        for problem in self._review.problems():
            self._log(problem, style="yellow")
        self._review.clear_problems()
        if pending:
            self.query_one("#dock", TabbedContent).active = "tab-agent"
            self._log(
                f"{len(pending)} file(s) awaiting review — n/p to move, a accept, r revert",
                style="bold",
            )

    @on(ReviewPanel.Accepted)
    async def _on_review_accepted(self, event: ReviewPanel.Accepted) -> None:
        await self._review.accept(event.path)
        self._log(f"  kept {event.path}", style="green")
        self._show_review()

    @on(ReviewPanel.Reverted)
    async def _on_review_reverted(self, event: ReviewPanel.Reverted) -> None:
        await self._review.revert(event.path)
        self._log(f"  reverted {event.path}", style="yellow")
        self._show_review()
        # The file on disk just changed underneath any open tab; reload it rather than leaving
        # the editor showing content that is no longer there.
        editor = self.query_one("#editor", EditorTabs)
        if event.path in editor.dirty_paths() or editor.active_path == event.path:
            try:
                editor.reload(await self._backend.read_file(event.path))
            except AgentError as error:
                self._set_status(explain(error))
        await self.action_refresh()


def _parent_of(path: str) -> str:
    parent = str(Path(path).parent).replace("\\", "/")
    return "" if parent == "." else parent


def main() -> None:
    """Entry point. Builds the real backend and hands it to the app."""
    repo_root = Path(__file__).resolve().parents[3]
    server = repo_root / "host-bridge" / "dist" / "mcp-main.js"

    # One transcript per session, alongside the ones scripts/delegate.mjs writes. A run hands
    # file-writing authority to a model nobody watched, and terminal scrollback dies with the
    # window.
    log_file = repo_root / "logs" / "ide" / f"{datetime.now().strftime('%Y-%m-%d_%H%M%S')}.txt"

    async def run() -> None:
        async with McpBackend(server) as backend:
            app = LocalCoderApp(
                backend,
                model=os.environ.get("MCP_AGENT_MODEL"),
                log_file=log_file,
            )
            await app.run_async()

    try:
        asyncio.run(run())
    except AgentError as error:
        raise SystemExit(explain(error)) from error


if __name__ == "__main__":
    main()
