"""Specification for `local_coder.lsp`.

Nothing here needs a real language server, and that is deliberate: **none is installed on
this machine** (neither `pyright-langserver` nor `typescript-language-server`), which is also
the state a first-time user is in. A suite that needed one would be unrunnable exactly when
it matters most.

Two levels of double are used, on purpose:

* The **pure** layer — framing, URI conversion, position conversion, dict parsing — is tested
  directly, with no process anywhere. That is where the fiddly, silently-wrong bugs live.
* The **client** layer is tested against a tiny LSP server written into `tmp_path` and run
  with `sys.executable`. It speaks real `Content-Length` framing over real pipes, so the
  parts that can deadlock (an undrained pipe, a body split across reads, a child that
  outlives its parent) are exercised for real rather than mocked away.

The one thing worth restating before reading any of this: **LSP is not newline-delimited
JSON.** `mcp_client.py` splits stdout on newlines and that is correct for NDJSON; doing it
here would hang forever with no error, because an LSP body legitimately contains newlines and
the length prefix is the only thing that says where a message ends.
"""

from __future__ import annotations

import asyncio
import sys
from pathlib import Path

import pytest

from local_coder.lsp import (
    Completion,
    Diagnostic,
    Location,
    LspClient,
    LspError,
    MessageBuffer,
    encode_message,
    install_hint,
    language_id_for,
    parse_completion,
    parse_diagnostic,
    path_to_uri,
    severity_rank,
    to_editor_position,
    to_lsp_position,
    uri_to_path,
)

# --------------------------------------------------------------------------------------
# A real, if very small, language server.
#
# Written to disk rather than run in-process because the failure modes this file guards
# against are *pipe* failures: a body arriving in two reads, a child that has to be killed,
# stderr filling up. None of those exist without an actual subprocess and actual OS pipes.
#
# It is synchronous and single-threaded, which is fine — it answers one message at a time and
# publishes diagnostics as a side effect of `didOpen`, which is precisely the server-initiated
# notification the dispatcher has to route by `method` rather than by `id`.
# --------------------------------------------------------------------------------------
_FAKE_SERVER = r'''
import json
import sys


def _read():
    stream = sys.stdin.buffer
    header = b""
    while not header.endswith(b"\r\n\r\n"):
        byte = stream.read(1)
        if not byte:
            return None
        header += byte
    length = 0
    for line in header.decode("ascii").split("\r\n"):
        if line.lower().startswith("content-length:"):
            length = int(line.split(":", 1)[1].strip())
    body = b""
    while len(body) < length:
        chunk = stream.read(length - len(body))
        if not chunk:
            return None
        body += chunk
    return json.loads(body.decode("utf-8"))


def _send(payload):
    body = json.dumps(payload).encode("utf-8")
    out = sys.stdout.buffer
    out.write(b"Content-Length: " + str(len(body)).encode("ascii") + b"\r\n\r\n")
    out.write(body)
    out.flush()


def _respond(request_id, result):
    _send({"jsonrpc": "2.0", "id": request_id, "result": result})


# Proves the stderr drain matters: a server that logs and is never read from eventually
# blocks on a full pipe. One line is not enough to fill anything, but it does mean the drain
# task has to cope with output arriving before the handshake has finished.
sys.stderr.write("fake language server starting\n")
sys.stderr.flush()

while True:
    message = _read()
    if message is None:
        break
    method = message.get("method")
    request_id = message.get("id")

    if method == "initialize":
        _respond(request_id, {"capabilities": {"hoverProvider": True}})
    elif method == "textDocument/didOpen":
        uri = message["params"]["textDocument"]["uri"]
        _send(
            {
                "jsonrpc": "2.0",
                "method": "textDocument/publishDiagnostics",
                "params": {
                    "uri": uri,
                    "diagnostics": [
                        {
                            "range": {
                                "start": {"line": 2, "character": 4},
                                "end": {"line": 2, "character": 9},
                            },
                            "severity": 1,
                            "message": "\"vlaue\" is not defined",
                            "source": "fake",
                        }
                    ],
                },
            }
        )
    elif method == "textDocument/completion":
        _respond(
            request_id,
            {
                "isIncomplete": False,
                "items": [
                    {"label": "value", "kind": 6, "detail": "int", "insertText": "value"},
                    {"label": "values", "kind": 3, "detail": "() -> list[int]"},
                ],
            },
        )
    elif method == "textDocument/hover":
        _respond(
            request_id,
            {"contents": {"kind": "markdown", "value": "(variable) value: int"}},
        )
    elif method == "textDocument/definition":
        _respond(
            request_id,
            [
                {
                    "uri": message["params"]["textDocument"]["uri"],
                    "range": {
                        "start": {"line": 0, "character": 6},
                        "end": {"line": 0, "character": 11},
                    },
                }
            ],
        )
    elif method == "shutdown":
        _respond(request_id, None)
    elif method == "exit":
        break
    elif request_id is not None:
        _respond(request_id, None)
'''


@pytest.fixture
def server_script(tmp_path: Path) -> Path:
    script = tmp_path / "fake_language_server.py"
    script.write_text(_FAKE_SERVER, encoding="utf-8")
    return script


@pytest.fixture
async def start_client(server_script: Path, tmp_path: Path):
    """Factory that starts a client against the fake server and closes it afterwards.

    The teardown is not politeness: a leaked child holds its end of three pipes open and, in
    the shipped app, would hold a language server's whole index in memory for the rest of the
    session. Every test that starts one goes through here, so there is exactly one place that
    can forget.
    """
    started: list[LspClient] = []

    async def _start(**kwargs) -> LspClient:
        client = LspClient([sys.executable, str(server_script)], tmp_path, **kwargs)
        started.append(client)
        await client.start()
        return client

    yield _start

    for client in started:
        await client.close()


# --------------------------------------------------------------------------------------
# Framing
# --------------------------------------------------------------------------------------


class TestFraming:
    """`Content-Length` framing, which is the whole reason this cannot reuse `mcp_client`."""

    def test_encode_puts_the_byte_length_in_the_header(self) -> None:
        data = encode_message({"jsonrpc": "2.0", "id": 1})

        header, _, body = data.partition(b"\r\n\r\n")
        assert header == b"Content-Length: %d" % len(body)
        assert body.startswith(b"{")

    def test_length_counts_bytes_not_characters(self) -> None:
        # The bug this catches is invisible in English and constant in real use: a diagnostic
        # quoting an identifier, a path with an accent, any non-ASCII at all makes len(str)
        # and len(utf-8 bytes) disagree, and every message after the short one is then framed
        # against the wrong offset.
        message = {"text": "\u0e04\u0e23\u0e31\u0e1a"}
        data = encode_message(message)

        header, _, body = data.partition(b"\r\n\r\n")
        assert len(body) > len('{"text": "\u0e04\u0e23\u0e31\u0e1a"}')
        assert header == b"Content-Length: %d" % len(body)
        assert MessageBuffer().feed(data) == [message]

    def test_a_single_message_round_trips(self) -> None:
        payload = {"jsonrpc": "2.0", "id": 7, "result": {"ok": True}}

        assert MessageBuffer().feed(encode_message(payload)) == [payload]

    def test_two_messages_in_one_read(self) -> None:
        first = {"id": 1, "result": "a"}
        second = {"method": "notify", "params": {}}

        got = MessageBuffer().feed(encode_message(first) + encode_message(second))

        assert got == [first, second]

    def test_a_message_split_across_reads(self) -> None:
        payload = {"id": 1, "result": {"value": "x" * 200}}
        data = encode_message(payload)
        buffer = MessageBuffer()

        # Split mid-body. A pipe hands over whatever happened to be written, not whatever a
        # message happens to need — a 4 KiB read across a 9 KiB completion response is the
        # normal case here, not an edge case.
        assert buffer.feed(data[:40]) == []
        assert buffer.feed(data[40:]) == [payload]

    def test_a_header_split_across_reads(self) -> None:
        payload = {"id": 2, "result": None}
        data = encode_message(payload)
        buffer = MessageBuffer()

        assert buffer.feed(data[:6]) == []
        assert buffer.feed(data[6:]) == [payload]

    def test_a_body_arriving_one_byte_at_a_time(self) -> None:
        payload = {"id": 3, "result": [1, 2, 3]}
        data = encode_message(payload)
        buffer = MessageBuffer()

        got: list[dict] = []
        for index in range(len(data)):
            got.extend(buffer.feed(data[index : index + 1]))

        assert got == [payload]

    def test_tolerates_a_header_block_terminated_with_bare_newlines(self) -> None:
        # Not hypothetical: hand-written test servers and a few real ones emit `\n` rather
        # than `\r\n`. Being strict here buys nothing and costs an unexplainable hang.
        assert MessageBuffer().feed(b'Content-Length: 8\n\n{"a": 1}') == [{"a": 1}]

    def test_header_names_are_matched_case_insensitively(self) -> None:
        assert MessageBuffer().feed(b'content-length: 8\r\n\r\n{"a": 1}') == [{"a": 1}]

    def test_extra_headers_are_ignored(self) -> None:
        data = (
            b"Content-Length: 8\r\n"
            b"Content-Type: application/vscode-jsonrpc; charset=utf-8\r\n"
            b"\r\n"
            b'{"a": 1}'
        )

        assert MessageBuffer().feed(data) == [{"a": 1}]

    def test_a_corrupt_body_does_not_poison_the_stream(self) -> None:
        # Dropping the bad message and carrying on is the only survivable choice: the length
        # prefix already said where the next one starts, so resynchronisation is free, and a
        # request that mattered surfaces as a timeout rather than as a dead session.
        buffer = MessageBuffer()
        good = {"id": 1, "result": "ok"}

        got = buffer.feed(b"Content-Length: 3\r\n\r\nnot" + encode_message(good))

        assert got == [good]

    def test_a_header_block_with_no_length_is_skipped(self) -> None:
        buffer = MessageBuffer()
        good = {"id": 1, "result": "ok"}

        got = buffer.feed(b"X-Nonsense: 1\r\n\r\n" + encode_message(good))

        assert got == [good]


# --------------------------------------------------------------------------------------
# URIs and positions — the two conversions that must happen exactly once, at this boundary
# --------------------------------------------------------------------------------------


class TestUri:
    def test_a_windows_path_gets_three_slashes_and_forward_separators(self) -> None:
        # `file://D:/x` (two slashes) makes `D:` the *authority*, i.e. a hostname, and servers
        # reject it or silently resolve nothing. The third slash is not cosmetic.
        assert path_to_uri(r"D:\AI\project\src\app.py") == "file:///D:/AI/project/src/app.py"

    def test_the_drive_colon_is_not_percent_encoded(self) -> None:
        assert "%3A" not in path_to_uri(r"D:\AI\app.py")

    def test_a_posix_path_keeps_its_single_leading_slash(self) -> None:
        assert path_to_uri("/home/user/app.py") == "file:///home/user/app.py"

    def test_spaces_are_percent_encoded(self) -> None:
        assert path_to_uri(r"D:\My Code\app.py") == "file:///D:/My%20Code/app.py"

    def test_uri_to_path_returns_a_forward_slash_path(self) -> None:
        # Forward slashes on both platforms, matching `Entry.path` and `SearchHit.path`
        # everywhere else in this package. One convention, not two.
        assert uri_to_path("file:///D:/AI/project/src/app.py") == "D:/AI/project/src/app.py"

    def test_uri_to_path_decodes_percent_escapes(self) -> None:
        assert uri_to_path("file:///D:/My%20Code/app.py") == "D:/My Code/app.py"

    def test_windows_paths_round_trip(self) -> None:
        original = r"D:\AI\zEXtream-Application-AI\ide\src\local_coder\lsp.py"

        assert uri_to_path(path_to_uri(original)) == original.replace("\\", "/")

    def test_posix_paths_round_trip(self) -> None:
        assert uri_to_path(path_to_uri("/tmp/a b/c.py")) == "/tmp/a b/c.py"


class TestPositions:
    """LSP counts from zero. This repo counts from one. Everything below is that one fact."""

    def test_the_origin_becomes_line_one_column_one(self) -> None:
        assert to_editor_position({"line": 0, "character": 0}) == (1, 1)

    def test_a_later_position_is_shifted_by_one_on_both_axes(self) -> None:
        assert to_editor_position({"line": 11, "character": 4}) == (12, 5)

    def test_a_missing_position_is_treated_as_the_origin(self) -> None:
        assert to_editor_position({}) == (1, 1)

    def test_the_conversion_is_reversible(self) -> None:
        assert to_lsp_position(12, 5) == {"line": 11, "character": 4}

    def test_going_back_clamps_at_zero(self) -> None:
        # A caller handing over a 0 (an empty editor, an off-by-one elsewhere) must not send
        # `line: -1`, which servers answer with an error rather than with an empty result.
        assert to_lsp_position(0, 0) == {"line": 0, "character": 0}


# --------------------------------------------------------------------------------------
# Parsing raw server dicts
# --------------------------------------------------------------------------------------


class TestParseDiagnostic:
    RAW = {
        "range": {
            "start": {"line": 11, "character": 4},
            "end": {"line": 11, "character": 9},
        },
        "severity": 2,
        "message": 'Import "foo" is unused',
        "source": "Pyright",
    }

    def test_position_is_one_based(self) -> None:
        diagnostic = parse_diagnostic("src/app.py", self.RAW)

        assert (diagnostic.line, diagnostic.column) == (12, 5)

    def test_carries_the_path_it_was_given(self) -> None:
        assert parse_diagnostic("src/app.py", self.RAW).path == "src/app.py"

    def test_message_and_source_survive_unchanged(self) -> None:
        diagnostic = parse_diagnostic("src/app.py", self.RAW)

        assert diagnostic.message == 'Import "foo" is unused'
        assert diagnostic.source == "Pyright"

    @pytest.mark.parametrize(
        ("code", "expected"),
        [(1, "error"), (2, "warning"), (3, "info"), (4, "hint")],
    )
    def test_severity_codes_map_to_names(self, code: int, expected: str) -> None:
        diagnostic = parse_diagnostic("a.py", {**self.RAW, "severity": code})

        assert diagnostic.severity == expected

    def test_a_missing_severity_is_treated_as_an_error(self) -> None:
        # The spec leaves it to the client. Guessing "hint" would sort a real problem to the
        # bottom of the panel and hide it; guessing "error" is loud, and wrong at worst.
        raw = {key: value for key, value in self.RAW.items() if key != "severity"}

        assert parse_diagnostic("a.py", raw).severity == "error"

    def test_an_unknown_severity_code_is_treated_as_an_error(self) -> None:
        assert parse_diagnostic("a.py", {**self.RAW, "severity": 99}).severity == "error"

    def test_a_diagnostic_with_no_source_still_parses(self) -> None:
        raw = {"range": self.RAW["range"], "message": "boom"}

        diagnostic = parse_diagnostic("a.py", raw)

        assert diagnostic.source == ""
        assert diagnostic.message == "boom"

    def test_a_diagnostic_with_no_range_lands_on_line_one(self) -> None:
        assert parse_diagnostic("a.py", {"message": "boom"}).line == 1

    def test_severity_rank_orders_worst_first(self) -> None:
        ranks = [severity_rank(name) for name in ("error", "warning", "info", "hint")]

        assert ranks == sorted(ranks)
        assert severity_rank("error") < severity_rank("hint")


class TestParseCompletion:
    def test_reads_label_detail_and_kind(self) -> None:
        item = parse_completion(
            {"label": "append", "detail": "(object: int) -> None", "kind": 2}
        )

        assert item == Completion(
            label="append",
            detail="(object: int) -> None",
            kind="method",
            insert_text="append",
        )

    def test_insert_text_defaults_to_the_label(self) -> None:
        # Most servers omit `insertText` when it equals the label. Falling back to "" here
        # produces a completion that inserts nothing, which looks like the editor eating a
        # keystroke rather than like a parsing bug.
        assert parse_completion({"label": "value", "kind": 6}).insert_text == "value"

    def test_an_explicit_insert_text_wins(self) -> None:
        item = parse_completion({"label": "print", "kind": 3, "insertText": "print()"})

        assert item.insert_text == "print()"

    def test_a_text_edit_supplies_the_insert_text(self) -> None:
        item = parse_completion(
            {
                "label": "os.path",
                "kind": 9,
                "textEdit": {
                    "range": {
                        "start": {"line": 0, "character": 0},
                        "end": {"line": 0, "character": 2},
                    },
                    "newText": "os.path",
                },
            }
        )

        assert item.insert_text == "os.path"

    def test_label_details_fill_in_a_missing_detail(self) -> None:
        item = parse_completion(
            {"label": "sorted", "kind": 3, "labelDetails": {"detail": "(iterable)"}}
        )

        assert item.detail == "(iterable)"

    def test_an_unknown_kind_falls_back_to_text(self) -> None:
        assert parse_completion({"label": "x", "kind": 999}).kind == "text"

    def test_a_missing_kind_falls_back_to_text(self) -> None:
        assert parse_completion({"label": "x"}).kind == "text"


class TestLanguageId:
    """`did_open` needs an LSP `languageId`, and the app has nothing else that knows one.

    Deriving it here rather than in `app.py` keeps every fact about the protocol on this side
    of the boundary — the editor deals in paths and text, and `languageId` is a protocol
    vocabulary word, not a property of the file.
    """

    @pytest.mark.parametrize(
        ("path", "expected"),
        [
            ("src/app.py", "python"),
            ("src/app.pyi", "python"),
            ("src/app.ts", "typescript"),
            ("src/app.tsx", "typescriptreact"),
            ("src/app.js", "javascript"),
            ("src/app.jsx", "javascriptreact"),
            ("package.json", "json"),
            ("README.md", "markdown"),
            ("style.css", "css"),
            ("index.html", "html"),
            ("compose.yaml", "yaml"),
            ("compose.yml", "yaml"),
            ("pyproject.toml", "toml"),
            ("run.sh", "shellscript"),
            ("main.rs", "rust"),
            ("main.go", "go"),
        ],
    )
    def test_known_extensions(self, path: str, expected: str) -> None:
        assert language_id_for(path) == expected

    def test_the_lookup_is_case_insensitive(self) -> None:
        # Windows hands back whatever casing is on disk, and `.PY` is a Python file.
        assert language_id_for("SRC/APP.PY") == "python"

    def test_a_windows_path_is_handled(self) -> None:
        windows_path = "D:\\proj\\src\\app.py"

        assert language_id_for(windows_path) == "python"

    def test_a_file_named_by_convention_rather_than_extension(self) -> None:
        # Dockerfile and Makefile carry their language in the whole name. Splitting on "." and
        # giving up is how those end up as plaintext.
        assert language_id_for("Dockerfile") == "dockerfile"
        assert language_id_for("build/Makefile") == "makefile"

    def test_an_unknown_extension_falls_back_to_plaintext(self) -> None:
        # "plaintext" rather than "" because it is a real LSP languageId: a server that does
        # not handle it declines cleanly, whereas an empty string is a protocol violation.
        assert language_id_for("notes.zzz") == "plaintext"

    def test_a_file_with_no_extension_falls_back_to_plaintext(self) -> None:
        assert language_id_for("LICENSE") == "plaintext"

    def test_a_dotfile_is_not_mistaken_for_an_extension(self) -> None:
        # `.gitignore` splits into ("", ".gitignore"); treating "gitignore" as the extension
        # is the bug this pins.
        assert language_id_for(".gitignore") == "plaintext"


class TestInstallHint:
    def test_names_the_pyright_install_command(self) -> None:
        assert install_hint("pyright-langserver") == "npm install -g pyright"

    def test_names_the_typescript_install_command(self) -> None:
        hint = install_hint("typescript-language-server")

        assert hint.startswith("npm install -g typescript-language-server")

    def test_a_windows_cmd_shim_is_recognised(self) -> None:
        # npm installs `pyright-langserver.cmd` on Windows and that is what ends up on PATH,
        # so the lookup has to see through the extension or the hint silently goes generic.
        assert install_hint(r"C:\npm\pyright-langserver.cmd") == "npm install -g pyright"

    def test_an_unknown_server_still_gets_actionable_advice(self) -> None:
        hint = install_hint("some-other-language-server")

        assert "some-other-language-server" in hint
        assert "PATH" in hint


# --------------------------------------------------------------------------------------
# The client, against the fake server
# --------------------------------------------------------------------------------------


class TestStartup:
    async def test_a_missing_binary_names_the_install_command(self, tmp_path: Path) -> None:
        client = LspClient(["pyright-langserver"], tmp_path)

        with pytest.raises(LspError) as raised:
            await client.start()

        message = str(raised.value)
        assert "pyright-langserver" in message
        assert "npm install -g pyright" in message
        # The whole point: not a FileNotFoundError traceback. Nothing on this machine has a
        # language server installed, so this is the *first* path a new user takes.
        assert "Traceback" not in message
        assert not client.running

    async def test_a_missing_binary_raises_before_anything_is_spawned(
        self, tmp_path: Path
    ) -> None:
        client = LspClient(["definitely-not-a-real-language-server-xyz"], tmp_path)

        with pytest.raises(LspError):
            await client.start()

        assert not client.running
        # Safe to call regardless — the app's error path does exactly this.
        await client.close()

    async def test_start_completes_the_handshake(self, start_client) -> None:
        client = await start_client()

        assert client.running


class TestDiagnostics:
    async def test_a_publish_notification_arrives_and_is_queryable_by_path(
        self, start_client
    ) -> None:
        arrived = asyncio.Event()
        seen: list[tuple[str, tuple[Diagnostic, ...]]] = []

        def _on_diagnostics(path: str, diagnostics: tuple[Diagnostic, ...]) -> None:
            seen.append((path, diagnostics))
            arrived.set()

        client = await start_client(on_diagnostics=_on_diagnostics)
        await client.did_open("src/app.py", "x = vlaue\n", "python")
        await asyncio.wait_for(arrived.wait(), 15)

        assert seen[0][0] == "src/app.py"
        assert client.diagnostics("src/app.py") == seen[0][1]

    async def test_the_diagnostic_is_converted_to_one_based_positions(
        self, start_client
    ) -> None:
        arrived = asyncio.Event()
        client = await start_client(on_diagnostics=lambda *_: arrived.set())
        await client.did_open("src/app.py", "x = vlaue\n", "python")
        await asyncio.wait_for(arrived.wait(), 15)

        diagnostic = client.diagnostics("src/app.py")[0]

        # The server said line 2, character 4 — zero-based.
        assert (diagnostic.line, diagnostic.column) == (3, 5)
        assert diagnostic.severity == "error"
        assert diagnostic.source == "fake"
        assert diagnostic.path == "src/app.py"

    async def test_paths_come_back_relative_to_the_root(self, start_client) -> None:
        """The panel and the editor both address files the way `Entry.path` does.

        A diagnostic carrying an absolute `file:///C:/Users/.../src/app.py` would be a path
        the editor cannot open and the panel cannot group with anything else.
        """
        arrived = asyncio.Event()
        client = await start_client(on_diagnostics=lambda *_: arrived.set())
        await client.did_open("src/deep/nested/mod.py", "x = 1\n", "python")
        await asyncio.wait_for(arrived.wait(), 15)

        assert [d.path for d in client.diagnostics()] == ["src/deep/nested/mod.py"]

    async def test_querying_with_no_path_returns_everything(self, start_client) -> None:
        arrived = asyncio.Event()
        count = 0

        def _on_diagnostics(*_: object) -> None:
            nonlocal count
            count += 1
            if count == 2:
                arrived.set()

        client = await start_client(on_diagnostics=_on_diagnostics)
        await client.did_open("a.py", "x\n", "python")
        await client.did_open("b.py", "y\n", "python")
        await asyncio.wait_for(arrived.wait(), 15)

        assert len(client.diagnostics()) == 2
        assert {d.path for d in client.diagnostics()} == {"a.py", "b.py"}

    def test_a_notification_is_routed_by_method_not_by_id(self, tmp_path: Path) -> None:
        """The single most important line in the dispatcher, tested without a process.

        `publishDiagnostics` has no `id`. A dispatcher that only matches responses to pending
        futures drops it on the floor — and the symptom is not an error, it is diagnostics
        that never appear, which reads like a server that never sent any.
        """
        seen: list[tuple[str, tuple[Diagnostic, ...]]] = []
        client = LspClient(["x"], tmp_path, on_diagnostics=lambda p, d: seen.append((p, d)))

        client.handle_message(
            {
                "jsonrpc": "2.0",
                "method": "textDocument/publishDiagnostics",
                "params": {
                    "uri": path_to_uri(f"{tmp_path}/src/app.py"),
                    "diagnostics": [
                        {
                            "range": {
                                "start": {"line": 0, "character": 0},
                                "end": {"line": 0, "character": 1},
                            },
                            "severity": 2,
                            "message": "unused",
                            "source": "t",
                        }
                    ],
                },
            }
        )

        assert seen and seen[0][0] == "src/app.py"
        assert client.diagnostics("src/app.py")[0].severity == "warning"

    def test_a_republish_replaces_rather_than_appends(self, tmp_path: Path) -> None:
        """`publishDiagnostics` is a full replacement for that file, always.

        Appending would make the panel grow by one row per keystroke and never shrink — the
        user fixes the error and it stays on screen forever.
        """
        client = LspClient(["x"], tmp_path)
        uri = path_to_uri(f"{tmp_path}/a.py")
        raw = {
            "range": {
                "start": {"line": 0, "character": 0},
                "end": {"line": 0, "character": 1},
            },
            "severity": 1,
            "message": "boom",
            "source": "t",
        }

        client.handle_message(
            {
                "method": "textDocument/publishDiagnostics",
                "params": {"uri": uri, "diagnostics": [raw, raw]},
            }
        )
        assert len(client.diagnostics("a.py")) == 2

        client.handle_message(
            {
                "method": "textDocument/publishDiagnostics",
                "params": {"uri": uri, "diagnostics": []},
            }
        )
        assert client.diagnostics("a.py") == ()
        assert client.diagnostics() == ()

    def test_an_exception_in_the_callback_does_not_escape(self, tmp_path: Path) -> None:
        """The callback runs on the stdout reader task. An exception there kills the reader
        and every later message with it — including the responses other calls are awaiting.
        """

        def _boom(*_: object) -> None:
            raise RuntimeError("widget not mounted yet")

        client = LspClient(["x"], tmp_path, on_diagnostics=_boom)

        client.handle_message(
            {
                "method": "textDocument/publishDiagnostics",
                "params": {"uri": path_to_uri(f"{tmp_path}/a.py"), "diagnostics": []},
            }
        )

    def test_an_unknown_notification_is_ignored(self, tmp_path: Path) -> None:
        client = LspClient(["x"], tmp_path)

        client.handle_message({"method": "window/logMessage", "params": {"message": "hi"}})
        client.handle_message({"method": "$/progress", "params": {}})

        assert client.diagnostics() == ()


class TestRequests:
    async def test_completion_returns_parsed_items(self, start_client) -> None:
        client = await start_client()
        await client.did_open("src/app.py", "value = 1\nval\n", "python")

        items = await client.completion("src/app.py", 2, 4)

        assert [item.label for item in items] == ["value", "values"]
        assert items[0] == Completion("value", "int", "variable", "value")

    async def test_hover_returns_plain_text(self, start_client) -> None:
        client = await start_client()
        await client.did_open("src/app.py", "value = 1\n", "python")

        assert await client.hover("src/app.py", 1, 1) == "(variable) value: int"

    async def test_definition_returns_a_one_based_location(self, start_client) -> None:
        client = await start_client()
        await client.did_open("src/app.py", "value = 1\n", "python")

        location = await client.definition("src/app.py", 1, 1)

        assert location == Location("src/app.py", 1, 7)

    async def test_requests_after_close_fail_loudly(self, start_client) -> None:
        client = await start_client()
        await client.close()

        with pytest.raises(LspError):
            await client.completion("src/app.py", 1, 1)


class TestDebounce:
    """`did_change` fires per keystroke; the wire must not.

    Exercised without a process by replacing `_notify`, because what is asserted here is *how
    many* notifications were produced — a fact about scheduling, not about pipes.
    """

    async def test_a_burst_of_edits_becomes_one_notification(self, tmp_path: Path) -> None:
        sent: list[tuple[str, dict]] = []

        async def _notify(method: str, params: dict) -> None:
            sent.append((method, params))

        client = LspClient(["x"], tmp_path, debounce=0.05)
        client._notify = _notify  # type: ignore[method-assign]

        await client.did_change("a.py", "v")
        await client.did_change("a.py", "va")
        await client.did_change("a.py", "val")
        assert sent == []

        await client.flush()

        assert len(sent) == 1
        assert sent[0][0] == "textDocument/didChange"
        assert sent[0][1]["contentChanges"][0]["text"] == "val"

    async def test_the_document_version_advances_once_per_send(self, tmp_path: Path) -> None:
        sent: list[dict] = []

        async def _notify(method: str, params: dict) -> None:
            sent.append(params)

        client = LspClient(["x"], tmp_path, debounce=0.0)
        client._notify = _notify  # type: ignore[method-assign]

        await client.did_change("a.py", "one")
        await client.flush()
        await client.did_change("a.py", "two")
        await client.flush()

        versions = [params["textDocument"]["version"] for params in sent]
        assert len(versions) == 2
        assert versions[1] > versions[0]

    async def test_edits_to_two_files_are_both_sent(self, tmp_path: Path) -> None:
        sent: list[dict] = []

        async def _notify(method: str, params: dict) -> None:
            sent.append(params)

        client = LspClient(["x"], tmp_path, debounce=0.05)
        client._notify = _notify  # type: ignore[method-assign]

        await client.did_change("a.py", "1")
        await client.did_change("b.py", "2")
        await client.flush()

        assert len(sent) == 2

    async def test_a_request_flushes_the_pending_edit_first(self, tmp_path: Path) -> None:
        """Otherwise the server answers about the document as it was several keystrokes ago,
        and completion silently offers names from a version the user cannot see.
        """
        order: list[str] = []

        async def _notify(method: str, params: dict) -> None:
            order.append(method)

        async def _request(method: str, params: dict, timeout: float = 0.0):
            order.append(method)
            return []

        client = LspClient(["x"], tmp_path, debounce=5.0)
        client._notify = _notify  # type: ignore[method-assign]
        client._request = _request  # type: ignore[method-assign]

        await client.did_change("a.py", "val")
        await client.completion("a.py", 1, 4)

        assert order == ["textDocument/didChange", "textDocument/completion"]


class TestLifetime:
    async def test_close_terminates_the_child(self, start_client) -> None:
        client = await start_client()
        process = client._process
        assert process is not None and process.returncode is None

        await client.close()

        assert process.returncode is not None
        assert not client.running

    async def test_close_is_idempotent(self, start_client) -> None:
        client = await start_client()

        await client.close()
        await client.close()

        assert not client.running

    async def test_close_fails_anything_still_waiting(self, start_client) -> None:
        """A future nobody ever resolves is a frozen UI, not a slow one.

        Racing `close()` against an in-flight request is the realistic shape of this: the user
        quits while a completion is on the wire.
        """
        client = await start_client()
        pending = asyncio.ensure_future(client.hover("a.py", 1, 1))
        await asyncio.sleep(0)
        await client.close()

        with pytest.raises(LspError):
            await pending

    async def test_the_context_manager_closes_on_the_way_out(
        self, server_script: Path, tmp_path: Path
    ) -> None:
        client = LspClient([sys.executable, str(server_script)], tmp_path)

        async with client:
            assert client.running
            process = client._process

        assert process is not None and process.returncode is not None
        assert not client.running

    async def test_close_after_a_failed_start_is_harmless(self, tmp_path: Path) -> None:
        client = LspClient(["still-not-a-language-server"], tmp_path)

        with pytest.raises(LspError):
            await client.start()
        await client.close()

        assert not client.running

    async def test_did_close_forgets_that_files_diagnostics(self, start_client) -> None:
        arrived = asyncio.Event()
        client = await start_client(on_diagnostics=lambda *_: arrived.set())
        await client.did_open("src/app.py", "x = vlaue\n", "python")
        await asyncio.wait_for(arrived.wait(), 15)
        assert client.diagnostics("src/app.py")

        await client.did_close("src/app.py")

        assert client.diagnostics("src/app.py") == ()
