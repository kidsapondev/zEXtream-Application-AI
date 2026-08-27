"""Small custom widgets the reference design needs and Qt does not ship.

Each of these exists because the stock widget could not be styled into the required shape, not
because a custom one looked more interesting. Where Qt's own widget was sufficient — trees,
tabs, combo boxes — it is used directly and styled in `styles.py`.
"""

from __future__ import annotations

from PySide6.QtCore import QRect, QSize, Qt
from PySide6.QtGui import (
    QColor,
    QFont,
    QFontMetrics,
    QPainter,
    QPaintEvent,
    QTextFormat,
)
from PySide6.QtWidgets import (
    QHBoxLayout,
    QLabel,
    QPlainTextEdit,
    QTextEdit,
    QWidget,
)

from . import palette as p
from .palette import file_kind


class FileBadge(QWidget):
    """The small coloured square that identifies a file's type.

    Drawn rather than assembled from a styled `QLabel`: the badge is a rounded rectangle with
    text centred inside it at a size that has to stay legible at 16 pixels, and Qt's box model
    fights that — padding, border radius and font metrics interact differently on each
    platform. Painting it directly gives the same result everywhere.
    """

    SIZE = 16

    def __init__(self, name: str, parent: QWidget | None = None) -> None:
        super().__init__(parent)
        self._kind = file_kind(name)
        self.setFixedSize(QSize(self.SIZE, self.SIZE))

    def set_name(self, name: str) -> None:
        self._kind = file_kind(name)
        self.update()

    def paintEvent(self, event: QPaintEvent) -> None:  # noqa: N802 - Qt's name
        painter = QPainter(self)
        painter.setRenderHint(QPainter.RenderHint.Antialiasing)
        rect = QRect(0, 0, self.SIZE, self.SIZE)

        painter.setPen(Qt.PenStyle.NoPen)
        painter.setBrush(QColor(self._kind.color))
        painter.drawRoundedRect(rect, 4, 4)

        font = QFont(self.font())
        font.setPointSizeF(7.5)
        font.setBold(True)
        painter.setFont(font)
        # Black or white by luminance rather than a fixed ink colour: these badges span a
        # yellow and a deep purple, and one fixed foreground is unreadable on one of them.
        painter.setPen(QColor(_ink_for(self._kind.color)))
        painter.drawText(rect, Qt.AlignmentFlag.AlignCenter, self._kind.badge)
        painter.end()


def _ink_for(background: str) -> str:
    """Black or white, whichever stays readable on `background`.

    Rec. 601 luma rather than a plain average: the eye is far more sensitive to green than to
    blue, and averaging makes yellow badges pick white ink, which is the exact case this
    guards against.
    """
    colour = QColor(background)
    luma = 0.299 * colour.red() + 0.587 * colour.green() + 0.114 * colour.blue()
    return "#101214" if luma > 150 else "#FFFFFF"


class LineNumberArea(QWidget):
    """The gutter. Owned by `CodeEditor`, which does the painting."""

    def __init__(self, editor: "CodeEditor") -> None:
        super().__init__(editor)
        self._editor = editor

    def sizeHint(self) -> QSize:  # noqa: N802 - Qt's name
        return QSize(self._editor.gutter_width(), 0)

    def paintEvent(self, event: QPaintEvent) -> None:  # noqa: N802 - Qt's name
        self._editor.paint_gutter(event)


class CodeEditor(QPlainTextEdit):
    """A plain text editor with a line-number gutter and a highlighted current line.

    `QPlainTextEdit` rather than a full editor component. QScintilla is the usual answer and
    has no maintained PySide6 binding; embedding a browser to run Monaco would make this a web
    view in a native frame, which is the approach that was explicitly not chosen. What is left
    is Qt's own editor, which handles enormous files well and leaves syntax highlighting to a
    `QSyntaxHighlighter` — the arrangement Qt itself documents for exactly this.

    Line numbers are not decoration: every diagnostic, search hit and agent step in this
    application is addressed by line, and without a gutter none of those numbers mean anything
    on screen.
    """

    def __init__(self, parent: QWidget | None = None) -> None:
        super().__init__(parent)
        self.setObjectName("code")
        self._gutter = LineNumberArea(self)

        self.blockCountChanged.connect(lambda _count: self._update_gutter_width())
        self.updateRequest.connect(self._on_update_request)
        self.cursorPositionChanged.connect(self._highlight_current_line)

        self.setLineWrapMode(QPlainTextEdit.LineWrapMode.NoWrap)
        # Tabs render four columns wide to match the workspace's own convention. Qt measures
        # this in pixels, so it has to be derived from the font rather than assumed.
        self.setTabStopDistance(QFontMetrics(self.font()).horizontalAdvance(" ") * 4)

        self._update_gutter_width()
        self._highlight_current_line()

    # -- gutter --------------------------------------------------------------------------

    def gutter_width(self) -> int:
        digits = max(2, len(str(max(1, self.blockCount()))))
        return 18 + QFontMetrics(self.font()).horizontalAdvance("9") * digits

    def _update_gutter_width(self) -> None:
        self.setViewportMargins(self.gutter_width(), 0, 0, 0)

    def _on_update_request(self, rect: QRect, dy: int) -> None:
        if dy:
            self._gutter.scroll(0, dy)
        else:
            self._gutter.update(0, rect.y(), self._gutter.width(), rect.height())
        if rect.contains(self.viewport().rect()):
            self._update_gutter_width()

    def resizeEvent(self, event) -> None:  # noqa: N802, ANN001 - Qt's name and type
        super().resizeEvent(event)
        contents = self.contentsRect()
        self._gutter.setGeometry(
            QRect(contents.left(), contents.top(), self.gutter_width(), contents.height())
        )

    def paint_gutter(self, event: QPaintEvent) -> None:
        painter = QPainter(self._gutter)
        painter.fillRect(event.rect(), QColor(p.EDITOR))

        block = self.firstVisibleBlock()
        number = block.blockNumber()
        top = round(self.blockBoundingGeometry(block).translated(self.contentOffset()).top())
        bottom = top + round(self.blockBoundingRect(block).height())
        current = self.textCursor().blockNumber()

        while block.isValid() and top <= event.rect().bottom():
            if block.isVisible() and bottom >= event.rect().top():
                # The current line's number is brighter than the rest — the cheapest way to
                # keep "where am I" answerable without a second highlight competing with the
                # syntax colouring in the text itself.
                painter.setPen(QColor(p.TEXT_SECONDARY if number == current else p.TEXT_MUTED))
                painter.drawText(
                    0,
                    top,
                    self._gutter.width() - 8,
                    self.fontMetrics().height(),
                    Qt.AlignmentFlag.AlignRight,
                    str(number + 1),
                )
            block = block.next()
            top = bottom
            bottom = top + round(self.blockBoundingRect(block).height())
            number += 1
        painter.end()

    def _highlight_current_line(self) -> None:
        selection = QTextEdit.ExtraSelection()
        selection.format.setBackground(QColor(p.SURFACE_RAISED))
        selection.format.setProperty(QTextFormat.Property.FullWidthSelection, True)
        selection.cursor = self.textCursor()
        selection.cursor.clearSelection()
        self.setExtraSelections([selection])


class Pill(QLabel):
    """A rounded label used for counts and short status words."""

    def __init__(self, text: str = "", tone: str = p.SURFACE_ACTIVE, parent: QWidget | None = None) -> None:
        super().__init__(text, parent)
        self.setStyleSheet(
            f"background: {tone}; color: {p.TEXT}; border-radius: 9px;"
            " padding: 2px 8px; font-size: 11px;"
        )


class Row(QWidget):
    """A horizontal strip with sane defaults, since every panel here needs several."""

    def __init__(self, spacing: int = 8, margins: tuple[int, int, int, int] = (0, 0, 0, 0)) -> None:
        super().__init__()
        layout = QHBoxLayout(self)
        layout.setContentsMargins(*margins)
        layout.setSpacing(spacing)
        self.layout_ = layout

    def add(self, widget: QWidget) -> QWidget:
        self.layout_.addWidget(widget)
        return widget

    def stretch(self) -> None:
        self.layout_.addStretch(1)
