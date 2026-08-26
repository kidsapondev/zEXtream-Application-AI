"""Widgets.

Each module here owns one panel and imports nothing from `app.py` — the app wires them
together, they never reach back. That direction is what lets each widget be tested on its own
against `FakeBackend` without booting the whole application.
"""
