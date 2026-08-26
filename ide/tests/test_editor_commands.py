"""Line-level editing operations.

Pure functions, so these run without a terminal and pin the exact off-by-one behaviour that
is invisible in review and obvious the first time someone uses the feature.
"""

from __future__ import annotations

import pytest

from local_coder.editor_commands import (
    comment_prefix,
    dedent_lines,
    duplicate_lines,
    indent_lines,
    move_lines,
    strip_trailing_whitespace,
    toggle_comment,
)

PY = "a.py"
CODE = "one\ntwo\nthree\nfour\n"


class TestCommentPrefix:
    @pytest.mark.parametrize(
        ("path", "expected"),
        [("a.py", "#"), ("a.ts", "//"), ("a.sql", "--"), ("a.yaml", "#")],
    )
    def test_known_languages(self, path: str, expected: str) -> None:
        assert comment_prefix(path) == expected

    def test_unknown_language_has_none(self) -> None:
        # Toggling in a language we do not know would produce broken code; doing nothing is
        # the correct answer, not a guess.
        assert comment_prefix("a.xyz") is None
        assert comment_prefix("Makefile") is None


class TestToggleComment:
    def test_comments_a_single_line(self) -> None:
        assert toggle_comment(CODE, 1, 1, PY) == "one\n# two\nthree\nfour\n"

    def test_uncomments_when_every_line_is_commented(self) -> None:
        commented = "# one\n# two\nthree\n"

        assert toggle_comment(commented, 0, 1, PY) == "one\ntwo\nthree\n"

    def test_comments_when_only_some_lines_are_commented(self) -> None:
        # A mixed selection is far more often a half-finished comment-out than a request to
        # invert each line.
        mixed = "# one\ntwo\n"

        assert toggle_comment(mixed, 0, 1, PY) == "# # one\n# two\n"

    def test_marker_is_indented_to_the_shallowest_line(self) -> None:
        code = "def f():\n    a = 1\n    b = 2\n"

        assert toggle_comment(code, 1, 2, PY) == "def f():\n    # a = 1\n    # b = 2\n"

    def test_blank_lines_are_left_alone(self) -> None:
        code = "one\n\ntwo\n"

        assert toggle_comment(code, 0, 2, PY) == "# one\n\n# two\n"

    def test_uncomment_removes_only_one_space(self) -> None:
        commented = "#     deliberately indented\n"

        assert toggle_comment(commented, 0, 0, PY) == "    deliberately indented\n"

    def test_unknown_language_is_a_no_op(self) -> None:
        assert toggle_comment(CODE, 0, 1, "a.xyz") == CODE

    def test_uses_the_right_marker_per_language(self) -> None:
        assert toggle_comment("x = 1\n", 0, 0, "a.ts") == "// x = 1\n"

    def test_a_selection_of_only_blank_lines_is_a_no_op(self) -> None:
        assert toggle_comment("\n\n", 0, 1, PY) == "\n\n"


class TestDuplicate:
    def test_duplicates_one_line_below_itself(self) -> None:
        text, cursor = duplicate_lines(CODE, 1, 1)

        assert text == "one\ntwo\ntwo\nthree\nfour\n"
        # The cursor lands in the copy, so typing continues there rather than in the original.
        assert cursor == 2

    def test_duplicates_a_range(self) -> None:
        text, cursor = duplicate_lines(CODE, 0, 1)

        assert text == "one\ntwo\none\ntwo\nthree\nfour\n"
        assert cursor == 2

    def test_duplicating_the_last_line_works(self) -> None:
        text, _ = duplicate_lines(CODE, 3, 3)

        assert text == "one\ntwo\nthree\nfour\nfour\n"

    def test_a_file_with_no_trailing_newline_keeps_none(self) -> None:
        # Round-tripping through splitlines/join silently adds one otherwise, which shows up
        # as a spurious diff in every file the user touches.
        text, _ = duplicate_lines("a\nb", 0, 0)

        assert text == "a\na\nb"


class TestMove:
    def test_moves_a_line_down(self) -> None:
        text, start, end = move_lines(CODE, 0, 0, 1)

        assert text == "two\none\nthree\nfour\n"
        assert (start, end) == (1, 1)

    def test_moves_a_line_up(self) -> None:
        text, start, end = move_lines(CODE, 2, 2, -1)

        assert text == "one\nthree\ntwo\nfour\n"
        assert (start, end) == (1, 1)

    def test_moves_a_range(self) -> None:
        text, start, end = move_lines(CODE, 0, 1, 1)

        assert text == "three\none\ntwo\nfour\n"
        assert (start, end) == (1, 2)

    def test_moving_past_the_top_is_a_no_op(self) -> None:
        # Silently moving one line when two were asked for is harder to notice than nothing.
        assert move_lines(CODE, 0, 0, -1) == (CODE, 0, 0)

    def test_moving_past_the_bottom_is_a_no_op(self) -> None:
        assert move_lines(CODE, 3, 3, 1) == (CODE, 3, 3)

    def test_zero_delta_is_a_no_op(self) -> None:
        assert move_lines(CODE, 1, 1, 0) == (CODE, 1, 1)


class TestIndent:
    def test_indents_a_range(self) -> None:
        assert indent_lines("a\nb\n", 0, 1) == "    a\n    b\n"

    def test_skips_blank_lines(self) -> None:
        assert indent_lines("a\n\nb\n", 0, 2) == "    a\n\n    b\n"

    def test_dedents_a_full_level(self) -> None:
        assert dedent_lines("    a\n    b\n", 0, 1) == "a\nb\n"

    def test_dedents_partially_indented_lines_by_what_they_have(self) -> None:
        # Otherwise a dedent through mixed indentation leaves the block ragged.
        assert dedent_lines("  a\n      b\n", 0, 1) == "a\n    b\n"

    def test_dedenting_unindented_text_is_a_no_op(self) -> None:
        assert dedent_lines("a\nb\n", 0, 1) == "a\nb\n"


class TestBackwardsSelection:
    def test_every_operation_orders_the_range(self) -> None:
        # A selection dragged upwards arrives with start > end; without ordering these would
        # operate on an empty slice and look like "the command did nothing".
        assert toggle_comment(CODE, 1, 0, PY) == "# one\n# two\nthree\nfour\n"
        assert duplicate_lines(CODE, 1, 0)[0] == "one\ntwo\none\ntwo\nthree\nfour\n"
        assert move_lines(CODE, 2, 1, 1)[0] == "one\nfour\ntwo\nthree\n"


class TestStripTrailingWhitespace:
    def test_trims_every_line(self) -> None:
        assert strip_trailing_whitespace("a   \nb\t\n") == "a\nb\n"

    def test_leaves_the_final_newline_alone(self) -> None:
        assert strip_trailing_whitespace("a\n") == "a\n"
        assert strip_trailing_whitespace("a") == "a"
