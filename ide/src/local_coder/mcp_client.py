"""The real `CoderBackend`: talks to `host-bridge/dist/mcp-main.js` over stdio.

Standard library only, on purpose. The obvious alternative is the official MCP Python SDK,
but this client needs exactly three things — spawn a server, complete the handshake, call a
tool — and adding a fast-moving dependency to get them would reintroduce the problem
`pyproject.toml` pins versions to avoid: a locally-hosted model writing against a remembered
older API. Newline-delimited JSON-RPC 2.0 is about a hundred lines and does not move.

Three failure modes shaped this file, all of them things that hang rather than crash:

* **An undrained pipe deadlocks the child.** The server logs to stderr (stdout is the
  protocol and must never carry anything else), and a child whose stderr buffer fills will
  block forever mid-write. Both pipes are drained by their own task for the whole lifetime
  of the process, not read on demand.
* **A response can arrive split across reads, and several can arrive in one.** Everything
  goes through a buffer split on newlines, the same framing the Node side uses for NDJSON.
* **An orphaned server holds a model in VRAM.** Every exit path — success, exception,
  cancellation — goes through `close()`, which terminates the child and waits for it.
"""

from __future__ import annotations

import asyncio
import json
import os
import re
from pathlib import Path
from typing import Any, Callable

from .protocols import (
    AgentError,
    AgentRun,
    AgentStep,
    Entry,
    EntryKind,
    FileContent,
    ModelStatus,
    SearchHit,
    StopReason,
)

# The handshake is cheap and local; if it has not completed in this long the server is not
# coming up at all (usually a missing build or a Node that failed to start).
_HANDSHAKE_TIMEOUT = 30.0

# A real agent run reads files, calls a 14B model several times, and may run a build. On a
# cold model load the first turn alone can take well over a minute. This is a guard against
# a hung process, not a performance target.
_AGENT_TIMEOUT = 900.0

_METADATA_TIMEOUT = 30.0

_PROTOCOL_VERSION = "2025-06-18"


def _to_posix(path: str) -> str:
    """The sandbox on the far side resolves relative POSIX paths.

    Handing it a Windows path produces a rejection whose message points at the path rather
    than at the separator, which is a genuinely confusing thing to debug. Normalising once,
    at the boundary, is cheaper than recognising that error later.
    """
    return path.replace("\\", "/").strip("/")


class McpBackend:
    """Implements `CoderBackend` against a spawned MCP server.

    Use as an async context manager; `close()` is not optional.
    """

    def __init__(
        self,
        server_script: str | Path,
        *,
        env: dict[str, str] | None = None,
        node: str = "node",
        on_log: Callable[[str], None] | None = None,
    ) -> None:
        self._script = Path(server_script)
        self._env = env
        self._node = node
        # Server stderr is diagnostic output meant for a human. A TUI has no terminal to
        # print it to, so it is handed to the caller instead of being written anywhere.
        self._on_log = on_log
        self._process: asyncio.subprocess.Process | None = None
        self._pending: dict[int, asyncio.Future[dict[str, Any]]] = {}
        self._next_id = 0
        self._tasks: list[asyncio.Task[None]] = []
        self._write_lock = asyncio.Lock()

    # -- lifecycle ---------------------------------------------------------------------

    async def __aenter__(self) -> "McpBackend":
        await self.start()
        return self

    async def __aexit__(self, *_exc: object) -> None:
        await self.close()

    async def start(self) -> None:
        if not self._script.exists():
            raise AgentError(
                f"MCP server not found at {self._script}. "
                "Build it first: pnpm --filter host-bridge build"
            )

        env = {**os.environ, **(self._env or {})}
        try:
            self._process = await asyncio.create_subprocess_exec(
                self._node,
                str(self._script),
                stdin=asyncio.subprocess.PIPE,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
                env=env,
                # The server loads its configuration with `dotenv/config`, which resolves
                # `.env` against the *working directory*, not the script. Launched from
                # anywhere else it silently finds the wrong file — or none — and then reports
                # a perfectly clear "workspace not configured" for a workspace that is in fact
                # configured. Pinning the cwd to the host-bridge package is what makes
                # `host-bridge/.env` the file it actually reads.
                cwd=str(self._script.parent.parent),
            )
        except FileNotFoundError as exc:
            raise AgentError(
                f"Could not run '{self._node}'. Node 24+ must be on PATH."
            ) from exc

        self._tasks.append(asyncio.create_task(self._read_stdout()))
        self._tasks.append(asyncio.create_task(self._read_stderr()))

        try:
            await asyncio.wait_for(self._handshake(), _HANDSHAKE_TIMEOUT)
        except TimeoutError:
            await self.close()
            raise AgentError(
                "The MCP server did not complete its handshake. "
                "Check that host-bridge/dist is built and Node 24+ is installed."
            ) from None

    async def close(self) -> None:
        for task in self._tasks:
            task.cancel()
        self._tasks.clear()

        # Anything still waiting must be failed, not left pending: a future that never
        # resolves turns a dead server into a frozen UI.
        for future in self._pending.values():
            if not future.done():
                future.set_exception(AgentError("MCP server closed"))
        self._pending.clear()

        process, self._process = self._process, None
        if process is None or process.returncode is not None:
            return
        try:
            process.terminate()
            await asyncio.wait_for(process.wait(), 5.0)
        except (ProcessLookupError, TimeoutError):
            # A server mid-generation may not honour terminate promptly; killing it is
            # correct here, since leaving it running would hold a model in VRAM.
            try:
                process.kill()
            except ProcessLookupError:
                pass

    # -- transport ---------------------------------------------------------------------

    async def _read_stdout(self) -> None:
        assert self._process is not None and self._process.stdout is not None
        stream = self._process.stdout
        buffer = b""
        while True:
            chunk = await stream.read(4096)
            if not chunk:
                break
            buffer += chunk
            while b"\n" in buffer:
                line, buffer = buffer.split(b"\n", 1)
                if line.strip():
                    self._dispatch(line)

    def _dispatch(self, line: bytes) -> None:
        try:
            message = json.loads(line)
        except json.JSONDecodeError:
            # Never fatal. A stray non-JSON line on stdout means something on the far side
            # logged to the wrong stream; dropping it keeps the session alive, and the
            # request it belonged to will surface as a timeout if it mattered.
            return
        if not isinstance(message, dict):
            return
        future = self._pending.pop(message.get("id", -1), None)
        if future is not None and not future.done():
            future.set_result(message)

    async def _read_stderr(self) -> None:
        assert self._process is not None and self._process.stderr is not None
        stream = self._process.stderr
        while True:
            line = await stream.readline()
            if not line:
                break
            if self._on_log is not None:
                self._on_log(line.decode("utf-8", "replace").rstrip())

    async def _send(self, payload: dict[str, Any]) -> None:
        if self._process is None or self._process.stdin is None:
            raise AgentError("MCP server is not running")
        data = (json.dumps(payload) + "\n").encode("utf-8")
        # Serialised because two concurrent writes can interleave inside one line and
        # corrupt the framing for everything that follows.
        async with self._write_lock:
            self._process.stdin.write(data)
            await self._process.stdin.drain()

    async def _request(
        self, method: str, params: dict[str, Any], timeout: float
    ) -> dict[str, Any]:
        self._next_id += 1
        request_id = self._next_id
        future: asyncio.Future[dict[str, Any]] = asyncio.get_running_loop().create_future()
        self._pending[request_id] = future

        await self._send(
            {"jsonrpc": "2.0", "id": request_id, "method": method, "params": params}
        )
        try:
            message = await asyncio.wait_for(future, timeout)
        except TimeoutError:
            self._pending.pop(request_id, None)
            raise AgentError(f"{method} timed out after {timeout:.0f}s") from None

        if "error" in message:
            raise AgentError(str(message["error"].get("message", message["error"])))
        result = message.get("result")
        if not isinstance(result, dict):
            raise AgentError(f"{method} returned no result")
        return result

    async def _handshake(self) -> None:
        await self._request(
            "initialize",
            {
                "protocolVersion": _PROTOCOL_VERSION,
                "capabilities": {},
                "clientInfo": {"name": "local-coder", "version": "0.1.0"},
            },
            _HANDSHAKE_TIMEOUT,
        )
        # A notification, so no id and no response to wait for. Skipping it leaves some
        # servers refusing tool calls as "not initialised".
        await self._send({"jsonrpc": "2.0", "method": "notifications/initialized"})

    async def _call_tool(
        self, name: str, arguments: dict[str, Any], timeout: float = _METADATA_TIMEOUT
    ) -> str:
        result = await self._request(
            "tools/call", {"name": name, "arguments": arguments}, timeout
        )
        text = "\n".join(
            block.get("text", "")
            for block in result.get("content", [])
            if isinstance(block, dict) and block.get("type") == "text"
        )
        if result.get("isError"):
            raise AgentError(text or f"{name} failed")
        return text

    # -- CoderBackend ------------------------------------------------------------------

    async def status(self) -> ModelStatus:
        try:
            text = await self._call_tool("local_model_status", {})
        except AgentError as exc:
            # `local_model_status` is the one call whose whole job is to explain why things
            # are broken, so it reports rather than raises.
            return ModelStatus(
                reachable=False,
                workspace_configured=False,
                workspace_root=None,
                models=(),
                tool_capable_models=(),
                allowed_commands=(str(exc),),
            )
        return _parse_status(text)

    async def list_dir(self, path: str = "") -> tuple[Entry, ...]:
        text = await self._call_tool("local_workspace_list", {"path": _to_posix(path)})
        return _parse_listing(text, _to_posix(path))

    async def read_file(self, path: str) -> FileContent:
        clean = _to_posix(path)
        text = await self._call_tool("local_workspace_read", {"path": clean})
        truncated = "[truncated" in text
        return FileContent(clean, text, len(text.encode("utf-8")), truncated)

    async def write_file(self, path: str, text: str) -> None:
        await self._call_tool(
            "local_workspace_write", {"path": _to_posix(path), "content": text}
        )

    async def search(self, query: str, path: str = "") -> tuple[SearchHit, ...]:
        text = await self._call_tool(
            "local_workspace_search", {"query": query, "path": _to_posix(path)}
        )
        return _parse_search(text)

    async def run_agent(
        self,
        task: str,
        *,
        path: str | None = None,
        model: str | None = None,
    ) -> AgentRun:
        arguments: dict[str, Any] = {"task": task}
        if path:
            arguments["path"] = _to_posix(path)
        if model:
            arguments["model"] = model
        try:
            text = await self._call_tool("local_code_agent", arguments, _AGENT_TIMEOUT)
        except AgentError as exc:
            return AgentRun(
                task=task, answer="", stopped=StopReason.ERROR, error=str(exc)
            )
        return _parse_agent_result(task, text)


# --------------------------------------------------------------------------------------
# Response parsing
#
# The MCP tools return human-readable text, not JSON, because their primary consumer is an
# IDE that shows the text to a person. Parsing it back into the dataclasses is therefore a
# real coupling to `formatAgentResult` in host-bridge/src/mcp/tools.ts. The tests pin the
# exact strings these parsers expect, so a change on the Node side fails here loudly rather
# than silently producing empty step lists.
# --------------------------------------------------------------------------------------

_STEP_RE = re.compile(r"^\s*\d+\.\s+(ok|FAIL)\s+(.*)$")
_STOPPED_RE = re.compile(r"^Stopped \(([^)]+)\):\s*(.*)$")
_TURNS_RE = re.compile(r"(\d+)\s+turn")
_SEARCH_RE = re.compile(r"^(.+?):(\d+):\s?(.*)$")
# `dir ` is space-padded to four characters so the name column lines up, and the columns are
# separated by two spaces — matching loosely on whitespace keeps this working if that
# padding is ever tidied up.
_LISTING_RE = re.compile(r"^(file|dir)\s\s+(.+?)\s\s+(\d+)$")
_MODEL_RE = re.compile(r"^\s+(\S.*?)\s+\[tools:\s*(\S+)\]$")


def _parse_agent_result(task: str, text: str) -> AgentRun:
    steps: list[AgentStep] = []
    stopped = StopReason.DONE
    error: str | None = None
    turns = 0
    answer_lines: list[str] = []
    in_steps = False

    for line in text.splitlines():
        if line.startswith("Local agent"):
            match = _TURNS_RE.search(line)
            if match:
                turns = int(match.group(1))
            continue
        if line.strip() == "Steps:":
            in_steps = True
            continue

        step_match = _STEP_RE.match(line)
        if in_steps and step_match:
            summary = step_match.group(2).strip()
            tool = summary.split("(", 1)[0].strip() if "(" in summary else summary
            steps.append(AgentStep(tool, summary, ok=step_match.group(1) == "ok"))
            continue

        stopped_match = _STOPPED_RE.match(line)
        if stopped_match:
            in_steps = False
            raw = stopped_match.group(1)
            stopped = (
                StopReason.MAX_TURNS if raw == "max-turns" else StopReason.ERROR
            )
            error = stopped_match.group(2).strip() or None
            continue

        if line.strip():
            in_steps = False
            answer_lines.append(line)
        elif answer_lines:
            answer_lines.append(line)

    return AgentRun(
        task=task,
        answer="\n".join(answer_lines).strip(),
        steps=tuple(steps),
        stopped=stopped,
        turns=turns,
        error=error,
    )


def _parse_listing(text: str, parent: str) -> tuple[Entry, ...]:
    entries: list[Entry] = []
    for line in text.splitlines():
        match = _LISTING_RE.match(line)
        if not match:
            continue
        kind_raw, name, size = match.groups()
        full = f"{parent}/{name}" if parent else name
        kind = EntryKind.DIR if kind_raw == "dir" else EntryKind.FILE
        entries.append(Entry(full, name, kind, int(size)))
    return tuple(entries)


def _parse_search(text: str) -> tuple[SearchHit, ...]:
    hits: list[SearchHit] = []
    for line in text.splitlines():
        match = _SEARCH_RE.match(line)
        if match:
            hits.append(SearchHit(match.group(1), int(match.group(2)), match.group(3)))
    return tuple(hits)


def _parse_status(text: str) -> ModelStatus:
    """Reads the three-section report `local_model_status` renders.

    Matching is done on the exact indented labels that tool emits (`  configured: yes`,
    `  root: ...`, `    name  [tools: YES]`) rather than on loose substrings, because the
    report is written for a human and contains prose — a fix hint mentioning
    `BRIDGE_EXEC_ALLOWLIST`, for instance — that a sloppier match would misread as data.
    """
    models: list[str] = []
    tool_capable: list[str] = []
    root: str | None = None
    reachable = False
    configured = False
    exec_enabled = False
    allowed: tuple[str, ...] = ()
    section = ""

    for line in text.splitlines():
        stripped = line.strip()
        if not line.startswith(" ") and stripped:
            # Section headings are the only unindented lines; both "enabled:" and
            # "reachable:" would otherwise be ambiguous between sections.
            section = stripped.lower()
            continue

        lowered = stripped.lower()
        if lowered.startswith("configured:"):
            configured = lowered.endswith("yes")
        elif lowered.startswith("root:"):
            root = stripped.split(":", 1)[1].strip() or None
        elif lowered.startswith("enabled:") and section.startswith("command execution"):
            exec_enabled = lowered.split(":", 1)[1].strip().startswith("yes")
        elif lowered.startswith("allowed commands:"):
            allowed = tuple(
                command.strip()
                for command in stripped.split(":", 1)[1].split(",")
                if command.strip()
            )
        elif lowered.startswith("reachable:"):
            reachable = lowered.split(":", 1)[1].strip().startswith("yes")
        else:
            match = _MODEL_RE.match(line)
            if match:
                name = match.group(1)
                models.append(name)
                if match.group(2).lower() == "yes":
                    tool_capable.append(name)

    return ModelStatus(
        reachable=reachable,
        workspace_configured=configured,
        workspace_root=root,
        models=tuple(models),
        tool_capable_models=tuple(tool_capable),
        exec_enabled=exec_enabled,
        allowed_commands=allowed,
    )
