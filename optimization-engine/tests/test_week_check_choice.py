"""Kontrollera veckan med lärarval: what the engine says to the payloads the gateway makes.

THE ENGINE IS NOT CHANGED FOR THIS. The gateway (src/optimization/week-check-
choice.ts) asks POST /api/v1/check-week about copies of Generera's payload in
which some posts have another teacher: every post whose subject has two or more
qualified teachers gets a teacher of its own, an id made from the post's (the
floor, the relaxation _parallel_groups_probe uses), and one teacher's posts of a
subject are shared with a virtual second teacher (a what-if). The route, its
request and its answer are exactly what they were.

These tests hold the two things the gateway leans on and cannot check itself:

* THE ENGINE ACCEPTS WHAT THE GATEWAY MAKES: the payloads come from the file the
  gateway's own spec writes (src/optimization/__fixtures__/week-check-choice-
  cases.json, WEEK_CHECK_CHOICE_WRITE=1), so a derived id or a field the engine
  refuses fails here, and a fixture that is not what the gateway code makes
  fails there;
* WHAT THE ENGINE NAMES FOR THE TIGHTEST WEEK: a year with periods is counted
  period by period and the answer keeps the heaviest per year without saying
  which. The gateway names the period from the posts of the TIGHT_WEEK_LOAD
  row, and that only holds while the row's `requirementIds` are the year's posts
  that run in that week. The fixture's two periods are the autumn and the
  spring, and the tight week is the spring's.

The numbers are arithmetic, as in tests/test_week_load.py: a class's 27 lessons
are 27 x 55, a Hemkunskap group's four lessons 4 x 45 = 180, the spring's three
groups of one teacher 540 if they cannot overlap, a class eats 75, the week is
2,200 minutes. 27 x 55 + 540 + 75 = 2,100: 95 %.
"""

from __future__ import annotations

import copy
import json
from pathlib import Path
from typing import Any

import pytest
from fastapi.testclient import TestClient

from app.main import create_app
from tests import test_optimize as to

FIXTURE = (
    Path(__file__).resolve().parents[2]
    / "src/optimization/__fixtures__/week-check-choice-cases.json"
)
HEADERS = {"X-API-Key": to.API_KEY}


@pytest.fixture(scope="module")
def cases() -> dict[str, Any]:
    return json.loads(FIXTURE.read_text())


@pytest.fixture
def client() -> TestClient:
    return TestClient(create_app(to._settings()))


def _check(client: TestClient, payload: dict[str, Any]) -> dict[str, Any]:
    response = client.post("/api/v1/check-week", json=payload, headers=HEADERS)
    assert response.status_code == 200, response.text
    return response.json()


def _year(answer: dict[str, Any], year: int) -> dict[str, Any] | None:
    return next((row for row in answer["years"] if row["year"] == year), None)


def test_the_base_week_is_tight_in_the_spring_and_names_the_spring_s_posts(
    client: TestClient, cases: dict[str, Any],
) -> None:
    """The row the gateway reads the period from lists exactly the posts that run in the tightest week."""
    answer = _check(client, cases["base"])

    assert answer["verdict"] == "TIGHT"
    assert _year(answer, 9) == {
        "year": 9, "demandMinutes": 2100, "capacityMinutes": 2200, "percent": 95, "over": False,
    }
    (row,) = [c for c in answer["conflicts"]["conflicts"] if c["code"] == "TIGHT_WEEK_LOAD"]
    assert row["params"]["grades"] == "9"
    # The five classes (every period) and the three groups of the spring: the autumn's two groups are not in it.
    assert sorted(row["requirementIds"]) == sorted(cases["tightWeek"]["heldIds"])


def test_the_floor_is_asked_and_answered_and_is_lower_than_the_week_as_it_stands(
    client: TestClient, cases: dict[str, Any],
) -> None:
    """A teacher of their own on each of the five groups: the three of one teacher no longer queue."""
    answer = _check(client, cases["floor"])
    base = _check(client, cases["base"])

    # No row for a year under the tight threshold (85 %): the gateway reads that as "under 85 %", never as a number.
    assert answer["verdict"] == "OK"
    assert _year(answer, 9) is None
    assert _year(base, 9) is not None
    assert "WEEK_LOAD_DEADLINE" not in answer["skipped"]


def test_a_second_teacher_in_the_subject_is_asked_and_answered(client: TestClient, cases: dict[str, Any]) -> None:
    """One of the three posts to a second teacher: two stay in series (360), the third runs beside them."""
    (what_if,) = cases["whatIf"]
    answer = _check(client, what_if["payload"])
    base = _check(client, cases["base"])

    row = _year(answer, 9)
    assert row is not None
    # 27 x 55 + 360 + 75 = 1,920: the two posts that stay with the one teacher queue, the moved one runs beside them.
    assert row["demandMinutes"] < _year(base, 9)["demandMinutes"]  # type: ignore[index]
    assert (row["demandMinutes"], row["capacityMinutes"], row["percent"]) == (1920, 2200, 87)


def test_every_payload_the_gateway_makes_is_the_request_the_engine_takes_and_nothing_else_differs(
    cases: dict[str, Any],
) -> None:
    """Only the leads of the posts move: every other field of the payload is what Generera sent."""
    base = cases["base"]
    for name, payload in [("floor", cases["floor"]), ("whatIf", cases["whatIf"][0]["payload"])]:
        assert {k: v for k, v in payload.items() if k != "requirements"} == {
            k: v for k, v in base.items() if k != "requirements"
        }, name
        for before, after in zip(base["requirements"], payload["requirements"], strict=True):
            assert before["id"] == after["id"], name
            assert {k: v for k, v in before.items() if k != "teacherId"} == {
                k: v for k, v in after.items() if k != "teacherId"
            }, name


def test_the_derived_ids_are_nobody_s_own_and_do_not_repeat(cases: dict[str, Any]) -> None:
    """A teacher of their own is an id made from the post's, which no real teacher has: five posts, five ids."""
    base_teachers = {r["teacherId"] for r in cases["base"]["requirements"]}
    floor_teachers = [r["teacherId"] for r in cases["floor"]["requirements"] if r["id"] in cases["released"]]
    assert len(floor_teachers) == len(set(floor_teachers)) == 5
    assert not set(floor_teachers) & base_teachers


def test_a_payload_with_a_post_with_no_second_teacher_is_unchanged_in_its_answer(
    client: TestClient, cases: dict[str, Any],
) -> None:
    """Asking twice about one payload gives one answer: the figures the gateway compares are not noise."""
    first = _check(client, copy.deepcopy(cases["base"]))
    second = _check(client, copy.deepcopy(cases["base"]))
    assert first["years"] == second["years"]


def _autumn_over_and_spring_more(cases: dict[str, Any]) -> dict[str, Any]:
    """The fixture's week with both periods over the supply: the autumn's two groups share a teacher at nine lessons, the spring's three at twelve."""
    payload = copy.deepcopy(cases["base"])
    for requirement in payload["requirements"]:
        if requirement.get("periods") == [True, False]:
            requirement["lessonsPerWeek"] = 9
            requirement["teacherId"] = "cd22fde1-0000-4000-8000-000000000001"
        elif requirement.get("periods") == [False, True]:
            requirement["lessonsPerWeek"] = 12
    return payload


def _teacher_of_their_own(payload: dict[str, Any], periods: list[bool]) -> dict[str, Any]:
    relieved = copy.deepcopy(payload)
    for number, requirement in enumerate(r for r in relieved["requirements"] if r.get("periods") == periods):
        requirement["teacherId"] = f"cd22fde1-0000-4000-8000-0000000001{number:02d}"
    return relieved


def test_a_week_over_the_supply_is_answered_by_the_first_period_it_refuses_and_not_by_the_tightest(
    client: TestClient, cases: dict[str, Any],
) -> None:
    """The engine stops at the first period it refuses, so an over figure is a bound, never "the tightest period's".

    The gateway says such a figure "at least" and never ranks it (rankingFigure in week-check-choice.ts). If the engine
    one day counts every period before it refuses, this fails and the gateway may say the value.
    """
    today = _autumn_over_and_spring_more(cases)
    spring_alone = copy.deepcopy(today)
    spring_alone["requirements"] = [r for r in spring_alone["requirements"] if r.get("periods") != [True, False]]
    for requirement in spring_alone["requirements"]:
        requirement.pop("periods", None)
    spring_alone["periodWeeks"] = None
    spring_alone["periodOddWeeks"] = None

    answered = _year(_check(client, today), 9)
    spring = _year(_check(client, spring_alone), 9)
    relieved_autumn = _year(_check(client, _teacher_of_their_own(today, [True, False])), 9)

    # The spring is the tighter period, 144 % on its own, and the two-period week says the autumn's 107 %.
    assert spring is not None and spring["over"] and spring["percent"] == 144
    assert answered is not None and answered["over"] and answered["percent"] == 107
    # Relieve the autumn and the answer rises to the spring's: a change that can only relax the week reads as a worse one.
    assert relieved_autumn is not None and relieved_autumn["percent"] == 144
