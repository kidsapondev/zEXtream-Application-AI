"""The application: a terminal IDE whose "write the code" button is a model on this GPU.

Layout is three panes — a workspace tree, an editor, and a task box with a run log. The tree
and the editor are ordinary; the task box is the point. You describe a change, the local model
makes it against real files, and the log shows every tool call it made so the work is
reviewable rather than merely reported.

This module owns the wiring and the failure paths, deliberately: the individual pieces below
it are small and independently testable, but the way they fail together — a server that never
started, a run that half-finished and left files changed — is the part that needs to see the
whole picture.
"""

from __future__ import annotations

import asyncio
import os
from datetime import datetime
from pathlib import Path
from time import monotonic

from textual import on, work
from textual.worker import Worker
from textual.app import App, ComposeResult
from textual.binding import Binding
from textual.containers import Horizontal, Vertical
from textual.widgets import Footer, Header, Input, RichLog, Static, TextArea, Tree
from textual.widgets.tree import TreeNode

from .errors import explain, status_problems
from .history import RunHistory
from .mcp_client import McpBackend
from .protocols import AgentError, CoderBackend, Entry
from .workspace import WorkspaceTree

#: Extension to Textual/tree-sitter language name, for editor syntax highlighting. Only the
#: languages Textual ships a parser for are listed — naming one it cannot load raises, so an
#: unknown extension deliberately falls through to no highlighting rather than guessing.
_LANGUAGES = {
    ".py": "python",
    ".ts": "typescript",
    ".js": "javascript",
    ".json": "json",
    ".md": "markdown",
    ".html": "html",
    ".css": "css",
    ".yaml": "yaml",
    ".yml": "yaml",
    ".toml": "toml",
    ".sql": "sql",
}


def language_for(path: str) -> str | None:
    return _LANGUAGES.get(Path(path).suffix.lower())


class LocalCoderApp(App[None]):
    """The whole app. Construct with a backend; `main()` builds the real one."""

    CSS = """
    Screen { layout: vertical; }

    #body { height: 1fr; }

    #tree {
        width: 32;
        border-right: solid $panel-darken-2;
        padding: 0 1;
    }

    #editor { width: 1fr; }

    #bottom {
        height: 16;
        border-top: solid $panel-darken-2;
    }

    #task {
        border: none;
        background: $boost;
    }

    #log { height: 1fr; padding: 0 1; }

    #status {
        height: 1;
        padding: 0 1;
        background: $panel;
        color: $text-muted;
    }
    """

    BINDINGS = [
        Binding("ctrl+q", "quit", "Quit"),
        Binding("ctrl+s", "save", "Save file"),
        Binding("ctrl+r", "refresh", "Refresh tree"),
        Binding("ctrl+l", "focus_task", "Focus task"),
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
        self._history = RunHistory()
        self._model = model
        self._open_path: str | None = None
        #: Guards against a second run being started while one is in flight. The model holds
        #: the GPU for the whole run, so a concurrent second run would not just be confusing,
        #: it would queue behind the first and look like a hang.
        #:
        #: Named `_agent_busy` rather than the obvious `_running`: Textual's `App` already
        #: owns an attribute by that name and sets it True once the app loop starts, so the
        #: obvious name both clobbers framework state and makes this guard permanently true —
        #: which silently swallowed every run.
        self._agent_busy = False
        #: Plain-text mirror of everything written to the on-screen log.
        #:
        #: Two reasons it exists rather than reading the widget back. A `RichLog` only holds
        #: rendered lines once it has been laid out and given a size, so headless tests see
        #: nothing in it — the record has to live outside the widget to be assertable. And a
        #: run hands file-writing authority to a model: what it was asked and what it did has
        #: to survive the terminal window closing, which is what `log_file` is for.
        self._log_lines: list[str] = []
        self._log_file = log_file

    # -- layout ------------------------------------------------------------------------

    def compose(self) -> ComposeResult:
        yield Header(show_clock=False)
        with Horizontal(id="body"):
            yield Tree("workspace", id="tree")
            yield TextArea("", id="editor", read_only=True)
        with Vertical(id="bottom"):
            yield Input(
                placeholder="Describe a change and press Enter — the local model makes it",
                id="task",
            )
            yield RichLog(id="log", markup=True, wrap=True)
        yield Static("starting…", id="status")
        yield Footer()

    async def on_mount(self) -> None:
        self.title = "Local Coder"
        tree = self.query_one("#tree", Tree)
        tree.show_root = False
        tree.root.data = ""
        await self._check_status()
        await self._populate(tree.root, "")
        tree.root.expand()
        self.query_one("#task", Input).focus()

    # -- status ------------------------------------------------------------------------

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

        model = self._model or (status.tool_capable_models[0] if status.tool_capable_models else "?")
        self.sub_title = f"{model} · {status.workspace_root or ''}"
        self._set_status("ready")

    def _set_status(self, text: str) -> None:
        self.query_one("#status", Static).update(text)

    # -- logging -----------------------------------------------------------------------

    @property
    def session_log(self) -> str:
        """Everything written to the log this session, markup stripped."""
        return "\n".join(self._log_lines)

    def _log(self, text: str, *, style: str = "") -> None:
        """Writes one line to the on-screen log, the session record, and the log file.

        `text` is stored without styling so the file and the tests see the same words a
        person read on screen, not a markup soup.
        """
        self._log_lines.append(text)
        self.query_one("#log", RichLog).write(f"[{style}]{text}[/]" if style else text)
        if self._log_file is None:
            return
        try:
            self._log_file.parent.mkdir(parents=True, exist_ok=True)
            with self._log_file.open("a", encoding="utf-8") as handle:
                handle.write(f"{datetime.now().isoformat(timespec='seconds')}  {text}\n")
        except OSError:
            # A log that cannot be written must never take the session down with it; the
            # on-screen copy is still there.
            self._log_file = None

    # -- tree --------------------------------------------------------------------------

    async def _populate(self, node: TreeNode[Entry], path: str) -> None:
        """Fills `node` with one directory's contents, replacing whatever was there."""
        node.remove_children()
        try:
            entries = await self._tree_model.load(path)
        except AgentError as error:
            self._set_status(explain(error))
            return
        for entry in entries:
            if entry.is_dir:
                # `allow_expand` plus an empty child list is what makes expansion lazy: the
                # listing for a directory is only fetched when someone opens it, which keeps
                # startup to a single round trip no matter how deep the tree is.
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
        await self._open(entry.path)

    async def _open(self, path: str) -> None:
        editor = self.query_one("#editor", TextArea)
        try:
            content = await self._backend.read_file(path)
        except AgentError as error:
            self._set_status(explain(error))
            return

        editor.load_text(content.text)
        language = language_for(path)
        # Setting an unavailable language raises, and a missing highlighter is a far smaller
        # problem than a crash while opening a file.
        try:
            editor.language = language
        except Exception:
            editor.language = None

        if content.truncated:
            # Saving now would write back only the part that was read, silently destroying the
            # rest of the file — so the editor stays read-only until a smaller file is opened.
            editor.read_only = True
            self._open_path = None
            self._set_status(f"{path} — truncated at {content.bytes_read} bytes, read-only")
        else:
            editor.read_only = False
            self._open_path = path
            self._set_status(path)

    # -- actions -----------------------------------------------------------------------

    def action_focus_task(self) -> None:
        self.query_one("#task", Input).focus()

    async def action_save(self) -> None:
        if self._open_path is None:
            self._set_status("nothing to save")
            return
        path = self._open_path
        try:
            await self._backend.write_file(path, self.query_one("#editor", TextArea).text)
        except AgentError as error:
            self._set_status(explain(error))
            return
        self._tree_model.invalidate(str(Path(path).parent).replace("\\", "/").strip("."))
        self._set_status(f"saved {path}")

    async def action_refresh(self) -> None:
        self._tree_model.invalidate_all()
        tree = self.query_one("#tree", Tree)
        await self._populate(tree.root, "")
        tree.root.expand()
        self._set_status("tree refreshed")

    # -- delegation --------------------------------------------------------------------

    def on_input_submitted(self, event: Input.Submitted) -> None:
        self.action_run_task()

    def action_run_task(self) -> Worker[None] | None:
        """Hands whatever is in the task box to the local model.

        Split out from the Enter-key handler so it can be invoked — by a binding, by a test —
        without depending on key routing. Textual's headless `run_test()` does not deliver
        Enter to the focused Input reliably, and a run being unreachable in tests is worse
        than an extra method.

        Returns the worker so a caller can await the run. `App.workers.wait_for_complete()`
        is not a substitute: it resolves against workers already registered, and a run
        started in the same tick is not registered yet.
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

    @work(exclusive=True)
    async def _run_agent(self, task: str) -> None:
        """Runs the local model and reports every step.

        A worker rather than an awaited call: a run takes minutes, and anything blocking the
        event loop for that long would freeze the whole interface, including the log that is
        supposed to be showing progress.
        """
        self._agent_busy = True
        self._set_status("the local model is working…")
        self._log(f"▸ {task}", style="bold")
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

        # The model wrote directly to disk, so anything cached is stale exactly now. Done
        # before the summary below, not after: refreshing sets its own status line, and
        # running it last would replace the outcome of the run with "tree refreshed" — the
        # one piece of information the user was waiting for.
        await self.action_refresh()
        if self._open_path and self._open_path in run.touched_files:
            await self._open(self._open_path)

        self._set_status(
            f"{'done' if run.succeeded else 'stopped'} in {duration:.0f}s · "
            f"{len(run.steps)} tool call(s) · {self._history.succeeded} ok / "
            f"{self._history.failed} failed this session"
        )


def main() -> None:
    """Entry point. Builds the real backend and hands it to the app."""
    repo_root = Path(__file__).resolve().parents[3]
    server = repo_root / "host-bridge" / "dist" / "mcp-main.js"

    # One transcript per session, alongside the ones scripts/delegate.mjs writes. A run hands
    # file-writing authority to a model nobody watched; the terminal scrollback disappears
    # when the window closes, so this is the durable record of what was asked and what
    # happened.
    log_file = (
        repo_root / "logs" / "ide" / f"{datetime.now().strftime('%Y-%m-%d_%H%M%S')}.txt"
    )

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
