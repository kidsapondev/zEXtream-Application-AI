"""Turning a typed line into a command and arguments, without a shell.

`CoderBackend.exec` spawns an executable directly from an operator-controlled allowlist —
which is precisely why either UI is allowed to run commands on the host at all. Nothing on
the other side expands globs, splits words, or interprets quotes, so this file does the part
that is safe to do and refuses the part that is not.

The refusal matters as much as the parsing. `npm test | grep fail` split naively runs as `npm`
with `test`, `|` and `grep` as arguments, exits zero, and looks exactly like a pipeline that
worked. Detecting the operator and saying so is the difference between a limitation and a lie.

Kept outside `gui/` deliberately: nothing here imports Qt, and the terminal panel is a
feature either front end can grow.
"""

from __future__ import annotations

import re
from dataclasses import dataclass


@dataclass(frozen=True, slots=True)
class ParsedCommand:
    command: str
    args: tuple[str, ...]

    @property
    def display(self) -> str:
        return " ".join([self.command, *self.args])


#: Shell constructs the sandbox cannot honour. Matched on the raw line, before parsing: once
#: parsed, a `|` has become an ordinary argument and looks perfectly innocent.
_SHELL_SYNTAX = re.compile(r"[|;&><`$]")


def contains_shell_syntax(line: str) -> bool:
    return bool(_SHELL_SYNTAX.search(line))


def parse_command_line(line: str) -> ParsedCommand | None:
    """Splits on whitespace, honouring quotes and backslash escapes.

    `None` for a blank line. Not a shell parser — see the module docstring for what is
    deliberately refused instead of approximated.
    """
    tokens: list[str] = []
    current: list[str] = []
    started = False
    quote: str | None = None
    index = 0

    while index < len(line):
        char = line[index]

        if char == "\\" and index + 1 < len(line):
            current.append(line[index + 1])
            started = True
            index += 2
            continue

        if quote is not None:
            if char == quote:
                quote = None
            else:
                current.append(char)
            index += 1
            continue

        if char in "\"'":
            quote = char
            # An empty quoted string is still an argument: `git commit -m ""` passes one.
            started = True
            index += 1
            continue

        if char.isspace():
            if started:
                tokens.append("".join(current))
                current.clear()
                started = False
            index += 1
            continue

        current.append(char)
        started = True
        index += 1

    if started:
        tokens.append("".join(current))

    if not tokens:
        return None
    return ParsedCommand(tokens[0], tuple(tokens[1:]))


class CommandHistory:
    """A bounded history, browsed with up and down.

    De-duplicated only against the immediately previous entry, the way a shell's `ignoredups`
    behaves: re-running one test command five times should leave one entry to scroll back to,
    while two commands alternating are both worth keeping.
    """

    def __init__(self, limit: int = 100) -> None:
        self._entries: list[str] = []
        self._cursor = 0
        self._limit = limit

    @property
    def items(self) -> tuple[str, ...]:
        return tuple(self._entries)

    def add(self, line: str) -> None:
        trimmed = line.strip()
        if not trimmed:
            return
        if not self._entries or self._entries[-1] != trimmed:
            self._entries.append(trimmed)
            if len(self._entries) > self._limit:
                self._entries.pop(0)
        # Every submission resets the browse position, so the next up-arrow starts from the
        # most recent command rather than wherever the last browse left off.
        self._cursor = len(self._entries)

    def previous(self) -> str | None:
        if self._cursor == 0:
            return None
        self._cursor -= 1
        return self._entries[self._cursor]

    def next(self) -> str | None:
        """The next command, or `""` once past the newest.

        The empty string is the line the user was typing before they started browsing;
        restoring it is what makes down-arrow an escape hatch rather than a dead end.
        """
        if self._cursor >= len(self._entries):
            return None
        self._cursor += 1
        return "" if self._cursor >= len(self._entries) else self._entries[self._cursor]
