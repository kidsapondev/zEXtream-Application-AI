"""Line-level editing operations, as pure functions over text.

The operations an editor needs that `TextArea` does not provide: comment toggling, line
duplication, moving lines, and indent handling. Every one of them is a transformation from
(text, selected line range) to (new text, new line range), with no widget involved.

That shape is deliberate. A line-move that is correct only when driven through a live widget
cannot be tested without a terminal, and these are exactly the operations where off-by-one
errors are invisible in review and obvious the moment someone uses them — a duplicate that
lands one line high, a comment toggle that eats the first character of code.

Line numbers here are **0-based**, matching `TextArea.cursor_location` and `Selection`. That
differs from `DiffLine` and `SearchHit`, which are 1-based because they are read by people.
Every conversion happens at the widget boundary, never inside these functions.
"""

from __future__ import annotations

from pathlib import Path

#: Line-comment prefix per file extension. Languages whose line comment is not a simple
#: prefix (or that have none) are deliberately absent: toggling a comment in a language this
#: does not know would produce syntactically broken code, which is worse than doing nothing.
_COMMENT_PREFIXES = {
    ".py": "#",
    ".sh": "#",
    ".toml": "#",
    ".yaml": "#",
    ".yml": "#",
    ".ts": "//",
    ".tsx": "//",
    ".js": "//",
    ".jsx": "//",
    ".mjs": "//",
    ".java": "//",
    ".go": "//",
    ".rs": "//",
    ".c": "//",
    ".cpp": "//",
    ".cs": "//",
    ".sql": "--",
}


def comment_prefix(path: str) -> str | None:
    """The line-comment marker for `path`, or `None` when the language has no known one."""
    return _COMMENT_PREFIXES.get(Path(path).suffix.lower())


def _split(text: str) -> tuple[list[str], bool]:
    """Lines plus whether the text ended with a newline.

    Tracked separately because `splitlines()` discards that fact and `"\\n".join()` cannot
    recover it — round-tripping without it silently strips or adds a trailing newline on every
    edit, which shows up as a one-line diff in every file the user touches.
    """
    ends_with_newline = text.endswith("\n")
    return text.splitlines(), ends_with_newline


def _join(lines: list[str], ends_with_newline: bool) -> str:
    joined = "\n".join(lines)
    return f"{joined}\n" if ends_with_newline else joined


def toggle_comment(text: str, start: int, end: int, path: str) -> str:
    """Comments the line range, or uncomments it if every non-blank line is already commented.

    "Every non-blank line" is the rule editors converge on for a reason: a selection where one
    line is commented and three are not is far more often a half-finished comment-out than a
    request to invert each line individually.

    Blank lines inside the range are left alone. Commenting them adds trailing markers that
    every formatter then strips, producing spurious diffs.
    """
    prefix = comment_prefix(path)
    if prefix is None:
        return text

    lines, trailing = _split(text)
    if not lines:
        return text
    start, end = _clamp(start, end, len(lines))

    span = lines[start : end + 1]
    meaningful = [line for line in span if line.strip()]
    if not meaningful:
        return text

    if all(line.lstrip().startswith(prefix) for line in meaningful):
        lines[start : end + 1] = [_uncomment(line, prefix) for line in span]
    else:
        # Indent the marker to the shallowest line in the selection rather than to column
        # zero, so a commented-out block keeps the shape of the code around it.
        indent = min(
            (len(line) - len(line.lstrip()) for line in meaningful),
            default=0,
        )
        lines[start : end + 1] = [
            line if not line.strip() else f"{line[:indent]}{prefix} {line[indent:]}"
            for line in span
        ]

    return _join(lines, trailing)


def _uncomment(line: str, prefix: str) -> str:
    if not line.strip():
        return line
    indent = len(line) - len(line.lstrip())
    body = line[indent:]
    body = body[len(prefix) :]
    # Remove the single space this module adds when commenting, but only one: a line that was
    # deliberately indented under its marker keeps that indentation.
    if body.startswith(" "):
        body = body[1:]
    return f"{line[:indent]}{body}"


def duplicate_lines(text: str, start: int, end: int) -> tuple[str, int]:
    """Copies the line range immediately below itself.

    Returns the new text and the line the cursor should move to — the first line of the copy,
    so typing continues in the duplicate rather than in the original.
    """
    lines, trailing = _split(text)
    if not lines:
        return text, start
    start, end = _clamp(start, end, len(lines))

    span = lines[start : end + 1]
    lines[end + 1 : end + 1] = span
    return _join(lines, trailing), end + 1


def move_lines(text: str, start: int, end: int, delta: int) -> tuple[str, int, int]:
    """Moves the line range up (`delta < 0`) or down (`delta > 0`).

    Returns the new text and the moved range's new bounds. A move that would run off either
    end is a no-op rather than a clamp: silently moving a block one line when the user asked
    for two is harder to notice than nothing happening.
    """
    lines, trailing = _split(text)
    if not lines or delta == 0:
        return text, start, end
    start, end = _clamp(start, end, len(lines))

    target = start + delta
    if target < 0 or end + delta >= len(lines):
        return text, start, end

    span = lines[start : end + 1]
    del lines[start : end + 1]
    lines[target : target] = span
    return _join(lines, trailing), target, target + (end - start)


def indent_lines(text: str, start: int, end: int, width: int = 4) -> str:
    """Adds one indent level to the range, skipping blank lines."""
    lines, trailing = _split(text)
    if not lines:
        return text
    start, end = _clamp(start, end, len(lines))
    pad = " " * width
    lines[start : end + 1] = [
        line if not line.strip() else f"{pad}{line}" for line in lines[start : end + 1]
    ]
    return _join(lines, trailing)


def dedent_lines(text: str, start: int, end: int, width: int = 4) -> str:
    """Removes up to one indent level from the range.

    "Up to" matters: a line indented by two spaces inside a four-space file must lose those
    two rather than nothing, or a dedent through mixed indentation leaves the block ragged.
    """
    lines, trailing = _split(text)
    if not lines:
        return text
    start, end = _clamp(start, end, len(lines))

    span = lines[start : end + 1]
    removable = min(
        (len(line) - len(line.lstrip(" ")) for line in span if line.strip()),
        default=0,
    )
    remove = min(width, removable)
    if remove:
        lines[start : end + 1] = [
            line if not line.strip() else line[remove:] for line in span
        ]
    return _join(lines, trailing)


def strip_trailing_whitespace(text: str) -> str:
    """Trims trailing spaces from every line, leaving the final newline alone."""
    lines, trailing = _split(text)
    return _join([line.rstrip() for line in lines], trailing)


def _clamp(start: int, end: int, count: int) -> tuple[int, int]:
    """Orders and bounds a line range.

    A selection dragged upwards arrives with `start > end`; every function here would silently
    operate on an empty slice without this, which reads as "the command did nothing" and is
    the kind of bug that only shows up for users who select backwards.
    """
    if start > end:
        start, end = end, start
    return max(start, 0), min(end, count - 1)
