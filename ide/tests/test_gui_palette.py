"""File-type identity, tested without a display.

`palette.py` imports no Qt, which is what lets these run in the same headless suite as
everything else — and is the reason the colours and badges live apart from the widgets that
paint them.
"""

from __future__ import annotations

import pytest

from local_coder.gui.palette import file_kind, language_for


class TestFileKind:
    @pytest.mark.parametrize(
        ("name", "badge", "language"),
        [
            ("app.py", "py", "python"),
            ("main.ts", "TS", "typescript"),
            ("main.js", "JS", "javascript"),
            ("package.json", "{}", "json"),
            ("index.html", "<>", "html"),
            ("team.css", "#", "css"),
            ("mailer.php", "P", "php"),
        ],
    )
    def test_known_types(self, name: str, badge: str, language: str) -> None:
        kind = file_kind(name)

        assert kind.badge == badge
        assert kind.language == language

    def test_an_unknown_extension_falls_back(self) -> None:
        kind = file_kind("notes.xyz")

        assert kind.language == "text"
        assert kind.badge

    def test_a_dotfile_is_not_treated_as_an_extension(self) -> None:
        # `.gitignore` is a whole name. Reading `gitignore` as its type would badge every
        # dotfile by whatever follows the dot.
        assert file_kind(".gitignore").language == "text"
        assert file_kind(".env").language == "text"

    def test_a_name_with_no_dot_falls_back(self) -> None:
        assert file_kind("Makefile").language == "text"

    def test_matching_is_case_insensitive(self) -> None:
        assert file_kind("APP.PY").language == "python"

    def test_the_last_dot_wins(self) -> None:
        assert file_kind("archive.tar.py").language == "python"

    def test_badges_stay_short_enough_to_scan(self) -> None:
        # A file row is 26 pixels tall and the name beside it is what people read; a longer
        # badge starts competing with the filename for the same glance.
        for name in ("a.py", "a.ts", "a.js", "a.json", "a.html", "a.css", "a.php", "a.xyz"):
            assert len(file_kind(name).badge) <= 2

    def test_language_for_is_the_kind_s_language(self) -> None:
        assert language_for("src/app.py") == "python"


class TestKnownLanguages:
    """The picker's contents, derived rather than hand-listed.

    A non-editable combo box silently ignores `setCurrentText` with a value it does not
    contain, so a language missing from the picker shows the *previous* file's language with
    no error anywhere. Opening a Markdown file showed "python" for exactly this reason.
    """

    def test_every_file_type_s_language_is_offered(self) -> None:
        from local_coder.gui.palette import known_languages

        offered = set(known_languages())
        for name in (
            "a.py", "a.ts", "a.js", "a.json", "a.html", "a.css",
            "a.php", "a.md", "a.yml", "a.toml", "a.sql", "a.sh", "a.scss",
        ):
            assert language_for(name) in offered, name

    def test_the_fallback_language_is_offered_last(self) -> None:
        from local_coder.gui.palette import known_languages

        languages = known_languages()

        assert languages[-1] == "text"
        assert languages.count("text") == 1

    def test_the_list_is_sorted_apart_from_the_fallback(self) -> None:
        from local_coder.gui.palette import known_languages

        head = known_languages()[:-1]

        assert list(head) == sorted(head)
