"""`GitRepo`, driven entirely against `FakeBackend` — no real git, no subprocess.

`FakeBackend.exec` returns a canned `ExecResult` from `backend.exec_result`, which is fine for
a test that only cares about one call. Several tests here need a *different* answer per git
subcommand in the same call (e.g. `status()` calls `rev-parse` then `status --porcelain`), so
those replace `backend.exec` with a small async function instead — the same pattern
`test_app.py` uses for `run_agent` (see `writing_run` there).
"""

from __future__ import annotations

from local_coder.diff import LineKind
from local_coder.git import GitFile, GitRepo, _parse_branch_line, _parse_entries
from local_coder.protocols import AgentError, ExecResult, FileContent


def _exec_result(command: str, stdout: str = "", stderr: str = "", exit_code: int = 0) -> ExecResult:
    return ExecResult(command=command, exit_code=exit_code, stdout=stdout, stderr=stderr, timed_out=False)


def _status_stdout(*parts: str) -> str:
    """Joins porcelain records the way real `-z` output does: NUL-separated, NUL-terminated."""
    return "".join(f"{part}\0" for part in parts)


def _scripted_exec(answers: dict[tuple[str, ...], ExecResult]):
    """Returns a `backend.exec` replacement that answers by the `args` tuple alone.

    `command` is always "git" in every test here, so keying on `args` is enough and keeps the
    fixtures below readable as plain porcelain-command tuples.
    """

    async def exec_(command, args=(), *, cwd=""):
        key = tuple(args)
        if key not in answers:
            raise AssertionError(f"unscripted git call: {command} {list(args)}")
        return answers[key]

    return exec_


# ---------------------------------------------------------------------------------------
# Porcelain parsing — pure functions, no backend involved at all.
# ---------------------------------------------------------------------------------------


class TestParseBranchLine:
    def test_a_tracked_branch_with_no_divergence(self) -> None:
        assert _parse_branch_line("## main...origin/main") == ("main", 0, 0)

    def test_ahead_and_behind_both_present(self) -> None:
        assert _parse_branch_line("## main...origin/main [ahead 2, behind 1]") == ("main", 2, 1)

    def test_ahead_only(self) -> None:
        assert _parse_branch_line("## main...origin/main [ahead 3]") == ("main", 3, 0)

    def test_behind_only(self) -> None:
        assert _parse_branch_line("## main...origin/main [behind 4]") == ("main", 0, 4)

    def test_a_branch_with_no_upstream_configured(self) -> None:
        assert _parse_branch_line("## feature/thing") == ("feature/thing", 0, 0)

    def test_detached_head(self) -> None:
        assert _parse_branch_line("## HEAD (no branch)") == (None, 0, 0)

    def test_a_brand_new_repository_with_no_commits_yet(self) -> None:
        assert _parse_branch_line("## No commits yet on main") == ("main", 0, 0)


class TestParseEntries:
    def test_a_path_containing_a_space(self) -> None:
        # The entire reason `-z` is used: without it, git would have quoted this path as
        # `"a file.py"` and a naive split would corrupt or misplace it.
        files = _parse_entries([" M a file.py"])
        assert files == (GitFile(path="a file.py", index_status=" ", work_status="M"),)

    def test_an_untracked_file(self) -> None:
        files = _parse_entries(["?? new.py"])
        assert files[0].untracked is True
        assert files[0].staged is False
        assert files[0].label == "??"

    def test_a_staged_and_further_modified_file(self) -> None:
        # Staged (index) *and* modified again in the work tree — the "MM" case that a
        # lookup-table label implementation would need a dedicated entry for.
        files = _parse_entries(["MM both.py"])
        assert files[0].staged is True
        assert files[0].label == "MM"

    def test_a_purely_staged_addition(self) -> None:
        files = _parse_entries(["A  added.py"])
        assert files[0].index_status == "A"
        assert files[0].work_status == " "
        assert files[0].staged is True
        assert files[0].label == "A"

    def test_a_purely_unstaged_modification(self) -> None:
        files = _parse_entries([" M edited.py"])
        assert files[0].staged is False
        assert files[0].label == "M"

    def test_a_rename_consumes_the_original_path_field_and_renders_as_the_new_path(self) -> None:
        # Real `-z` output for a staged rename: two NUL-separated records, new path first,
        # original path second, with no status prefix on the second record at all.
        files = _parse_entries(["R  new_name.py", "old_name.py", "?? unrelated.py"])
        assert [f.path for f in files] == ["new_name.py", "unrelated.py"]
        assert files[0].index_status == "R"

    def test_multiple_entries_in_order(self) -> None:
        files = _parse_entries(["?? a.py", " M b.py", "A  c.py"])
        assert [f.path for f in files] == ["a.py", "b.py", "c.py"]

    def test_a_trailing_empty_token_from_the_final_nul_is_ignored(self) -> None:
        # `"XY path\0".split("\0")` leaves a trailing "" — the shape every real status()
        # call produces, since -z always terminates (not just separates) records.
        files = _parse_entries(["?? a.py", ""])
        assert [f.path for f in files] == ["a.py"]


# ---------------------------------------------------------------------------------------
# GitRepo.is_repo / status
# ---------------------------------------------------------------------------------------


class TestIsRepo:
    async def test_true_when_rev_parse_reports_inside_a_work_tree(self, backend) -> None:
        backend.exec_result = _exec_result("git rev-parse", stdout="true\n")
        repo = GitRepo(backend)
        assert await repo.is_repo() is True

    async def test_false_when_rev_parse_fails(self, backend) -> None:
        backend.exec_result = _exec_result(
            "git rev-parse", stderr="fatal: not a git repository", exit_code=128
        )
        repo = GitRepo(backend)
        assert await repo.is_repo() is False


class TestStatus:
    async def test_not_a_repo_degrades_to_an_empty_status_without_raising(self, backend) -> None:
        backend.exec_result = _exec_result(
            "git rev-parse", stderr="fatal: not a git repository", exit_code=128
        )
        repo = GitRepo(backend)
        status = await repo.status()

        assert status.branch is None
        assert status.files == ()
        assert status.ahead == 0
        assert status.behind == 0
        # The `git status` porcelain call must never even run once `is_repo()` says no — that
        # is the whole point of checking first rather than just reading the second call's exit
        # code.
        assert not any(call[0] == "status" for call in backend.called("exec"))

    async def test_branch_and_files_from_one_porcelain_call(self, backend) -> None:
        stdout = _status_stdout(
            "## main...origin/main [ahead 1, behind 2]",
            " M src/app.py",
            "?? new.py",
        )
        backend.exec = _scripted_exec(
            {
                ("rev-parse", "--is-inside-work-tree"): _exec_result("git rev-parse", stdout="true\n"),
                ("status", "--porcelain=v1", "-b", "-z"): _exec_result("git status", stdout=stdout),
            }
        )
        repo = GitRepo(backend)
        status = await repo.status()

        assert status.branch == "main"
        assert status.ahead == 1
        assert status.behind == 2
        assert [f.path for f in status.files] == ["src/app.py", "new.py"]

    async def test_a_path_with_a_space_survives_the_round_trip_through_status(self, backend) -> None:
        stdout = _status_stdout("## main", " M a file with spaces.py")
        backend.exec = _scripted_exec(
            {
                ("rev-parse", "--is-inside-work-tree"): _exec_result("git rev-parse", stdout="true\n"),
                ("status", "--porcelain=v1", "-b", "-z"): _exec_result("git status", stdout=stdout),
            }
        )
        repo = GitRepo(backend)
        status = await repo.status()

        assert status.files[0].path == "a file with spaces.py"

    async def test_detached_head_reports_no_branch_but_still_lists_files(self, backend) -> None:
        stdout = _status_stdout("## HEAD (no branch)", "?? untracked.py")
        backend.exec = _scripted_exec(
            {
                ("rev-parse", "--is-inside-work-tree"): _exec_result("git rev-parse", stdout="true\n"),
                ("status", "--porcelain=v1", "-b", "-z"): _exec_result("git status", stdout=stdout),
            }
        )
        repo = GitRepo(backend)
        status = await repo.status()

        assert status.branch is None
        assert [f.path for f in status.files] == ["untracked.py"]

    async def test_a_clean_repo_reports_a_branch_and_no_files(self, backend) -> None:
        stdout = _status_stdout("## main...origin/main")
        backend.exec = _scripted_exec(
            {
                ("rev-parse", "--is-inside-work-tree"): _exec_result("git rev-parse", stdout="true\n"),
                ("status", "--porcelain=v1", "-b", "-z"): _exec_result("git status", stdout=stdout),
            }
        )
        repo = GitRepo(backend)
        status = await repo.status()

        assert status.branch == "main"
        assert status.files == ()


# ---------------------------------------------------------------------------------------
# GitRepo.diff — built from diff.py's unified_diff, not by parsing git's own diff output.
# ---------------------------------------------------------------------------------------


class TestDiff:
    async def test_not_a_repo_returns_no_lines(self, backend) -> None:
        backend.exec_result = _exec_result(
            "git rev-parse", stderr="fatal: not a git repository", exit_code=128
        )
        repo = GitRepo(backend)
        assert await repo.diff("src/app.py") == ()

    async def test_diffs_head_against_the_working_copy(self, backend) -> None:
        backend.files["src/app.py"] = "def main():\n    return 2\n"
        backend.exec = _scripted_exec(
            {
                ("rev-parse", "--is-inside-work-tree"): _exec_result("git rev-parse", stdout="true\n"),
                ("show", "HEAD:src/app.py"): _exec_result(
                    "git show", stdout="def main():\n    return 1\n"
                ),
            }
        )
        repo = GitRepo(backend)
        lines = await repo.diff("src/app.py")

        assert any(line.kind is LineKind.REMOVED and "return 1" in line.text for line in lines)
        assert any(line.kind is LineKind.ADDED and "return 2" in line.text for line in lines)

    async def test_a_file_new_to_head_diffs_as_all_additions(self, backend) -> None:
        # `git show HEAD:path` fails for a path that has never been committed — that failure
        # is the correct signal for "there is no old side", not an error to propagate.
        backend.files["new.py"] = "VALUE = 1\n"
        backend.exec = _scripted_exec(
            {
                ("rev-parse", "--is-inside-work-tree"): _exec_result("git rev-parse", stdout="true\n"),
                ("show", "HEAD:new.py"): _exec_result(
                    "git show", stderr="fatal: path 'new.py' does not exist in 'HEAD'", exit_code=128
                ),
            }
        )
        repo = GitRepo(backend)
        lines = await repo.diff("new.py")

        assert all(line.kind is not LineKind.REMOVED for line in lines)
        assert any(line.kind is LineKind.ADDED and "VALUE = 1" in line.text for line in lines)

    async def test_a_file_deleted_from_disk_diffs_as_all_removals(self, backend) -> None:
        del backend.files["src/app.py"]  # deleted on disk, still exists in HEAD per this fake
        backend.exec = _scripted_exec(
            {
                ("rev-parse", "--is-inside-work-tree"): _exec_result("git rev-parse", stdout="true\n"),
                ("show", "HEAD:src/app.py"): _exec_result(
                    "git show", stdout="def main():\n    return 1\n"
                ),
            }
        )
        repo = GitRepo(backend)
        lines = await repo.diff("src/app.py")

        assert any(line.kind is LineKind.REMOVED for line in lines)
        assert all(line.kind is not LineKind.ADDED for line in lines)


# ---------------------------------------------------------------------------------------
# stage / unstage / revert_file — thin wrappers, checked by the exact command shape.
# ---------------------------------------------------------------------------------------


class TestStageUnstageRevert:
    async def test_stage_runs_git_add(self, backend) -> None:
        repo = GitRepo(backend)
        await repo.stage("src/app.py")
        assert backend.called("exec")[-1] == ("git", ("add", "--", "src/app.py"), "")

    async def test_unstage_runs_git_restore_staged(self, backend) -> None:
        repo = GitRepo(backend)
        await repo.unstage("src/app.py")
        assert backend.called("exec")[-1] == (
            "git",
            ("restore", "--staged", "--", "src/app.py"),
            "",
        )

    async def test_revert_file_runs_git_checkout(self, backend) -> None:
        repo = GitRepo(backend)
        await repo.revert_file("src/app.py")
        assert backend.called("exec")[-1] == ("git", ("checkout", "--", "src/app.py"), "")


# ---------------------------------------------------------------------------------------
# commit
# ---------------------------------------------------------------------------------------


class TestCommit:
    async def test_a_successful_commit_returns_gits_own_summary_line(self, backend) -> None:
        backend.exec_result = _exec_result(
            "git commit",
            stdout="[main a1b2c3d] fix the thing\n 1 file changed, 1 insertion(+)\n",
        )
        repo = GitRepo(backend)
        summary = await repo.commit("fix the thing")

        assert summary == "[main a1b2c3d] fix the thing"

    async def test_nothing_staged_raises_a_clear_message_not_a_bare_exit_code(self, backend) -> None:
        backend.exec_result = _exec_result(
            "git commit",
            stdout="On branch main\nnothing to commit, working tree clean\n",
            exit_code=1,
        )
        repo = GitRepo(backend)

        try:
            await repo.commit("nothing to say")
            raised = False
        except AgentError as error:
            raised = True
            assert "nothing" in str(error).lower()
        assert raised

    async def test_no_changes_added_to_commit_is_also_recognised_as_nothing_staged(self, backend) -> None:
        backend.exec_result = _exec_result(
            "git commit",
            stdout='no changes added to commit (use "git add" and/or "git commit -a")\n',
            exit_code=1,
        )
        repo = GitRepo(backend)

        try:
            await repo.commit("still nothing")
            raised = False
        except AgentError:
            raised = True
        assert raised

    async def test_a_different_commit_failure_still_raises_with_the_real_detail(self, backend) -> None:
        backend.exec_result = _exec_result(
            "git commit", stderr="error: gpg failed to sign the data", exit_code=1
        )
        repo = GitRepo(backend)

        try:
            await repo.commit("signed commit")
            raised = False
        except AgentError as error:
            raised = True
            assert "gpg" in str(error).lower()
        assert raised


def test_fake_backend_read_file_and_exec_result_are_used_directly_here() -> None:
    """Sanity check on the two fixtures this file builds on, so a future change to either
    `ExecResult` or `FileContent` breaks loudly here instead of confusingly in a test above.
    """
    result = _exec_result("git status", stdout="x")
    assert result.ok is True
    content = FileContent("a.py", "x", 1, truncated=False)
    assert content.text == "x"
