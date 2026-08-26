"""The one row that is always on screen.

Six things a person checks constantly while working — where they are, what language, what is
broken, what branch, which model, what it has cost — and no good place to check any of them
before this widget existed. They lived in a single `Static` that the last thing to happen
overwrote, so opening a file erased the run result and refreshing the tree erased both.

Segments are independently settable for exactly that reason: a status line where writing one
fact destroys the others is not a status line, it is a notification area. Transient messages
still need somewhere to go, so `message` is its own segment that takes priority when set and
falls back to the rest when cleared.

Everything renders as text with an explicit label or glyph. Colour reinforces, never carries:
a terminal's palette belongs to the user, and this is the row they read while tired.
"""

from __future__ import annotations

from dataclasses import dataclass, field

from textual.reactive import reactive
from textual.widgets import Static

#: Between segments. A middot rather than a border or a pipe — at this density anything
#: heavier reads as a table, and the eye starts parsing structure instead of content.
SEPARATOR = "  ·  "


@dataclass(frozen=True, slots=True)
class StatusState:
    """Everything the bar can show. Frozen so a repaint cannot half-apply."""

    path: str = ""
    line: int = 0
    column: int = 0
    language: str = ""
    errors: int = 0
    warnings: int = 0
    branch: str = ""
    dirty_files: int = 0
    model: str = ""
    tokens: int = 0
    runs: int = 0
    message: str = ""
    #: Kept out of `__eq__` so two states differing only in this still compare equal — the
    #: widget repaints on change, and a spinner tick is not a change worth repainting for.
    _unused: tuple[()] = field(default=(), compare=False)


def render_segments(state: StatusState) -> list[str]:
    """The segments, in reading order, omitting anything that has nothing to say.

    Omission rather than placeholders: a bar padded with "—" for every unknown is mostly
    punctuation, and the eye has to work out which dashes matter. What is absent is absent.
    """
    if state.message:
        # A transient message displaces the lot. It is always the most recent thing that
        # happened, and burying it among six standing facts is how it gets missed.
        return [state.message]

    segments: list[str] = []
    if state.path:
        segments.append(state.path)
    if state.line and state.column:
        segments.append(f"{state.line}:{state.column}")
    if state.language:
        segments.append(state.language)

    if state.errors or state.warnings:
        # Glyph plus number, in ASCII: box-drawing and emoji render as replacement boxes in
        # the wrong font, and this row must survive whatever terminal the user already has.
        parts = []
        if state.errors:
            parts.append(f"x{state.errors}")
        if state.warnings:
            parts.append(f"!{state.warnings}")
        segments.append(" ".join(parts))

    if state.branch:
        branch = state.branch
        if state.dirty_files:
            branch = f"{branch} *{state.dirty_files}"
        segments.append(branch)

    if state.model:
        segments.append(state.model)
    if state.tokens:
        segments.append(f"{state.tokens:,} tok / {state.runs} run")
    return segments


class StatusBar(Static):
    """Renders a `StatusState`. Update segments individually, never the whole line."""

    state: reactive[StatusState] = reactive(StatusState, always_update=True)

    def __init__(self, *, id: str | None = None) -> None:
        super().__init__("", id=id)

    def watch_state(self, state: StatusState) -> None:
        self.update(SEPARATOR.join(render_segments(state)))

    # -- setters -------------------------------------------------------------------------

    def set_message(self, message: str) -> None:
        """Shows a transient line, displacing the standing facts until cleared."""
        self.state = replace(self.state, message=message)

    def clear_message(self) -> None:
        self.state = replace(self.state, message="")

    def set_file(self, path: str, *, language: str = "") -> None:
        self.state = replace(self.state, path=path, language=language, message="")

    def set_position(self, line: int, column: int) -> None:
        self.state = replace(self.state, line=line, column=column)

    def set_diagnostics(self, *, errors: int, warnings: int) -> None:
        self.state = replace(self.state, errors=errors, warnings=warnings)

    def set_git(self, branch: str, *, dirty_files: int = 0) -> None:
        self.state = replace(self.state, branch=branch, dirty_files=dirty_files)

    def set_model(self, model: str) -> None:
        self.state = replace(self.state, model=model)

    def set_usage(self, *, tokens: int, runs: int) -> None:
        self.state = replace(self.state, tokens=tokens, runs=runs)


def replace(state: StatusState, **changes: object) -> StatusState:
    """`dataclasses.replace` for a slotted frozen dataclass, narrowed to this type.

    Defined here rather than imported so the module reads as one thing; the stdlib version
    would work identically.
    """
    from dataclasses import replace as _replace

    return _replace(state, **changes)  # type: ignore[arg-type]
