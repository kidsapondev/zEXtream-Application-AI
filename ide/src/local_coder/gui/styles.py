"""The window's stylesheet, built from `palette.py`.

Qt Style Sheets rather than per-widget `setStyleSheet` calls scattered through the UI: one
place to read, and — more usefully — one place where a colour can be changed without hunting
through widget construction code for the four other places it was pasted.

Two Qt-specific things worth knowing before editing this:

* **A widget with a stylesheet background must have `objectName` set** for an id selector to
  reach it, and unnamed children of a styled parent do not inherit its background. Every rule
  below therefore selects by `#objectName` or by class, never by position.
* **`border-radius` on a plain `QWidget` does nothing** unless the widget paints its own
  background. `QFrame` with a background set does; a bare `QWidget` does not, which is why the
  panels here are frames.
"""

from __future__ import annotations

from . import palette as p


def stylesheet() -> str:
    """The whole application stylesheet as one string."""
    return f"""
QWidget {{
    background: {p.SURFACE};
    color: {p.TEXT};
    font-family: "Segoe UI", "Inter", system-ui, sans-serif;
    font-size: 13px;
}}

QMainWindow, #root {{
    background: {p.CHROME};
}}

/* -- title bar and toolbar ---------------------------------------------------------- */

#titleBar {{
    background: {p.CHROME};
    border-bottom: 1px solid {p.HAIRLINE};
}}

#toolBar {{
    background: {p.CHROME};
    border-bottom: 1px solid {p.HAIRLINE};
}}

QPushButton#toolAction {{
    background: transparent;
    border: none;
    border-radius: {p.RADIUS_MD}px;
    padding: 7px 12px;
    color: {p.TEXT_SECONDARY};
    text-align: left;
}}

QPushButton#toolAction:hover {{
    background: {p.SURFACE_HOVER};
    color: {p.TEXT};
}}

QPushButton#toolAction:pressed {{
    background: {p.SURFACE_ACTIVE};
}}

/* -- panels -------------------------------------------------------------------------- */

QFrame#panel {{
    background: {p.SURFACE};
    border: 1px solid {p.HAIRLINE};
    border-radius: {p.RADIUS_LG}px;
}}

QLabel#panelTitle {{
    color: {p.TEXT_MUTED};
    font-size: 11px;
    font-weight: 600;
    letter-spacing: 1px;
    padding: 10px 12px 6px;
}}

/* -- primary action ------------------------------------------------------------------ */

QPushButton#primary {{
    background: {p.ACCENT};
    color: {p.ACCENT_INK};
    border: none;
    border-radius: {p.RADIUS_MD}px;
    padding: 9px 14px;
    font-weight: 600;
}}

QPushButton#primary:hover {{
    background: #D4FF6B;
}}

QPushButton#primary:disabled {{
    background: {p.SURFACE_ACTIVE};
    color: {p.TEXT_MUTED};
}}

QPushButton#ghost {{
    background: {p.SURFACE_RAISED};
    color: {p.TEXT_SECONDARY};
    border: 1px solid {p.HAIRLINE_STRONG};
    border-radius: {p.RADIUS_MD}px;
    padding: 8px 12px;
}}

QPushButton#ghost:hover {{
    background: {p.SURFACE_HOVER};
    color: {p.TEXT};
}}

/* -- explorer tree -------------------------------------------------------------------- */

QTreeWidget#explorer {{
    background: transparent;
    border: none;
    outline: none;
    show-decoration-selected: 1;
}}

QTreeWidget#explorer::item {{
    height: 26px;
    border-radius: {p.RADIUS_SM}px;
    color: {p.TEXT_SECONDARY};
}}

QTreeWidget#explorer::item:hover {{
    background: {p.SURFACE_HOVER};
}}

/* The selected row is a filled rounded rectangle, matching the reference design, rather than
   Qt's default full-width highlight bar. */
QTreeWidget#explorer::item:selected {{
    background: {p.SURFACE_ACTIVE};
    color: {p.TEXT};
}}

/* -- editor tabs ---------------------------------------------------------------------- */

QTabWidget#editorTabs::pane {{
    border: none;
    background: {p.EDITOR};
}}

QTabBar::tab {{
    background: {p.CHROME};
    color: {p.TEXT_MUTED};
    border: none;
    border-right: 1px solid {p.HAIRLINE};
    padding: 9px 14px;
    min-width: 90px;
}}

QTabBar::tab:selected {{
    background: {p.EDITOR};
    color: {p.TEXT};
}}

QTabBar::tab:hover {{
    color: {p.TEXT_SECONDARY};
}}

QTabBar::close-button {{
    subcontrol-position: right;
}}

/* -- editor ---------------------------------------------------------------------------- */

QPlainTextEdit#code {{
    background: {p.EDITOR};
    color: {p.TEXT};
    border: none;
    font-family: "Cascadia Mono", "Consolas", monospace;
    font-size: 13px;
    selection-background-color: #204A46;
}}

/* -- bottom dock ----------------------------------------------------------------------- */

QTabWidget#dock::pane {{
    border: none;
    border-top: 1px solid {p.HAIRLINE};
    background: {p.SURFACE};
}}

QPlainTextEdit#dockOutput {{
    background: {p.SURFACE};
    color: {p.TEXT_SECONDARY};
    border: none;
    font-family: "Cascadia Mono", "Consolas", monospace;
    font-size: 12px;
}}

QLineEdit#terminalInput {{
    background: {p.SURFACE_RAISED};
    border: 1px solid {p.HAIRLINE_STRONG};
    border-radius: {p.RADIUS_MD}px;
    padding: 7px 10px;
    color: {p.TEXT};
    font-family: "Cascadia Mono", "Consolas", monospace;
}}

QLineEdit#terminalInput:focus {{
    border-color: {p.ACCENT};
}}

/* -- status bar -------------------------------------------------------------------------- */

#statusBar {{
    background: {p.CHROME};
    border-top: 1px solid {p.HAIRLINE};
    color: {p.TEXT_MUTED};
    font-size: 11px;
}}

/* -- scrollbars ---------------------------------------------------------------------------- */

QScrollBar:vertical {{
    background: transparent;
    width: 10px;
    margin: 0;
}}

QScrollBar::handle:vertical {{
    background: {p.SURFACE_ACTIVE};
    border-radius: 5px;
    min-height: 30px;
}}

QScrollBar::handle:vertical:hover {{
    background: {p.HAIRLINE_STRONG};
}}

QScrollBar::add-line:vertical, QScrollBar::sub-line:vertical {{
    height: 0;
}}

QScrollBar:horizontal {{
    background: transparent;
    height: 10px;
}}

QScrollBar::handle:horizontal {{
    background: {p.SURFACE_ACTIVE};
    border-radius: 5px;
    min-width: 30px;
}}

QScrollBar::add-line:horizontal, QScrollBar::sub-line:horizontal {{
    width: 0;
}}

QComboBox {{
    background: {p.SURFACE_RAISED};
    border: 1px solid {p.HAIRLINE_STRONG};
    border-radius: {p.RADIUS_MD}px;
    padding: 6px 10px;
    color: {p.TEXT};
}}

QComboBox QAbstractItemView {{
    background: {p.SURFACE_RAISED};
    border: 1px solid {p.HAIRLINE_STRONG};
    selection-background-color: {p.SURFACE_ACTIVE};
    color: {p.TEXT};
}}
"""
