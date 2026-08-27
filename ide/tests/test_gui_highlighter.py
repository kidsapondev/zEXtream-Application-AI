"""Highlighting rules, tested as data rather than through a painted widget.

`build_rules` returns plain objects, so the ordering guarantee — the one thing about this
module that is easy to get wrong and invisible when wrong — can be asserted without a display.
"""

from __future__ import annotations

import pytest

pytest.importorskip("PySide6", reason="the desktop UI is optional; skip when Qt is absent")

from local_coder.gui.highlighter import build_rules  # noqa: E402


def _matches(rules, text: str) -> list[tuple[int, int]]:
    """Every span the last rule that matches claims, i.e. what would win on screen."""
    spans: dict[tuple[int, int], int] = {}
    for index, rule in enumerate(rules):
        iterator = rule.pattern.globalMatch(text)
        while iterator.hasNext():
            match = iterator.next()
            spans[(match.capturedStart(), match.capturedLength())] = index
    return [span for span, _ in sorted(spans.items())]


class TestRuleOrder:
    def test_strings_and_comments_come_after_everything_else(self) -> None:
        """The ordering guarantee, stated as a test.

        Strings and comments must be applied last so they overwrite anything matched inside
        them. Reversing this is the classic way to end up with `# TODO: return None` painted
        like code.
        """
        rules = build_rules("python")
        # The last rules are the two string patterns and the comment pattern.
        tail = [rule.pattern.pattern() for rule in rules[-3:]]

        assert any(pattern.startswith('"') for pattern in tail)
        assert any(pattern.startswith("'") for pattern in tail)
        assert any("#" in pattern for pattern in tail)

    def test_a_keyword_inside_a_comment_is_reached_by_the_comment_rule(self) -> None:
        rules = build_rules("python")
        text = "# return None"

        comment_rule = rules[-1]
        iterator = comment_rule.pattern.globalMatch(text)

        assert iterator.hasNext()
        match = iterator.next()
        assert match.capturedStart() == 0
        assert match.capturedLength() == len(text)


class TestLanguages:
    def test_python_keywords_are_matched(self) -> None:
        rules = build_rules("python")
        patterns = [rule.pattern.pattern() for rule in rules]

        assert r"\bdef\b" in patterns
        assert r"\bimport\b" in patterns

    def test_typescript_gets_its_own_keywords(self) -> None:
        patterns = [rule.pattern.pattern() for rule in build_rules("typescript")]

        assert r"\binterface\b" in patterns
        assert r"\bdef\b" not in patterns

    def test_an_unknown_language_still_gets_the_generic_rules(self) -> None:
        # Numbers, quoted strings and capitalised names are language-agnostic, so an unknown
        # file is dimly highlighted rather than flat.
        rules = build_rules("klingon")

        assert rules
        assert _matches(rules, 'x = "hello"')

    def test_a_language_with_no_line_comment_gets_no_comment_rule(self) -> None:
        # JSON has no comments; inventing one would colour a legitimate `//` inside a URL.
        patterns = [rule.pattern.pattern() for rule in build_rules("json")]

        assert not any(pattern.startswith("//") for pattern in patterns)

    def test_sql_uses_a_double_dash_comment(self) -> None:
        patterns = [rule.pattern.pattern() for rule in build_rules("sql")]

        assert any(pattern.count("-") >= 2 for pattern in patterns)
