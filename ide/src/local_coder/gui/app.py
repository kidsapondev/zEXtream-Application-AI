"""Entry point for the desktop window.

Marries Qt's event loop to asyncio with `qasync`, so the backend — which is asyncio all the
way down, driving a subprocess over stdio — can be awaited from the same loop that paints.
Without that, every backend call either blocks the interface or lands on the wrong thread to
touch a widget from.

The MCP server is started before the window and closed after it, in that order, so a session
never outlives the process it depends on and never leaves one running with a model loaded in
VRAM.
"""

from __future__ import annotations

import asyncio
import os
import sys
from pathlib import Path

from ..errors import explain
from ..mcp_client import McpBackend
from ..protocols import AgentError


def main() -> None:
    # Imported inside the function so `python -m local_coder` — the terminal app — still runs
    # on a machine without PySide6 installed. The desktop window is optional; the TUI is not.
    try:
        import qasync
        from PySide6.QtWidgets import QApplication
    except ImportError as error:  # pragma: no cover - depends on the machine, not the code
        raise SystemExit(
            "The desktop window needs PySide6 and qasync.\n"
            "  fix: python -m pip install --user PySide6 qasync"
        ) from error

    from .main_window import MainWindow
    from .styles import stylesheet

    repo_root = Path(__file__).resolve().parents[4]
    server = repo_root / "host-bridge" / "dist" / "mcp-main.js"

    app = QApplication(sys.argv)
    app.setApplicationName("Local Coder")
    app.setStyleSheet(stylesheet())

    loop = qasync.QEventLoop(app)
    asyncio.set_event_loop(loop)

    async def run() -> None:
        async with McpBackend(server) as backend:
            window = MainWindow(backend, model=os.environ.get("MCP_AGENT_MODEL"))
            window.show()
            # Loading starts only after the window is up, so a slow first listing shows an
            # empty tree that fills rather than a blank screen that eventually appears.
            await window.start()

            closed = asyncio.Event()
            app.aboutToQuit.connect(closed.set)
            await closed.wait()

    try:
        with loop:
            loop.run_until_complete(run())
    except AgentError as error:
        raise SystemExit(explain(error)) from error

    # Qt's own loop has stopped by the time `run()` returns, but qasync can be left holding a
    # reader on the server's stdout pipe, and the process then sits alive with no window —
    # closing the last window has to end the program, so this is not optional tidiness.
    # Verified: without it the offscreen smoke run finished its work and never exited.
    os._exit(0)


if __name__ == "__main__":
    main()
