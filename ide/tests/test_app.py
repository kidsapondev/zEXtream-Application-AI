"""End-to-end tests for the app, driven headlessly through Textual's Pilot.

These boot the real widget tree against `FakeBackend`, so they exercise the wiring — bindings,
event handlers, the worker that runs the agent — without a subprocess, a model, or a terminal.
That combination is what makes them safe to run on every change: the parts they replace are
exactly the slow and non-deterministic ones.
"""

from __future__ import annotations

from textual.widgets import Input, Static, TextArea, Tree

from local_coder.app import LocalCoderApp, language_for
from local_coder.protocols import AgentRun, AgentStep, StopReason


class TestLanguageFor:
    def test_maps_known_extensions(self) -> None:
        assert language_for("src/app.py") == "python"
        assert language_for("a/b/data.json") == "json"

    def test_is_none_for_unknown_extensions(self) -> None:
        # Handing Textual a language it has no parser for raises, so "unknown" has to mean
        # no highlighting rather than a guess.
        assert language_for("notes.xyz") is None
        assert language_for("Makefile") is None


class TestStartup:
    async def test_populates_the_tree_from_the_workspace_root(self, backend) -> None:
        app = LocalCoderApp(backend)
        async with app.run_test() as pilot:
            await pilot.pause()
            tree = app.query_one("#tree", Tree)
            labels = [str(node.label) for node in tree.root.children]

        assert labels == ["src/", "README.md"]

    async def test_reports_a_broken_setup_in_the_log_instead_of_crashing(self, backend) -> None:
        from local_coder.protocols import ModelStatus

        backend.status_result = ModelStatus(
            reachable=False,
            workspace_configured=False,
            workspace_root=None,
        )
        app = LocalCoderApp(backend)
        async with app.run_test() as pilot:
            await pilot.pause()
            log_lines = app.session_log
            status = str(app.query_one("#status", Static).content)

        assert log_lines, "a broken setup must be explained, not swallowed"
        assert "setup" in status.lower()


class TestOpeningFiles:
    async def test_selecting_a_file_loads_it_into_the_editor(self, backend) -> None:
        app = LocalCoderApp(backend)
        async with app.run_test() as pilot:
            await pilot.pause()
            tree = app.query_one("#tree", Tree)
            readme = next(node for node in tree.root.children if str(node.label) == "README.md")
            tree.select_node(readme)
            await pilot.pause()
            editor = app.query_one("#editor", TextArea)

            assert editor.text == "# Sample\n"
            assert editor.read_only is False

    async def test_expanding_a_directory_lists_it_lazily(self, backend) -> None:
        app = LocalCoderApp(backend)
        async with app.run_test() as pilot:
            await pilot.pause()
            tree = app.query_one("#tree", Tree)
            src = next(node for node in tree.root.children if str(node.label) == "src/")

            # Nothing is fetched for a directory until it is opened.
            assert not src.children

            src.expand()
            await pilot.pause()

            assert [str(node.label) for node in src.children] == ["app.py", "util.py"]


class TestSaving:
    async def test_ctrl_s_writes_the_editor_contents_back(self, backend) -> None:
        app = LocalCoderApp(backend)
        async with app.run_test() as pilot:
            await pilot.pause()
            tree = app.query_one("#tree", Tree)
            tree.select_node(
                next(node for node in tree.root.children if str(node.label) == "README.md")
            )
            await pilot.pause()
            app.query_one("#editor", TextArea).load_text("# Changed\n")
            await app.action_save()
            await pilot.pause()

        assert backend.files["README.md"] == "# Changed\n"

    async def test_saving_with_nothing_open_is_a_no_op(self, backend) -> None:
        app = LocalCoderApp(backend)
        async with app.run_test() as pilot:
            await pilot.pause()
            await app.action_save()
            await pilot.pause()

        assert backend.called("write_file") == []


class TestDelegating:
    async def test_submitting_a_task_runs_the_agent_and_logs_each_step(self, backend) -> None:
        backend.agent_result = AgentRun(
            task="add a docstring",
            answer="Added it.",
            steps=(
                AgentStep("read_file", "read_file(src/app.py) -> 40 bytes", ok=True),
                AgentStep("write_file", "write_file(src/app.py) -> 62 bytes", ok=True),
            ),
            stopped=StopReason.DONE,
            turns=3,
        )
        app = LocalCoderApp(backend)
        async with app.run_test() as pilot:
            await pilot.pause()
            task = app.query_one("#task", Input)
            task.value = "add a docstring"
            worker = app.action_run_task()
            assert worker is not None
            await worker.wait()
            await pilot.pause()

            assert backend.called("run_agent")[0][0] == "add a docstring"
            # The input clears so the next task can be typed straight away.
            assert task.value == ""
            rendered = app.session_log
            assert "write_file(src/app.py)" in rendered

    async def test_an_empty_task_does_nothing(self, backend) -> None:
        app = LocalCoderApp(backend)
        async with app.run_test() as pilot:
            await pilot.pause()
            app.query_one("#task", Input).value = "   "
            app.action_run_task()
            await pilot.pause()

        assert backend.called("run_agent") == []

    async def test_a_failed_run_is_reported_rather_than_raised(self, backend) -> None:
        backend.agent_result = AgentRun(
            task="do the impossible",
            answer="",
            steps=(AgentStep("write_file", "write_file(x) -> denied", ok=False),),
            stopped=StopReason.MAX_TURNS,
            turns=20,
            error="ran out of turns",
        )
        app = LocalCoderApp(backend)
        async with app.run_test() as pilot:
            await pilot.pause()
            app.query_one("#task", Input).value = "do the impossible"
            worker = app.action_run_task()
            assert worker is not None
            await worker.wait()
            await pilot.pause()

            rendered = app.session_log
            assert "ran out of turns" in rendered
            # Failed or not, the files it touched must still be visible in the status line.
            assert "stopped" in str(app.query_one("#status", Static).content).lower()
