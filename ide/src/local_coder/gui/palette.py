"""Colours and file-type identity for the desktop window.

Kept apart from any Qt import so it can be read and tested without a display. Everything a
stylesheet or a painter needs is a plain string here; `styles.py` turns it into QSS.

The palette is deliberately darker and cooler than the terminal app's. A TUI inherits the
terminal's own background and has to sit politely on top of it; a window owns every pixel it
draws, so it can commit to a ground of its own — which is what makes the rounded panels and
soft separations in the reference design read as depth rather than as noise.
"""

from __future__ import annotations

from dataclasses import dataclass

# Ground upward. Each step is a real surface in the layout, not a decorative gradient:
# chrome is the window frame and toolbars, surface is the panels, raised is a control inside
# a panel, and editor is the one place code sits.
CHROME = "#101214"
SURFACE = "#16191C"
SURFACE_RAISED = "#1E2226"
SURFACE_HOVER = "#242A2F"
SURFACE_ACTIVE = "#2B3238"
EDITOR = "#1A1D21"

HAIRLINE = "#23282D"
HAIRLINE_STRONG = "#2F363C"

TEXT = "#E6EBEF"
TEXT_SECONDARY = "#A9B3BC"
TEXT_MUTED = "#6F7A83"

#: The lime the reference design uses for its one committed action. Reserved for exactly
#: that: a second lime element anywhere would cost the first one its weight.
ACCENT = "#C8F751"
ACCENT_INK = "#12160B"
ACCENT_SOFT = "#2A3313"

DANGER = "#F2705D"
WARNING = "#E0A83C"
SUCCESS = "#6FCF8F"
INFO = "#5AB6E8"

RADIUS_SM = 6
RADIUS_MD = 10
RADIUS_LG = 14


@dataclass(frozen=True, slots=True)
class FileKind:
    """How one family of files is labelled and coloured in the tree and on tabs.

    `badge` is two characters at most. A file row is 20 pixels tall and the name beside it is
    what people actually read — a longer badge starts competing with the filename for the same
    glance, which is the opposite of what an icon is for.
    """

    badge: str
    color: str
    language: str


#: Colours follow the conventions people already have from other editors — Python green,
#: JavaScript yellow, CSS blue — rather than a palette invented here. Recognition beats
#: harmony for something scanned hundreds of times a session.
_KINDS: dict[str, FileKind] = {
    ".py": FileKind("py", "#3BA55D", "python"),
    ".pyi": FileKind("py", "#3BA55D", "python"),
    ".ts": FileKind("TS", "#3178C6", "typescript"),
    ".tsx": FileKind("TS", "#3178C6", "typescript"),
    ".js": FileKind("JS", "#E8C33C", "javascript"),
    ".mjs": FileKind("JS", "#E8C33C", "javascript"),
    ".jsx": FileKind("JS", "#E8C33C", "javascript"),
    ".json": FileKind("{}", "#E8C33C", "json"),
    ".html": FileKind("<>", "#E8623C", "html"),
    ".htm": FileKind("<>", "#E8623C", "html"),
    ".css": FileKind("#", "#3BA0E8", "css"),
    ".scss": FileKind("#", "#CD6799", "scss"),
    ".php": FileKind("P", "#A66BE8", "php"),
    ".md": FileKind("M", "#8C99A4", "markdown"),
    ".yml": FileKind("Y", "#C77B3C", "yaml"),
    ".yaml": FileKind("Y", "#C77B3C", "yaml"),
    ".toml": FileKind("T", "#9C7B5C", "toml"),
    ".sql": FileKind("DB", "#5AB6E8", "sql"),
    ".sh": FileKind("$", "#7FB069", "shell"),
    ".exe": FileKind("EX", "#6FCF8F", "text"),
    ".png": FileKind("IM", "#8C7BE8", "text"),
    ".jpg": FileKind("IM", "#8C7BE8", "text"),
    ".svg": FileKind("IM", "#8C7BE8", "text"),
}

_DEFAULT = FileKind("·", "#5C666E", "text")


def file_kind(name: str) -> FileKind:
    """The badge, colour and language for a file name.

    Matched on the last dot rather than with `pathlib`: this is called once per visible row on
    every repaint, and the names arriving here are already normalised POSIX-style paths from
    the workspace protocol, so there is nothing for a path library to disambiguate.
    """
    lowered = name.lower()
    dot = lowered.rfind(".")
    if dot <= 0:
        # A leading dot is not an extension — `.gitignore` is a whole name, and treating
        # `gitignore` as its type would badge every dotfile by whatever follows the dot.
        return _DEFAULT
    return _KINDS.get(lowered[dot:], _DEFAULT)


def language_for(name: str) -> str:
    return file_kind(name).language
