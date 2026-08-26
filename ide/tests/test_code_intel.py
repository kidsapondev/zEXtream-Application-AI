"""Specification for `local_coder.code_intel`.

Nothing here starts a subprocess or talks to a language server. `_FakeClient` below stands in
for `LspClient` and records what it was asked, which is the only way to assert the thing that
actually matters about this module: that it asks the *right question about the right text*.
A `CodeIntel` that returns plausible candidates for the document as it was four keystrokes ago
looks completely correct from the outside, so the interaction is the specification.

The other half of the file is pure string work — `should_trigger`, `word_prefix`, the ranking
and `apply` — which needs no fake at all. Those are the functions a spurious popup or a
`selfself.foo` come out of, and they are cheap to pin down exhaustively here rather than by
squinting at a terminal.
"""

from __future__ import annotations

import pytest

from local_coder.code_intel import CodeIntel, CompletionRequest
from local_coder.lsp import Completion, Location, LspError


class _FakeClient:
    """Duck-typed stand-in for `LspClient`, recording every call.

    Deliberately not a `MagicMock`, for the reason `conftest.FakeBackend` gives: a mock
    answers to any attribute name, so a typo in `code_intel.py` would pass this suite and
    fail only in the real app against a real server nobody has installed.
    """

    def __init__(
        self,
        *,
        completions: tuple[Completion, ...] = (),
        hover: str | None = None,
        definition: Location | None = None,
        fail_with: Exception | None = None,
    ) -> None:
        self.completions = completions
        self.hover_result = hover
        self.definition_result = definition
        self.fail_with = fail_with
        self.calls: list[tuple[str, tuple[object, ...]]] = []

    def called(self, name: str) -> list[tuple[object, ...]]:
        return [args for called_name, args in self.calls if called_name == name]

    def _record(self, name: str, *args: object) -> None:
        self.calls.append((name, args))
        if self.fail_with is not None:
            raise self.fail_with

    async def did_change(self, path: str, text: str) -> None:
        self._record("did_change", path, text)

    async def flush(self) -> None:
        self._record("flush")

    async def completion(
        self, path: str, line: int, column: int
    ) -> tuple[Completion, ...]:
        self._record("completion", path, line, column)
        return self.completions

    async def hover(self, path: str, line: int, column: int) -> str | None:
        self._record("hover", path, line, column)
        return self.hover_result

    async def definition(self, path: str, line: int, column: int) -> Location | None:
        self._record("definition", path, line, column)
        return self.definition_result


def _completion(label: str, *, insert: str | None = None, kind: str = "text") -> Completion:
    return Completion(
        label=label,
        detail="",
        kind=kind,
        insert_text=insert if insert is not None else label,
    )


class TestShouldTrigger:
    """When a keystroke is worth a round trip to the server.

    Every `True` here is a request and a popup appearing over the user's text; every wrong
    `True` is a flash of a list nobody asked for.
    """

    def test_fires_after_an_identifier_character(self) -> None:
        intel = CodeIntel(_FakeClient())

        assert intel.should_trigger("os.pa", 1, 6) is True

    def test_fires_after_a_dot(self) -> None:
        intel = CodeIntel(_FakeClient())

        # The member-access case, and the one that matters most: the prefix is empty, so
        # nothing but the trigger tells us to ask.
        assert intel.should_trigger("os.", 1, 4) is True

    def test_does_not_fire_after_a_space(self) -> None:
        intel = CodeIntel(_FakeClient())

        assert intel.should_trigger("import ", 1, 8) is False

    def test_does_not_fire_after_a_closing_bracket(self) -> None:
        intel = CodeIntel(_FakeClient())

        assert intel.should_trigger("f()", 1, 4) is False
        assert intel.should_trigger("a[0]", 1, 5) is False
        assert intel.should_trigger("{}", 1, 3) is False

    def test_does_not_fire_at_the_start_of_a_line(self) -> None:
        intel = CodeIntel(_FakeClient())

        assert intel.should_trigger("value = 1", 1, 1) is False

    def test_does_not_fire_on_an_empty_line(self) -> None:
        intel = CodeIntel(_FakeClient())

        assert intel.should_trigger("", 1, 1) is False

    def test_does_not_fire_inside_a_string(self) -> None:
        intel = CodeIntel(_FakeClient())

        assert intel.should_trigger('name = "abc', 1, 12) is False
        assert intel.should_trigger("name = 'abc", 1, 12) is False

    def test_fires_again_after_a_string_is_closed(self) -> None:
        intel = CodeIntel(_FakeClient())

        assert intel.should_trigger('x = "abc".up', 1, 13) is True

    def test_does_not_fire_inside_a_comment(self) -> None:
        intel = CodeIntel(_FakeClient())

        assert intel.should_trigger("value = 1  # note", 1, 18) is False
        assert intel.should_trigger("const x = 1 // note", 1, 20) is False

    def test_does_not_fire_after_a_decimal_point(self) -> None:
        intel = CodeIntel(_FakeClient())

        # `1.` is a float literal being typed, not a member access. Asking here is a
        # guaranteed-empty round trip plus a popup over a number.
        assert intel.should_trigger("total = 1.", 1, 11) is False

    def test_uses_the_line_the_cursor_is_on(self) -> None:
        intel = CodeIntel(_FakeClient())
        text = "import os\nos.pa\n"

        assert intel.should_trigger(text, 2, 6) is True
        # Same column on the first line lands on "os" -- still an identifier, but the point
        # is that the two lines are told apart at all.
        assert intel.should_trigger(text, 1, 1) is False

    def test_a_line_number_past_the_end_is_not_a_crash(self) -> None:
        intel = CodeIntel(_FakeClient())

        assert intel.should_trigger("x = 1\n", 99, 1) is False


class TestWordPrefix:
    """The identifier immediately left of the cursor.

    Used twice and both uses have to agree: it filters the server's list, and it is the exact
    run of characters a chosen completion replaces.
    """

    def test_empty_at_the_start_of_a_line(self) -> None:
        intel = CodeIntel(_FakeClient())

        assert intel.word_prefix("value", 1, 1) == ""

    def test_partial_word_in_the_middle_of_a_line(self) -> None:
        intel = CodeIntel(_FakeClient())

        assert intel.word_prefix("os.pathsep", 1, 7) == "pat"

    def test_whole_word_at_the_end_of_a_line(self) -> None:
        intel = CodeIntel(_FakeClient())

        assert intel.word_prefix("value", 1, 6) == "value"

    def test_empty_on_an_empty_line(self) -> None:
        intel = CodeIntel(_FakeClient())

        assert intel.word_prefix("", 1, 1) == ""

    def test_a_dot_is_not_part_of_the_prefix(self) -> None:
        intel = CodeIntel(_FakeClient())

        # After `os.` there is nothing typed yet, so nothing gets replaced. Including the dot
        # would make an accepted completion eat it and produce `ospath`.
        assert intel.word_prefix("os.", 1, 4) == ""

    def test_underscores_and_digits_belong_to_the_identifier(self) -> None:
        intel = CodeIntel(_FakeClient())

        assert intel.word_prefix("_private_2", 1, 11) == "_private_2"

    def test_stops_at_the_preceding_punctuation(self) -> None:
        intel = CodeIntel(_FakeClient())

        assert intel.word_prefix("f(arg", 1, 6) == "arg"

    def test_reads_the_cursor_line_of_a_multi_line_buffer(self) -> None:
        intel = CodeIntel(_FakeClient())

        assert intel.word_prefix("import os\nos.pathsep\n", 2, 7) == "pat"

    def test_a_column_past_the_end_of_the_line_clamps(self) -> None:
        intel = CodeIntel(_FakeClient())

        assert intel.word_prefix("value", 1, 500) == "value"


class TestApply:
    """Turning a chosen candidate into new line text and a new cursor column."""

    def test_replaces_the_prefix_rather_than_appending_to_it(self) -> None:
        """The `selfself` case, spelled out.

        This is the classic broken-autocomplete symptom: the server is asked at the cursor,
        answers with the *whole* identifier, and a client that inserts rather than replaces
        doubles everything the user already typed.
        """
        line, column = CodeIntel.apply("self", 1, 5, "self", _completion("self"))

        assert line == "self"
        assert column == 5

    def test_replaces_a_partial_word(self) -> None:
        line, column = CodeIntel.apply("os.pat", 1, 7, "pat", _completion("pathsep"))

        assert line == "os.pathsep"
        assert column == 11

    def test_inserts_at_the_cursor_when_there_is_no_prefix(self) -> None:
        line, column = CodeIntel.apply("os.", 1, 4, "", _completion("pathsep"))

        assert line == "os.pathsep"
        assert column == 11

    def test_keeps_whatever_follows_the_cursor(self) -> None:
        line, column = CodeIntel.apply("f(va)", 1, 5, "va", _completion("value"))

        assert line == "f(value)"
        assert column == 8

    def test_uses_insert_text_in_preference_to_the_label(self) -> None:
        # `Completion` keeps them separate precisely because servers send different things
        # in each; the label is for reading, the insert text is what goes in the buffer.
        line, column = CodeIntel.apply(
            "ap", 1, 3, "ap", _completion("append(…)", insert="append")
        )

        assert line == "append"
        assert column == 7

    def test_a_prefix_that_no_longer_matches_the_line_inserts_instead(self) -> None:
        """A late answer must never eat characters it did not put there.

        The request carries the prefix as it was when it was sent. By the time the user picks
        something the line can have changed, and blindly deleting `len(prefix)` characters to
        the left would delete text the prefix was never standing for.
        """
        line, column = CodeIntel.apply("total", 1, 6, "xyz", _completion("value"))

        assert line == "totalvalue"
        assert column == 11

    def test_operates_on_the_cursor_line_of_a_multi_line_buffer(self) -> None:
        line, column = CodeIntel.apply(
            "import os\nos.pat\n", 2, 7, "pat", _completion("pathsep")
        )

        # Only the one line comes back -- the caller has exactly one line's worth of edit to
        # make, and handing back a whole document would make it guess which part changed.
        assert line == "os.pathsep"
        assert column == 11


class TestRanking:
    """The server's list is not a shortlist. Filtering and ordering it is this module's job."""

    async def test_prefix_matches_come_first(self) -> None:
        client = _FakeClient(
            completions=(
                _completion("unrelated_path"),
                _completion("pathsep"),
                _completion("path"),
            )
        )
        intel = CodeIntel(client)

        results = await intel.complete("a.py", "os.pat", 1, 7)

        labels = [item.label for item in results]
        assert labels[0] == "path"
        assert labels[1] == "pathsep"
        # A mid-word match is kept, but only after everything that actually starts with what
        # was typed -- it is a fallback, not a peer.
        assert labels[2] == "unrelated_path"

    async def test_candidates_that_do_not_match_at_all_are_dropped(self) -> None:
        client = _FakeClient(
            completions=(_completion("path"), _completion("environ"), _completion("getcwd"))
        )
        intel = CodeIntel(client)

        results = await intel.complete("a.py", "os.pat", 1, 7)

        assert [item.label for item in results] == ["path"]

    async def test_an_exact_case_match_outranks_a_case_insensitive_one(self) -> None:
        client = _FakeClient(completions=(_completion("Value"), _completion("value")))
        intel = CodeIntel(client)

        results = await intel.complete("a.py", "va", 1, 3)

        assert [item.label for item in results] == ["value", "Value"]

    async def test_an_empty_prefix_keeps_every_candidate(self) -> None:
        client = _FakeClient(
            completions=(_completion("zeta"), _completion("alpha"), _completion("_hidden"))
        )
        intel = CodeIntel(client)

        results = await intel.complete("a.py", "os.", 1, 4)

        assert len(results) == 3
        # Public names before private ones: `_hidden` is almost never what someone reaching
        # for a member of a module meant, and it would otherwise sort first on text.
        assert results[-1].label == "_hidden"

    async def test_shorter_labels_win_a_tie(self) -> None:
        client = _FakeClient(
            completions=(_completion("pathological"), _completion("path"))
        )
        intel = CodeIntel(client)

        results = await intel.complete("a.py", "pat", 1, 4)

        assert [item.label for item in results] == ["path", "pathological"]


class TestComplete:
    async def test_pushes_the_current_buffer_before_asking(self) -> None:
        """The whole reason `complete` takes the buffer text.

        `LspClient.did_change` is debounced and the app only syncs on a dirty *transition*, so
        the server's copy of a file being actively typed into is routinely several keystrokes
        stale. Sending the text as part of the request is what makes the answer be about what
        is on screen; `LspClient.completion` flushes it before the request goes out.
        """
        client = _FakeClient(completions=(_completion("path"),))
        intel = CodeIntel(client)

        await intel.complete("src/a.py", "os.pat", 1, 7)

        assert client.called("did_change") == [("src/a.py", "os.pat")]
        # Order matters: the edit has to be recorded before the question is asked.
        assert [name for name, _ in client.calls][:2] == ["did_change", "completion"]

    async def test_asks_at_the_cursor_position_it_was_given(self) -> None:
        client = _FakeClient()
        intel = CodeIntel(client)

        await intel.complete("src/a.py", "import os\nos.pat", 2, 7)

        assert client.called("completion") == [("src/a.py", 2, 7)]

    async def test_a_server_error_is_no_completions_rather_than_a_crash(self) -> None:
        client = _FakeClient(fail_with=LspError("server died"))
        intel = CodeIntel(client)

        assert await intel.complete("a.py", "os.pat", 1, 7) == ()


class TestDefineAndDescribe:
    async def test_define_returns_the_location(self) -> None:
        location = Location("src/util.py", 4, 1)
        client = _FakeClient(definition=location)
        intel = CodeIntel(client)

        assert await intel.define("src/a.py", 2, 7) is location
        assert client.called("definition") == [("src/a.py", 2, 7)]

    async def test_define_swallows_a_server_error(self) -> None:
        intel = CodeIntel(_FakeClient(fail_with=LspError("no")))

        assert await intel.define("src/a.py", 2, 7) is None

    async def test_describe_returns_the_hover_text(self) -> None:
        intel = CodeIntel(_FakeClient(hover="(module) os"))

        assert await intel.describe("src/a.py", 1, 2) == "(module) os"

    async def test_describe_returns_none_when_there_is_nothing_there(self) -> None:
        intel = CodeIntel(_FakeClient(hover=None))

        assert await intel.describe("src/a.py", 1, 2) is None

    async def test_describe_collapses_blank_hover_text_to_none(self) -> None:
        intel = CodeIntel(_FakeClient(hover="   \n  "))

        assert await intel.describe("src/a.py", 1, 2) is None

    async def test_describe_swallows_a_server_error(self) -> None:
        intel = CodeIntel(_FakeClient(fail_with=LspError("no")))

        assert await intel.describe("src/a.py", 1, 2) is None


class TestNoServer:
    """`client=None` is the default state of this machine, not an edge case.

    No language server is installed here (see `app.LANGUAGE_SERVERS`), so every one of these
    paths runs on a fresh checkout. Each must degrade to "nothing to offer", never raise.
    """

    def test_is_not_available(self) -> None:
        assert CodeIntel(None).available is False

    def test_is_available_with_a_client(self) -> None:
        assert CodeIntel(_FakeClient()).available is True

    async def test_complete_returns_nothing(self) -> None:
        assert await CodeIntel(None).complete("a.py", "os.pat", 1, 7) == ()

    async def test_define_returns_none(self) -> None:
        assert await CodeIntel(None).define("a.py", 1, 1) is None

    async def test_describe_returns_none(self) -> None:
        assert await CodeIntel(None).describe("a.py", 1, 1) is None

    def test_the_pure_helpers_still_work(self) -> None:
        """They are string functions; a missing server has nothing to do with them.

        Worth pinning: an implementation that short-circuits every method on `available`
        would make the popup's own logic untestable without a server, which is the opposite
        of what this split is for.
        """
        intel = CodeIntel(None)

        assert intel.should_trigger("os.pat", 1, 7) is True
        assert intel.word_prefix("os.pat", 1, 7) == "pat"
        assert CodeIntel.apply("os.pat", 1, 7, "pat", _completion("path")) == (
            "os.path",
            8,
        )

    def test_request_returns_none_without_a_server(self) -> None:
        assert CodeIntel(None).request("a.py", "os.pat", 1, 7) is None


class TestRequest:
    """`CompletionRequest` is what an in-flight request is remembered as.

    The app needs to know which position an answer belongs to: completion is asked on a
    keystroke and answered later, and by then the cursor has usually moved. Comparing the
    reply against the request is how a stale popup is thrown away instead of shown.
    """

    def test_carries_the_position_and_the_prefix(self) -> None:
        intel = CodeIntel(_FakeClient())

        request = intel.request("src/a.py", "os.pat", 1, 7)

        assert request == CompletionRequest("src/a.py", 1, 7, "pat")

    def test_is_none_when_the_keystroke_should_not_trigger(self) -> None:
        intel = CodeIntel(_FakeClient())

        assert intel.request("src/a.py", "import ", 1, 8) is None

    def test_is_hashable_so_it_can_be_compared_to_a_later_state(self) -> None:
        # `frozen=True, slots=True`, matching every other value type in this package.
        assert hash(CompletionRequest("a.py", 1, 7, "pat")) == hash(
            CompletionRequest("a.py", 1, 7, "pat")
        )
        with pytest.raises(Exception):
            CompletionRequest("a.py", 1, 7, "pat").line = 2  # type: ignore[misc]
