"""Specification for `local_coder.ui.search_panel`.

Driven through Textual's headless `Pilot` inside a tiny host `App` defined here, the same
pattern `test_app.py` and `test_file_finder.py` use. `FakeBackend.search` (see `conftest.py`)
is a real, if in-memory, substring search — case-insensitive, over `backend.files` — so these
tests exercise the actual round trip through `CoderBackend.search`, just without a subprocess
on the other end of it.
"""

from __future__ import annotations

from textual import on
from textual.app import App, ComposeResult
from textual.widgets import Input, Label, ListView, Static

from local_coder.protocols import AgentError, SearchHit
from local_coder.ui.search_panel import SearchPanel, _summary


class _HostApp(App[None]):
    """Mounts a single `SearchPanel` and records what it posts — see `test_file_finder.py`
    for why the widget is exercised standalone rather than through the full app.
    """

    def __init__(self, backend) -> None:
        super().__init__()
        self._backend = backend
        self.selected: tuple[str, int] | None = None

    def compose(self) -> ComposeResult:
        yield SearchPanel(self._backend, id="search")

    @on(SearchPanel.HitSelected)
    def _on_hit_selected(self, event: SearchPanel.HitSelected) -> None:
        self.selected = (event.path, event.line)


async def _submit(pilot, query: str) -> None:
    """Types `query` into the search box and presses Enter, then waits for the worker.

    `SearchPanel._run_search` is a `@work` method, started in the same tick `Input.Submitted`
    fires — `App.workers.wait_for_complete()` can return before it is even registered (see
    the note on `action_run_task` in `app.py`), so this polls the status line instead of
    trusting the worker queue, which is what an app driving this widget would effectively see
    too: text on screen, not an internal handle.
    """
    box = pilot.app.query_one(Input)
    box.value = query
    box.post_message(Input.Submitted(box, query))
    await pilot.pause()
    status = pilot.app.query_one("#search-status", Static)
    for _ in range(50):
        if str(status.content) != "Searching…":
            return
        await pilot.pause()


class TestSummary:
    def test_pluralises_correctly(self) -> None:
        one_hit = (SearchHit("a.py", 1, "x"),)
        two_hits_one_file = (SearchHit("a.py", 1, "x"), SearchHit("a.py", 2, "y"))
        two_hits_two_files = (SearchHit("a.py", 1, "x"), SearchHit("b.py", 1, "y"))

        assert _summary(one_hit) == "1 match in 1 file"
        assert _summary(two_hits_one_file) == "2 matches in 1 file"
        assert _summary(two_hits_two_files) == "2 matches in 2 files"


class TestEmptyState:
    async def test_shows_a_plain_prompt_before_any_search(self, backend) -> None:
        app = _HostApp(backend)
        async with app.run_test() as pilot:
            await pilot.pause()
            status = str(app.query_one("#search-status", Static).content)

        assert "search" in status.lower() or "query" in status.lower()
        assert backend.called("search") == []

    async def test_submitting_an_empty_query_does_not_search(self, backend) -> None:
        app = _HostApp(backend)
        async with app.run_test() as pilot:
            await pilot.pause()
            await _submit(pilot, "   ")

        assert backend.called("search") == []

    async def test_a_query_with_no_hits_says_so_plainly(self, backend) -> None:
        backend.files = {"README.md": "nothing interesting here\n"}
        app = _HostApp(backend)
        async with app.run_test() as pilot:
            await pilot.pause()
            await _submit(pilot, "xyzzy")
            status = str(app.query_one("#search-status", Static).content)

        assert "no matches" in status.lower()
        assert "xyzzy" in status


class TestSearching:
    async def test_shows_the_match_and_file_count(self, backend) -> None:
        backend.files = {
            "a.py": "value = 1\nvalue = 2\n",
            "b.py": "value = 3\n",
            "c.py": "nothing here\n",
        }
        app = _HostApp(backend)
        async with app.run_test() as pilot:
            await pilot.pause()
            await _submit(pilot, "value")
            status = str(app.query_one("#search-status", Static).content)

        assert status == "3 matches in 2 files"

    async def test_never_claims_to_be_a_regex_search(self, backend) -> None:
        app = _HostApp(backend)
        async with app.run_test() as pilot:
            await pilot.pause()
            placeholder = app.query_one(Input).placeholder

        assert "regex" not in placeholder.lower() or "not a regex" in placeholder.lower()
        assert "plain text" in placeholder.lower()

    async def test_a_backend_failure_is_shown_rather_than_raised(self, backend) -> None:
        backend.fail_with = AgentError("workspace not configured")
        app = _HostApp(backend)
        async with app.run_test() as pilot:
            await pilot.pause()
            await _submit(pilot, "value")
            status = str(app.query_one("#search-status", Static).content)

        assert "workspace not configured" in status

    async def test_selecting_a_hit_posts_its_path_and_line(self, backend) -> None:
        backend.files = {"src/app.py": "def main():\n    return 1\n"}
        app = _HostApp(backend)
        async with app.run_test() as pilot:
            await pilot.pause()
            await _submit(pilot, "return")
            results = app.query_one(ListView)
            # Row 0 is the file-name header ("src/app.py"); row 1 is the one real hit.
            # `ListView`'s own `enter` binding (`select_cursor`) only fires while the list
            # itself is focused — Enter on the still-focused search box would just resubmit
            # the query — so the test moves focus the same way a mouse click or Tab would.
            results.index = 1
            results.focus()
            await pilot.press("enter")
            await pilot.pause()

        assert app.selected == ("src/app.py", 2)

    async def test_selecting_a_file_header_row_does_nothing(self, backend) -> None:
        backend.files = {"src/app.py": "def main():\n    return 1\n"}
        app = _HostApp(backend)
        async with app.run_test() as pilot:
            await pilot.pause()
            await _submit(pilot, "return")
            results = app.query_one(ListView)
            results.index = 0  # the header row
            results.focus()
            await pilot.press("enter")
            await pilot.pause()

        assert app.selected is None

    async def test_results_are_grouped_by_file_in_order(self, backend) -> None:
        backend.files = {
            "a.py": "target = 1\n",
            "b.py": "target = 2\ntarget = 3\n",
        }
        app = _HostApp(backend)
        async with app.run_test() as pilot:
            await pilot.pause()
            await _submit(pilot, "target")
            results = app.query_one(ListView)
            rendered = [str(item.query_one(Label).content) for item in results.children]

        # One header row per file, immediately followed by that file's hit rows, in the same
        # order `FakeBackend.search` returns them (sorted by path). b.py's two hits are on
        # its own lines 1 and 2 — each file's line numbers start over, they are not a
        # running count across the whole result set.
        assert rendered[0] == "a.py"
        assert "1:" in rendered[1]
        assert rendered[2] == "b.py"
        assert "1:" in rendered[3]
        assert "2:" in rendered[4]
