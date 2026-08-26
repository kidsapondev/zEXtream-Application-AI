"""Specification for `local_coder.runner`.

Two things are pinned here. `Runner.discover()` must find only what this workspace can
actually run — nothing recursive, nothing off the allowlist — and `Runner.run()` must turn
whatever a test runner printed into a `passed`/`failed` count without ever raising on a
failing or timed-out command; a run panel exists specifically to show that outcome, and an
exception here would take the panel down instead.

Everything runs against `FakeBackend`. Discovery is driven by the files handed to its
constructor; execution is driven by setting `backend.exec_result` to the `ExecResult` a real
command would have produced, which is the mechanism `FakeBackend.exec` was built for (see
`conftest.py`).
"""

from __future__ import annotations

from local_coder.protocols import ExecResult, ModelStatus
from local_coder.runner import RunConfig, Runner

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


class TestDiscoverPytest:
    async def test_a_root_level_pyproject_toml_offers_pytest(self) -> None:
        backend = make_backend({"pyproject.toml": "[tool.pytest.ini_options]\n"})
        runner = Runner(backend)

        configs = await runner.discover()

        assert configs == (
            RunConfig(name="pytest", command="python", args=("-m", "pytest", "-q"), cwd=""),
        )

    async def test_a_pyproject_toml_in_a_subdirectory_scopes_the_cwd(self) -> None:
        backend = make_backend(
            {
                "backend/pyproject.toml": "[tool.pytest.ini_options]\n",
                "backend/src/main.py": "x = 1\n",
            }
        )
        runner = Runner(backend)

        configs = await runner.discover()

        assert len(configs) == 1
        assert configs[0].command == "python"
        assert configs[0].cwd == "backend"
        assert "backend" in configs[0].name

    async def test_a_pyproject_toml_two_levels_down_is_not_found(self) -> None:
        # Discovery is documented to search only the root and its immediate subdirectories —
        # a recursive walk over a real checkout is a round trip per directory and would stall
        # the run panel before it can show a single button.
        backend = make_backend({"a/b/pyproject.toml": "[tool.pytest.ini_options]\n"})
        runner = Runner(backend)

        configs = await runner.discover()

        assert configs == ()


class TestDiscoverNpm:
    async def test_offers_one_config_per_script(self) -> None:
        backend = make_backend(
            {
                "package.json": (
                    '{"scripts": {"test": "jest", "build": "tsc", "lint": "eslint ."}}'
                )
            }
        )
        runner = Runner(backend)

        configs = await runner.discover()

        names = [c.name for c in configs]
        assert names == ["npm run build", "npm run lint", "npm run test"]
        assert all(c.command == "npm" for c in configs)
        assert [c.args for c in configs] == [
            ("run", "build"),
            ("run", "lint"),
            ("run", "test"),
        ]

    async def test_a_package_json_with_no_scripts_offers_nothing(self) -> None:
        backend = make_backend({"package.json": "{}"})
        runner = Runner(backend)

        assert await runner.discover() == ()

    async def test_malformed_json_is_skipped_rather_than_raised(self) -> None:
        backend = make_backend(
            {
                "package.json": "not json",
                "pyproject.toml": "[tool.pytest.ini_options]\n",
            }
        )
        runner = Runner(backend)

        configs = await runner.discover()

        # The broken manifest costs nothing else discoverable in the same directory.
        assert [c.command for c in configs] == ["python"]


class TestDiscoverNeither:
    async def test_a_workspace_with_neither_file_offers_nothing(self, backend) -> None:
        runner = Runner(backend)

        assert await runner.discover() == ()


class TestDiscoverAllowlist:
    async def test_a_command_missing_from_the_allowlist_is_skipped(self) -> None:
        backend = make_backend(
            {"pyproject.toml": "[tool.pytest.ini_options]\n", "package.json": '{"scripts": {"test": "jest"}}'},
            allowed=("git",),  # neither python nor npm
        )
        runner = Runner(backend)

        assert await runner.discover() == ()

    async def test_only_the_allowlisted_half_is_offered(self) -> None:
        backend = make_backend(
            {"pyproject.toml": "[tool.pytest.ini_options]\n", "package.json": '{"scripts": {"test": "jest"}}'},
            allowed=("python",),  # pytest only, no npm
        )
        runner = Runner(backend)

        configs = await runner.discover()

        assert [c.command for c in configs] == ["python"]


class TestDiscoverOrdering:
    async def test_results_are_sorted_by_name(self) -> None:
        backend = make_backend(
            {
                "pyproject.toml": "[tool.pytest.ini_options]\n",
                "package.json": '{"scripts": {"build": "tsc"}}',
            }
        )
        runner = Runner(backend)

        configs = await runner.discover()

        assert [c.name for c in configs] == sorted(c.name for c in configs)


class TestParsingPytest:
    """The three shapes pytest -q actually prints as its final summary line."""

    async def test_all_passed(self) -> None:
        backend = make_backend({})
        backend.exec_result = ExecResult(
            command="python -m pytest -q", exit_code=0, stdout="14 passed in 0.02s", stderr="", timed_out=False
        )
        runner = Runner(backend)
        config = RunConfig("pytest", "python", ("-m", "pytest", "-q"))

        outcome = await runner.run(config)

        assert outcome.passed == 14
        assert outcome.failed == 0
        assert outcome.ok is True

    async def test_mixed_pass_and_fail(self) -> None:
        backend = make_backend({})
        backend.exec_result = ExecResult(
            command="python -m pytest -q",
            exit_code=1,
            stdout="3 failed, 11 passed in 1.2s",
            stderr="",
            timed_out=False,
        )
        runner = Runner(backend)
        config = RunConfig("pytest", "python", ("-m", "pytest", "-q"))

        outcome = await runner.run(config)

        assert outcome.passed == 11
        assert outcome.failed == 3
        assert outcome.ok is False

    async def test_no_tests_collected(self) -> None:
        backend = make_backend({})
        backend.exec_result = ExecResult(
            command="python -m pytest -q", exit_code=5, stdout="no tests ran in 0.00s", stderr="", timed_out=False
        )
        runner = Runner(backend)
        config = RunConfig("pytest", "python", ("-m", "pytest", "-q"))

        outcome = await runner.run(config)

        # Recognised as a real (if empty) pytest summary, not as unparseable output.
        assert outcome.passed == 0
        assert outcome.failed == 0


class TestParsingJest:
    async def test_jest_summary_line(self) -> None:
        backend = make_backend({})
        backend.exec_result = ExecResult(
            command="npm run test",
            exit_code=0,
            stdout="Tests:       128 passed, 128 total",
            stderr="",
            timed_out=False,
        )
        runner = Runner(backend)
        config = RunConfig("npm run test", "npm", ("run", "test"))

        outcome = await runner.run(config)

        assert outcome.passed == 128
        assert outcome.failed == 0
        assert outcome.ok is True

    async def test_jest_with_failures(self) -> None:
        backend = make_backend({})
        backend.exec_result = ExecResult(
            command="npm run test",
            exit_code=1,
            stdout="Tests:       2 failed, 126 passed, 128 total",
            stderr="",
            timed_out=False,
        )
        runner = Runner(backend)
        config = RunConfig("npm run test", "npm", ("run", "test"))

        outcome = await runner.run(config)

        assert outcome.passed == 126
        assert outcome.failed == 2
        assert outcome.ok is False


class TestParsingUnrecognised:
    async def test_output_with_no_recognisable_summary_gives_none_not_zero(self) -> None:
        backend = make_backend({})
        backend.exec_result = ExecResult(
            command="npm run build", exit_code=0, stdout="webpack compiled successfully", stderr="", timed_out=False
        )
        runner = Runner(backend)
        config = RunConfig("npm run build", "npm", ("run", "build"))

        outcome = await runner.run(config)

        assert outcome.passed is None
        assert outcome.failed is None
        # None is meaningfully different from a clean 0/0 pass, but the process itself still
        # exited cleanly, so the verdict falls back to that.
        assert outcome.ok is True


class TestExecutionOutcomes:
    async def test_a_non_zero_exit_is_reported_as_failed_not_raised(self) -> None:
        backend = make_backend({})
        backend.exec_result = ExecResult(
            command="npm run build", exit_code=2, stdout="", stderr="fatal error", timed_out=False
        )
        runner = Runner(backend)
        config = RunConfig("npm run build", "npm", ("run", "build"))

        outcome = await runner.run(config)

        assert outcome.ok is False
        assert outcome.result.exit_code == 2

    async def test_a_timed_out_run_is_reported_as_failed_not_raised(self) -> None:
        backend = make_backend({})
        backend.exec_result = ExecResult(
            command="python -m pytest -q", exit_code=None, stdout="", stderr="", timed_out=True
        )
        runner = Runner(backend)
        config = RunConfig("pytest", "python", ("-m", "pytest", "-q"))

        outcome = await runner.run(config)

        assert outcome.ok is False
        assert outcome.result.timed_out is True


class TestHistory:
    async def test_history_is_newest_first(self) -> None:
        backend = make_backend({})
        runner = Runner(backend)
        config = RunConfig("pytest", "python", ("-m", "pytest", "-q"))

        backend.exec_result = ExecResult("python -m pytest -q", 0, "1 passed in 0.01s", "", False)
        first = await runner.run(config)
        backend.exec_result = ExecResult("python -m pytest -q", 0, "2 passed in 0.01s", "", False)
        second = await runner.run(config)

        assert runner.history() == (second, first)

    async def test_history_starts_empty(self) -> None:
        runner = Runner(make_backend({}))
        assert runner.history() == ()
