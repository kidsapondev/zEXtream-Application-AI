"""Specification for `local_coder.workspace`.

Written before the module, to be handed to the local model as its brief. Everything here
runs against `FakeBackend` from `conftest.py` — no subprocess, no Ollama, no real files — so
the model can run this suite after every edit and get an answer in well under a second.

The module under test is the file-tree model behind the UI: it decides what is worth showing,
remembers what it has already fetched, and knows when to forget it.
"""

from __future__ import annotations

import pytest

from local_coder.protocols import EntryKind
from local_coder.workspace import DEFAULT_IGNORE, WorkspaceTree, should_ignore


class TestShouldIgnore:
    @pytest.mark.parametrize(
        "name",
        ["__pycache__", ".git", "node_modules", ".venv", "dist", ".pytest_cache"],
    )
    def test_hides_noise_directories(self, name: str) -> None:
        assert should_ignore(name) is True

    @pytest.mark.parametrize("name", ["src", "app.py", "README.md", ".env.example"])
    def test_keeps_real_files(self, name: str) -> None:
        assert should_ignore(name) is False

    def test_hides_compiled_python(self) -> None:
        assert should_ignore("module.pyc") is True
        assert should_ignore("module.py") is False

    def test_accepts_a_custom_ignore_set(self) -> None:
        assert should_ignore("logs", ignore=frozenset({"logs"})) is True
        # A custom set replaces the default rather than adding to it, so a caller can
        # deliberately show everything.
        assert should_ignore("__pycache__", ignore=frozenset()) is False

    def test_default_ignore_is_immutable(self) -> None:
        assert isinstance(DEFAULT_IGNORE, frozenset)


class TestLoad:
    async def test_returns_entries_for_the_root(self, backend) -> None:
        tree = WorkspaceTree(backend)

        entries = await tree.load()

        assert [entry.name for entry in entries] == ["src", "README.md"]
        assert entries[0].kind is EntryKind.DIR

    async def test_returns_entries_for_a_subdirectory(self, backend) -> None:
        tree = WorkspaceTree(backend)

        entries = await tree.load("src")

        assert [entry.name for entry in entries] == ["app.py", "util.py"]
        assert entries[0].path == "src/app.py"

    async def test_filters_ignored_names(self, backend) -> None:
        backend.files["__pycache__/app.pyc"] = "junk"
        backend.files["notes.txt"] = "keep"
        tree = WorkspaceTree(backend)

        names = [entry.name for entry in await tree.load()]

        assert "__pycache__" not in names
        assert "notes.txt" in names

    async def test_caches_so_a_second_load_does_not_hit_the_backend(self, backend) -> None:
        # The tree is redrawn on every keystroke in a filter box; re-listing the directory
        # each time would put a subprocess round trip in the render path.
        tree = WorkspaceTree(backend)

        await tree.load("src")
        await tree.load("src")

        assert len(backend.called("list_dir")) == 1

    async def test_caches_each_directory_separately(self, backend) -> None:
        tree = WorkspaceTree(backend)

        await tree.load("")
        await tree.load("src")

        assert len(backend.called("list_dir")) == 2


class TestRefreshAndInvalidate:
    async def test_refresh_bypasses_the_cache(self, backend) -> None:
        tree = WorkspaceTree(backend)
        await tree.load("src")

        entries = await tree.refresh("src")

        assert len(backend.called("list_dir")) == 2
        assert [entry.name for entry in entries] == ["app.py", "util.py"]

    async def test_refresh_picks_up_a_new_file(self, backend) -> None:
        # The case that matters: the local agent just wrote a file and the tree must show it.
        tree = WorkspaceTree(backend)
        await tree.load("src")
        backend.files["src/new.py"] = "x = 1\n"

        names = [entry.name for entry in await tree.refresh("src")]

        assert "new.py" in names

    async def test_invalidate_forces_the_next_load_to_refetch(self, backend) -> None:
        tree = WorkspaceTree(backend)
        await tree.load("src")

        tree.invalidate("src")
        await tree.load("src")

        assert len(backend.called("list_dir")) == 2

    async def test_invalidate_leaves_other_directories_cached(self, backend) -> None:
        tree = WorkspaceTree(backend)
        await tree.load("")
        await tree.load("src")

        tree.invalidate("src")
        await tree.load("")

        assert len(backend.called("list_dir")) == 2

    async def test_invalidate_all_clears_everything(self, backend) -> None:
        tree = WorkspaceTree(backend)
        await tree.load("")
        await tree.load("src")

        tree.invalidate_all()
        await tree.load("")

        assert len(backend.called("list_dir")) == 3


class TestCached:
    async def test_returns_none_before_a_directory_is_loaded(self, backend) -> None:
        assert WorkspaceTree(backend).cached("src") is None

    async def test_returns_the_entries_after_loading(self, backend) -> None:
        tree = WorkspaceTree(backend)
        loaded = await tree.load("src")

        assert tree.cached("src") == loaded

    async def test_reading_the_cache_never_touches_the_backend(self, backend) -> None:
        tree = WorkspaceTree(backend)
        await tree.load("src")
        before = len(backend.called("list_dir"))

        tree.cached("src")

        assert len(backend.called("list_dir")) == before
