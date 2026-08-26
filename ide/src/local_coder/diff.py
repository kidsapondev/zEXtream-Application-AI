"""Unified diff, in a shape a terminal UI can render line by line.

Wraps `difflib.unified_diff` rather than reimplementing the algorithm — the interesting part
here is not producing the diff but attaching a *side* and a *line number* to each row, which
`difflib` gives only as text and which a widget needs as data in order to draw a gutter.

Line numbers come from the hunk header, counted forward. That is worth stating explicitly
because the obvious-looking alternative — reading numbers out of each line — is wrong and
silently so: a diff line's content is source code, not a number.
"""

from __future__ import annotations

import difflib
import re
from dataclasses import dataclass
from enum import Enum
from typing import Iterable

# `@@ -1,3 +1,4 @@`, and also `@@ -0,0 +1 @@` — the counts are omitted when a side has
# exactly one line, and are `0,0` when a side is empty, so both parts have to be optional.
_HUNK_RE = re.compile(r"^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@")


class LineKind(str, Enum):
    """Values are the conventional diff markers.

    Inherits from `str` so a widget can use the value directly as the gutter glyph without
    a lookup table, while still comparing by identity in the code below.
    """

    CONTEXT = " "
    ADDED = "+"
    REMOVED = "-"
    HEADER = "@"


@dataclass(frozen=True, slots=True)
class DiffLine:
    """One row of a rendered diff.

    `text` never carries the leading diff marker — that information lives in `kind`. Keeping
    the marker in the text would mean every renderer has to strip it, and one of them would
    eventually strip a real leading `-` off a line of code.

    `old_line` and `new_line` are `None` on the side a row does not exist on: an added row
    has no position in the old file, a removed row has none in the new one, and a header has
    neither. That is what lets a gutter render blanks correctly instead of guessing.
    """

    kind: LineKind
    text: str
    old_line: int | None = None
    new_line: int | None = None


def unified_diff(
    before: str,
    after: str,
    *,
    path: str = "",
    context: int = 3,
) -> tuple[DiffLine, ...]:
    """Diffs two whole-file strings.

    Returns an empty tuple when nothing changed, so a caller can test the result for
    truthiness instead of comparing the inputs again.
    """
    if before == after:
        return ()

    # splitlines() rather than split("\n"): a file with no trailing newline would otherwise
    # gain a phantom empty final line, which then shows up as a spurious change. Files
    # written by a model routinely lack that newline, so this is the common case, not an
    # edge case.
    before_lines = before.splitlines()
    after_lines = after.splitlines()

    raw = difflib.unified_diff(
        before_lines,
        after_lines,
        fromfile=path,
        tofile=path,
        lineterm="",
        n=context,
    )

    lines: list[DiffLine] = []
    old_no = 0
    new_no = 0

    for entry in raw:
        # The `--- file` / `+++ file` preamble is dropped rather than emitted as two more
        # rows: it duplicates information the hunk header already carries (see below), and
        # leaving it in would make those two rows indistinguishable from a removed and an
        # added line of source that happened to start with a dash or a plus.
        if entry.startswith("---") or entry.startswith("+++"):
            continue

        match = _HUNK_RE.match(entry)
        if match:
            old_no = int(match.group(1))
            new_no = int(match.group(2))
            # The path is appended to the hunk header, git-style, so it survives dropping
            # the preamble above and a caller rendering only these rows still knows which
            # file it is looking at.
            text = f"{entry} {path}" if path else entry
            lines.append(DiffLine(LineKind.HEADER, text))
            continue

        marker, body = entry[:1], entry[1:]
        if marker == "+":
            lines.append(DiffLine(LineKind.ADDED, body, None, new_no))
            new_no += 1
        elif marker == "-":
            lines.append(DiffLine(LineKind.REMOVED, body, old_no, None))
            old_no += 1
        else:
            lines.append(DiffLine(LineKind.CONTEXT, body, old_no, new_no))
            old_no += 1
            new_no += 1

    return tuple(lines)


def summarize(lines: Iterable[DiffLine]) -> tuple[int, int]:
    """Counts `(added, removed)` — the `+N -M` a UI shows next to a filename."""
    added = 0
    removed = 0
    for line in lines:
        if line.kind is LineKind.ADDED:
            added += 1
        elif line.kind is LineKind.REMOVED:
            removed += 1
    return added, removed
