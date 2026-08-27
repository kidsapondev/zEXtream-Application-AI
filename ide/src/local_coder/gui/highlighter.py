"""Syntax highlighting for the desktop editor.

A regex-based `QSyntaxHighlighter` rather than a parser. That is a real limitation and worth
stating rather than discovering: it colours tokens, not structure, so a keyword inside a
string stays a string only because strings are matched first, and nothing here understands
nesting. For an editor whose job is reading a file and applying a model's edit, that is the
right trade — a tree-sitter binding would add a native dependency and a grammar per language
for colouring that is already legible.

The palette deliberately reuses `palette.py` rather than picking new colours: the gutter, the
current-line highlight and the code all sit on the same surface, and a second palette here
would make the editor look like a different application from the frame around it.
"""

from __future__ import annotations

import re
from dataclasses import dataclass

from PySide6.QtCore import QRegularExpression
from PySide6.QtGui import QColor, QFont, QSyntaxHighlighter, QTextCharFormat, QTextDocument

from . import palette as p

_KEYWORD = "#E08B4F"
_STRING = "#9BC98C"
_NUMBER = "#D9A05B"
_COMMENT = p.TEXT_MUTED
_TYPE = "#8FB8E8"
_FUNCTION = "#55C2B7"

#: Per-language keyword sets. Only the languages this workspace actually holds — an
#: exhaustive table would be mostly untested and mostly unused.
_KEYWORDS: dict[str, tuple[str, ...]] = {
    "python": (
        "and as assert async await break class continue def del elif else except finally "
        "for from global if import in is lambda nonlocal not or pass raise return try while "
        "with yield True False None self"
    ).split(),
    "typescript": (
        "abstract as async await break case catch class const continue declare default "
        "delete do else enum export extends false finally for from function if implements "
        "import in instanceof interface let new null private protected public readonly "
        "return static super switch this throw true try type typeof undefined var void "
        "while yield"
    ).split(),
    "javascript": (
        "async await break case catch class const continue default delete do else export "
        "extends false finally for from function if import in instanceof let new null "
        "return static super switch this throw true try typeof undefined var void while yield"
    ).split(),
    "json": ("true", "false", "null"),
    "yaml": ("true", "false", "null"),
    "sql": (
        "select from where insert update delete create table alter drop join left right "
        "inner outer on group by order having limit offset values set and or not null"
    ).split(),
}

#: Line-comment markers per language, mirroring `editor_commands.comment_prefix`. Kept as a
#: separate table on purpose: that one drives an editing command and this one drives
#: colouring, and a language can plausibly gain one without the other.
_LINE_COMMENT = {
    "python": "#",
    "yaml": "#",
    "toml": "#",
    "shell": "#",
    "typescript": "//",
    "javascript": "//",
    "css": "//",
    "scss": "//",
    "php": "//",
    "sql": "--",
}


@dataclass(frozen=True, slots=True)
class Rule:
    pattern: QRegularExpression
    format: QTextCharFormat


def _format(colour: str, *, bold: bool = False, italic: bool = False) -> QTextCharFormat:
    fmt = QTextCharFormat()
    fmt.setForeground(QColor(colour))
    if bold:
        fmt.setFontWeight(QFont.Weight.DemiBold)
    fmt.setFontItalic(italic)
    return fmt


def build_rules(language: str) -> list[Rule]:
    """Highlighting rules for `language`, in the order they must be applied.

    Order is load-bearing. Strings and comments come **last** so they overwrite anything
    matched inside them — a keyword in a comment, a number in a string. Reversing this is the
    classic way to end up with `# TODO: return None` painted like code.
    """
    rules: list[Rule] = []

    for word in _KEYWORDS.get(language, ()):
        rules.append(
            Rule(QRegularExpression(rf"\b{re.escape(word)}\b"), _format(_KEYWORD, bold=True))
        )

    # Type-ish names: an initial capital. Crude, and deliberately so — it catches classes and
    # types across every language here without a symbol table, and its failure mode is a
    # capitalised constant looking like a type, which is harmless.
    rules.append(Rule(QRegularExpression(r"\b[A-Z][A-Za-z0-9_]*\b"), _format(_TYPE)))

    # A name immediately followed by an opening parenthesis is a call or a definition.
    rules.append(
        Rule(QRegularExpression(r"\b[A-Za-z_][A-Za-z0-9_]*(?=\s*\()"), _format(_FUNCTION))
    )

    rules.append(Rule(QRegularExpression(r"\b\d+(\.\d+)?\b"), _format(_NUMBER)))

    rules.append(Rule(QRegularExpression(r'"[^"\\]*(\\.[^"\\]*)*"'), _format(_STRING)))
    rules.append(Rule(QRegularExpression(r"'[^'\\]*(\\.[^'\\]*)*'"), _format(_STRING)))

    marker = _LINE_COMMENT.get(language)
    if marker:
        rules.append(
            Rule(QRegularExpression(rf"{re.escape(marker)}[^\n]*"), _format(_COMMENT, italic=True))
        )

    return rules


class Highlighter(QSyntaxHighlighter):
    """Applies `build_rules` to a document, re-buildable when the language changes."""

    def __init__(self, document: QTextDocument, language: str = "text") -> None:
        super().__init__(document)
        self._rules = build_rules(language)

    def set_language(self, language: str) -> None:
        self._rules = build_rules(language)
        # Qt does not repaint on its own when the rules change out from under it, so an
        # unhighlighted document is the symptom of forgetting this line.
        self.rehighlight()

    def highlightBlock(self, text: str) -> None:  # noqa: N802 - Qt's name
        for rule in self._rules:
            iterator = rule.pattern.globalMatch(text)
            while iterator.hasNext():
                match = iterator.next()
                self.setFormat(match.capturedStart(), match.capturedLength(), rule.format)
