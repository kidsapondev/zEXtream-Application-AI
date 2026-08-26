"""A flat, fuzzy-matchable index of every file path in the workspace.

Backs the "Search Everywhere" file finder: WebStorm-style navigation where you type a few
scattered letters of a path and jump straight to the file, instead of clicking down the tree
one directory at a time.

Built once by walking `CoderBackend.list_dir` recursively (see `build`), then matched against
entirely in memory — no further backend calls happen on each keystroke. That split matters
for the same reason `WorkspaceTree` caches directory listings (see `workspace.py`): each
`list_dir` call is a JSON-RPC round trip over stdio to a subprocess in the real app (see
`McpBackend` in `mcp_client.py`), and a finder that re-walked the tree per keystroke would put
that round trip directly in the render path of every character typed.

Nothing here imports Textual. Like `workspace.py`, this is state and pure logic; the widget in
`ui/file_finder.py` only renders it.
"""

from __future__ import annotations

from dataclasses import dataclass

from .protocols import CoderBackend
from .workspace import should_ignore

#: Characters that mark the start of a new "word" inside a path, in the fuzzy-matcher sense.
#: A matched character right after one of these reads, to a person scanning the result list,
#: as the start of a meaningful segment ("app" in "local_coder/app.py") rather than a hit
#: buried mid-word ("app" inside "snapshot.py") — so it earns a scoring bonus. Kept as its own
#: constant rather than inlined into the score loop because the highlighting UI may eventually
#: want the same notion of "boundary" that the scorer uses.
_WORD_BOUNDARY_CHARS = frozenset({"/", "_", "-", "."})


@dataclass(frozen=True, slots=True)
class Match:
    """One path that satisfied a fuzzy query, with enough detail for the UI to render it.

    `positions` are indices into `path`, not into the query — that is what lets the finder
    widget highlight exactly the characters that matched without re-running the match itself.
    """

    path: str
    score: int
    positions: tuple[int, ...]


def _match_positions(path: str, query: str) -> tuple[int, ...] | None:
    """Greedy, leftmost, case-insensitive subsequence match.

    For each character of `query` in order, find its first occurrence in `path` at or after
    the current search cursor, then advance the cursor past it. If any query character has no
    remaining occurrence, `query` is not a subsequence of `path` at all and this returns
    `None` — the standard fuzzy-finder test ("lcapp" matches "local_coder/app.py" because
    l-c-a-p-p appear in that order somewhere in the string, not necessarily touching).

    Deliberately the simplest correct algorithm rather than an optimal-alignment search
    (dynamic programming over every possible assignment of query chars to path positions):
    greedy-leftmost is O(len(path)) per candidate, is easy to reason about, and — because the
    scoring below rewards consecutive runs and word boundaries — a leftmost pick already tends
    to land on the "obvious" alignment a person would expect in the cases that matter (a whole
    query substring sitting inside one path segment). It will occasionally pick a locally
    earlier, lower-scoring position over a later, better one within the *same* path when a
    character repeats; nothing here promises a scoring-optimal alignment, only a scoring-
    consistent one across different paths for the same query, which is what ranking needs.
    """
    positions: list[int] = []
    search_start = 0
    path_lower = path.lower()
    for character in query.lower():
        index = path_lower.find(character, search_start)
        if index == -1:
            return None
        positions.append(index)
        search_start = index + 1
    return tuple(positions)


def _score(path: str, positions: tuple[int, ...], query: str) -> int:
    """Points for one already-found match, favouring the alignments a person expects.

    Each matched position can earn several bonuses at once; they are summed rather than
    picking "the" reason a character scored well, because a character that is both the start
    of the file name *and* the start of a consecutive run *and* an exact-case hit really is a
    better signal than one with only one of those properties.
    """
    # Everything at or after the last "/" is the file name; with no "/" at all, `rfind`
    # returns -1 and `name_start` is 0, so the whole path counts as "the name" — there is no
    # directory to be worse than.
    name_start = path.rfind("/") + 1

    score = 0
    for query_index, position in enumerate(positions):
        score += 1  # A bare match is still worth something over no match at all.

        if query[query_index] == path[position]:
            # Reward typing the path's actual case: it is more likely the user already knows
            # roughly what they are looking for than that they are guessing blind.
            score += 2

        if position >= name_start:
            # A hit in the file name itself is what the user is almost always looking for;
            # a hit that only lives in the enclosing directory path is a weaker signal — see
            # `TestScoringOrder.test_filename_match_outranks_directory_match`.
            score += 3

        if query_index > 0 and position == positions[query_index - 1] + 1:
            # Adjacent matched characters read as "the thing the user actually typed", not a
            # coincidence of scattered letters — the strongest single signal fuzzy matching
            # has, which is why it outweighs even the file-name bonus above.
            score += 5

        if position == 0 or path[position - 1] in _WORD_BOUNDARY_CHARS:
            score += 4

    return score


class FileIndex:
    """Walks the workspace once, then answers fuzzy queries entirely from memory."""

    def __init__(self, backend: CoderBackend, *, max_files: int = 20_000) -> None:
        self._backend = backend
        # A hard stop, not a tuning knob. `build` below is a recursive walk that issues one
        # `list_dir` per directory, and each of those is a real round trip through a
        # subprocess in the shipped app. A workspace root pointed at something large (a
        # monorepo, a node_modules-adjacent checkout with the ignore list not covering
        # everything) would otherwise turn "open the file finder" into "the UI hangs for a
        # while first" — the opposite of what a quick-jump tool is for.
        self._max_files = max_files
        self._paths: tuple[str, ...] = ()

    async def build(self, root: str = "") -> tuple[str, ...]:
        """Recursively collects every non-ignored file path under `root`.

        Ignored directories (`should_ignore`, the same rule `WorkspaceTree` uses so the
        finder never offers a path the tree itself would hide) are skipped *before* recursing
        into them — `list_dir` is never called on one at all, not just filtered out of the
        result afterwards. That is the difference between one wasted round trip and however
        many a deep `node_modules` or `.git` would otherwise cost.
        """
        collected: list[str] = []
        await self._walk(root, collected)
        self._paths = tuple(collected)
        return self._paths

    async def _walk(self, path: str, collected: list[str]) -> None:
        if len(collected) >= self._max_files:
            return
        entries = await self._backend.list_dir(path)
        for entry in entries:
            if should_ignore(entry.name):
                continue
            if entry.is_dir:
                await self._walk(entry.path, collected)
            else:
                collected.append(entry.path)
            # Checked after every single entry, not once per directory: a directory holding
            # more files than the remaining budget must not blow straight through the cap
            # just because the check only ran before the loop started.
            if len(collected) >= self._max_files:
                return

    def paths(self) -> tuple[str, ...]:
        """Every path from the last `build()`, or `()` if it has never run."""
        return self._paths

    def invalidate(self) -> None:
        """Forgets the built index. Call after an agent run has changed the tree on disk.

        Does not touch the backend or re-walk anything — callers decide when a rebuild is
        worth the round trips, the same division of responsibility as
        `WorkspaceTree.invalidate` versus `WorkspaceTree.refresh`.
        """
        self._paths = ()

    def match(self, query: str, *, limit: int = 30) -> tuple[Match, ...]:
        """Fuzzy-ranked paths for `query`, best match first.

        An empty query returns the first `limit` indexed paths rather than nothing: the
        finder opens showing something to scroll through, not a panel that looks broken until
        the user types.
        """
        if not query:
            return tuple(
                Match(path=path, score=0, positions=()) for path in self._paths[:limit]
            )

        matches: list[Match] = []
        for path in self._paths:
            positions = _match_positions(path, query)
            if positions is None:
                continue
            matches.append(Match(path=path, score=_score(path, positions, query), positions=positions))

        # Highest score first; a shorter path breaks an otherwise exact tie (it is the
        # smaller, more specific target — see `test_shorter_path_breaks_an_otherwise_equal_tie`).
        # Path text is the final tiebreaker purely so the order is fully deterministic and
        # tests never depend on Python's stable-sort input order by accident.
        matches.sort(key=lambda match: (-match.score, len(match.path), match.path))
        return tuple(matches[:limit])
