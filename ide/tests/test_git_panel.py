"""`GitPanel`, driven headlessly through Textual's Pilot.

The host app below exists only in this file — mounting the panel inside a one-widget `App` is
what makes its messages testable at all, the same reasoning `test_review_panel.py` and
`test_search_panel.py` give for their own host apps: a Textual `Message` only goes anywhere
once the widget is running inside an app.

`GitPanel` owns a real `GitRepo`, which itself only ever calls `FakeBackend.exec("git", ...)` —
so these tests script `backend.exec_result` / a replacement `backend.exec` the same way
`test_git.py` does for `GitRepo` directly, and never touch a real git binary.

`refresh_status`, `_stage_current`, `_unstage_current`, and `_do_commit` are all `@work`
methods (see the module docstring on why: a blocking backend round trip inside a widget
handler freezes the whole terminal UI). A worker started this tick is not registered yet, so
`await pilot.pause()` a couple of times — polling the title text, the same trick
`test_search_panel.py` uses for its own `_run_search` worker — is more reliable here than
trusting `App.workers.wait_for_complete()` to see a worker that may not exist yet.
"""

from __future__ import annotations

from textual import on
from textual.app import App, ComposeResult
from textual.widgets import Button, Input, Label, ListView, Static

from local_coder.git import GitFile, GitRepo, GitStatus
from local_coder.protocols import ExecResult
from local_coder.ui.git_panel import GitPanel, branch_summary, file_row


def _exec_result(stdout: str = "", stderr: str = "", exit_code: int = 0) -> ExecResult:
    return ExecResult(command="git", exit_code=exit_code, stdout=stdout, stderr=stderr, timed_out=False)


def _status_stdout(*parts: str) -> str:
    return "".join(f"{part}\0" for part in parts)


def _scripted_exec(answers: dict[tuple[str, ...], ExecResult]):
    """Same pattern as `test_git.py`: answer by the git subcommand tuple alone."""

    async def exec_(command, args=(), *, cwd=""):
        key = tuple(args)
        if key not in answers:
            raise AssertionError(f"unscripted git call: {command} {list(args)}")
        return answers[key]

    return exec_


def _repo_script(backend, status_stdout: str, extra: dict[tuple[str, ...], ExecResult] | None = None) -> None:
    """Wires `backend.exec` to answer `rev-parse` (a repo) and `status` with `status_stdout`,
    plus whatever else an individual test needs (`extra`) — stage/unstage/commit calls.
    """
    answers = {
        ("rev-parse", "--is-inside-work-tree"): _exec_result(stdout="true\n"),
        ("status", "--porcelain=v1", "-b", "-z"): _exec_result(stdout=status_stdout),
    }
    answers.update(extra or {})
    backend.exec = _scripted_exec(answers)


class GitHost(App[None]):
    """Minimal app whose only job is to own a `GitPanel` and record what it posts."""

    def __init__(self, repo: GitRepo) -> None:
        super().__init__()
        self._repo = repo
        self.selected: str | None = None
        self.committed: str | None = None

    def compose(self) -> ComposeResult:
        yield GitPanel(self._repo, id="git")

    @on(GitPanel.FileSelected)
    def _on_file_selected(self, event: GitPanel.FileSelected) -> None:
        self.selected = event.path

    @on(GitPanel.Committed)
    def _on_committed(self, event: GitPanel.Committed) -> None:
        self.committed = event.summary


async def _settle(pilot, predicate, attempts: int = 50) -> None:
    """Pumps the message loop until `predicate()` is true or `attempts` is exhausted.

    Needed because every git round trip in this panel runs on a `@work` worker rather than
    being awaited directly in a handler (see the module docstring) — a single `pilot.pause()`
    is not guaranteed to see it finish, the same reasoning `test_search_panel.py`'s `_submit`
    helper documents for its own worker.
    """
    for _ in range(attempts):
        await pilot.pause()
        if predicate():
            return
    await pilot.pause()


def _title(app) -> str:
    return str(app.query_one("#git-title", Static).content)


class TestPureHelpers:
    """`file_row` and `branch_summary` are plain functions precisely so they can be checked
    without booting Textual at all — the same split `review_panel.gutter_row` uses.
    """

    def test_file_row_marks_a_staged_file_with_a_literal_s(self) -> None:
        row = file_row(GitFile(path="a.py", index_status="M", work_status=" "))
        assert row.startswith("S")
        assert "M" in row
        assert row.endswith("a.py")

    def test_file_row_leaves_an_unstaged_file_unmarked(self) -> None:
        row = file_row(GitFile(path="a.py", index_status=" ", work_status="M"))
        assert row.startswith(" ")

    def test_file_row_shows_the_untracked_label(self) -> None:
        row = file_row(GitFile(path="new.py", index_status="?", work_status="?"))
        assert "??" in row
        assert row.endswith("new.py")

    def test_branch_summary_before_loading(self) -> None:
        assert "loading" in branch_summary(None).lower()

    def test_branch_summary_with_no_divergence(self) -> None:
        assert branch_summary(GitStatus(branch="main", files=())) == "main"

    def test_branch_summary_with_ahead_and_behind(self) -> None:
        summary = branch_summary(GitStatus(branch="main", files=(), ahead=1, behind=2))
        assert "ahead 1" in summary
        assert "behind 2" in summary

    def test_branch_summary_detached(self) -> None:
        assert "detached" in branch_summary(GitStatus(branch=None, files=())).lower()


class TestLoadingAndEmptyStates:
    async def test_not_a_repo_says_so_plainly_and_lists_nothing(self, backend) -> None:
        backend.exec = _scripted_exec(
            {("rev-parse", "--is-inside-work-tree"): _exec_result(stderr="fatal: not a git repository", exit_code=128)}
        )
        repo = GitRepo(backend)
        app = GitHost(repo)
        async with app.run_test() as pilot:
            await _settle(pilot, lambda: "not a git repository" in _title(app))
            title = _title(app)
            files = list(app.query_one(ListView).children)

        assert "not a git repository" in title
        assert files == []

    async def test_a_clean_repo_says_so_plainly(self, backend) -> None:
        _repo_script(backend, _status_stdout("## main"))
        repo = GitRepo(backend)
        app = GitHost(repo)
        async with app.run_test() as pilot:
            await _settle(pilot, lambda: "clean" in _title(app).lower())
            title = _title(app)

        assert "main" in title
        assert "clean" in title.lower()

    async def test_changed_files_are_listed_with_their_labels(self, backend) -> None:
        stdout = _status_stdout("## main", " M src/app.py", "?? new.py")
        _repo_script(backend, stdout)
        repo = GitRepo(backend)
        app = GitHost(repo)
        async with app.run_test() as pilot:
            await _settle(pilot, lambda: len(app.query_one(ListView).children) == 2)
            rows = [str(item.query_one(Label).content) for item in app.query_one(ListView).children]
            title = _title(app)

        assert any("src/app.py" in row and "M" in row for row in rows)
        assert any("new.py" in row and "??" in row for row in rows)
        assert "2 changed" in title


class TestStagingAndUnstaging:
    async def test_the_stage_button_stages_the_highlighted_file_and_reloads(self, backend) -> None:
        first_status = _status_stdout("## main", " M src/app.py")
        after_stage = _status_stdout("## main", "M  src/app.py")
        calls = {"status_call": 0, "staged": False}

        async def exec_(command, args=(), *, cwd=""):
            key = tuple(args)
            if key == ("rev-parse", "--is-inside-work-tree"):
                return _exec_result(stdout="true\n")
            if key == ("status", "--porcelain=v1", "-b", "-z"):
                calls["status_call"] += 1
                stdout = first_status if calls["status_call"] == 1 else after_stage
                return _exec_result(stdout=stdout)
            if key == ("add", "--", "src/app.py"):
                # `backend.exec` is replaced wholesale here rather than left to
                # `FakeBackend`'s default (see `_scripted_exec`), so `FakeBackend._record`
                # never runs and `backend.called("exec")` stays empty — the call is tracked
                # in this closure instead.
                calls["staged"] = True
                return _exec_result()
            raise AssertionError(f"unscripted git call: {args}")

        backend.exec = exec_
        repo = GitRepo(backend)
        app = GitHost(repo)
        async with app.run_test() as pilot:
            await _settle(pilot, lambda: len(app.query_one(ListView).children) == 1)
            app.query_one(ListView).index = 0
            await pilot.pause()

            app.query_one("#git-stage", Button).press()
            await _settle(pilot, lambda: calls["status_call"] >= 2)

            rows = [str(item.query_one(Label).content) for item in app.query_one(ListView).children]

        assert rows[0].startswith("S")
        assert calls["staged"] is True

    async def test_the_unstage_button_unstages_the_highlighted_file(self, backend) -> None:
        first_status = _status_stdout("## main", "M  staged.py")
        after_unstage = _status_stdout("## main", " M staged.py")
        calls = {"status_call": 0, "unstaged": False}

        async def exec_(command, args=(), *, cwd=""):
            key = tuple(args)
            if key == ("rev-parse", "--is-inside-work-tree"):
                return _exec_result(stdout="true\n")
            if key == ("status", "--porcelain=v1", "-b", "-z"):
                calls["status_call"] += 1
                stdout = first_status if calls["status_call"] == 1 else after_unstage
                return _exec_result(stdout=stdout)
            if key == ("restore", "--staged", "--", "staged.py"):
                calls["unstaged"] = True
                return _exec_result()
            raise AssertionError(f"unscripted git call: {args}")

        backend.exec = exec_
        repo = GitRepo(backend)
        app = GitHost(repo)
        async with app.run_test() as pilot:
            await _settle(pilot, lambda: len(app.query_one(ListView).children) == 1)
            app.query_one(ListView).index = 0
            await pilot.pause()

            app.query_one("#git-unstage", Button).press()
            await _settle(pilot, lambda: calls["status_call"] >= 2)

            rows = [str(item.query_one(Label).content) for item in app.query_one(ListView).children]

        assert rows[0].startswith(" ")
        assert calls["unstaged"] is True

    async def test_stage_is_disabled_for_an_already_staged_file(self, backend) -> None:
        _repo_script(backend, _status_stdout("## main", "M  staged.py"))
        repo = GitRepo(backend)
        app = GitHost(repo)
        async with app.run_test() as pilot:
            await _settle(pilot, lambda: len(app.query_one(ListView).children) == 1)
            app.query_one(ListView).index = 0
            await pilot.pause()

            stage_button = app.query_one("#git-stage", Button)
            unstage_button = app.query_one("#git-unstage", Button)

        assert stage_button.disabled is True
        assert unstage_button.disabled is False

    async def test_unstage_is_disabled_for_an_unstaged_file(self, backend) -> None:
        _repo_script(backend, _status_stdout("## main", " M unstaged.py"))
        repo = GitRepo(backend)
        app = GitHost(repo)
        async with app.run_test() as pilot:
            await _settle(pilot, lambda: len(app.query_one(ListView).children) == 1)
            app.query_one(ListView).index = 0
            await pilot.pause()

            stage_button = app.query_one("#git-stage", Button)
            unstage_button = app.query_one("#git-unstage", Button)

        assert stage_button.disabled is False
        assert unstage_button.disabled is True

    async def test_with_nothing_selected_both_buttons_are_disabled(self, backend) -> None:
        _repo_script(backend, _status_stdout("## main"))
        repo = GitRepo(backend)
        app = GitHost(repo)
        async with app.run_test() as pilot:
            await _settle(pilot, lambda: "clean" in _title(app).lower())
            stage_button = app.query_one("#git-stage", Button)
            unstage_button = app.query_one("#git-unstage", Button)

        assert stage_button.disabled is True
        assert unstage_button.disabled is True


class TestSelecting:
    async def test_choosing_a_file_posts_its_path(self, backend) -> None:
        _repo_script(backend, _status_stdout("## main", " M src/app.py"))
        repo = GitRepo(backend)
        app = GitHost(repo)
        async with app.run_test() as pilot:
            await _settle(pilot, lambda: len(app.query_one(ListView).children) == 1)
            results = app.query_one(ListView)
            results.index = 0
            results.focus()
            await pilot.press("enter")
            await pilot.pause()

        assert app.selected == "src/app.py"


class TestCommitting:
    async def test_committing_with_a_message_posts_the_summary_and_reloads(self, backend) -> None:
        staged_status = _status_stdout("## main", "M  staged.py")
        clean_status = _status_stdout("## main")
        calls = {"status_call": 0}

        async def exec_(command, args=(), *, cwd=""):
            key = tuple(args)
            if key == ("rev-parse", "--is-inside-work-tree"):
                return _exec_result(stdout="true\n")
            if key == ("status", "--porcelain=v1", "-b", "-z"):
                calls["status_call"] += 1
                stdout = staged_status if calls["status_call"] == 1 else clean_status
                return _exec_result(stdout=stdout)
            if key == ("commit", "-m", "fix the thing"):
                return _exec_result(stdout="[main a1b2c3d] fix the thing\n")
            raise AssertionError(f"unscripted git call: {args}")

        backend.exec = exec_
        repo = GitRepo(backend)
        app = GitHost(repo)
        async with app.run_test() as pilot:
            await _settle(pilot, lambda: len(app.query_one(ListView).children) == 1)
            app.query_one("#git-commit-input", Input).value = "fix the thing"
            app.query_one("#git-commit-button", Button).press()
            await _settle(pilot, lambda: app.committed is not None)
            input_value = app.query_one("#git-commit-input", Input).value

        assert app.committed == "[main a1b2c3d] fix the thing"
        assert input_value == ""

    async def test_committing_with_an_empty_message_shows_a_prompt_and_commits_nothing(self, backend) -> None:
        _repo_script(backend, _status_stdout("## main", "M  staged.py"))
        repo = GitRepo(backend)
        app = GitHost(repo)
        async with app.run_test() as pilot:
            await _settle(pilot, lambda: len(app.query_one(ListView).children) == 1)
            app.query_one("#git-commit-button", Button).press()
            await _settle(pilot, lambda: str(app.query_one("#git-message", Static).content) != "")

            message = str(app.query_one("#git-message", Static).content)

        assert "message" in message.lower()
        assert app.committed is None
        # No "commit" branch was ever registered in `_repo_script`'s `answers` dict, so a
        # commit call reaching the backend at all would have raised inside `exec_` and failed
        # this test loudly — the empty-message guard has to be what stopped it.

    async def test_committing_nothing_staged_shows_the_backends_explanation(self, backend) -> None:
        _repo_script(
            backend,
            _status_stdout("## main"),
            extra={
                ("commit", "-m", "x"): _exec_result(
                    stdout="nothing to commit, working tree clean\n", exit_code=1
                )
            },
        )
        repo = GitRepo(backend)
        app = GitHost(repo)
        async with app.run_test() as pilot:
            await _settle(pilot, lambda: "clean" in _title(app).lower())
            app.query_one("#git-commit-input", Input).value = "x"
            app.query_one("#git-commit-button", Button).press()
            await _settle(pilot, lambda: str(app.query_one("#git-message", Static).content) != "")

            message = str(app.query_one("#git-message", Static).content)

        assert "nothing" in message.lower()
        assert app.committed is None
