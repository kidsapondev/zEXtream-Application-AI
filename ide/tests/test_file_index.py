"""Specification for `local_coder.file_index`.

Written before the module, to be handed to the local model as its brief (see the delegation
playbook in `.claude/skills/gpu-workspace-coding/SKILL.md`). Runs entirely against
`FakeBackend` from `conftest.py` — no subprocess, no Ollama, no real files.

The scoring tests deliberately assert *relative order* ("this path ranks above that one"),
not hand-picked magic numbers. Pinning exact scores would make the test suite as fragile as
the implementation and would not actually describe the rule being tested. Each pair of paths
below is constructed so that exactly one property differs between them (name-vs-directory,
consecutive-vs-scattered, boundary-vs-mid-word, or length) — everything else about the two
paths is held equal, so a passing test can only mean the one property under test moved the
score.
"""

from __future__ import annotations

from local_coder.file_index import FileIndex, Match


class TestBuild:
    async def test_recursive_build_finds_nested_files(self, backend) -> None:
        backend.files["a/b/c/deep.py"] = "x = 1\n"
        index = FileIndex(backend)

        paths = await index.build()

        assert "a/b/c/deep.py" in paths
        assert paths == index.paths()

    async def test_skips_ignored_directories_entirely(self, backend) -> None:
        # Junk that `should_ignore` (from workspace.py) hides from the tree must never even
        # be walked into — not just filtered out afterwards. Asserting on the list_dir call
        # log, not just the result, is what proves the walk never descended into them: a
        # naive "filter after the fact" implementation would pass a result-only check.
        backend.files["__pycache__/app.cpython-313.pyc"] = "junk"
        backend.files[".git/config"] = "junk"
        backend.files["src/app.py"] = "def main(): ...\n"
        index = FileIndex(backend)

        paths = await index.build()

        assert "src/app.py" in paths
        assert not any("__pycache__" in path for path in paths)
        assert not any(".git" in path for path in paths)
        visited = {call[0] for call in backend.called("list_dir")}
        assert "__pycache__" not in visited
        assert ".git" not in visited

    async def test_max_files_stops_the_walk(self, backend) -> None:
        # A hard stop, not a tuning knob: `build` is a round trip per directory through a
        # subprocess (see McpBackend), so an unbounded walk on a real, huge checkout would
        # hang the UI on open rather than show a finder the user can already type into.
        backend.files = {f"file{n}.txt": "x" for n in range(10)}
        index = FileIndex(backend, max_files=3)

        paths = await index.build()

        assert len(paths) == 3

    async def test_build_return_value_matches_paths(self, backend) -> None:
        index = FileIndex(backend)

        built = await index.build()

        assert built == index.paths()

    async def test_paths_is_empty_before_build(self, backend) -> None:
        assert FileIndex(backend).paths() == ()

    async def test_invalidate_clears_the_index(self, backend) -> None:
        index = FileIndex(backend)
        await index.build()
        assert index.paths() != ()

        index.invalidate()

        assert index.paths() == ()


class TestMatchBasics:
    async def test_empty_query_returns_the_first_paths_rather_than_nothing(self, backend) -> None:
        # The finder opens on an empty query. Returning nothing there would show a blank
        # panel with no way to tell it is working at all.
        backend.files = {f"file{n}.txt": "x" for n in range(5)}
        index = FileIndex(backend)
        await index.build()

        matches = index.match("", limit=3)

        assert len(matches) == 3
        assert all(isinstance(m, Match) for m in matches)
        assert all(m.path in index.paths() for m in matches)

    async def test_subsequence_match_across_directory_and_name(self, backend) -> None:
        # The characteristic fuzzy-finder case: every query character appears in the path,
        # in order, but not adjacently, and not all within one path segment.
        backend.files = {"local_coder/app.py": "x = 1\n"}
        index = FileIndex(backend)
        await index.build()

        matches = index.match("lcapp")

        assert [m.path for m in matches] == ["local_coder/app.py"]

    async def test_non_subsequence_does_not_match(self, backend) -> None:
        backend.files = {"local_coder/app.py": "x = 1\n"}
        index = FileIndex(backend)
        await index.build()

        # "z" never occurs in the path at all, so no ordering of characters can match it.
        matches = index.match("zzz")

        assert matches == ()

    async def test_positions_are_indices_into_the_full_path(self, backend) -> None:
        # A single, unambiguous file with no other candidate characters to choose between —
        # the one case where the exact position tuple is worth pinning literally.
        backend.files = {"app.py": "x = 1\n"}
        index = FileIndex(backend)
        await index.build()

        matches = index.match("app")

        assert len(matches) == 1
        assert matches[0].positions == (0, 1, 2)

    async def test_limit_caps_the_result_count(self, backend) -> None:
        backend.files = {f"app{n}.py": "x" for n in range(10)}
        index = FileIndex(backend)
        await index.build()

        matches = index.match("app", limit=4)

        assert len(matches) == 4


class TestScoringOrder:
    async def test_filename_match_outranks_directory_match(self, backend) -> None:
        # "app" is a subsequence of both paths below, once landing entirely inside the
        # directory segment and once entirely inside the file name — same characters, same
        # total path length, same leading-boundary and consecutive-run shape either way.
        # Only the name-vs-directory location differs, so only that can explain the order.
        backend.files = {
            "app/util.py": "x = 1\n",
            "util/app.py": "x = 1\n",
        }
        index = FileIndex(backend)
        await index.build()

        matches = index.match("app")

        assert [m.path for m in matches] == ["util/app.py", "app/util.py"]

    async def test_consecutive_run_outranks_scattered_characters(self, backend) -> None:
        # "ap" lands as an adjacent run in the first path and as two characters split by a
        # filler letter in the second. Both start at position 0 (so the leading-boundary
        # bonus is identical), both are the whole path (so there is no name/directory
        # distinction to confound the comparison) — only adjacency differs.
        backend.files = {
            "apzz.py": "x = 1\n",
            "azpz.py": "x = 1\n",
        }
        index = FileIndex(backend)
        await index.build()

        matches = index.match("ap")

        assert [m.path for m in matches] == ["apzz.py", "azpz.py"]

    async def test_word_boundary_match_outranks_mid_word_match(self, backend) -> None:
        # "c" sits right after a separator (`_`) in the first path and mid-word (after a
        # plain letter) in the second — same path length, same single matched character,
        # only its boundary status differs.
        backend.files = {
            "x_c.py": "x = 1\n",
            "xxc.py": "x = 1\n",
        }
        index = FileIndex(backend)
        await index.build()

        matches = index.match("c")

        assert [m.path for m in matches] == ["x_c.py", "xxc.py"]

    async def test_exact_case_match_outranks_case_insensitive_match(self, backend) -> None:
        # Both paths match the lowercase query "app" only case-insensitively-or-better; the
        # first matches with the query's exact case, the second only after folding case.
        # Structurally identical otherwise (no directory, same length, same positions).
        backend.files = {
            "app.py": "x = 1\n",
            "APP.PY": "x = 1\n",
        }
        index = FileIndex(backend)
        await index.build()

        matches = index.match("app")

        assert [m.path for m in matches] == ["app.py", "APP.PY"]

    async def test_shorter_path_breaks_an_otherwise_equal_tie(self, backend) -> None:
        # "app" matches immediately after the directory separator in both paths, so name
        # location, boundary, consecutive-run, and exact-case bonuses are all identical
        # between them — the directories differ only in length ("src/" vs "test/").
        backend.files = {
            "src/app.py": "x = 1\n",
            "test/app.py": "x = 1\n",
        }
        index = FileIndex(backend)
        await index.build()

        matches = index.match("app")

        assert [m.path for m in matches] == ["src/app.py", "test/app.py"]
