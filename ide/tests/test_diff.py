"""Specification for `local_coder.diff`.

Written before the module exists. `diff.py` is the first module handed to the locally-hosted
model, and this file is the whole brief: the names it must define, the shapes it must return,
and the edge cases it must survive. A delegated task is only as good as the test waiting for
it — without one, a small model produces something plausible that nobody can check.
"""

from __future__ import annotations

from local_coder.diff import DiffLine, LineKind, summarize, unified_diff

BEFORE = "one\ntwo\nthree\n"
AFTER = "one\nTWO\nthree\nfour\n"


class TestUnifiedDiff:
    def test_identical_text_produces_no_lines(self) -> None:
        assert unified_diff(BEFORE, BEFORE) == ()

    def test_marks_added_and_removed_lines(self) -> None:
        lines = unified_diff(BEFORE, AFTER)

        removed = [line.text for line in lines if line.kind is LineKind.REMOVED]
        added = [line.text for line in lines if line.kind is LineKind.ADDED]

        assert removed == ["two"]
        assert added == ["TWO", "four"]

    def test_keeps_unchanged_lines_as_context(self) -> None:
        context = [
            line.text for line in unified_diff(BEFORE, AFTER) if line.kind is LineKind.CONTEXT
        ]

        assert "one" in context
        assert "three" in context

    def test_line_text_carries_no_diff_marker(self) -> None:
        # The marker belongs to `kind`. A renderer that also has to strip a leading "+"
        # from the text will eventually strip a real one off a line of code.
        #
        # Header lines are exempt: their text *is* the raw "@@ ... @@" hunk marker, which is
        # what `test_includes_a_hunk_header` requires. An earlier version of this test
        # asserted over every line including headers, which made the two tests jointly
        # impossible to satisfy — worth remembering, because the model given this file as
        # its brief spent its whole turn budget failing to square that circle.
        for line in unified_diff(BEFORE, AFTER):
            if line.kind is LineKind.HEADER:
                continue
            assert not line.text.startswith(("+", "-"))

    def test_numbers_lines_against_the_correct_side(self) -> None:
        lines = [
            line
            for line in unified_diff(BEFORE, AFTER)
            if line.kind is not LineKind.HEADER
        ]

        for line in lines:
            if line.kind is LineKind.ADDED:
                assert line.old_line is None
                assert line.new_line is not None
            elif line.kind is LineKind.REMOVED:
                assert line.new_line is None
                assert line.old_line is not None
            else:
                assert line.old_line is not None and line.new_line is not None

        first_context = next(line for line in lines if line.kind is LineKind.CONTEXT)
        assert first_context.old_line == 1
        assert first_context.new_line == 1

    def test_includes_a_hunk_header(self) -> None:
        headers = [
            line for line in unified_diff(BEFORE, AFTER) if line.kind is LineKind.HEADER
        ]

        assert len(headers) == 1
        assert headers[0].text.startswith("@@")

    def test_context_argument_limits_surrounding_lines(self) -> None:
        before = "\n".join(str(n) for n in range(1, 21)) + "\n"
        after = before.replace("10", "TEN")

        tight = unified_diff(before, after, context=1)
        wide = unified_diff(before, after, context=5)

        tight_context = sum(1 for line in tight if line.kind is LineKind.CONTEXT)
        wide_context = sum(1 for line in wide if line.kind is LineKind.CONTEXT)
        assert tight_context < wide_context

    def test_handles_text_with_no_trailing_newline(self) -> None:
        # Files written by a model routinely lack a final newline; this must not add a
        # phantom empty line to the diff.
        lines = unified_diff("a\nb", "a\nc")

        assert [line.text for line in lines if line.kind is LineKind.ADDED] == ["c"]
        assert [line.text for line in lines if line.kind is LineKind.REMOVED] == ["b"]

    def test_handles_an_empty_before(self) -> None:
        lines = unified_diff("", "hello\n")

        assert [line.text for line in lines if line.kind is LineKind.ADDED] == ["hello"]

    def test_handles_an_empty_after(self) -> None:
        lines = unified_diff("hello\n", "")

        assert [line.text for line in lines if line.kind is LineKind.REMOVED] == ["hello"]

    def test_path_appears_in_the_file_headers_when_given(self) -> None:
        rendered = "\n".join(line.text for line in unified_diff(BEFORE, AFTER, path="a.py"))

        assert "a.py" in rendered

    def test_lines_are_immutable(self) -> None:
        line = unified_diff(BEFORE, AFTER)[0]

        assert isinstance(line, DiffLine)
        try:
            line.text = "mutated"  # type: ignore[misc]
        except (AttributeError, TypeError):
            return
        raise AssertionError("DiffLine must be frozen")


class TestSummarize:
    def test_counts_added_and_removed(self) -> None:
        added, removed = summarize(unified_diff(BEFORE, AFTER))

        assert (added, removed) == (2, 1)

    def test_counts_nothing_for_an_empty_diff(self) -> None:
        assert summarize(()) == (0, 0)
