"""Code intelligence: a Language Server Protocol client, spoken over stdio.

This is what turns the editor pane into an IDE — diagnostics while you type, completion,
hover, go-to-definition — without this package knowing anything about any particular
language. A language server does the understanding; this file only carries messages.

Standard library only, for the same reason `mcp_client.py` refuses the MCP SDK: `pygls` and
`lsprotocol` are large, fast-moving dependencies that would exist here to model a wire format
that is about two hundred lines and has not changed in years. Worse, most of this package is
written by a locally-hosted 14B model against pinned versions (see `pyproject.toml`), and a
dependency whose API the model half-remembers is exactly the failure `pyproject.toml` pins
versions to avoid.

**LSP is not newline-delimited JSON.** This is the single most important sentence in the
file. `mcp_client.py` is the closest model for everything else here, and its stdout reader
splits on `\\n` — correct for NDJSON, catastrophic here. LSP frames every message
HTTP-style::

    Content-Length: 245\\r\\n
    \\r\\n
    {"jsonrpc":"2.0", ... }

A JSON body legitimately contains newlines (any diagnostic message quoting source does), so
the length prefix is the *only* thing that says where a message ends. Splitting on newlines
does not raise, does not warn, and does not time out at the transport level: it simply never
produces a complete message, and the client hangs at the handshake forever. `MessageBuffer`
below reads exactly `Content-Length` bytes after the blank line and nothing else does.

Three more things that are easy to get wrong, all commented where they happen:

* **Diagnostics are a notification, not a response.** `textDocument/publishDiagnostics`
  arrives unprompted and carries no `id`. A dispatcher that only matches responses to pending
  futures drops it silently — the symptom is a Problems panel that stays empty forever, which
  looks like a server that never analysed anything.
* **LSP positions are 0-based on both axes.** Everything else in this package is 1-based
  (`SearchHit.line`, `DiffLine.old_line`, every editor on earth). The conversion happens
  exactly twice — `to_editor_position` on the way in, `to_lsp_position` on the way out — and
  nowhere else. Anything holding a `Diagnostic`, `Location` or `Completion` is holding
  1-based numbers.
* **Paths cross the wire as `file://` URIs**, and on Windows that means `file:///D:/x/y.py`:
  three slashes, forward separators, and the drive colon left unencoded. Two slashes makes
  `D:` a hostname. `path_to_uri` / `uri_to_path` are the only two places that know this.

Lifetime is handled the way `mcp_client.py` handles it, for the reasons documented there:
both pipes are drained by their own task for the whole life of the process (a child whose
stderr buffer fills blocks forever mid-write), and every exit path — success, exception,
cancellation — goes through `close()`, which terminates the child and waits for it.
"""

from __future__ import annotations

import asyncio
import json
import os
import re
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Callable, Iterable, Mapping, Sequence
from urllib.parse import quote, unquote

from .protocols import AgentError

# The handshake is a local process answering one message. If it has not replied in this long
# the server is not coming up — usually a binary that starts, prints a usage message and
# exits, which produces no error on our side at all without this bound.
_HANDSHAKE_TIMEOUT = 30.0

# Completion against a cold server can genuinely take seconds: pyright indexes the workspace
# on first request, and the first hover after that is often the slowest call of the session.
# This is a guard against a wedged server, not a latency target.
_REQUEST_TIMEOUT = 15.0

_TERMINATE_GRACE = 5.0

#: Seconds of quiet before a document's pending text is sent.
#:
#: `did_change` on every keystroke is the normal LSP pattern, and full-document sync means
#: every one of those carries the entire file. At 60 keystrokes in a burst that is 60 copies
#: of the buffer pushed through a pipe and re-parsed, to answer questions about 59 states the
#: user never looked at.
#:
#: 250 ms is chosen against two numbers, not by taste. Continuous typing runs at roughly a
#: 100–150 ms gap between keystrokes, so anything at or above ~200 ms collapses a burst into
#: a single send. And the perceptual threshold where a pause starts to read as lag rather
#: than as the tool thinking is around 400 ms, so staying well under that keeps diagnostics
#: feeling attached to the typing. Lower is not free: each send costs a full re-parse.
_DEFAULT_DEBOUNCE = 0.25

#: Severity names, worst first. This order *is* `severity_rank`, and `ProblemsPanel` sorts by
#: it — the tuple is the single definition of "worse", so adding a level means editing one
#: line rather than hunting for comparison functions.
SEVERITIES: tuple[str, ...] = ("error", "warning", "info", "hint")

#: `DiagnosticSeverity` from the LSP spec. 1 is the most severe, which is the opposite of how
#: it reads.
_SEVERITY_NAMES: dict[int, str] = {1: "error", 2: "warning", 3: "info", 4: "hint"}

#: `CompletionItemKind`. Servers send the number; the UI wants a word. Values outside this
#: table are not an error — the enum grows between spec versions — so parsing falls back to
#: "text" rather than raising on a kind nobody has seen yet.
_COMPLETION_KINDS: dict[int, str] = {
    1: "text",
    2: "method",
    3: "function",
    4: "constructor",
    5: "field",
    6: "variable",
    7: "class",
    8: "interface",
    9: "module",
    10: "property",
    11: "unit",
    12: "value",
    13: "enum",
    14: "keyword",
    15: "snippet",
    16: "color",
    17: "file",
    18: "reference",
    19: "folder",
    20: "enum-member",
    21: "constant",
    22: "struct",
    23: "event",
    24: "operator",
    25: "type-parameter",
}

#: How to install the servers a user of this app is most likely to want.
#:
#: This table is the difference between "FileNotFoundError: [WinError 2]" and a line the user
#: can paste. It matters more than it looks: **no language server is installed on this machine
#: by default**, so the missing-binary path is the first one a new user takes, not an edge
#: case reached after something goes wrong.
_INSTALL_HINTS: dict[str, str] = {
    "pyright-langserver": "npm install -g pyright",
    "pyright": "npm install -g pyright",
    "basedpyright-langserver": "pip install basedpyright",
    "typescript-language-server": "npm install -g typescript-language-server typescript",
    "vscode-json-language-server": "npm install -g vscode-langservers-extracted",
    "vscode-html-language-server": "npm install -g vscode-langservers-extracted",
    "vscode-css-language-server": "npm install -g vscode-langservers-extracted",
    "bash-language-server": "npm install -g bash-language-server",
    "ruff": "pip install ruff",
    "ruff-lsp": "pip install ruff-lsp",
    "gopls": "go install golang.org/x/tools/gopls@latest",
    "rust-analyzer": "rustup component add rust-analyzer",
    "clangd": "install LLVM — clangd ships with it",
}

#: Extension (no dot, lowercased) to LSP `languageId`.
#:
#: The vocabulary is the protocol's, not this app's — "typescriptreact", "shellscript" and
#: "bat" are the exact strings servers match on, and a plausible-looking "tsx" or "shell"
#: would be accepted silently and then handled by nothing.
_LANGUAGE_IDS: dict[str, str] = {
    "py": "python",
    "pyi": "python",
    "ts": "typescript",
    "tsx": "typescriptreact",
    "mts": "typescript",
    "cts": "typescript",
    "js": "javascript",
    "jsx": "javascriptreact",
    "mjs": "javascript",
    "cjs": "javascript",
    "json": "json",
    "jsonc": "jsonc",
    "md": "markdown",
    "markdown": "markdown",
    "css": "css",
    "scss": "scss",
    "less": "less",
    "html": "html",
    "htm": "html",
    "vue": "vue",
    "svelte": "svelte",
    "yaml": "yaml",
    "yml": "yaml",
    "toml": "toml",
    "ini": "ini",
    "xml": "xml",
    "sh": "shellscript",
    "bash": "shellscript",
    "zsh": "shellscript",
    "ps1": "powershell",
    "bat": "bat",
    "cmd": "bat",
    "rs": "rust",
    "go": "go",
    "c": "c",
    "h": "c",
    "cpp": "cpp",
    "cc": "cpp",
    "cxx": "cpp",
    "hpp": "cpp",
    "java": "java",
    "cs": "csharp",
    "rb": "ruby",
    "php": "php",
    "lua": "lua",
    "sql": "sql",
    "kt": "kotlin",
    "kts": "kotlin",
    "swift": "swift",
    "r": "r",
    "scala": "scala",
    "txt": "plaintext",
}

#: Whole file names whose language is in the name rather than in an extension. Checked before
#: the extension table, so `CMakeLists.txt` is CMake rather than plain text.
_LANGUAGE_IDS_BY_NAME: dict[str, str] = {
    "dockerfile": "dockerfile",
    "containerfile": "dockerfile",
    "makefile": "makefile",
    "gnumakefile": "makefile",
    "cmakelists.txt": "cmake",
    "gemfile": "ruby",
    "rakefile": "ruby",
}

#: `D:/...` or `d:\...`. Used to tell a Windows absolute path from a relative one *by shape*
#: rather than by asking the host OS, so the conversion behaves identically wherever it runs
#: and a test can assert on Windows paths from any machine.
_DRIVE_RE = re.compile(r"^[A-Za-z]:(/|$)")


class LspError(AgentError):
    """The language server could not be started, or could not answer.

    Subclasses `AgentError` deliberately. Every failure path in `app.py` already catches that
    and routes it through `errors.explain()`, so code intelligence failing behaves like every
    other backend failure in this app — a line in the status bar — rather than needing a
    second, parallel error path that someone has to remember to add.
    """


@dataclass(frozen=True, slots=True)
class Diagnostic:
    """One problem reported by a language server.

    `line` and `column` are **1-based**, converted from the server's 0-based position at the
    boundary. `path` is relative to the client's root and uses forward slashes, matching
    `Entry.path` and `SearchHit.path` — so the Problems panel can hand a path straight to the
    editor without a second translation.
    """

    path: str
    line: int
    column: int
    severity: str
    message: str
    source: str


@dataclass(frozen=True, slots=True)
class Completion:
    """One completion candidate.

    `insert_text` is separate from `label` because they routinely differ: the label is what
    the list shows (`os.path`, `append`), the insert text is what actually goes in the buffer
    (`os.path`, `append(`). Collapsing them is invisible until a server sends a snippet.
    """

    label: str
    detail: str
    kind: str
    insert_text: str


@dataclass(frozen=True, slots=True)
class Location:
    """Where a symbol is defined. 1-based, like `Diagnostic`."""

    path: str
    line: int
    column: int


# --------------------------------------------------------------------------------------
# Pure helpers
#
# Everything below this line is a total function over its arguments: no process, no event
# loop, no filesystem. That is what makes the conversions testable at all — an off-by-one in
# a position or a missing slash in a URI is invisible end-to-end (the server just answers
# about the wrong place) and obvious in a unit test.
# --------------------------------------------------------------------------------------


def severity_rank(severity: str) -> int:
    """Sort key for a severity name, worst first. Unknown names sort last."""
    try:
        return SEVERITIES.index(severity)
    except ValueError:
        return len(SEVERITIES)


def install_hint(command: str) -> str:
    """The command that installs `command`, or generic advice naming it.

    `command` may be a bare name, a full path, or a Windows shim (`pyright-langserver.cmd` —
    which is what npm actually puts on PATH), so the directory and extension are stripped
    before the lookup.
    """
    name = command.replace("\\", "/").rsplit("/", 1)[-1]
    # `.cmd`/`.exe`/`.bat`/`.ps1` are Windows launcher shims around the real program; on PATH
    # they are what gets found, so matching on the stem is matching on the server's name.
    stem = re.sub(r"\.(cmd|bat|exe|ps1)$", "", name, flags=re.IGNORECASE)
    hint = _INSTALL_HINTS.get(stem.lower())
    if hint is not None:
        return hint
    return f"install {stem} and make sure it is on PATH"


def language_id_for(path: str) -> str:
    """The LSP `languageId` for a file, by name then extension.

    `did_open` cannot be called without one, and nothing else in this package knows what a
    `languageId` is: the editor deals in paths and buffers, and "typescriptreact" is protocol
    vocabulary. Deriving it here keeps every protocol word on this side of the boundary — the
    same reason the URI and position conversions live here rather than at their call sites.

    Falls back to "plaintext", which is a real `languageId` rather than a placeholder. A
    server that does not handle it declines cleanly; an empty string is a protocol violation
    and gets a much less friendly answer.
    """
    name = path.replace("\\", "/").rsplit("/", 1)[-1].lower()
    by_name = _LANGUAGE_IDS_BY_NAME.get(name)
    if by_name is not None:
        return by_name

    stem, dot, extension = name.rpartition(".")
    # `not dot` is a file with no extension at all ("LICENSE"); an empty `stem` is a dotfile
    # (".gitignore"), where the text after the dot is the *whole name*. Treating "gitignore"
    # as an extension is the mistake this guards against — it happens to miss today only
    # because no such entry exists in the table, which is not a property worth relying on.
    if not dot or not stem:
        return "plaintext"
    return _LANGUAGE_IDS.get(extension, "plaintext")


def path_to_uri(path: str) -> str:
    """A filesystem path as a `file://` URI.

    Windows is the whole difficulty. `D:\\AI\\app.py` has to become
    `file:///D:/AI/app.py`:

    * **Three slashes.** `file://D:/AI/app.py` parses `D:` as the URI *authority* — a
      hostname — and a server either rejects it or resolves nothing, with no useful message
      either way.
    * **Forward separators.** A backslash in a URI is an ordinary character, not a separator.
    * **The drive colon stays literal.** Percent-encoding it to `D%3A` is technically
      defensible and practically breaks every server tested.

    Everything else that is not URI-safe *is* percent-encoded, because real project paths
    contain spaces (`D:\\My Code\\...`) and a raw space terminates the URI.
    """
    normalised = path.replace("\\", "/")
    # `safe` keeps the separators and the drive colon; `quote` escapes spaces, `#`, `?` and
    # the rest, which is exactly the set that would otherwise be misparsed as URI syntax.
    encoded = quote(normalised, safe="/:")
    if _DRIVE_RE.match(normalised):
        return f"file:///{encoded}"
    if normalised.startswith("/"):
        # Already absolute POSIX: `file://` + `/home/...` gives the same three slashes.
        return f"file://{encoded}"
    return f"file:///{encoded}"


def uri_to_path(uri: str) -> str:
    """The inverse of `path_to_uri`, always with forward slashes.

    Forward slashes on every platform is a deliberate choice rather than a shortcut: `Entry`,
    `SearchHit` and the MCP sandbox all use them (see `Entry.path`), so returning a native
    Windows path here would introduce a second convention that has to be converted again one
    layer up.
    """
    text = uri
    if text.startswith("file://"):
        text = text[len("file://") :]
    text = unquote(text)
    # `file:///D:/x` leaves `/D:/x`; the leading slash belongs to the URI, not to the path.
    if _DRIVE_RE.match(text[1:]) and text.startswith("/"):
        text = text[1:]
    return text.replace("\\", "/")


def to_editor_position(position: Mapping[str, Any]) -> tuple[int, int]:
    """An LSP `Position` as this repo's 1-based `(line, column)`.

    This and `to_lsp_position` are the only two places in the package that know LSP counts
    from zero. Doing the +1 at a call site instead is how a diagnostic ends up pointing one
    line above the actual problem — which is close enough to look correct.
    """
    line = position.get("line", 0)
    character = position.get("character", 0)
    return (int(line) + 1, int(character) + 1)


def to_lsp_position(line: int, column: int) -> dict[str, int]:
    """This repo's 1-based `(line, column)` as an LSP `Position`.

    Clamped at zero. A caller handing over a 0 — an empty editor, an off-by-one somewhere
    upstream — would otherwise produce `line: -1`, which servers answer with a protocol error
    rather than with an empty result, turning a harmless edge case into a visible failure.
    """
    return {"line": max(0, int(line) - 1), "character": max(0, int(column) - 1)}


def parse_diagnostic(path: str, raw: Mapping[str, Any]) -> Diagnostic:
    """One `Diagnostic` from a server's raw dict, positions converted to 1-based.

    A missing or unrecognised `severity` becomes "error". The spec explicitly leaves the
    choice to the client, and the asymmetry matters: guessing "hint" sorts a real problem to
    the bottom of the Problems panel where nobody looks, while guessing "error" is at worst
    conspicuously wrong.
    """
    start = (raw.get("range") or {}).get("start") or {}
    line, column = to_editor_position(start)
    severity = _SEVERITY_NAMES.get(raw.get("severity"), "error")
    return Diagnostic(
        path=path,
        line=line,
        column=column,
        severity=severity,
        message=str(raw.get("message", "")),
        source=str(raw.get("source") or ""),
    )


def parse_completion(raw: Mapping[str, Any]) -> Completion:
    """One `Completion` from a server's raw `CompletionItem`.

    `insert_text` falls back through `insertText` → `textEdit.newText` → `label`, in that
    order. Most servers omit `insertText` when it equals the label, so defaulting to "" would
    produce a candidate that inserts nothing — which reads as the editor swallowing a
    keystroke, not as a parsing bug.
    """
    label = str(raw.get("label", ""))
    text_edit = raw.get("textEdit") or {}
    insert_text = raw.get("insertText") or text_edit.get("newText") or label
    detail = raw.get("detail") or (raw.get("labelDetails") or {}).get("detail") or ""
    return Completion(
        label=label,
        detail=str(detail),
        kind=_COMPLETION_KINDS.get(raw.get("kind"), "text"),
        insert_text=str(insert_text),
    )


def encode_message(payload: Mapping[str, Any]) -> bytes:
    """A JSON-RPC payload with its LSP frame.

    `Content-Length` counts **bytes, not characters**. That distinction is invisible in
    English and constant in practice — one accented path, one diagnostic quoting a non-ASCII
    identifier — and getting it wrong desynchronises the stream permanently, because every
    subsequent message is then read from the wrong offset.
    """
    body = json.dumps(payload).encode("utf-8")
    return b"Content-Length: %d\r\n\r\n" % len(body) + body


class MessageBuffer:
    """Reassembles `Content-Length`-framed JSON from arbitrary chunks of bytes.

    Feed it whatever a pipe hands over; get back the complete messages that are now readable.
    A pipe delivers whatever happened to be written, not whatever a message happens to need,
    so both halves of this are the normal case, not edge cases: one message arriving in five
    reads, and five messages arriving in one.

    Non-fatal on malformed input, on purpose. The length prefix already said where the next
    message starts, so resynchronising after a bad body is free — and a client that dies on
    one unparseable message turns a recoverable hiccup into a dead session, where the request
    that mattered would have surfaced as a timeout anyway.
    """

    def __init__(self) -> None:
        self._buffer = b""

    def feed(self, chunk: bytes) -> list[dict[str, Any]]:
        self._buffer += chunk
        messages: list[dict[str, Any]] = []
        while True:
            message, consumed = self._take_one()
            if not consumed:
                break
            if message is not None:
                messages.append(message)
        return messages

    def _take_one(self) -> tuple[dict[str, Any] | None, bool]:
        """Pops one framed message. Returns `(message, consumed_anything)`.

        The two results are independent: a header block with no `Content-Length`, or a body
        that is not JSON, consumes bytes without yielding a message, and the loop above has to
        keep going in both cases rather than stopping at the first `None`.
        """
        header_end, separator_length = _find_header_end(self._buffer)
        if header_end is None:
            return None, False

        header_block = self._buffer[:header_end]
        body_start = header_end + separator_length
        length = _content_length(header_block)
        if length is None:
            # A header block that never said how long the body is. There is no way to know
            # where the next message begins other than to drop this block and rescan, which
            # is what dropping it does.
            self._buffer = self._buffer[body_start:]
            return None, True

        if len(self._buffer) - body_start < length:
            # The body is still arriving. Leave everything in place — including the header,
            # so the length is re-read rather than remembered in a second piece of state.
            return None, False

        body = self._buffer[body_start : body_start + length]
        self._buffer = self._buffer[body_start + length :]
        try:
            message = json.loads(body.decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError):
            return None, True
        return (message if isinstance(message, dict) else None), True


def _find_header_end(buffer: bytes) -> tuple[int | None, int]:
    """Index of the blank line that ends the header block, and its length.

    Tolerates a header block terminated with bare `\\n` as well as the spec's `\\r\\n`. Being
    strict here buys nothing — hand-written servers and a couple of real ones emit bare
    newlines — and costs an unexplainable hang, since a client that never finds its terminator
    simply waits forever.
    """
    crlf = buffer.find(b"\r\n\r\n")
    lf = buffer.find(b"\n\n")
    if crlf == -1 and lf == -1:
        return None, 0
    if crlf != -1 and (lf == -1 or crlf < lf):
        return crlf, 4
    return lf, 2


def _content_length(header_block: bytes) -> int | None:
    for raw_line in header_block.replace(b"\r\n", b"\n").split(b"\n"):
        name, separator, value = raw_line.partition(b":")
        # Case-insensitive because the header name is, and at least one server in the wild
        # sends `content-length`.
        if separator and name.strip().lower() == b"content-length":
            try:
                return int(value.strip())
            except ValueError:
                return None
    return None


def _normalise_root(root: Path | str) -> str:
    text = str(root).replace("\\", "/").rstrip("/")
    return text


def _is_absolute(path: str) -> bool:
    return bool(_DRIVE_RE.match(path)) or path.startswith("/")


def _hover_text(contents: Any) -> str | None:
    """Flattens the three shapes `Hover.contents` is allowed to take.

    The field has been `MarkedString`, `MarkedString[]` and `MarkupContent` across spec
    versions, and servers still send all three depending on what the client advertised. This
    is a display string, so the markdown is kept as-is rather than rendered — a one-line type
    signature is the overwhelmingly common case and reads fine either way.
    """
    if contents is None:
        return None
    if isinstance(contents, str):
        return contents.strip() or None
    if isinstance(contents, Mapping):
        return str(contents.get("value", "")).strip() or None
    if isinstance(contents, Sequence):
        parts = [text for item in contents if (text := _hover_text(item))]
        return "\n\n".join(parts) or None
    return None


class LspClient:
    """Spawns one language server and exposes what the UI needs from it.

    One client per server, not per file: a server keeps a whole-project index, so restarting
    it per document would be both slow and wrong. `root` is what it is told to index.

    Use as an async context manager, or pair `start()` with `close()`. `close()` is not
    optional — an orphaned language server holds a full project index in memory.
    """

    def __init__(
        self,
        command: Sequence[str],
        root: Path,
        *,
        on_diagnostics: Callable[[str, tuple[Diagnostic, ...]], None] | None = None,
        on_log: Callable[[str], None] | None = None,
        debounce: float = _DEFAULT_DEBOUNCE,
    ) -> None:
        self._command = list(command)
        # Kept as given rather than `.resolve()`d: resolving hits the filesystem, follows
        # symlinks and can change the drive-letter casing, and this string is compared
        # against every URI the server sends back.
        self._root = _normalise_root(root)
        self._on_diagnostics = on_diagnostics
        # A language server's stderr is diagnostic output for a human. A TUI has no terminal
        # to print it to, so it is handed to the caller — but it must still be *read*, which
        # is the point of the drain task, not this callback.
        self._on_log = on_log
        self._debounce = debounce

        self._process: asyncio.subprocess.Process | None = None
        self._pending: dict[int, asyncio.Future[Any]] = {}
        self._next_id = 0
        self._tasks: list[asyncio.Task[None]] = []
        self._write_lock = asyncio.Lock()

        self._diagnostics: dict[str, tuple[Diagnostic, ...]] = {}
        self._versions: dict[str, int] = {}
        self._pending_changes: dict[str, str] = {}
        self._flush_task: asyncio.Task[None] | None = None

    # -- lifecycle ---------------------------------------------------------------------

    async def __aenter__(self) -> "LspClient":
        await self.start()
        return self

    async def __aexit__(self, *_exc: object) -> None:
        await self.close()

    @property
    def running(self) -> bool:
        return self._process is not None and self._process.returncode is None

    @property
    def root(self) -> str:
        return self._root

    async def start(self) -> None:
        if not self._command:
            raise LspError("No language server command configured.")

        try:
            self._process = await asyncio.create_subprocess_exec(
                *self._command,
                stdin=asyncio.subprocess.PIPE,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
                # Several servers resolve their own config (pyrightconfig.json, tsconfig.json,
                # .ruff.toml) against the working directory rather than against `rootUri`.
                cwd=self._root or None,
            )
        except (FileNotFoundError, NotADirectoryError) as exc:
            self._process = None
            # The path a first-time user takes, so it gets the good message. A raw
            # FileNotFoundError here reads as a bug in this app rather than as a missing
            # optional tool, and says nothing about how to fix it.
            raise LspError(
                f"Language server '{self._command[0]}' is not installed or not on PATH."
                f"  ·  fix: {install_hint(self._command[0])}"
            ) from exc
        except PermissionError as exc:
            self._process = None
            raise LspError(
                f"Not allowed to run '{self._command[0]}'."
                f"  ·  fix: {install_hint(self._command[0])}"
            ) from exc

        self._tasks.append(asyncio.create_task(self._read_stdout()))
        self._tasks.append(asyncio.create_task(self._read_stderr()))

        try:
            await asyncio.wait_for(self._handshake(), _HANDSHAKE_TIMEOUT)
        except TimeoutError:
            await self.close()
            raise LspError(
                f"'{self._command[0]}' did not complete the LSP handshake in "
                f"{_HANDSHAKE_TIMEOUT:.0f}s. It may have started and exited — run it in a "
                "terminal to see what it printed."
            ) from None
        except LspError:
            await self.close()
            raise

    async def close(self) -> None:
        """Stops the server and releases everything. Safe to call twice, and after a failed
        `start()` — the app's error path does exactly that.
        """
        flush_task, self._flush_task = self._flush_task, None
        self._pending_changes.clear()

        tasks = self._tasks
        self._tasks = []
        if flush_task is not None:
            tasks = [*tasks, flush_task]
        for task in tasks:
            task.cancel()
        if tasks:
            # Awaited, not merely cancelled: a cancelled-but-unawaited task is still pending
            # when the loop shuts down, which asyncio reports as "Task was destroyed but it is
            # pending" — noise that hides real failures in a test run.
            await asyncio.gather(*tasks, return_exceptions=True)

        # Anything still waiting must be failed, not left pending. A future nobody resolves
        # turns a dead server into a frozen UI rather than into an error message.
        for future in self._pending.values():
            if not future.done():
                future.set_exception(LspError("Language server closed"))
        self._pending.clear()

        process, self._process = self._process, None
        if process is None:
            return
        if process.returncode is None:
            try:
                # No graceful `shutdown`/`exit` exchange. It requires the server to still be
                # answering, and the case where close() matters most is precisely the one
                # where it is not — so this would add a timeout to every quit to save nothing.
                process.terminate()
                await asyncio.wait_for(process.wait(), _TERMINATE_GRACE)
            except (ProcessLookupError, TimeoutError):
                try:
                    process.kill()
                    await process.wait()
                except ProcessLookupError:
                    pass
        _close_transport(process)

    # -- transport ---------------------------------------------------------------------

    async def _read_stdout(self) -> None:
        assert self._process is not None and self._process.stdout is not None
        stream = self._process.stdout
        buffer = MessageBuffer()
        while True:
            # `read(n)`, never `readline()`. Two reasons, either one sufficient: the framing
            # is length-prefixed rather than line-delimited, and `StreamReader.readline()`
            # raises `LimitOverrunError` past its 64 KiB default — which a completion response
            # from a real server exceeds routinely.
            chunk = await stream.read(4096)
            if not chunk:
                break
            for message in buffer.feed(chunk):
                self.handle_message(message)

    async def _read_stderr(self) -> None:
        """Drains stderr for the whole life of the process.

        Not optional and not for logging's sake: a child whose stderr pipe fills blocks
        forever mid-write, and a server that blocks mid-write stops answering stdout too. The
        symptom is a client that worked fine for a few minutes and then hung.
        """
        assert self._process is not None and self._process.stderr is not None
        stream = self._process.stderr
        pending = b""
        while True:
            chunk = await stream.read(4096)
            if not chunk:
                break
            pending += chunk
            while b"\n" in pending:
                line, pending = pending.split(b"\n", 1)
                if self._on_log is not None and line.strip():
                    self._on_log(line.decode("utf-8", "replace").rstrip())

    async def _send(self, payload: dict[str, Any]) -> None:
        process = self._process
        if process is None or process.stdin is None or process.returncode is not None:
            raise LspError("Language server is not running")
        data = encode_message(payload)
        # Serialised because two concurrent writes can interleave inside one frame, and a
        # corrupted length prefix desynchronises the stream for everything that follows.
        async with self._write_lock:
            try:
                process.stdin.write(data)
                await process.stdin.drain()
            except (BrokenPipeError, ConnectionResetError) as exc:
                raise LspError("Language server stopped accepting input") from exc

    async def _notify(self, method: str, params: dict[str, Any]) -> None:
        await self._send({"jsonrpc": "2.0", "method": method, "params": params})

    async def _request(
        self, method: str, params: dict[str, Any], timeout: float = _REQUEST_TIMEOUT
    ) -> Any:
        """One request/response round trip.

        Returns the raw `result`, whatever shape it has — unlike `mcp_client._request`, which
        can insist on a dict. LSP results are legitimately lists (`textDocument/definition`)
        and legitimately `null` (a hover over whitespace), and rejecting either would turn
        "nothing to show" into an error.
        """
        self._next_id += 1
        request_id = self._next_id
        future: asyncio.Future[Any] = asyncio.get_running_loop().create_future()
        self._pending[request_id] = future

        try:
            await self._send(
                {"jsonrpc": "2.0", "id": request_id, "method": method, "params": params}
            )
        except LspError:
            self._pending.pop(request_id, None)
            raise

        try:
            return await asyncio.wait_for(future, timeout)
        except TimeoutError:
            self._pending.pop(request_id, None)
            raise LspError(f"{method} timed out after {timeout:.0f}s") from None

    def handle_message(self, message: Mapping[str, Any]) -> None:
        """Routes one decoded message. **Public because it is the whole dispatcher.**

        Three kinds of message arrive on this stream and they are told apart by which fields
        are present, not by what was expected next:

        * `method` and no `id` — a **notification**. `textDocument/publishDiagnostics` is
          one, and it is the only reason diagnostics ever appear. Routing purely by `id`
          against pending futures silently drops every one of them, and the failure has no
          error attached to it: the Problems panel is simply always empty.
        * `method` and an `id` — a **server-to-client request**. Answered below; some servers
          stall waiting for the reply.
        * `id` and no `method` — a **response** to something we sent.
        """
        method = message.get("method")
        if method is not None:
            if message.get("id") is not None:
                self._answer_server_request(message)
            else:
                self._handle_notification(str(method), message.get("params") or {})
            return

        future = self._pending.pop(message.get("id", -1), None)
        if future is None or future.done():
            return
        if "error" in message:
            error = message["error"] or {}
            detail = error.get("message", error) if isinstance(error, Mapping) else error
            future.set_exception(LspError(str(detail)))
        else:
            future.set_result(message.get("result"))

    def _handle_notification(self, method: str, params: Mapping[str, Any]) -> None:
        if method != "textDocument/publishDiagnostics":
            # `window/logMessage`, `$/progress`, `telemetry/event` and friends. Ignored on
            # purpose rather than logged: they arrive constantly and none of them changes
            # what is on screen.
            return

        path = self._path_for_uri(str(params.get("uri", "")))
        raw_items = params.get("diagnostics") or []
        parsed = tuple(
            parse_diagnostic(path, item) for item in raw_items if isinstance(item, Mapping)
        )
        # A publish is a **full replacement** for that file, and an empty list means
        # "cleared". Appending instead would grow the panel by a row per keystroke and never
        # shrink it — the user fixes the error and it stays on screen forever.
        if parsed:
            self._diagnostics[path] = parsed
        else:
            self._diagnostics.pop(path, None)

        if self._on_diagnostics is None:
            return
        try:
            self._on_diagnostics(path, parsed)
        except Exception as error:  # noqa: BLE001 - see below
            # This runs on the stdout reader task. An exception escaping here kills the
            # reader, and with it every response any other call is still awaiting — a widget
            # that is not mounted yet would take the whole client down.
            if self._on_log is not None:
                self._on_log(f"diagnostics callback failed: {error}")

    def _answer_server_request(self, message: Mapping[str, Any]) -> None:
        """Replies to a request the *server* sent us.

        pyright and typescript-language-server both send `client/registerCapability` and
        `workspace/configuration` during startup and wait for an answer. Ignoring them is not
        harmless: the server holds the request open and, in pyright's case, never gets round
        to publishing diagnostics. Answering with defaults is the honest reply — this client
        advertises no dynamic registration and carries no per-folder settings.
        """
        method = str(message.get("method"))
        if method == "workspace/configuration":
            items = (message.get("params") or {}).get("items") or []
            result: Any = [{} for _ in items]
        else:
            result = None

        payload = {"jsonrpc": "2.0", "id": message.get("id"), "result": result}
        try:
            asyncio.get_running_loop()
        except RuntimeError:
            return
        # Fire-and-forget: this is called from the reader task, and awaiting the write here
        # would mean the reader is not reading while it drains.
        task = asyncio.create_task(self._send_quietly(payload))
        self._tasks.append(task)
        task.add_done_callback(self._forget_task)

    def _forget_task(self, task: asyncio.Task[None]) -> None:
        """Drops a finished reply task so `_tasks` does not grow for the whole session.

        Guarded because `close()` clears the list wholesale and the done callback fires
        afterwards — removing an entry that is no longer there would raise inside asyncio's
        callback machinery, where nothing is watching.
        """
        if task in self._tasks:
            self._tasks.remove(task)

    async def _send_quietly(self, payload: dict[str, Any]) -> None:
        try:
            await self._send(payload)
        except LspError:
            # The server is gone. `close()` is already failing everything that was waiting;
            # a courtesy reply to a dead process is not worth a second error path.
            return

    # -- documents ---------------------------------------------------------------------

    def _uri_for_path(self, path: str) -> str:
        """Workspace-relative or absolute path in, `file://` URI out."""
        clean = path.replace("\\", "/")
        if _is_absolute(clean) or not self._root:
            return path_to_uri(clean)
        return path_to_uri(f"{self._root}/{clean.lstrip('/')}")

    def _path_for_uri(self, uri: str) -> str:
        """`file://` URI in, workspace-relative forward-slash path out.

        Relative because that is how every other path in this package is addressed
        (`Entry.path`, `SearchHit.path`): a diagnostic carrying an absolute
        `file:///C:/Users/.../src/app.py` is a path the editor cannot open and the Problems
        panel cannot group with anything else.
        """
        absolute = uri_to_path(uri)
        if not self._root:
            return absolute
        prefix = f"{self._root}/"
        # Case-insensitive when the root looks like a Windows path, because it is: the server
        # may echo back `d:/proj/...` for a root given as `D:/proj`, and an exact compare
        # would leave every diagnostic absolute and ungroupable. Decided by the path's shape
        # rather than by the host OS so the behaviour is the same wherever this runs.
        if _DRIVE_RE.match(self._root):
            if absolute[: len(prefix)].lower() == prefix.lower():
                return absolute[len(prefix) :]
        elif absolute.startswith(prefix):
            return absolute[len(prefix) :]
        return absolute

    def _key(self, path: str) -> str:
        """The canonical form a document is tracked under: relative, forward slashes."""
        return self._path_for_uri(self._uri_for_path(path))

    async def did_open(self, path: str, text: str, language_id: str) -> None:
        key = self._key(path)
        self._versions[key] = 1
        await self._notify(
            "textDocument/didOpen",
            {
                "textDocument": {
                    "uri": self._uri_for_path(path),
                    "languageId": language_id,
                    "version": 1,
                    "text": text,
                }
            },
        )

    async def did_change(self, path: str, text: str) -> None:
        """Records an edit. The wire send is debounced — see `_DEFAULT_DEBOUNCE`.

        Only the newest text per document is kept, because full-document sync means each send
        supersedes the last completely. Coalescing is therefore lossless here, which is not
        true of incremental sync and is the main reason this client uses full sync.
        """
        self._pending_changes[self._key(path)] = text
        if self._flush_task is None or self._flush_task.done():
            self._flush_task = asyncio.create_task(self._flush_after_delay())

    async def _flush_after_delay(self) -> None:
        await asyncio.sleep(self._debounce)
        await self._flush_now()

    async def flush(self) -> None:
        """Sends any debounced edits immediately.

        Every request calls this first. Without it the server answers about the document as
        it was several keystrokes ago, and completion silently offers names from a version
        the user cannot see — which is much worse than a slightly slower popup, because
        nothing about it looks wrong.
        """
        task, self._flush_task = self._flush_task, None
        if task is not None and not task.done():
            task.cancel()
            await asyncio.gather(task, return_exceptions=True)
        await self._flush_now()

    async def _flush_now(self) -> None:
        pending, self._pending_changes = self._pending_changes, {}
        for key, text in pending.items():
            version = self._versions.get(key, 1) + 1
            self._versions[key] = version
            await self._notify(
                "textDocument/didChange",
                {
                    "textDocument": {"uri": self._uri_for_path(key), "version": version},
                    # One change covering the whole document. `TextDocumentSyncKind.Full`,
                    # which is what this client advertises in `initialize`.
                    "contentChanges": [{"text": text}],
                },
            )

    async def did_close(self, path: str) -> None:
        key = self._key(path)
        # Dropped rather than flushed: sending an edit for a document immediately before
        # telling the server it is closed is a race the server is entitled to complain about.
        self._pending_changes.pop(key, None)
        self._versions.pop(key, None)
        # Cleared locally because several servers — pyright among them — do not publish an
        # empty diagnostic set on close. Leaving them would keep a file's errors in the
        # Problems panel after the tab is gone, where selecting one reopens a file the user
        # deliberately shut.
        self._diagnostics.pop(key, None)
        await self._notify(
            "textDocument/didClose",
            {"textDocument": {"uri": self._uri_for_path(path)}},
        )

    def diagnostics(self, path: str | None = None) -> tuple[Diagnostic, ...]:
        """Everything currently known, or just one file's.

        A plain accessor over state the notification handler maintains, so the Problems panel
        can redraw itself at any time without asking the server anything.
        """
        if path is not None:
            return self._diagnostics.get(self._key(path), ())
        return tuple(
            diagnostic
            for key in sorted(self._diagnostics)
            for diagnostic in self._diagnostics[key]
        )

    # -- queries -----------------------------------------------------------------------

    async def completion(self, path: str, line: int, column: int) -> tuple[Completion, ...]:
        await self.flush()
        result = await self._request(
            "textDocument/completion", self._position_params(path, line, column)
        )
        # `CompletionList` or a bare `CompletionItem[]`; servers send both, and which one is
        # not something the client gets to choose.
        items: Iterable[Any]
        if isinstance(result, Mapping):
            items = result.get("items") or ()
        elif isinstance(result, list):
            items = result
        else:
            items = ()
        return tuple(parse_completion(item) for item in items if isinstance(item, Mapping))

    async def hover(self, path: str, line: int, column: int) -> str | None:
        await self.flush()
        result = await self._request(
            "textDocument/hover", self._position_params(path, line, column)
        )
        if not isinstance(result, Mapping):
            # `null` is the normal answer for "nothing here", not a failure.
            return None
        return _hover_text(result.get("contents"))

    async def definition(self, path: str, line: int, column: int) -> Location | None:
        await self.flush()
        result = await self._request(
            "textDocument/definition", self._position_params(path, line, column)
        )
        # `Location`, `Location[]`, or `LocationLink[]` — three shapes for one question, all
        # of them in current use. The first entry is taken: a symbol with several definitions
        # (an overload, a conditional import) has no "more correct" one to pick, and jumping
        # to the first is what every editor does.
        entries: Sequence[Any]
        if isinstance(result, list):
            entries = result
        elif isinstance(result, Mapping):
            entries = [result]
        else:
            entries = []

        for entry in entries:
            if not isinstance(entry, Mapping):
                continue
            uri = entry.get("uri") or entry.get("targetUri")
            if not uri:
                continue
            span = (
                entry.get("range")
                or entry.get("targetSelectionRange")
                or entry.get("targetRange")
                or {}
            )
            line_number, column_number = to_editor_position(span.get("start") or {})
            return Location(self._path_for_uri(str(uri)), line_number, column_number)
        return None

    def _position_params(self, path: str, line: int, column: int) -> dict[str, Any]:
        return {
            "textDocument": {"uri": self._uri_for_path(path)},
            "position": to_lsp_position(line, column),
        }

    # -- handshake ---------------------------------------------------------------------

    async def _handshake(self) -> None:
        root_uri = path_to_uri(self._root) if self._root else None
        await self._request(
            "initialize",
            {
                # Servers use this to exit if the editor dies without closing them. Worth
                # sending: an orphaned language server is invisible and holds a whole index.
                "processId": os.getpid(),
                "clientInfo": {"name": "local-coder", "version": "0.1.0"},
                "rootUri": root_uri,
                "workspaceFolders": (
                    [{"uri": root_uri, "name": self._root.rsplit("/", 1)[-1]}]
                    if root_uri
                    else None
                ),
                "capabilities": _CLIENT_CAPABILITIES,
            },
            _HANDSHAKE_TIMEOUT,
        )
        # A notification, so no id and nothing to wait for. Skipping it leaves several
        # servers refusing every subsequent request as "not initialised" — the same trap
        # `mcp_client._handshake` documents for `notifications/initialized`.
        await self._notify("initialized", {})


#: What this client tells the server it can do.
#:
#: Understated on purpose. Every capability declared here is a promise the server will hold
#: us to: advertising snippet support means completions arrive as `${1:placeholder}` strings
#: that this editor has no machinery to expand, and advertising incremental sync means the
#: server expects ranged edits that `did_change` does not produce.
_CLIENT_CAPABILITIES: dict[str, Any] = {
    "textDocument": {
        "synchronization": {
            # 1 = TextDocumentSyncKind.Full. Full documents are wasteful per keystroke, which
            # is what the debounce is for; incremental sync would need the editor to hand over
            # ranged edits, and `EditorTabs` deals in whole buffers.
            "dynamicRegistration": False,
            "willSave": False,
            "didSave": False,
        },
        "publishDiagnostics": {"relatedInformation": False},
        "completion": {
            "completionItem": {
                "snippetSupport": False,
                "documentationFormat": ["plaintext", "markdown"],
                "labelDetailsSupport": True,
            },
            "contextSupport": False,
        },
        # plaintext first: a server that honours the preference sends text this panel can
        # display as-is, instead of markdown nothing here renders.
        "hover": {"contentFormat": ["plaintext", "markdown"]},
        "definition": {"linkSupport": True},
    },
    "workspace": {"workspaceFolders": True, "configuration": True},
}


def _close_transport(process: asyncio.subprocess.Process) -> None:
    """Closes the subprocess transport once the child has exited.

    asyncio's `BaseSubprocessTransport.__del__` raises a `ResourceWarning` if it was never
    closed, and this suite runs with `filterwarnings = ["error"]`, so a leaked transport
    surfaces as an unrelated test failing during garbage collection — the least debuggable
    failure shape there is. `_transport` is private, hence the guard: a future asyncio can
    drop it without breaking anything here.
    """
    transport = getattr(process, "_transport", None)
    if transport is None:
        return
    try:
        transport.close()
    except Exception:  # noqa: BLE001 - closing must never be the thing that raises
        pass
