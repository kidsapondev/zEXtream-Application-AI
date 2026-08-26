"""Git integration: everything the app knows about the workspace's repository state.

Every git invocation goes through `CoderBackend.exec("git", [...])`, never `subprocess`
directly. The backend's `exec` is sandboxed to the workspace root and allowlisted by an
operator-controlled config (see `protocols.py:CoderBackend.exec`, and the "Never allowlist a
shell" invariant in the workspace-coding skill) — reaching around it here would give this one
module more system access than the rest of the app has, for a feature that does not need it.

`git status --porcelain=v1 -b -z` is the only status source, and `-z` is not a cosmetic
choice. Without it, git quotes any filename containing a space, a tab, or a non-ASCII byte in
C-style escapes (`"a b.py"`), and a naive line-`split()` would then either corrupt the path or
split one entry into two — exactly the paths a user most needs to see rendered correctly. `-z`
instead NUL-terminates every record, branch header included, and leaves filenames completely
unquoted, at the cost of the output no longer being newline-delimited text.

Not being a git repository is treated as an ordinary state throughout, never as an error: the
workspace is very often a plain folder someone pointed `BRIDGE_WORKSPACE_ROOT` at (see
`review.py`'s module docstring, which makes the same point about the review gate). Every
method here degrades to an empty/harmless result in that case instead of raising, so a caller
can call this unconditionally and just render "not a repository" for an empty status.
"""

from __future__ import annotations

import re
from dataclasses import dataclass

from .diff import DiffLine, unified_diff
from .protocols import AgentError, CoderBackend

# Matches the two optional counts in `## main...origin/main [ahead 1, behind 2]`. The two
# regexes are independent, not one regex with two optional groups, because either count can be
# present without the other: a branch that is only ahead prints `[ahead 1]`, only behind prints
# `[behind 2]`, and a branch with no upstream prints no brackets at all.
_AHEAD_RE = re.compile(r"ahead (\d+)")
_BEHIND_RE = re.compile(r"behind (\d+)")

# Status characters that mean "nothing here" rather than "a real change" in the index column.
# "!" (ignored) is included for completeness even though plain `--porcelain` without
# `--ignored` never actually emits it.
_CLEAN = (" ", "?", "!")

# git reports a rename or copy by putting R or C in either the index or work-tree status
# column; whichever one it is, that entry carries a second NUL-terminated field (the original
# path) instead of the usual single "XY path" record.
_RENAME_STATUSES = ("R", "C")


@dataclass(frozen=True, slots=True)
class GitFile:
    """One line of `git status`, already split into its two status columns.

    `path` is the *current* path. A rename's original path is consumed while parsing (see
    `_parse_entries`) but not kept here: the tree/gutter this feeds only ever needs to say
    where a file is now, so a renamed entry renders as its new path only. If a "renamed from"
    caption is ever wanted, add the field then rather than carrying it unused everywhere
    until that day.
    """

    path: str
    index_status: str  # column X: staged / index state. " " when the index matches HEAD.
    work_status: str  # column Y: work-tree state. " " when the file matches the index.

    @property
    def staged(self) -> bool:
        """True when there is something in the index git would commit right now."""
        return self.index_status not in _CLEAN

    @property
    def untracked(self) -> bool:
        """`??` — git has never seen this path before, in the index or in a prior commit."""
        return self.index_status == "?" and self.work_status == "?"

    @property
    def label(self) -> str:
        """What a tree gutter shows: "M", "A", "??", "MM" — whichever columns are non-blank.

        Built by stripping the blank column rather than by a lookup table, because the two
        columns combine freely — a file can be staged-modified *and* further modified in the
        work tree since, hence "MM" — and a table would need one entry per combination
        instead of one rule that works for all of them, including ones nobody has hit yet.
        """
        return f"{self.index_status}{self.work_status}".strip()


@dataclass(frozen=True, slots=True)
class GitStatus:
    """The whole-repo picture a panel renders in one pass.

    `branch` is `None` for two situations this type cannot tell apart on its own — detached
    HEAD, and "this folder is not a git repository at all" — and that is fine, because
    `GitRepo.status()` never actually returns this for the second case by accident; it
    constructs exactly this empty shape on purpose. See `GitRepo.status`.
    """

    branch: str | None
    files: tuple[GitFile, ...]
    ahead: int = 0
    behind: int = 0


def _parse_branch_line(line: str) -> tuple[str | None, int, int]:
    """Parses the `## ...` header that `-b` adds to porcelain output.

    Handles every shape git actually emits here: a tracked branch with a divergence count
    (`## main...origin/main [ahead 1, behind 2]`), a tracked branch with none
    (`## main...origin/main`), a branch with no upstream configured at all (`## main`), a
    brand new repository with no commits yet (`## No commits yet on main`), and detached HEAD
    (`## HEAD (no branch)`).
    """
    # `status()` only calls this after confirming the token starts with "##", but the space
    # after it is not equally guaranteed by that check alone, so both prefixes are handled
    # rather than assuming the longer one.
    rest = line[3:] if line.startswith("## ") else line[2:]

    if rest.startswith("HEAD (no branch)"):
        return None, 0, 0

    # A fresh repository has no HEAD to compare against, so ahead/behind are meaningless here
    # — but the branch name itself is still worth surfacing, since a title line with nothing
    # in it reads like a bug rather than like "you haven't committed yet".
    prefix = "No commits yet on "
    if rest.startswith(prefix):
        rest = rest[len(prefix) :]

    ahead_match = _AHEAD_RE.search(rest)
    behind_match = _BEHIND_RE.search(rest)
    ahead = int(ahead_match.group(1)) if ahead_match else 0
    behind = int(behind_match.group(1)) if behind_match else 0

    # The branch name is whatever precedes the first "..." (upstream separator) or the first
    # " [" (divergence bracket), whichever appears first — a branch with no upstream and no
    # divergence has neither marker, and the whole remainder is the name.
    name = rest
    for marker in ("...", " ["):
        index = name.find(marker)
        if index != -1:
            name = name[:index]
            break

    return name, ahead, behind


def _parse_entries(tokens: list[str]) -> tuple[GitFile, ...]:
    """Turns the NUL-split records *after* the branch header into `GitFile`s.

    Each record is normally `"XY path"` — two status characters, a space, then the path
    verbatim, unquoted because `-z` was passed. A rename or copy (X or Y is `R`/`C`) is the
    one exception: git emits the *new* path in this record and the *original* path as a
    completely separate record immediately after it, with no status prefix of its own. That
    second record has to be consumed here, or every entry after a rename would parse one
    record out of alignment with reality — but it is discarded rather than attached to the
    `GitFile`, so a rename shows up as its new path only (see the `GitFile.path` docstring).
    """
    files: list[GitFile] = []
    index = 0
    while index < len(tokens):
        token = tokens[index]
        index += 1
        if not token:
            # `str.split("\0")` leaves one trailing empty string when the output itself ends
            # in a NUL, which it always does; skip it instead of choking on a record with no
            # status columns to read.
            continue

        index_status, work_status = token[0], token[1]
        path = token[3:]
        files.append(GitFile(path=path, index_status=index_status, work_status=work_status))

        if index_status in _RENAME_STATUSES or work_status in _RENAME_STATUSES:
            index += 1  # Skip the original-path record; see the docstring above.

    return tuple(files)


class GitRepo:
    """Everything the app knows how to ask git for, expressed against `CoderBackend.exec`."""

    def __init__(self, backend: CoderBackend) -> None:
        self._backend = backend

    async def is_repo(self) -> bool:
        """Whether the workspace root is inside a git working tree.

        `rev-parse --is-inside-work-tree` is what git itself uses internally to answer exactly
        this question, and it is the cheapest possible call: no status computation, no
        diffing, just a look at the filesystem for a `.git`. A non-zero exit — git's own
        "fatal: not a git repository" — means no, on equal footing with the command timing out
        or the workspace root not existing at all; neither case is worth telling apart from
        the caller's point of view.
        """
        result = await self._backend.exec("git", ["rev-parse", "--is-inside-work-tree"])
        return result.ok and result.stdout.strip() == "true"

    async def status(self) -> GitStatus:
        """The branch line plus every changed file, from one `git status` call.

        Checks `is_repo()` first rather than just running `status --porcelain` and reading its
        exit code, because a plain folder and a broken git repository can both make that
        command fail — and collapsing "not a repository" (expected, common, silent) into the
        same path as "git itself is broken" (rare, worth surfacing differently) would hide the
        second behind the first. In both branches the return shape is identical, on purpose:
        nothing downstream needs to tell "no repo" apart from "repo, nothing to report".
        """
        if not await self.is_repo():
            return GitStatus(branch=None, files=())

        result = await self._backend.exec("git", ["status", "--porcelain=v1", "-b", "-z"])
        if not result.ok:
            return GitStatus(branch=None, files=())

        tokens = result.stdout.split("\0")
        if not tokens or not tokens[0].startswith("##"):
            # Should not happen given `-b` was passed, but a status with no parseable branch
            # header is more useful reported as "no files, no branch" than as a crash deep in
            # a Textual message handler.
            return GitStatus(branch=None, files=())

        branch, ahead, behind = _parse_branch_line(tokens[0])
        files = _parse_entries(tokens[1:])
        return GitStatus(branch=branch, files=files, ahead=ahead, behind=behind)

    async def diff(self, path: str) -> tuple[DiffLine, ...]:
        """Working tree vs `HEAD` for one file, built with `diff.py`'s differ — not git's own.

        The repo already has one tested unified-diff implementation that attaches per-side
        line numbers a widget can render (`diff.py:unified_diff`), the same one `review.py`
        uses for the model's own edits. Parsing `git diff`'s text output here would mean
        maintaining a second, untested implementation of the same idea that could silently
        drift from the first over time — two differs is a strictly worse bet than one extra
        `git show` call to fetch the old side as plain text.
        """
        if not await self.is_repo():
            return ()

        before_result = await self._backend.exec("git", ["show", f"HEAD:{path}"])
        # A non-zero exit here is not necessarily wrong: it is exactly what `git show` returns
        # for a path that is new (untracked, or staged but never committed, so absent from
        # HEAD) and for a brand new repository with no commits at all. Either way "no old
        # content" is the correct diff baseline for those cases, not an error to surface.
        before = before_result.stdout if before_result.ok else ""

        try:
            after = (await self._backend.read_file(path)).text
        except AgentError:
            # The file exists in HEAD but not on disk any more — a deleted-but-uncommitted
            # file. The right diff for that is all-removals, which an empty "after" produces.
            after = ""

        return unified_diff(before, after, path=path)

    async def stage(self, path: str) -> None:
        await self._backend.exec("git", ["add", "--", path])

    async def unstage(self, path: str) -> None:
        # `restore --staged` rather than the older `reset -- <path>`: both unstage exactly one
        # path with no other side effect, but `reset` with no ref reads, at a glance, like
        # "reset the branch" to anyone skimming this call site — `restore --staged` says
        # exactly what it does in its own name.
        await self._backend.exec("git", ["restore", "--staged", "--", path])

    async def commit(self, message: str) -> str:
        """Commits whatever is currently staged and returns git's own one-line summary.

        Nothing staged is the single most likely way to fail from this panel: the commit
        input is always visible whether or not anything was staged first. git reports that
        case as a non-zero exit with an explanatory line on stdout (not stderr), so it is
        matched here and turned into a message that says what happened, rather than surfacing
        a bare "exit code 1" the user would have to go read a terminal to understand.
        """
        result = await self._backend.exec("git", ["commit", "-m", message])
        if not result.ok:
            combined = f"{result.stdout}\n{result.stderr}".lower()
            if "nothing to commit" in combined or "no changes added to commit" in combined:
                raise AgentError("Nothing staged to commit.")
            detail = (result.stderr or result.stdout).strip() or "unknown error"
            raise AgentError(f"git commit failed: {detail}")

        # git's own first stdout line is already a one-line summary, e.g.
        # "[main a1b2c3d] the message" — exactly what a status line wants, so it is returned
        # as-is instead of being reformatted into a second, possibly-drifting version of it.
        first_line = result.stdout.strip().splitlines()
        return first_line[0] if first_line else result.stdout.strip()

    async def revert_file(self, path: str) -> None:
        """Discards uncommitted changes to `path` by restoring it from the index.

        `checkout -- <path>` rather than the newer `restore <path>`: both discard the
        working-tree change identically, but `checkout` is the long-established spelling for
        exactly this operation and the one most git users already reach for by habit, which
        is worth favouring for a command this destructive and offered with no confirmation
        step in front of it.
        """
        await self._backend.exec("git", ["checkout", "--", path])
