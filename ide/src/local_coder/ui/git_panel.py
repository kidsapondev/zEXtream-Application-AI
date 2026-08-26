"""The git panel: what changed in the workspace, and stage / unstage / commit for it.

Modelled on `search_panel.py` rather than `review_panel.py`: this widget owns a `GitRepo`
directly and calls it from its own handlers, the same way `SearchPanel` owns a `CoderBackend`
and calls `search()` itself, rather than staying inert and pushing every decision up to the
app the way `ReviewPanel` does. The difference is what each widget is *for* — the review gate
exists specifically so a redraw can never write to disk (see `review_panel.py`'s docstring),
but staging a file has no undo-worthy consequence of its own: it changes what the *next*
commit will contain, not the file's content, and git itself is the undo for that. There is
nothing here a session object would need to remember between calls.

Every git round trip goes through a `@work` method, never an awaited call directly inside a
button or input handler — the same reason `SearchPanel._run_search` and
`LocalCoderApp._run_agent` are `@work` methods: a blocking call inside a widget handler freezes
the whole terminal UI, and `CoderBackend.exec` is a real I/O round trip (in the shipped app, a
JSON-RPC call over stdio to the sandboxed workspace), not a local computation.

Status must be legible without colour, which is why every row leads with plain characters —
`GitFile.label` ("M", "A", "??", "MM") and a literal "S" for staged — rather than relying on a
background colour to carry the only copy of that information. Colour (`_STAGED_CLASS`,
`_UNTRACKED_CLASS` below) is applied on top as reinforcement, never as the sole signal, for the
same reason a printed bank statement puts a minus sign in front of a debit instead of only
colouring it red.
"""

from __future__ import annotations

from textual import on, work
from textual.app import ComposeResult
from textual.containers import Horizontal, Vertical
from textual.message import Message
from textual.widgets import Button, Input, Label, ListItem, ListView, Static

from ..errors import explain
from ..git import GitFile, GitRepo, GitStatus
from ..protocols import AgentError

_NOT_REPO_TITLE = "not a git repository"
_LOADING_TITLE = "loading…"
_CLEAN_SUFFIX = "working tree clean"

#: Per-row colour, reinforcing the plain-text label rather than replacing it — see the module
#: docstring. Applied as a CSS class on the `ListItem`, not as a Rich style on the `Label`'s
#: text: that keeps the actual colour choice in `DEFAULT_CSS` next to every other visual
#: decision this widget makes, instead of a hex or style name buried in a loop in Python.
_STAGED_CLASS = "git-row-staged"
_UNTRACKED_CLASS = "git-row-untracked"


def file_row(file: GitFile) -> str:
    """One changed file as `<staged-marker> <label> <path>`.

    The marker is a literal "S" rather than a checkbox glyph or colour alone: this repo's own
    review panel makes the same call for its diff gutter (see `review_panel.gutter_row`), and
    a single ASCII letter survives being read back in a headless test the same way a Unicode
    box-drawing character would not reliably render as. `label` is left-padded to three columns
    so path columns line up down the list — "??" and "MM" are both two characters, "M" and "A"
    are one, and an unpadded mix of widths would stagger every path after the first short one.
    """
    marker = "S" if file.staged else " "
    return f"{marker} {file.label:<3} {file.path}"


def branch_summary(status: GitStatus | None) -> str:
    """"main  ahead 1 behind 2" — or "detached HEAD" when there is no branch name at all.

    Kept as a standalone function, not a method, so it can be unit-tested without booting
    Textual — the same split `review_panel.gutter_row` uses for the same reason.
    """
    if status is None:
        return _LOADING_TITLE
    parts = [status.branch if status.branch is not None else "detached HEAD"]
    if status.ahead:
        parts.append(f"ahead {status.ahead}")
    if status.behind:
        parts.append(f"behind {status.behind}")
    return "  ".join(parts)


class GitPanel(Vertical):
    """Changed files, a stage/unstage pair, and a commit box."""

    DEFAULT_CSS = """
    GitPanel {
        height: 1fr;
    }

    GitPanel #git-title {
        height: 1;
        padding: 0 1;
        background: $panel;
        color: $text;
    }

    GitPanel #git-files {
        height: 1fr;
    }

    GitPanel .git-row-staged {
        color: $success;
    }

    GitPanel .git-row-untracked {
        color: $text-muted;
    }

    GitPanel #git-buttons {
        height: 3;
        padding: 0 1;
    }

    GitPanel #git-buttons Button {
        margin-right: 1;
        min-width: 10;
    }

    GitPanel #git-commit-row {
        height: 3;
        padding: 0 1;
    }

    GitPanel #git-commit-row Input {
        width: 1fr;
    }

    GitPanel #git-message {
        height: 1;
        padding: 0 1;
        color: $text-muted;
    }
    """

    class FileSelected(Message):
        """Posted when a file row is chosen (Enter or click) — not on a mere cursor move.

        Carries only `path`, on the same reasoning `SearchPanel.HitSelected` carries only
        `path`/`line`: the app is expected to fetch a diff or open the file itself, and a
        `GitFile` here would tempt a handler into reading staged-ness off a snapshot that is
        already stale by the time the message is handled.
        """

        def __init__(self, path: str) -> None:
            self.path = path
            super().__init__()

    class Committed(Message):
        """Posted after a commit actually succeeds. `summary` is git's own one-line output."""

        def __init__(self, summary: str) -> None:
            self.summary = summary
            super().__init__()

    def __init__(self, repo: GitRepo, *, id: str | None = None) -> None:
        super().__init__(id=id)
        self._repo = repo
        # `None` before the first `refresh_status()` completes, distinct from a real
        # `GitStatus` with no files — the title needs to say "loading…" rather than "working
        # tree clean" for the instant between mount and the first status round trip landing.
        self._status: GitStatus | None = None
        self._is_repo = True
        self._files: list[GitFile] = []

    def compose(self) -> ComposeResult:
        yield Static(_LOADING_TITLE, id="git-title", markup=False)
        yield ListView(id="git-files")
        with Horizontal(id="git-buttons"):
            yield Button("Stage", id="git-stage")
            yield Button("Unstage", id="git-unstage")
        with Horizontal(id="git-commit-row"):
            yield Input(placeholder="Commit message…", id="git-commit-input")
            yield Button("Commit", id="git-commit-button", variant="success")
        yield Static("", id="git-message", markup=False)

    def on_mount(self) -> None:
        self.refresh_status()

    # -- loading -------------------------------------------------------------------------

    @work(exclusive=True)
    async def refresh_status(self) -> None:
        """Worker entry point: reloads everything from git and redraws.

        A thin `@work` wrapper around `_reload()` rather than `_reload()` itself being the
        worker, because a `Worker` object in this Textual version cannot be `await`ed directly
        (verified against 8.2.8: `TypeError: object Worker can't be used in 'await'
        expression`) — unlike a plain coroutine. `_stage_current` / `_unstage_current` /
        `_do_commit` are themselves already running as workers and need to reload afterwards
        *in the same worker*, so they call `await self._reload()` directly; this method exists
        for the one caller that is not already inside a worker — `on_mount`.
        """
        await self._reload()

    async def _reload(self) -> None:
        # Checked separately from `status()` rather than trusting `status().branch is None`
        # to mean "not a repo": that shape is also what a *clean detached HEAD* repo returns,
        # and this panel needs to tell the two apart to report either "not a git repository"
        # or "detached HEAD" correctly rather than collapsing them into one wrong message.
        self._is_repo = await self._repo.is_repo()
        if not self._is_repo:
            self._status = None
            self._files = []
            self._set_message("")
            await self._refresh_view()
            return

        self._status = await self._repo.status()
        self._files = list(self._status.files)
        await self._refresh_view()

    async def _refresh_view(self) -> None:
        """Redraws the title and file list from `self._files`/`self._status`.

        Named `_refresh_view`, not `_render` — `Widget` (an ancestor via `Vertical`) already
        owns a real internal method called exactly `_render` (`widget.py`, returns a `Visual`
        for the compositor). A subclass method of the same name silently shadows it rather
        than erroring, and the first symptom is not an exception at definition time but the
        compositor crashing later with `AttributeError: 'coroutine' object has no attribute
        'render_strips'` — because it called *this* async method expecting Rich's renderable
        instead. Caught by the widget test suite here; see the Textual field notes this repo
        keeps for the other names already known to collide (`_running` on `App`).
        """
        self.query_one("#git-title", Static).update(self._title())

        results = self.query_one(ListView)
        # Remembers the highlighted path across a redraw the same way `ReviewPanel.show`
        # remembers which file was open — a stage/unstage round trip reloads the whole list,
        # and losing the cursor position on every click would make working through several
        # files in a row unusable.
        looking_at = self._current_path(results)
        await results.clear()
        for file in self._files:
            classes = _STAGED_CLASS if file.staged else (_UNTRACKED_CLASS if file.untracked else "")
            results.append(ListItem(Label(file_row(file), markup=False), classes=classes or None))

        if self._files:
            restored = next(
                (i for i, f in enumerate(self._files) if f.path == looking_at), 0
            )
            results.index = restored
        self._refresh_buttons()

    def _title(self) -> str:
        if not self._is_repo:
            return _NOT_REPO_TITLE
        branch = branch_summary(self._status)
        if not self._files:
            return f"{branch}  —  {_CLEAN_SUFFIX}"
        count = len(self._files)
        return f"{branch}  ({count} changed)"

    # -- selection -------------------------------------------------------------------------

    def _current_path(self, results: ListView) -> str | None:
        index = results.index
        if index is None or index >= len(self._files):
            return None
        return self._files[index].path

    def _current(self) -> GitFile | None:
        path = self._current_path(self.query_one(ListView))
        return next((f for f in self._files if f.path == path), None)

    @on(ListView.Highlighted)
    def _on_highlighted(self, event: ListView.Highlighted) -> None:
        # Cursor movement alone, not a decision — but Stage/Unstage need to reflect whichever
        # file is now under the cursor, or pressing the button would silently act on whatever
        # was selected before the user moved off it.
        self._refresh_buttons()

    @on(ListView.Selected)
    def _on_selected(self, event: ListView.Selected) -> None:
        file = self._current()
        if file is None:
            return
        self.post_message(self.FileSelected(file.path))

    def _refresh_buttons(self) -> None:
        current = self._current()
        # Disabled rather than hidden, the same choice `ReviewPanel` makes for its own
        # buttons: they keep their place in the layout, and a click cannot fire an action for
        # a file that no longer exists in the list or is already in the state the button
        # claims to move it to.
        self.query_one("#git-stage", Button).disabled = current is None or current.staged
        self.query_one("#git-unstage", Button).disabled = current is None or not current.staged

    # -- actions -----------------------------------------------------------------------

    @on(Button.Pressed, "#git-stage")
    def _on_stage_pressed(self, event: Button.Pressed) -> None:
        event.stop()
        self._stage_current()

    @on(Button.Pressed, "#git-unstage")
    def _on_unstage_pressed(self, event: Button.Pressed) -> None:
        event.stop()
        self._unstage_current()

    @work(exclusive=True)
    async def _stage_current(self) -> None:
        file = self._current()
        if file is None:
            return
        await self._repo.stage(file.path)
        await self._reload()

    @work(exclusive=True)
    async def _unstage_current(self) -> None:
        file = self._current()
        if file is None:
            return
        await self._repo.unstage(file.path)
        await self._reload()

    @on(Button.Pressed, "#git-commit-button")
    def _on_commit_pressed(self, event: Button.Pressed) -> None:
        event.stop()
        self._do_commit()

    @on(Input.Submitted, "#git-commit-input")
    def _on_commit_submitted(self, event: Input.Submitted) -> None:
        self._do_commit()

    @work(exclusive=True)
    async def _do_commit(self) -> None:
        message_box = self.query_one("#git-commit-input", Input)
        message = message_box.value.strip()
        if not message:
            # Not an error state: an empty box is what this panel looks like before the user
            # has typed anything, the same call `SearchPanel` makes for an empty query.
            self._set_message("Enter a commit message first.")
            return

        try:
            summary = await self._repo.commit(message)
        except AgentError as error:
            # `GitRepo.commit` raises for "nothing staged" and for a real git failure alike
            # (see its docstring) — both come back as an `AgentError` with a message already
            # written for a person to read, so `explain()` (the same formatter every other
            # backend failure in this app goes through) is enough without inspecting which
            # case it was.
            self._set_message(explain(error))
            return

        message_box.value = ""
        self._set_message("")
        self.post_message(self.Committed(summary))
        await self._reload()

    def _set_message(self, text: str) -> None:
        self.query_one("#git-message", Static).update(text)
