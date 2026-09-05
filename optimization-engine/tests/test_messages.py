"""The message catalogue and the ICU subset it is written in."""
from __future__ import annotations

import pytest

from app.messages import (
    MESSAGES,
    MessageError,
    arguments_of,
    render,
    render_template,
)


def test_a_value_is_substituted() -> None:
    assert render_template("The hall holds {seats} seats.", {"seats": 115}) == (
        "The hall holds 115 seats."
    )


def test_a_plural_picks_its_branch_and_expands_the_count() -> None:
    template = "{count, plural, one {# class} other {# classes}} named."

    assert render_template(template, {"count": 1}) == "1 class named."
    assert render_template(template, {"count": 11}) == "11 classes named."


def test_a_plural_branch_may_name_another_value() -> None:
    """The branches are templates too — a Swedish sentence needs that, and a
    renderer that only substituted at the top level would silently print the
    braces into a school's screen."""
    template = "{count, plural, one {one class, {name}} other {# classes, {name} first}}"

    assert render_template(template, {"count": 1, "name": "4A"}) == "one class, 4A"
    assert render_template(template, {"count": 3, "name": "4A"}) == "3 classes, 4A first"


def test_a_missing_param_is_an_error_not_a_hole_in_a_sentence() -> None:
    with pytest.raises(MessageError, match="Missing param seats"):
        render_template("{seats} seats.", {})


def test_an_unknown_code_is_an_error() -> None:
    with pytest.raises(MessageError, match="No message for code"):
        render("NO_SUCH_MESSAGE")


def test_a_select_picks_the_branch_that_matches_the_value() -> None:
    """A weekday arrives as its ISO number and Swedish wants a name; a year
    span that may be unknown wants one sentence, not two codes."""
    template = "{day, select, 1 {Monday} 2 {Tuesday} other {day {day}}}"

    assert render_template(template, {"day": 2}) == "Tuesday"
    assert render_template(template, {"day": 6}) == "day 6"

    span = "{grades, select, all {all years} other {years {grades}}}"
    assert render_template(span, {"grades": "all"}) == "all years"
    assert render_template(span, {"grades": "4-6"}) == "years 4-6"


def test_a_select_without_a_matching_branch_or_other_is_an_error() -> None:
    with pytest.raises(MessageError, match="No matching branch"):
        render_template("{day, select, 1 {Monday}}", {"day": 4})


def test_an_unsupported_argument_type_is_refused_rather_than_printed() -> None:
    """Only `plural` and `select` are implemented, and a template reaching for
    anything else must fail here rather than reach a school as its own
    source code."""
    with pytest.raises(MessageError, match="Unsupported argument type 'date'"):
        render_template("{when, date, short}", {"when": 1})


def test_a_plural_needs_a_number() -> None:
    with pytest.raises(MessageError, match="not a number"):
        render_template("{count, plural, one {x} other {y}}", {"count": "many"})


def test_arguments_ignore_a_plural_s_own_branches() -> None:
    """The parity test on the web scans the Swedish this way; both sides must
    read `other {klasser}` as prose and not as an argument called `other`."""
    template = "{count, plural, one {# klass} other {# klasser}} i {room}."

    assert arguments_of(template) == {"count", "room"}


def test_every_message_renders_with_the_arguments_it_declares() -> None:
    """A typo in a placeholder is invisible until the day the message is used,
    and the day it is used is the day a school's week was refused."""
    import re

    for code, template in MESSAGES.items():
        params: dict[str, str | int] = {}
        # EVERY name, branches included — not arguments_of, which reads the top
        # level only. A select's `other` branch may itself substitute a value,
        # and that value is exactly what a dummy render has to supply.
        for name in set(re.findall(r"\{(\w+)[,}]", template)):
            # Numbers where a plural needs one, text elsewhere. A plural over a
            # string raises, which is exactly the check; a select falls to its
            # `other` branch, which every template here must have.
            params[name] = 2 if f"{{{name}, plural" in template else "x"
        rendered = render(code, params)
        assert "{" not in rendered, f"{code} left an argument unrendered"


def test_every_code_is_screaming_snake_and_says_what_it_is_about() -> None:
    for code in MESSAGES:
        assert code.isupper()
        assert code.replace("_", "").isalnum()


def _keys_of(params_node: object, helpers: dict[str, set[str]]) -> set[str]:
    """The param names a call site supplies, following one level of helper."""
    import ast

    keys: set[str] = set()
    for node in ast.walk(params_node):  # type: ignore[arg-type]
        if isinstance(node, ast.Dict):
            keys |= {k.value for k in node.keys if isinstance(k, ast.Constant)}
        elif isinstance(node, ast.Call) and isinstance(node.func, ast.Attribute):
            keys |= helpers.get(node.func.attr, set())
    return keys


def test_every_call_site_passes_the_arguments_its_message_needs() -> None:
    """The engine's own sentences, checked against the templates they name.

    A call site that renames a value — `eating` where the template says
    `students` — raises only on the day that refusal is reached, which is the
    day a school's week was refused. Read statically here instead: every
    `.of(CODE, {...})`, every `code=`/`params=` pair and every
    `summary_code=`/`summary_params=` pair in app/, against MESSAGES.
    """
    import ast
    import pathlib

    problems: list[str] = []
    for path in sorted(pathlib.Path("app").rglob("*.py")):
        if path.name == "messages.py":
            continue
        tree = ast.parse(path.read_text())
        # Several sites share a helper that returns the values for one kind of
        # thing — `**self._constraint_params(constraint)`. Read that helper's
        # own literal keys, or the check would report every caller as missing
        # everything the helper supplies.
        helpers = {
            fn.name: {
                key.value
                for n in ast.walk(fn) if isinstance(n, ast.Dict)
                for key in n.keys if isinstance(key, ast.Constant)
            }
            for n in ast.walk(tree)
            if isinstance(fn := n, ast.FunctionDef) and fn.name.endswith("_params")
        }
        for node in ast.walk(tree):
            if not isinstance(node, ast.Call):
                continue
            keywords = {k.arg: k.value for k in node.keywords if k.arg}
            code_node = params_node = None
            if isinstance(node.func, ast.Attribute) and node.func.attr == "of" and node.args:
                code_node = node.args[0]
                params_node = node.args[1] if len(node.args) > 1 else None
            elif "code" in keywords:
                code_node, params_node = keywords["code"], keywords.get("params")
            elif "summary_code" in keywords:
                code_node, params_node = keywords["summary_code"], keywords.get("summary_params")
            if code_node is None:
                continue
            # A ternary picks between two codes at several sites; both arms
            # are checked against the one params dict that serves them.
            codes = [
                n.value
                for n in ast.walk(code_node)
                if isinstance(n, ast.Constant) and isinstance(n.value, str)
            ]
            given = _keys_of(params_node, helpers) if params_node is not None else set()
            for code in codes:
                if code not in MESSAGES:
                    # main.py's error_payload names the KIND of HTTP failure,
                    # not a sentence, and has no template by design.
                    if path.name == "main.py":
                        continue
                    problems.append(f"{path}:{node.lineno} names no message: {code}")
                    continue
                missing = arguments_of(MESSAGES[code]) - given
                if missing:
                    problems.append(f"{path}:{node.lineno} {code} is missing {sorted(missing)}")
    assert not problems, "\n".join(problems)


def test_the_message_fixture_the_web_reads_is_current() -> None:
    """The web renders Swedish from these codes and cannot read Python.

    The catalogue is handed over as a generated fixture — the house pattern,
    the same one frame windows use — and this is the half that fails when a
    sentence is added here and the fixture is not rebuilt. Without it the
    first sign would be a school reading English again.
    """
    import json
    import pathlib

    fixture = pathlib.Path(__file__).resolve().parents[2] / "web/i18n/__fixtures__/engine-messages.json"
    assert fixture.exists(), f"missing {fixture}; run tests/generate_engine_messages.py"
    assert json.loads(fixture.read_text()) == dict(sorted(MESSAGES.items())), (
        "the engine's messages and web/i18n/__fixtures__/engine-messages.json "
        "disagree — rebuild it with tests/generate_engine_messages.py"
    )
