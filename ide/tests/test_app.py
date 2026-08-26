"""End-to-end tests for the app, driven headlessly through Textual's Pilot.

These boot the real widget tree against `FakeBackend`, so they exercise the wiring — bindings,
event handlers, the worker that runs the agent, and the review gate the run feeds — without a
subprocess, a model, or a terminal. That combination is what makes them safe to run on every
change: the parts they replace are exactly the slow and non-deterministic ones.

Widget-level behaviour lives in the per-widget test modules. What is tested here is only what
`app.py` itself owns: how the pieces fail *together*.
"""

from __future__ import annotations

from textual.widgets import Input, Select, Static, TabbedContent, Tree

from local_coder.app import LocalCoderApp
from local_coder.protocols import AgentRun, AgentStep, ModelStatus, StopReason, TokenUsage
from local_coder.ui.editor_tabs import EditorTabs
from local_coder.ui.review_panel import ReviewPanel


def status_of(app: LocalCoderApp) -> str:
    return str(app.query_one("#status", Static).content)


async def browse_src(app: LocalCoderApp, pilot) -> None:
    """Expands `src/` — which is what puts its files into the review snapshot candidates."""
    tree = app.query_one("#tree", Tree)
    next(node for node in tree.root.children if str(node.label) == "src/").expand()
    await pilot.pause()


async def run_task(app: LocalCoderApp, pilot, text: str) -> None:
    app.query_one("#task", Input).value = text
    worker = app.action_run_task()
    assert worker is not None
    await worker.wait()
    await pilot.pause()


class TestStartup:
    async def test_populates_the_tree_from_the_workspace_root(self, backend) -> None:
        app = LocalCoderApp(backend)
        async with app.run_test() as pilot:
            await pilot.pause()
            tree = app.query_one("#tree", Tree)

            assert [str(node.label) for node in tree.root.children] == ["src/", "README.md"]

    async def test_reports_a_broken_setup_in_the_log_instead_of_crashing(self, backend) -> None:
        backend.status_result = ModelStatus(
            reachable=False,
            workspace_configured=False,
            workspace_root=None,
        )
        app = LocalCoderApp(backend)
        async with app.run_test() as pilot:
            await pilot.pause()

            assert app.session_log, "a broken setup must be explained, not swallowed"
            assert "setup" in status_of(app).lower()


class TestOpeningFiles:
    async def test_selecting_a_file_opens_it_in_a_tab(self, backend) -> None:
        app = LocalCoderApp(backend)
        async with app.run_test() as pilot:
            await pilot.pause()
            tree = app.query_one("#tree", Tree)
            tree.select_node(
                next(node for node in tree.root.children if str(node.label) == "README.md")
            )
            await pilot.pause()
            editor = app.query_one("#editor", EditorTabs)

            assert editor.active_path == "README.md"
            assert editor.active_text == "# Sample\n"

    async def test_expanding_a_directory_lists_it_lazily(self, backend) -> None:
        app = LocalCoderApp(backend)
        async with app.run_test() as pilot:
            await pilot.pause()
            tree = app.query_one("#tree", Tree)
            src = next(node for node in tree.root.children if str(node.label) == "src/")

            assert not src.children

            src.expand()
            await pilot.pause()

            assert [str(node.label) for node in src.children] == ["app.py", "util.py"]

    async def test_open_path_can_place_the_cursor_on_a_line(self, backend) -> None:
        # The path a search hit takes: open the file, land on the match.
        app = LocalCoderApp(backend)
        async with app.run_test() as pilot:
            await pilot.pause()
            await app.open_path("src/app.py", line=2)
            await pilot.pause()
            area = app.query_one("#editor", EditorTabs).active_area

            assert area is not None
            assert area.cursor_location[0] == 1


class TestSaving:
    async def test_save_writes_the_active_tab_back(self, backend) -> None:
        app = LocalCoderApp(backend)
        async with app.run_test() as pilot:
            await pilot.pause()
            await app.open_path("README.md")
            await pilot.pause()
            app.query_one("#editor", EditorTabs).active_area.load_text("# Changed\n")
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

    async def test_closing_a_dirty_tab_is_refused_rather_than_prompted(self, backend) -> None:
        app = LocalCoderApp(backend)
        async with app.run_test() as pilot:
            await pilot.pause()
            await app.open_path("README.md")
            await pilot.pause()
            app.query_one("#editor", EditorTabs).active_area.insert("x")
            await pilot.pause()

            app.action_close_tab()
            await pilot.pause()

            assert app.query_one("#editor", EditorTabs).active_path == "README.md"
            assert "unsaved" in status_of(app).lower()


class TestDelegating:
    async def test_a_run_logs_each_step_and_clears_the_box(self, backend) -> None:
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
            await run_task(app, pilot, "add a docstring")

            assert backend.called("run_agent")[0][0] == "add a docstring"
            assert app.query_one("#task", Input).value == ""
            assert "write_file(src/app.py)" in app.session_log

    async def test_an_empty_task_does_nothing(self, backend) -> None:
        app = LocalCoderApp(backend)
        async with app.run_test() as pilot:
            await pilot.pause()
            app.query_one("#task", Input).value = "   "

            assert app.action_run_task() is None
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
            await run_task(app, pilot, "do the impossible")

            assert "ran out of turns" in app.session_log
            assert "stopped" in status_of(app).lower()


def writing_run(backend, path: str, text: str, task_answer: str = ""):
    """A stand-in for the real model: writes `text` to `path` and reports having done so."""

    async def run_agent(task, *, model=None, path_scope=None, **_kwargs):
        backend.files[path] = text
        return AgentRun(
            task=task,
            answer=task_answer,
            steps=(AgentStep("write_file", f"write_file({path}) -> {len(text)} bytes", ok=True),),
            stopped=StopReason.DONE,
            turns=2,
        )

    return run_agent


class TestReviewGate:
    """The rule the app exists to enforce: nothing the model wrote is final until reviewed."""

    async def test_a_changed_file_is_left_pending_with_its_before_and_after(self, backend) -> None:
        backend.run_agent = writing_run(backend, "src/app.py", "def main():\n    return 2\n")
        app = LocalCoderApp(backend)
        async with app.run_test() as pilot:
            await pilot.pause()
            await browse_src(app, pilot)
            await run_task(app, pilot, "change the return value")

            panel = app.query_one("#review", ReviewPanel)
            assert [change.path for change in panel.changes] == ["src/app.py"]
            assert panel.changes[0].before == "def main():\n    return 1\n"
            assert panel.changes[0].after == "def main():\n    return 2\n"
            assert "awaiting review" in app.session_log

    async def test_reverting_puts_the_original_content_back(self, backend) -> None:
        backend.run_agent = writing_run(backend, "src/app.py", "ruined\n")
        app = LocalCoderApp(backend)
        async with app.run_test() as pilot:
            await pilot.pause()
            await browse_src(app, pilot)
            await run_task(app, pilot, "ruin it")

            app.query_one("#review", ReviewPanel).action_revert()
            await pilot.pause()

            assert backend.files["src/app.py"] == "def main():\n    return 1\n"
            assert app.query_one("#review", ReviewPanel).changes == ()

    async def test_accepting_leaves_the_file_as_the_model_wrote_it(self, backend) -> None:
        backend.run_agent = writing_run(backend, "src/app.py", "def main():\n    return 2\n")
        app = LocalCoderApp(backend)
        async with app.run_test() as pilot:
            await pilot.pause()
            await browse_src(app, pilot)
            await run_task(app, pilot, "change it")

            app.query_one("#review", ReviewPanel).action_accept()
            await pilot.pause()

            assert backend.files["src/app.py"] == "def main():\n    return 2\n"
            assert app.query_one("#review", ReviewPanel).changes == ()

    async def test_a_run_that_changed_nothing_leaves_the_gate_empty(self, backend) -> None:
        app = LocalCoderApp(backend)
        async with app.run_test() as pilot:
            await pilot.pause()
            await run_task(app, pilot, "explain promises")

            assert app.query_one("#review", ReviewPanel).changes == ()


class TestDock:
    async def test_focus_task_switches_back_to_the_agent_tab(self, backend) -> None:
        app = LocalCoderApp(backend)
        async with app.run_test() as pilot:
            await pilot.pause()
            dock = app.query_one("#dock", TabbedContent)
            dock.active = "tab-search"
            await pilot.pause()

            app.action_focus_task()
            await pilot.pause()

            assert dock.active == "tab-agent"


class TestModelAndTokens:
    """Choosing what runs, and seeing what it cost."""

    async def test_the_picker_offers_only_tool_capable_models(self, backend) -> None:
        # A model without the capability cannot call a workspace tool at all, so offering it
        # puts a choice in front of the user whose only outcome is a run that touches nothing.
        backend.status_result = ModelStatus(
            reachable=True,
            workspace_configured=True,
            workspace_root="/w",
            models=("qwen2.5-coder:14b", "nomic-embed-text"),
            tool_capable_models=("qwen2.5-coder:14b",),
        )
        app = LocalCoderApp(backend)
        async with app.run_test() as pilot:
            await pilot.pause()
            offered = [str(label) for label, _value in app.query_one("#model", Select)._options]

            assert "qwen2.5-coder:14b" in offered
            assert "nomic-embed-text" not in offered

    async def test_it_defaults_to_what_the_server_would_have_picked(self, backend) -> None:
        # So the box never disagrees with what actually runs.
        app = LocalCoderApp(backend)
        async with app.run_test() as pilot:
            await pilot.pause()

            assert app._model == "qwen2.5-coder:14b"

    async def test_choosing_a_model_is_used_for_the_next_run(self, backend) -> None:
        backend.status_result = ModelStatus(
            reachable=True,
            workspace_configured=True,
            workspace_root="/w",
            models=("a:1b", "b:7b"),
            tool_capable_models=("a:1b", "b:7b"),
        )
        app = LocalCoderApp(backend)
        async with app.run_test() as pilot:
            await pilot.pause()
            app.query_one("#model", Select).value = "b:7b"
            await pilot.pause()
            await run_task(app, pilot, "do a thing")

            # run_agent(task, path, model) — the recorded call carries the chosen model.
            assert backend.called("run_agent")[0][2] == "b:7b"

    async def test_token_counts_are_shown_and_accumulate(self, backend) -> None:
        backend.agent_result = AgentRun(
            task="t",
            answer="done",
            stopped=StopReason.DONE,
            turns=2,
            usage=TokenUsage(1000, 250),
        )
        app = LocalCoderApp(backend)
        async with app.run_test() as pilot:
            await pilot.pause()
            await run_task(app, pilot, "first")
            after_one = str(app.query_one("#tokens", Static).content)
            await run_task(app, pilot, "second")
            after_two = str(app.query_one("#tokens", Static).content)

            assert "1,250" in after_one
            assert "2,500" in after_two
            assert "2 run(s)" in after_two
            # The per-run cost is in the transcript too, since the counter only shows a total.
            assert "1,250 tokens" in app.session_log

    async def test_a_run_that_reported_no_counts_shows_nothing(self, backend) -> None:
        # Blank rather than zero: zero would claim the run was free.
        backend.agent_result = AgentRun(task="t", answer="done", usage=None)
        app = LocalCoderApp(backend)
        async with app.run_test() as pilot:
            await pilot.pause()
            await run_task(app, pilot, "first")

            assert str(app.query_one("#tokens", Static).content) == ""
