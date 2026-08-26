"""The file-tree model behind the UI: what to show, what to remember, when to forget it.

Sits on top of `CoderBackend`, so it works identically against the real MCP-backed workspace
and against the in-memory fake the tests use. It holds no widgets and imports no UI library —
the tree is state, and Textual only renders it.

Written by the local model against `tests/test_workspace.py` and then tidied here: its logic
was correct, but it had carried three unused imports and had turned the task description into
docstrings. The comments below say why things are the way they are, which the brief could not.
"""

from __future__ import annotations

from collections.abc import Iterable

from local_coder.protocols import CoderBackend, Entry

#: Names never shown in the tree. Directories that are build output, dependency caches, or
#: version-control internals — the things that would otherwise dominate a listing and that
#: nobody navigates to on purpose.
#:
#: Deliberately a name list rather than a "hide anything starting with a dot" rule: dotfiles
#: are frequently the interesting ones in this repo (`.env.example`, `.gitignore`,
#: `.mcp.json.example`), and hiding them by pattern would make them unreachable in the UI.
DEFAULT_IGNORE = frozenset(
    {
        "__pycache__",
        ".git",
        "node_modules",
        ".venv",
        "dist",
        ".pytest_cache",
    }
)


def should_ignore(name: str, *, ignore: frozenset[str] = DEFAULT_IGNORE) -> bool:
    """True when `name` should be hidden from the tree.

    `ignore` replaces the default set rather than extending it, so a caller can pass an empty
    frozenset to show everything — useful when the thing you are looking for is precisely the
    file that is normally hidden.
    """
    # The `.pyc` suffix check is separate from the set because compiled files are named after
    # their source, so there is no fixed name to list.
    return name in ignore or name.endswith(".pyc")


class WorkspaceTree:
    """Directory listings, cached per path.

    The cache is not an optimisation detail: the tree is redrawn on every keystroke in a
    filter box, and each uncached listing is a JSON-RPC round trip to a subprocess. Without
    it, a stdio call sits in the render path.

    Nothing expires on a timer. Entries are dropped only when something is known to have
    changed — after an agent run, or on an explicit refresh — because a timer would either
    fire too often to help or too rarely to be correct.
    """

    def __init__(
        self,
        backend: CoderBackend,
        ignore: frozenset[str] = DEFAULT_IGNORE,
    ) -> None:
        self._backend = backend
        self._ignore = ignore
        self._cache: dict[str, tuple[Entry, ...]] = {}

    async def load(self, path: str = "") -> tuple[Entry, ...]:
        """Entries for `path`, from cache when available."""
        cached = self._cache.get(path)
        if cached is not None:
            return cached
        return await self.refresh(path)

    async def refresh(self, path: str = "") -> tuple[Entry, ...]:
        """Entries for `path`, always re-fetched.

        Call this after the local agent has run: it writes files directly to disk, so the
        cache is stale in exactly the moment the user most wants to see what changed.
        """
        entries = await self._backend.list_dir(path)
        visible = self._visible(entries)
        self._cache[path] = visible
        return visible

    def cached(self, path: str) -> tuple[Entry, ...] | None:
        """What is already known about `path`, or `None` if it has never been loaded.

        Synchronous and side-effect free by design — a render pass can call it freely, and a
        `None` means "draw a placeholder", not "go and fetch".
        """
        return self._cache.get(path)

    def invalidate(self, path: str) -> None:
        """Forget one directory. Forgetting an unknown path is not an error."""
        self._cache.pop(path, None)

    def invalidate_all(self) -> None:
        """Forget everything — after a branch switch, or any change of workspace root."""
        self._cache.clear()

    def _visible(self, entries: Iterable[Entry]) -> tuple[Entry, ...]:
        return tuple(
            entry for entry in entries if not should_ignore(entry.name, ignore=self._ignore)
        )
