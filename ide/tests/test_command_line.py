"""Command parsing, with no shell on the other side.

Pure functions, so these pin the behaviour that matters — quotes, and the operators that must
be refused rather than approximated — without a terminal or a subprocess.
"""

from __future__ import annotations

import pytest

from local_coder.command_line import (
    CommandHistory,
    contains_shell_syntax,
    parse_command_line,
)


class TestParse:
    def test_splits_a_plain_command(self) -> None:
        parsed = parse_command_line("git status")

        assert parsed is not None
        assert parsed.command == "git"
        assert parsed.args == ("status",)

    def test_keeps_a_double_quoted_argument_whole(self) -> None:
        # The case a naive split gets wrong on the most ordinary command anyone types.
        parsed = parse_command_line('git commit -m "two words"')

        assert parsed is not None
        assert parsed.args == ("commit", "-m", "two words")

    def test_keeps_a_single_quoted_argument_whole(self) -> None:
        parsed = parse_command_line("python -c 'print(1)'")

        assert parsed is not None
        assert parsed.args == ("-c", "print(1)")

    def test_an_empty_quoted_string_is_an_argument(self) -> None:
        parsed = parse_command_line('git commit -m ""')

        assert parsed is not None
        assert parsed.args == ("commit", "-m", "")

    def test_backslash_escapes_the_next_character(self) -> None:
        parsed = parse_command_line("echo a" + "\\" + " b")

        assert parsed is not None
        assert parsed.args == ("a b",)

    def test_collapses_runs_of_whitespace(self) -> None:
        parsed = parse_command_line("  npm   run    build  ")

        assert parsed is not None
        assert parsed.command == "npm"
        assert parsed.args == ("run", "build")

    def test_a_blank_line_is_none(self) -> None:
        assert parse_command_line("") is None
        assert parse_command_line("   ") is None

    def test_display_round_trips_the_command(self) -> None:
        parsed = parse_command_line("python -m pytest -q")

        assert parsed is not None
        assert parsed.display == "python -m pytest -q"


class TestShellSyntax:
    @pytest.mark.parametrize("line", ["a | b", "a && b", "a > out", "a; b", "echo $HOME", "a `b`"])
    def test_detects_operators(self, line: str) -> None:
        assert contains_shell_syntax(line) is True

    def test_leaves_ordinary_commands_alone(self) -> None:
        assert contains_shell_syntax("git status") is False
        assert contains_shell_syntax("python -m pytest -q") is False

    def test_is_checked_before_parsing_hides_the_operator(self) -> None:
        # Once parsed, `|` is an ordinary argument and looks innocent — which is how
        # "npm test | grep fail" would run as npm with three arguments and appear to work.
        line = "npm test | grep fail"

        assert contains_shell_syntax(line) is True
        parsed = parse_command_line(line)
        assert parsed is not None and parsed.command == "npm"


class TestHistory:
    def test_walks_backwards(self) -> None:
        history = CommandHistory()
        history.add("git status")
        history.add("npm test")

        assert history.previous() == "npm test"
        assert history.previous() == "git status"
        assert history.previous() is None

    def test_walks_forwards_and_ends_blank(self) -> None:
        history = CommandHistory()
        history.add("a")
        history.add("b")
        history.previous()
        history.previous()

        assert history.next() == "b"
        assert history.next() == ""

    def test_ignores_an_immediate_repeat_but_keeps_alternation(self) -> None:
        history = CommandHistory()
        for line in ("npm test", "npm test", "git status", "npm test"):
            history.add(line)

        assert history.items == ("npm test", "git status", "npm test")

    def test_ignores_blank_submissions(self) -> None:
        history = CommandHistory()
        history.add("   ")

        assert history.items == ()

    def test_drops_the_oldest_past_the_limit(self) -> None:
        history = CommandHistory(limit=2)
        for line in ("one", "two", "three"):
            history.add(line)

        assert history.items == ("two", "three")

    def test_every_submission_resets_the_browse_position(self) -> None:
        history = CommandHistory()
        history.add("one")
        history.previous()
        history.add("two")

        assert history.previous() == "two"
