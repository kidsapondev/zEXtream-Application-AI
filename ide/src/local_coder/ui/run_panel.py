"""The run panel: WebStorm-style run configurations for this workspace, one click each.

Before this module existed the app could delegate to the local model and review what it
wrote, but never find out whether the result actually worked — `CoderBackend.exec` runs one
command and hands back an `ExecResult`, and nothing turned that into "here is what you can
run, and here is whether it passed". `Runner` (see `..runner`) answers the first half by
inspecting the workspace for a `pyproject.toml` or `package.json`; this widget is the second
half — a list of what it found, a button per entry, and a verdict once one has been run.

Like `ReviewPanel`, this widget is deliberately thin: it holds a `Runner` and asks it to do
the real work, and its own job is display plus one Textual worker per run. It does not know
how a `pyproject.toml` implies pytest, or how "3 failed, 11 passed" gets parsed out of a
stdout blob — that logic lives in `runner.py`, is tested there without a widget in sight, and
is exactly the kind of pure string-handling that got delegated to the local model while this
file was designed by hand.
"""

from __future__ import annotations

from textual import on, work
from textual.app import ComposeResult
from textual.containers import Horizontal, Vertical, VerticalScroll
from textual.message import Message
from textual.widgets import Button, Static
from textual.worker import Worker

from ..errors import explain
from ..protocols import AgentError
from ..runner import RunConfig, RunOutcome, Runner

_EMPTY_TITLE = "no run configurations discovered"


class RunPanel(Vertical):
    """Lists what `Runner.discover()` found and runs whichever one is pressed."""

    DEFAULT_CSS = """
    RunPanel {
        height: 1fr;
    }

    RunPanel #run-title {
        height: 1;
        padding: 0 1;
        background: $panel;
        color: $text;
    }

    RunPanel #run-configs {
        height: auto;
        max-height: 10;
        border-bottom: solid $panel-darken-2;
    }

    RunPanel .run-row {
        height: 3;
        padding: 0 1;
    }

    RunPanel .run-row Button {
        margin-right: 1;
        min-width: 10;
    }

    RunPanel .run-row Static {
        width: 1fr;
        content-align: left middle;
    }

    RunPanel #run-status {
        height: 1;
        padding: 0 1;
        background: $panel;
        color: $text-muted;
    }

    RunPanel #run-output {
        height: 1fr;
    }

    RunPanel #run-output-body {
        padding: 0 1;
        width: auto;
    }
    """

    class Finished(Message):
        """Posted once a run through this panel has produced an `RunOutcome`.

        Carries the whole outcome, not just the pass/fail word, so a listener elsewhere in
        the app (a status-bar tally, a future run-history tab) can read timing and raw output
        without asking the runner for its history and re-deriving which entry was this one.

        A sibling of `ReviewPanel.Accepted`/`Reverted` in shape for the same reason those two
        are siblings rather than one subclassing the other: Textual matches a handler by
        `isinstance`, and this panel currently posts only one kind of message, but keeping it
        as a small `Message` subclass rather than a bare event keeps that door open without a
        forced rewrite later.
        """

        def __init__(self, panel: "RunPanel", outcome: RunOutcome) -> None:
            super().__init__()
            self.panel = panel
            self.outcome = outcome

        @property
        def control(self) -> "RunPanel":
            """What `@on(RunPanel.Finished, "#run")` matches against."""
            return self.panel

    def __init__(
        self,
        runner: Runner,
        *,
        name: str | None = None,
        id: str | None = None,  # noqa: A002 - Textual's own parameter name
        classes: str | None = None,
        disabled: bool = False,
    ) -> None:
        super().__init__(name=name, id=id, classes=classes, disabled=disabled)
        self._runner = runner
        self._configs: tuple[RunConfig, ...] = ()
        #: Names of configs with a run currently in flight. A set of names rather than of
        #: `RunConfig` objects: the row that must be disabled is found by position in
        #: `self._configs`, and comparing on the field a user actually reads (the name) is
        #: what stops two configs that differ only in, say, `args` from being treated as
        #: interchangeable by this guard.
        self._in_flight: set[str] = set()
        self._last_outcome: RunOutcome | None = None
        #: Plain-text mirror of the output currently on screen, for the same reason
        #: `ReviewPanel.rendered_diff` keeps one: a `Static`'s rendered text cannot be read
        #: back once drawn, and `RichLog` holds nothing at all in a headless test (see the
        #: Textual field notes in `.claude/skills/gpu-workspace-coding/SKILL.md`). Anything a
        #: test wants to assert on the output has to be told separately, so it is stored here
        #: too.
        self.rendered_output: list[str] = []
        #: True once `compose`'s children exist. `discover()` can be awaited from `on_mount`,
        #: which itself runs before this widget's own children are guaranteed mounted, and a
        #: `query_one` before then raises. Named distinctively rather than `_running` on
        #: purpose — see the same note on `ReviewPanel._view_ready` and `LocalCoderApp`'s
        #: `_agent_busy`: `_running` is a name Textual's `App` already owns and sets `True` at
        #: startup, which would make a guard written against it permanently, silently closed.
        self._view_ready = False

    # -- layout ------------------------------------------------------------------------

    def compose(self) -> ComposeResult:
        # `markup=False` throughout: raw command output is arbitrary text, and a stray `[` in
        # it would otherwise be parsed as Rich console markup — either swallowing part of a
        # line or raising mid-render. Diff review hit the same thing; see `review_panel.py`.
        yield Static(_EMPTY_TITLE, id="run-title", markup=False)
        yield VerticalScroll(id="run-configs")
        yield Static("", id="run-status", markup=False)
        # A scroll region of its own, separate from the config list above it: a test run's
        # output can run to hundreds of lines, and letting that stretch the whole panel would
        # push the config buttons off screen along with it. `overflow-x` stays at its
        # container default (hidden) rather than being widened to fit the longest output
        # line, which is what keeps the page from ever needing to scroll sideways.
        with VerticalScroll(id="run-output"):
            yield Static("", id="run-output-body", markup=False)

    async def on_mount(self) -> None:
        self._view_ready = True
        await self.discover()

    # -- state -------------------------------------------------------------------------

    @property
    def configs(self) -> tuple[RunConfig, ...]:
        """What the last `discover()` found, in the order shown on screen."""
        return self._configs

    @property
    def last_outcome(self) -> RunOutcome | None:
        """The most recent `RunOutcome` produced through this panel, if any."""
        return self._last_outcome

    async def discover(self) -> None:
        """(Re)loads the configs from the workspace and redraws the row list.

        Public, not just an `on_mount` step: the app can call this again after a run changes
        the workspace — a model that adds a `package.json` script, say — and `on_mount` only
        ever fires once.
        """
        self._configs = await self._runner.discover()
        await self._render_rows()

    async def _render_rows(self) -> None:
        if not self._view_ready:
            return
        container = self.query_one("#run-configs", VerticalScroll)
        await container.remove_children()

        rows = []
        for index, config in enumerate(self._configs):
            button = Button("Run", id=f"run-btn-{index}", variant="primary")
            button.disabled = config.name in self._in_flight
            rows.append(
                Horizontal(
                    Static(config.name, markup=False),
                    button,
                    classes="run-row",
                )
            )
        if rows:
            await container.mount_all(rows)

        title = _EMPTY_TITLE if not self._configs else f"{len(self._configs)} run configuration(s)"
        self.query_one("#run-title", Static).update(title)

    def _refresh_buttons(self) -> None:
        if not self._view_ready:
            return
        for index, config in enumerate(self._configs):
            # A row can be gone by the time this runs — `discover()` re-renders the whole
            # list, and a run started against a config that has since disappeared should
            # simply stop touching the screen rather than raise. `query_one` on an absent id
            # is the normal way that happens in this codebase; see `_dismiss_finder` in
            # `app.py` for the same guard around the same kind of race.
            try:
                button = self.query_one(f"#run-btn-{index}", Button)
            except Exception:
                continue
            button.disabled = config.name in self._in_flight

    def _set_status(self, text: str) -> None:
        if not self._view_ready:
            return
        self.query_one("#run-status", Static).update(text)

    # -- running -----------------------------------------------------------------------

    def run_config(self, config: RunConfig) -> Worker[None] | None:
        """Starts `config` running in a background worker and returns that worker.

        Returning it is what makes the run awaitable from outside: `App.workers.wait_for_
        complete()` resolves against workers already registered with the app, and a worker
        started this same tick is not registered yet — the same trap documented on
        `LocalCoderApp.action_run_task`. A caller — the app, or a test — awaits the returned
        worker directly instead and sidesteps the race entirely.

        `None` when `config` is already running: the guard lives here, synchronously, rather
        than inside the worker body, because the worker body only starts executing on its
        first `await` — a second click arriving before that point would otherwise race past
        an `_in_flight` check that has not been set yet. Marking it here, before the worker
        is even created, closes that window instead of narrowing it.
        """
        if config.name in self._in_flight:
            return None
        self._in_flight.add(config.name)
        self._refresh_buttons()
        self._set_status(f"running {config.name}…")
        return self._run(config)

    @work
    async def _run(self, config: RunConfig) -> None:
        """Executes `config` off the event loop.

        A worker because `Runner.run` goes through `CoderBackend.exec`, which for the real
        backend spawns a subprocess over MCP/stdio and waits for it to exit — a test suite
        can take anywhere from under a second to several minutes. Running that inline would
        freeze the whole interface for the duration, including the very status line meant to
        say a run is in progress.
        """
        try:
            outcome = await self._runner.run(config)
        except AgentError as error:
            # The far side could not even start the command — a rejected path, a dropped MCP
            # connection. Distinct from a command that ran and failed: there is no
            # `RunOutcome` to show here, only an explanation, so no `Finished` message is
            # posted for it — posting one with nothing meaningful in it would be worse than
            # posting nothing.
            self._in_flight.discard(config.name)
            self._refresh_buttons()
            self._set_status(f"{config.name}: {explain(error)}")
            return

        self._in_flight.discard(config.name)
        self._refresh_buttons()
        self._last_outcome = outcome
        self._show_output(outcome)
        self._set_status(self._verdict_line(outcome))
        self.post_message(self.Finished(self, outcome))

    # -- rendering -----------------------------------------------------------------------

    def _show_output(self, outcome: RunOutcome) -> None:
        lines: list[str] = []
        if outcome.result.stdout:
            lines.extend(outcome.result.stdout.splitlines())
        if outcome.result.stderr:
            lines.extend(outcome.result.stderr.splitlines())
        self.rendered_output = lines
        if self._view_ready:
            self.query_one("#run-output-body", Static).update("\n".join(lines))

    def _verdict_line(self, outcome: RunOutcome) -> str:
        # A word, not a colour: `RunOutcome.ok` already folds in a non-zero exit and a
        # timeout, but a colour-only tint is invisible to anyone reading the transcript this
        # app writes to `logs/ide/` (see `app.py`'s `_log`) or running under a screen reader,
        # and it is the whole reason this method exists rather than leaving the verdict to
        # `_ROW_STYLES`-style styling alone.
        if outcome.result.timed_out:
            word = "TIMEOUT"
        else:
            word = "PASS" if outcome.ok else "FAIL"

        counts = ""
        # Only shown when at least one count was actually parsed — printing "0 passed, 0
        # failed" for output this code could not read a summary out of would claim a kind of
        # certainty `passed=None, failed=None` was specifically invented to deny.
        if outcome.passed is not None or outcome.failed is not None:
            counts = f"  ·  {outcome.passed or 0} passed, {outcome.failed or 0} failed"

        return f"{word}  ·  {outcome.config.name}{counts}  ({outcome.duration_s:.1f}s)"

    # -- buttons -------------------------------------------------------------------------
    #
    # Stopped rather than left to bubble. A `Button.Pressed` bubbles up to whatever app this
    # panel is mounted in, and that app has buttons of its own elsewhere (see
    # `ReviewPanel`'s identical comment) — letting a run button's press reach the app would
    # make every future button in the app a potential silent second handler for this one.

    @on(Button.Pressed)
    def _on_run_pressed(self, event: Button.Pressed) -> None:
        button_id = event.button.id or ""
        if not button_id.startswith("run-btn-"):
            return
        event.stop()
        index = int(button_id.removeprefix("run-btn-"))
        if index >= len(self._configs):
            # The row list was re-rendered out from under this press — `discover()` running
            # between the click and this handler, in practice. Nothing sane to run.
            return
        self.run_config(self._configs[index])
