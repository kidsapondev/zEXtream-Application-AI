"""The run panel, driven headlessly through Textual's Pilot.

The host app below exists only in this file, for the same reason `ReviewHost` exists only in
`test_review_panel.py`: a Textual `Message` only goes anywhere once the widget posting it is
running inside a real `App`, so a `RunPanel` constructed standalone would post `Finished` into
nothing and every assertion here would pass for the wrong reason.

Discovery is driven through a real `Runner` wrapping `FakeBackend`, exactly as `test_runner.py`
drives it — this file is not re-testing discovery or output parsing, only that the widget wires
`Runner` up correctly. Execution is driven by setting `backend.exec_result`, and the one test
that needs to observe a run *in progress* replaces `runner.run` with a stand-in the test
controls with an `asyncio.Event` — the same "replace the async call" pattern `test_app.py` uses
for `run_agent`.
"""

from __future__ import annotations

import asyncio

from textual import on
from textual.app import App, ComposeResult
from textual.widgets import Button, Static

from local_coder.protocols import AgentError, ExecResult, ModelStatus
from local_coder.runner import RunOutcome, Runner
from local_coder.ui.run_panel import RunPanel

from conftest import FakeBackend


def make_backend(files: dict[str, str], allowed: tuple[str, ...] = ("git", "python", "npm")) -> FakeBackend:
    backend = FakeBackend(files=files)
    backend.status_result = ModelStatus(
        reachable=True,
        workspace_configured=True,
        workspace_root="/fake/workspace",
        allowed_commands=allowed,
    )
    return backend


class RunHost(App[None]):
    """Minimal app whose only job is to own a `RunPanel` and record what it posts."""

    def __init__(self, runner: Runner) -> None:
        super().__init__()
        self.runner = runner
        self.seen: list[RunOutcome] = []

    def compose(self) -> ComposeResult:
        yield RunPanel(self.runner, id="run")

    @on(RunPanel.Finished)
    def _finished(self, event: RunPanel.Finished) -> None:
        self.seen.append(event.outcome)


def status_text(app: App) -> str:
    return str(app.query_one("#run-status", Static).content)


class TestDiscoveryOnMount:
    async def test_lists_the_configs_runner_discover_found(self) -> None:
        backend = make_backend({"pyproject.toml": "[tool.pytest.ini_options]\n"})
        app = RunHost(Runner(backend))
        async with app.run_test() as pilot:
            await pilot.pause()
            panel = app.query_one(RunPanel)

            assert [c.name for c in panel.configs] == ["pytest"]
            assert "1 run configuration" in str(app.query_one("#run-title", Static).content)
            assert app.query_one("#run-btn-0", Button).label.plain == "Run"

    async def test_a_workspace_with_nothing_runnable_says_so(self) -> None:
        app = RunHost(Runner(make_backend({})))
        async with app.run_test() as pilot:
            await pilot.pause()
            panel = app.query_one(RunPanel)

            assert panel.configs == ()
            title = str(app.query_one("#run-title", Static).content)
            assert "no run configuration" in title.lower()

    async def test_several_npm_scripts_each_get_their_own_button(self) -> None:
        backend = make_backend({"package.json": '{"scripts": {"build": "tsc", "test": "jest"}}'})
        app = RunHost(Runner(backend))
        async with app.run_test() as pilot:
            await pilot.pause()
            panel = app.query_one(RunPanel)

            assert len(panel.configs) == 2
            assert app.query_one("#run-btn-0", Button) is not None
            assert app.query_one("#run-btn-1", Button) is not None


class TestRunningAConfig:
    async def test_a_passing_run_shows_pass_and_posts_finished(self) -> None:
        backend = make_backend({"pyproject.toml": "[tool.pytest.ini_options]\n"})
        backend.exec_result = ExecResult(
            command="python -m pytest -q", exit_code=0, stdout="5 passed in 0.01s", stderr="", timed_out=False
        )
        app = RunHost(Runner(backend))
        async with app.run_test() as pilot:
            await pilot.pause()
            panel = app.query_one(RunPanel)
            worker = panel.run_config(panel.configs[0])
            assert worker is not None
            await worker.wait()
            await pilot.pause()

            assert "PASS" in status_text(app)
            assert len(app.seen) == 1
            assert app.seen[0].ok is True
            assert app.seen[0].passed == 5
            assert panel.last_outcome is app.seen[0]

    async def test_a_failing_run_shows_fail(self) -> None:
        backend = make_backend({"pyproject.toml": "[tool.pytest.ini_options]\n"})
        backend.exec_result = ExecResult(
            command="python -m pytest -q",
            exit_code=1,
            stdout="1 failed, 4 passed in 0.02s",
            stderr="",
            timed_out=False,
        )
        app = RunHost(Runner(backend))
        async with app.run_test() as pilot:
            await pilot.pause()
            panel = app.query_one(RunPanel)
            worker = panel.run_config(panel.configs[0])
            assert worker is not None
            await worker.wait()
            await pilot.pause()

            assert "FAIL" in status_text(app)
            assert app.seen[0].ok is False

    async def test_verdict_is_a_word_not_only_a_colour(self) -> None:
        # The requirement is legibility without colour: the status line rendered as plain
        # text (via `.content`, exactly how a screen reader or the plain-text session log
        # would see it) must contain an unambiguous word, not rely on styling alone.
        backend = make_backend({"pyproject.toml": "[tool.pytest.ini_options]\n"})
        backend.exec_result = ExecResult(
            command="python -m pytest -q", exit_code=0, stdout="1 passed in 0.00s", stderr="", timed_out=False
        )
        app = RunHost(Runner(backend))
        async with app.run_test() as pilot:
            await pilot.pause()
            panel = app.query_one(RunPanel)
            worker = panel.run_config(panel.configs[0])
            await worker.wait()
            await pilot.pause()

            assert status_text(app).strip().startswith("PASS")

    async def test_unrecognised_output_does_not_invent_a_zero_count(self) -> None:
        backend = make_backend({"package.json": '{"scripts": {"build": "tsc"}}'})
        backend.exec_result = ExecResult(
            command="npm run build", exit_code=0, stdout="webpack compiled successfully", stderr="", timed_out=False
        )
        app = RunHost(Runner(backend))
        async with app.run_test() as pilot:
            await pilot.pause()
            panel = app.query_one(RunPanel)
            worker = panel.run_config(panel.configs[0])
            await worker.wait()
            await pilot.pause()

            assert app.seen[0].passed is None
            assert "passed" not in status_text(app)

    async def test_output_is_mirrored_for_headless_assertions(self) -> None:
        # `Static` cannot be read back reliably, and `RichLog` is empty headless — see the
        # Textual field notes this module's docstring points at. `rendered_output` is the
        # panel's own plain-text mirror, the same idea as `ReviewPanel.rendered_diff`.
        backend = make_backend({"pyproject.toml": "[tool.pytest.ini_options]\n"})
        backend.exec_result = ExecResult(
            command="python -m pytest -q",
            exit_code=1,
            stdout="FAILED test_x.py::test_one\n1 failed, 0 passed in 0.01s",
            stderr="",
            timed_out=False,
        )
        app = RunHost(Runner(backend))
        async with app.run_test() as pilot:
            await pilot.pause()
            panel = app.query_one(RunPanel)
            worker = panel.run_config(panel.configs[0])
            await worker.wait()
            await pilot.pause()

            assert panel.rendered_output == [
                "FAILED test_x.py::test_one",
                "1 failed, 0 passed in 0.01s",
            ]
            body = str(app.query_one("#run-output-body", Static).content)
            assert body.splitlines() == panel.rendered_output

    async def test_pressing_the_run_button_starts_the_configured_command(self) -> None:
        backend = make_backend({"pyproject.toml": "[tool.pytest.ini_options]\n"})
        backend.exec_result = ExecResult(
            command="python -m pytest -q", exit_code=0, stdout="2 passed in 0.01s", stderr="", timed_out=False
        )
        app = RunHost(Runner(backend))
        async with app.run_test() as pilot:
            await pilot.pause()
            app.query_one("#run-btn-0", Button).press()
            await pilot.pause()
            await app.workers.wait_for_complete()
            await pilot.pause()

            assert backend.called("exec")
            assert "PASS" in status_text(app)


class TestConcurrencyGuard:
    async def test_a_run_in_flight_disables_its_own_button_and_says_so(self) -> None:
        backend = make_backend({"pyproject.toml": "[tool.pytest.ini_options]\n"})
        runner = Runner(backend)
        hold = asyncio.Event()
        real_run = runner.run

        async def slow_run(config):
            await hold.wait()
            return await real_run(config)

        runner.run = slow_run  # type: ignore[method-assign]

        app = RunHost(runner)
        async with app.run_test() as pilot:
            await pilot.pause()
            panel = app.query_one(RunPanel)
            worker = panel.run_config(panel.configs[0])
            assert worker is not None
            await pilot.pause()

            assert app.query_one("#run-btn-0", Button).disabled is True
            assert "running" in status_text(app).lower()

            hold.set()
            await worker.wait()
            await pilot.pause()

            assert app.query_one("#run-btn-0", Button).disabled is False

    async def test_calling_run_config_again_while_running_is_a_no_op(self) -> None:
        backend = make_backend({"pyproject.toml": "[tool.pytest.ini_options]\n"})
        runner = Runner(backend)
        hold = asyncio.Event()
        real_run = runner.run

        async def slow_run(config):
            await hold.wait()
            return await real_run(config)

        runner.run = slow_run  # type: ignore[method-assign]

        app = RunHost(runner)
        async with app.run_test() as pilot:
            await pilot.pause()
            panel = app.query_one(RunPanel)
            config = panel.configs[0]

            first = panel.run_config(config)
            second = panel.run_config(config)

            assert first is not None
            assert second is None

            hold.set()
            await first.wait()


class TestErrors:
    async def test_the_backend_being_unable_to_run_at_all_is_reported_not_raised(self) -> None:
        backend = make_backend({"pyproject.toml": "[tool.pytest.ini_options]\n"})
        runner = Runner(backend)

        async def failing_run(config):
            raise AgentError("command not in the allowlist")

        runner.run = failing_run  # type: ignore[method-assign]

        app = RunHost(runner)
        async with app.run_test() as pilot:
            await pilot.pause()
            panel = app.query_one(RunPanel)
            worker = panel.run_config(panel.configs[0])
            assert worker is not None
            await worker.wait()
            await pilot.pause()

            assert "not in the allowlist" in status_text(app)
            # No outcome exists for a run that never started, so nothing is posted for it —
            # posting a `Finished` with no meaningful `RunOutcome` would be worse than silence.
            assert app.seen == []
            # And the button must not be left stuck disabled by the failure.
            assert app.query_one("#run-btn-0", Button).disabled is False
