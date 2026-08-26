"""Pins the text formats this client parses.

`local_*` MCP tools return human-readable text rather than JSON, because their primary
consumer is an IDE showing it to a person. That makes the parsers in `mcp_client` a real
coupling to `formatAgentResult` and friends in `host-bridge/src/mcp/tools.ts`.

Every string below is copied from what that file actually emits. If someone changes the Node
side's wording, these fail loudly — which is the point. Without them a format change would
show up as an empty step list and a UI that quietly claims the model did nothing.
"""

from __future__ import annotations

from local_coder.mcp_client import (
    _parse_agent_result,
    _parse_listing,
    _parse_search,
    _parse_status,
)
from local_coder.protocols import EntryKind, StopReason


class TestAgentResult:
    def test_parses_a_successful_run(self) -> None:
        text = (
            "Local agent (qwen2.5-coder:14b) on the workspace root "
            "— 3 turn(s), 2 tool call(s).\n"
            "\n"
            "Steps:\n"
            "  1. ok   read_file(src/app.py) -> 412 bytes\n"
            "  2. ok   write_file(src/app.py) -> 480 bytes\n"
            "\n"
            "Added the missing return type annotation."
        )

        run = _parse_agent_result("annotate app.py", text)

        assert run.stopped is StopReason.DONE
        assert run.succeeded
        assert run.turns == 3
        assert [step.tool for step in run.steps] == ["read_file", "write_file"]
        assert all(step.ok for step in run.steps)
        assert run.answer == "Added the missing return type annotation."
        assert run.touched_files == ("src/app.py",)

    def test_keeps_steps_when_the_run_failed(self) -> None:
        # The important case: the model wrote a file and then gave up. Those edits are on
        # disk, so hiding the steps behind the failure would leave the user unaware.
        text = (
            "Local agent (qwen2.5-coder:14b) on ide — 8 turn(s), 2 tool call(s).\n"
            "\n"
            "Steps:\n"
            "  1. ok   write_file(a.py) -> 12 bytes\n"
            "  2. FAIL read_file(../../etc/passwd) -> Path escapes the workspace root\n"
            "\n"
            "Stopped (max-turns): The model kept calling tools without finishing an answer.\n"
        )

        run = _parse_agent_result("do a thing", text)

        assert run.stopped is StopReason.MAX_TURNS
        assert not run.succeeded
        assert len(run.steps) == 2
        assert run.steps[1].ok is False
        assert run.error is not None and "kept calling tools" in run.error
        assert run.touched_files == ("a.py",)

    def test_handles_a_run_with_no_tool_calls(self) -> None:
        text = (
            "Local agent (qwen2.5-coder:14b) on the workspace root "
            "— 1 turn(s), 0 tool call(s).\n"
            "\n"
            "A promise represents a value that is not available yet."
        )

        run = _parse_agent_result("explain promises", text)

        assert run.steps == ()
        assert run.turns == 1
        assert run.answer.startswith("A promise represents")


class TestListing:
    def test_parses_the_padded_two_space_columns(self) -> None:
        text = ".:\ndir   src  0\nfile  README.md  128\n"

        entries = _parse_listing(text, "")

        assert [entry.name for entry in entries] == ["src", "README.md"]
        assert entries[0].kind is EntryKind.DIR
        assert entries[1].kind is EntryKind.FILE
        assert entries[1].size == 128

    def test_prefixes_names_with_the_parent_path(self) -> None:
        entries = _parse_listing("src:\nfile  app.py  40\n", "src")

        assert entries[0].path == "src/app.py"

    def test_an_empty_directory_yields_nothing(self) -> None:
        assert _parse_listing("src: (empty directory)", "src") == ()


class TestSearch:
    def test_parses_path_line_text(self) -> None:
        text = "src/app.py:12: def main() -> int:\nsrc/util.py:3: VALUE = 2\n"

        hits = _parse_search(text)

        assert len(hits) == 2
        assert hits[0].path == "src/app.py"
        assert hits[0].line == 12
        assert hits[0].text == "def main() -> int:"

    def test_no_matches_yields_nothing(self) -> None:
        assert _parse_search('No matches for "zzz" under .') == ()


class TestStatus:
    HEALTHY = (
        "Workspace:\n"
        "  configured: yes\n"
        "  root: D:\\AI\\zEXtream-Application-AI\n"
        "  max file bytes: 256000\n"
        "\n"
        "Command execution (run_command):\n"
        "  enabled: yes\n"
        "  allowed commands: git, npm, pnpm, node, python\n"
        "\n"
        "Ollama (http://localhost:11434):\n"
        "  reachable: yes\n"
        "  models (2):\n"
        "    llama3.2:1b  [tools: YES]\n"
        "    qwen2.5-coder:14b  [tools: YES]\n"
        "\n"
        "  local_code_agent can use: llama3.2:1b, qwen2.5-coder:14b\n"
    )

    def test_parses_a_healthy_report(self) -> None:
        status = _parse_status(self.HEALTHY)

        assert status.reachable
        assert status.workspace_configured
        assert status.workspace_root == "D:\\AI\\zEXtream-Application-AI"
        assert status.exec_enabled
        assert "python" in status.allowed_commands
        assert status.models == ("llama3.2:1b", "qwen2.5-coder:14b")
        assert status.tool_capable_models == status.models

    def test_parses_an_unconfigured_report(self) -> None:
        text = (
            "Workspace:\n"
            "  configured: NO\n"
            "  fix: set BRIDGE_WORKSPACE_ROOT to an absolute path in host-bridge/.env, "
            "then restart the MCP server from your IDE.\n"
            "  max file bytes: 256000\n"
            "\n"
            "Command execution (run_command):\n"
            "  enabled: no (set BRIDGE_EXEC_ALLOWLIST in host-bridge/.env to enable)\n"
            "\n"
            "Ollama (http://localhost:11434):\n"
            "  reachable: NO — fetch failed\n"
            "  fix: start Ollama (`ollama serve`), or set OLLAMA_BASE_URL in "
            "host-bridge/.env.\n"
        )

        status = _parse_status(text)

        assert not status.workspace_configured
        assert not status.reachable
        assert not status.exec_enabled
        assert status.workspace_root is None
        # The fix hints mention both env vars; a looser parser would read those as data.
        assert status.allowed_commands == ()
        assert status.models == ()

    def test_separates_tool_capable_models_from_the_rest(self) -> None:
        text = (
            "Ollama (http://localhost:11434):\n"
            "  reachable: yes\n"
            "  models (2):\n"
            "    qwen2.5-coder:14b  [tools: YES]\n"
            "    nomic-embed-text  [tools: no]\n"
        )

        status = _parse_status(text)

        assert status.models == ("qwen2.5-coder:14b", "nomic-embed-text")
        assert status.tool_capable_models == ("qwen2.5-coder:14b",)


class TestAgentUsage:
    """Token counts and the model name, both of which the app shows to the user."""

    REPORT = (
        "Local agent (qwen2.5-coder:14b) on the workspace root "
        "— 3 turn(s), 1 tool call(s).\n"
        "\n"
        "Steps:\n"
        "  1. ok   write_file(a.py) -> 12 bytes\n"
        "\n"
        "Done.\n"
        "\n"
        "Tokens: 3238 in / 1171 out.\n"
    )

    def test_parses_the_token_counts(self) -> None:
        run = _parse_agent_result("write a file", self.REPORT)

        assert run.usage is not None
        assert (run.usage.input_tokens, run.usage.output_tokens) == (3238, 1171)
        assert run.usage.total == 4409

    def test_parses_the_model_that_actually_ran(self) -> None:
        # The caller may not have pinned one, in which case the server chose and this line is
        # the only place that says which.
        run = _parse_agent_result("write a file", self.REPORT)

        assert run.model == "qwen2.5-coder:14b"

    def test_usage_is_none_when_the_server_reported_no_counts(self) -> None:
        # Distinct from zero, which would claim the run was free.
        report = "Local agent (m) on . — 1 turn(s), 0 tool call(s).\n\nHello.\n"

        assert _parse_agent_result("hi", report).usage is None

    def test_the_token_line_does_not_leak_into_the_answer(self) -> None:
        run = _parse_agent_result("write a file", self.REPORT)

        assert "Tokens:" not in run.answer
        assert run.answer == "Done."
