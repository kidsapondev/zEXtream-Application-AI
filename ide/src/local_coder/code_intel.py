"""Between the editor buffer and the language server.

Everything here answers one of two questions: *should we ask the server anything right now*,
and *what do we do with what it said*. Deliberately free of Textual imports — the decisions
are string work and interaction order, and both are far cheaper to get right against a fake
client than by squinting at a terminal.

Two failure modes shape the whole module:

* **Asking about stale text.** `LspClient.did_change` is debounced and the app only syncs on a
  dirty *transition*, so the server's copy of a file being actively typed into is routinely
  several keystrokes behind. A completion list for the document as it was four characters ago
  looks entirely correct from the outside and is useless. Hence `complete()` takes the buffer
  and pushes it before asking.
* **Asking too often.** Every trigger is a round trip and a popup appearing over the user's
  code. `should_trigger` exists to make the common keystrokes — a space, a closing bracket,
  anything inside a string or a comment — cost nothing.
"""

from __future__ import annotations

from dataclasses import dataclass

from .lsp import Completion, Location, LspClient

#: Characters that can appear inside an identifier. `$` is included for JavaScript, where it
#: is a perfectly ordinary name character and omitting it would break completion on jQuery-era
#: code and on any `$`-prefixed convention.
_IDENT = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_$"


@dataclass(frozen=True, slots=True)
class CompletionRequest:
    """What was asked, as it was when it was asked.

    Frozen because it outlives the keystroke that created it: the answer arrives later, and
    `apply` needs the prefix as it stood at request time to know how much text the chosen
    candidate is standing in for. A mutable request would let the caller "helpfully" update it
    to the current cursor and quietly reintroduce the bug it exists to prevent.
    """

    path: str
    line: int
    column: int
    prefix: str


class CodeIntel:
    """Completion, definition and hover for one workspace.

    Every method is safe to call with no language server: `client` is `None` whenever none is
    installed, which is the default state on a fresh machine, and each method degrades to an
    empty answer rather than raising. Code intelligence is the one genuinely optional feature
    in this app.
    """

    def __init__(self, client: LspClient | None) -> None:
        self._client = client

    @property
    def available(self) -> bool:
        return self._client is not None

    # -- deciding whether to ask ---------------------------------------------------------

    def should_trigger(self, text: str, line: int, column: int) -> bool:
        """Whether the character just typed warrants asking the server.

        True after an identifier character or a member-access dot; false after whitespace,
        punctuation, and anywhere inside a string or a comment. Each false is a round trip and
        a popup that did not happen.
        """
        before = self._line_before_cursor(text, line, column)
        if before is None or not before:
            return False
        if _in_string_or_comment(before):
            return False

        last = before[-1]
        if last in _IDENT:
            return True
        if last == ".":
            # A dot after a digit is a decimal point, not member access. `1.` offering the
            # float's methods is technically defensible and, in practice, a popup covering the
            # code every time someone types a number.
            return len(before) < 2 or before[-2] not in "0123456789"
        return False

    def word_prefix(self, text: str, line: int, column: int) -> str:
        """The identifier immediately left of the cursor.

        Used twice: to filter the server's list, and to know how much text a chosen candidate
        replaces. Returns `""` at the start of a line or straight after a non-identifier
        character, which is the "insert, do not replace" case.
        """
        before = self._line_before_cursor(text, line, column)
        if not before:
            return ""
        index = len(before)
        while index > 0 and before[index - 1] in _IDENT:
            index -= 1
        return before[index:]

    def request(
        self, path: str, text: str, line: int, column: int
    ) -> CompletionRequest | None:
        """A request for this position, or `None` when this position does not warrant one.

        Also `None` with no server: there is no point building a request nobody can answer,
        and returning one would invite the caller to open a popup that never fills.
        """
        if self._client is None or not self.should_trigger(text, line, column):
            return None
        return CompletionRequest(path, line, column, self.word_prefix(text, line, column))

    # -- asking ---------------------------------------------------------------------------

    async def complete(
        self, path: str, text: str, line: int, column: int
    ) -> tuple[Completion, ...]:
        """Completions for the cursor, ranked and filtered for what has been typed.

        Pushes the buffer first. That ordering is the point of the method: the server answers
        about the document it has, so the document it has must be the one on screen.
        """
        if self._client is None:
            return ()
        prefix = self.word_prefix(text, line, column)
        try:
            await self._client.did_change(path, text)
            candidates = await self._client.completion(path, line, column)
        except Exception:
            # A server that died mid-session must not turn a keystroke into a traceback. The
            # popup simply does not appear; `LspClient` surfaces the failure through its own
            # log sink.
            return ()
        return rank(candidates, prefix)

    async def define(self, path: str, line: int, column: int) -> Location | None:
        if self._client is None:
            return None
        try:
            return await self._client.definition(path, line, column)
        except Exception:
            return None

    async def describe(self, path: str, line: int, column: int) -> str | None:
        """Hover text, or `None` when there is nothing worth showing.

        Whitespace-only hover counts as nothing: some servers answer with an empty markdown
        block rather than with no result, and a status line that clears itself to show a blank
        tooltip is worse than one that does not react.
        """
        if self._client is None:
            return None
        try:
            text = await self._client.hover(path, line, column)
        except Exception:
            return None
        if text is None or not text.strip():
            return None
        return text

    # -- using the answer -----------------------------------------------------------------

    @staticmethod
    def apply(
        text: str, line: int, column: int, prefix: str, completion: Completion
    ) -> tuple[str, int]:
        """Inserts `completion` at the cursor, replacing `prefix`.

        Returns the new text of the cursor's line and the new column — one line's worth of
        edit, because that is exactly what the caller has to apply. Handing back a whole
        document would make it work out which part changed.

        Replacing rather than inserting is the entire subtlety. The server is asked at the
        cursor and answers with the *whole* identifier, so a client that inserts produces
        `selfself` — the classic broken-autocomplete symptom.
        """
        lines = text.split("\n")
        index = max(0, min(line - 1, len(lines) - 1))
        current = lines[index] if lines else ""
        cut = max(0, min(column - 1, len(current)))

        before, after = current[:cut], current[cut:]
        # Only remove the prefix if it is genuinely still there. The request carries the prefix
        # as it was when sent; by the time the user picks something the line can have changed,
        # and deleting `len(prefix)` characters regardless would eat text the prefix never
        # stood for.
        if prefix and before.endswith(prefix):
            before = before[: -len(prefix)]

        insert = completion.insert_text or completion.label
        return f"{before}{insert}{after}", len(before) + len(insert) + 1

    # -- internals -------------------------------------------------------------------------

    @staticmethod
    def _line_before_cursor(text: str, line: int, column: int) -> str | None:
        """The cursor line up to the cursor, or `None` when the position is not in the text.

        Positions are 1-based here, matching `lsp.py` and everything else a person reads.
        """
        if line < 1 or column < 1:
            return None
        lines = text.split("\n")
        if line > len(lines):
            return None
        current = lines[line - 1]
        return current[: min(column - 1, len(current))]


def _in_string_or_comment(before: str) -> bool:
    """Whether the cursor sits inside a string literal or a line comment.

    A single left-to-right scan rather than a parse: this runs on every keystroke, and the
    only question is whether asking the server is worth a round trip. Both `#` and `//` count
    as comment starts regardless of language — a `#` outside a string is a comment in every
    language this app highlights, and treating it as one in the two where it is not costs a
    completion nobody was going to use inside a comment anyway.
    """
    quote: str | None = None
    index = 0
    while index < len(before):
        char = before[index]
        if quote is not None:
            if char == "\\":
                index += 2
                continue
            if char == quote:
                quote = None
        elif char in "\"'":
            quote = char
        elif char == "#":
            return True
        elif char == "/" and before[index + 1 : index + 2] == "/":
            return True
        index += 1
    return quote is not None


def rank(candidates: tuple[Completion, ...], prefix: str) -> tuple[Completion, ...]:
    """Filters and orders the server's list for what has actually been typed.

    Servers return hundreds of items and frequently ignore the prefix entirely, so an unranked
    list is not a shortlist — it is the whole module namespace, in whatever order the server
    felt like. Ordering, best first:

    1. candidates starting with the prefix, exact case before case-insensitive
    2. candidates merely containing it — a fallback, never a peer of a real prefix match
    3. public names before private ones, then shorter labels, then alphabetical

    Anything not matching at all is dropped. With no prefix everything is kept, since there is
    nothing to filter on and the user asked to see what is available.
    """
    lowered = prefix.lower()

    def sort_key(item: Completion) -> tuple[int, int, int, str]:
        label = item.label
        if not prefix:
            tier = 0
        elif label.startswith(prefix):
            tier = 0
        elif label.lower().startswith(lowered):
            tier = 1
        else:
            tier = 2
        # `_hidden` is almost never what someone reaching for a member of a module meant, and
        # it would otherwise sort first on text.
        private = 1 if label.startswith("_") else 0
        return (tier, private, len(label), label)

    matching = [
        item
        for item in candidates
        if not prefix or lowered in item.label.lower()
    ]
    return tuple(sorted(matching, key=sort_key))
