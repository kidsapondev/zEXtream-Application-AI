"""The look of the app: one palette, applied to the chrome and to the code.

Two themes are defined here and they have to agree. Textual's `Theme` colours the frame —
borders, tab bars, the footer, panel titles — while `TextAreaTheme` colours what is inside
the editor. Left to their defaults they come from different palettes entirely, and the result
is a window whose gutter and whose border look like they belong to different applications.

The palette itself is the one this project's design documents use, carried over deliberately
so the terminal app and its written material read as the same product: a cool neutral ground
biased slightly green, a copper accent, and teal as the second signal colour.

Colour never carries meaning alone anywhere in this app. Severity, run verdicts and git status
all render a word or a glyph as well, because a terminal's palette is ultimately the user's,
not ours — and because these are exactly the states someone reads at a glance while tired.
"""

from __future__ import annotations

from rich.style import Style
from textual.theme import Theme
from textual.widgets.text_area import TextAreaTheme

#: Named once so the editor theme below and the chrome theme cannot drift apart.
GROUND = "#131614"
SURFACE = "#1B201D"
PANEL = "#232925"
INK = "#E4E9E3"
INK_MUTED = "#8D968F"
RULE = "#333A35"
COPPER = "#E08B4F"
TEAL = "#55C2B7"
WARN = "#D6A034"
ERROR = "#E4796D"
SUCCESS = "#74C083"

LOCAL_CODER_THEME = Theme(
    name="local-coder",
    dark=True,
    background=GROUND,
    surface=SURFACE,
    panel=PANEL,
    foreground=INK,
    # Textual draws focused borders and panel titles in `primary`, so the accent belongs
    # here rather than only in `accent` — otherwise the one colour meant to draw the eye
    # never appears on the parts of the frame the eye actually goes to.
    primary=COPPER,
    secondary=TEAL,
    accent=COPPER,
    warning=WARN,
    error=ERROR,
    success=SUCCESS,
    variables={
        # `$border` and `$border-blurred` are deliberately NOT set here. Textual's own
        # stylesheet uses them as *colours* (`background: $border` appears in its built-in
        # rules), so overriding them with a border shorthand like "solid #333A35" makes the
        # framework's own CSS fail to parse — the whole app then refuses to start with
        # "Invalid value ('solid') for the background property", pointing at a rule this
        # project never wrote.
        "text-muted": INK_MUTED,
        "block-cursor-background": COPPER,
        "block-cursor-foreground": GROUND,
        "block-cursor-text-style": "none",
        "footer-key-foreground": COPPER,
        "footer-description-foreground": INK_MUTED,
        "input-selection-background": f"{TEAL} 35%",
        "scrollbar": RULE,
        "scrollbar-hover": INK_MUTED,
        "scrollbar-active": COPPER,
    },
)

#: The editor's own theme. Syntax colours are picked to sit on `SURFACE` at a comfortable
#: contrast rather than to be maximally saturated: a file is read for minutes at a time, and
#: the accent has to stay reserved for the frame, or nothing on screen is emphatic any more.
LOCAL_CODER_EDITOR_THEME = TextAreaTheme(
    name="local-coder",
    base_style=Style(color=INK, bgcolor=SURFACE),
    gutter_style=Style(color=RULE, bgcolor=SURFACE),
    cursor_style=Style(color=GROUND, bgcolor=COPPER),
    # The current line is marked by a slightly lifted background rather than a border or a
    # bright tint: it has to be findable at a glance without competing with the syntax
    # colouring it sits behind.
    cursor_line_style=Style(bgcolor=PANEL),
    cursor_line_gutter_style=Style(color=INK_MUTED, bgcolor=PANEL),
    bracket_matching_style=Style(bgcolor=RULE, bold=True),
    selection_style=Style(bgcolor="#204A46"),
    syntax_styles={
        "comment": Style(color=INK_MUTED, italic=True),
        "string": Style(color="#9BC98C"),
        "string.documentation": Style(color=INK_MUTED, italic=True),
        "number": Style(color="#D9A05B"),
        "boolean": Style(color="#D9A05B"),
        "constant": Style(color="#D9A05B"),
        "constant.builtin": Style(color="#D9A05B"),
        "keyword": Style(color=COPPER),
        "keyword.function": Style(color=COPPER),
        "keyword.return": Style(color=COPPER),
        "operator": Style(color=INK_MUTED),
        "function": Style(color=TEAL),
        "function.call": Style(color=TEAL),
        "method": Style(color=TEAL),
        "method.call": Style(color=TEAL),
        "class": Style(color="#8FB8E8"),
        "type": Style(color="#8FB8E8"),
        "type.class": Style(color="#8FB8E8"),
        "type.builtin": Style(color="#8FB8E8"),
        "variable": Style(color=INK),
        "parameter": Style(color=INK),
        "json.label": Style(color=TEAL),
        "tag": Style(color=COPPER),
        "error": Style(color=ERROR, underline=True),
    },
)
