"""Föreslå bemanning, veckan före och efter: what the engine says to the payloads the gateway makes.

THE ENGINE IS NOT CHANGED FOR THIS. The gateway (src/optimization/staffing-week.ts) asks POST /api/v1/check-week twice,
about the week as it stands and about a copy in which the leads a proposal gives are laid over their posts: the same
route, request and answer as Kontrollera veckan's.

These tests hold what the gateway leans on and cannot check itself, with the engine's own numbers:

* THE ENGINE ACCEPTS WHAT THE GATEWAY MAKES: the payloads come from the file the gateway's own spec writes
  (src/optimization/__fixtures__/staffing-week-cases.json, STAFFING_WEEK_WRITE=1), so an id the gateway mints for a
  teacher the week does not name, or a field the engine refuses, fails here, and a fixture that is not what the
  gateway code makes fails there;
* WHAT A LEAD DOES TO THE WEEK: a post nobody teaches counts no teacher, so giving it to a teacher who has other posts in
  the same period makes the week tighter, and giving it to a teacher the week does not name does not. That is why the
  dialog says a post nobody teaches is counted with no teacher "before", and why it counts the teachers who are new to
  the week;
* THAT THE FIGURE IS THE TIGHTEST PERIOD'S: a change in a period that is not the tightest does not move the year's
  figure, however much it tightens that period. The dialog says so ("den trängsta perioden");
* THAT A WEEK THE ENGINE REFUSES IS COUNTED ONLY UP TO THE FIRST WEEK IT REFUSES, FOR EVERY YEAR: another year's row is
  then a lower bound of its tightest period and not its value (the gateway says "at least" of it, countOf).

The numbers are arithmetic, as in tests/test_week_load.py and tests/test_week_check_choice.py: a class's 27 lessons are
27 x 55, a Hemkunskap group's four lessons 4 x 40 = 160 (the fixture's posts), the spring's three groups of one teacher
480 if they cannot overlap, a class eats 75, the week is 2,200 minutes.
"""

from __future__ import annotations

import copy
import json
import uuid
from pathlib import Path
from typing import Any

import pytest
from fastapi.testclient import TestClient

from app.main import create_app
from tests import test_optimize as to

FIXTURE = (
    Path(__file__).resolve().parents[2]
    / "src/optimization/__fixtures__/staffing-week-cases.json"
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


def _figure(answer: dict[str, Any]) -> tuple[int, int, int] | None:
    row = _year(answer, 9)
    return None if row is None else (row["demandMinutes"], row["capacityMinutes"], row["percent"])


def test_the_week_as_it_stands_is_tight_in_the_spring(client: TestClient, cases: dict[str, Any]) -> None:
    """The fixture's base: the spring's three groups of one teacher queue (3 x 160 = 480), 27 x 55 + 480 + 75 = 2,100: 95 %."""
    answer = _check(client, cases["base"])

    assert answer["verdict"] == "TIGHT"
    assert _figure(answer) == (2100, 2200, 95)


def test_a_post_nobody_teaches_counts_no_teacher_so_the_week_before_is_under_the_threshold(
    client: TestClient, cases: dict[str, Any],
) -> None:
    """The spring's three posts with no teacher: nothing queues, and the engine gives the year no row at all (under 85 %).

    That is the week "before" of a proposal that staffs posts nobody teaches. The gateway says it "under 85 %" and says
    how many posts were counted with no teacher on them.
    """
    answer = _check(client, cases["unstaffed"])

    assert answer["verdict"] == "OK"
    assert _figure(answer) is None


def test_a_lead_on_those_posts_makes_the_week_tighter_when_the_teacher_has_the_others(
    client: TestClient, cases: dict[str, Any],
) -> None:
    """The three to the teacher who has them in the base is the base: from under the threshold to 95 %.

    A proposal that staffs a post with a teacher who has other posts in the same period makes the week tighter; the
    gateway says so ("under 85 % -> 95 %, tighter") and warns.
    """
    answer = _check(client, cases["cases"]["staffedAll"]["payload"])

    assert _figure(answer) == (2100, 2200, 95)
    assert cases["cases"]["staffedAll"]["payload"]["requirements"] == cases["base"]["requirements"]


def test_a_lead_on_a_teacher_the_week_does_not_name_adds_no_edge(client: TestClient, cases: dict[str, Any]) -> None:
    """Three new teachers, one post each: nothing queues, exactly as with no teacher on them: the year has no row."""
    answer = _check(client, cases["cases"]["staffedNew"]["payload"])

    assert answer["verdict"] == "OK"
    assert _figure(answer) is None


def test_two_posts_to_the_teacher_and_one_to_a_new_teacher_is_the_what_if_of_the_second_teacher(
    client: TestClient, cases: dict[str, Any],
) -> None:
    """Two queue (320), the third runs beside them: 27 x 55 + 320 + 75 = 1,880, rounded up to the slot: 1,920 (87 %).

    The same figure test_week_check_choice.py gets for "a second teacher in the subject" on the base week: the
    overlay of a proposal and the lärarval what-if are the same edit of the same payload, made by two readers.
    """
    answer = _check(client, cases["cases"]["staffedMixed"]["payload"])

    assert _figure(answer) == (1920, 2200, 87)


def test_a_change_in_a_period_that_is_not_the_tightest_does_not_move_the_year_s_figure(
    client: TestClient, cases: dict[str, Any],
) -> None:
    """The autumn's second group to the first group's teacher: the autumn queues now, and the year is still the spring's 95 %.

    The figure is the heaviest period's, so a proposal that tightens only a lighter period shows no change. The gateway
    says the figure is "den trängsta perioden", and this is the case that sentence is for.
    """
    base = _check(client, cases["base"])
    clash = _check(client, cases["cases"]["autumnClash"]["payload"])

    assert _figure(base) == (2100, 2200, 95)
    assert _figure(clash) == (2100, 2200, 95)


def test_every_payload_the_gateway_makes_is_the_request_the_engine_takes_and_only_the_leads_differ(
    cases: dict[str, Any],
) -> None:
    """Only the leads of the posts move: every other field of the payload is what Generera sent."""
    for name, source, made in [
        ("staffedAll", cases["unstaffed"], cases["cases"]["staffedAll"]["payload"]),
        ("staffedMixed", cases["unstaffed"], cases["cases"]["staffedMixed"]["payload"]),
        ("staffedNew", cases["unstaffed"], cases["cases"]["staffedNew"]["payload"]),
        ("autumnClash", cases["base"], cases["cases"]["autumnClash"]["payload"]),
    ]:
        assert {k: v for k, v in made.items() if k != "requirements"} == {
            k: v for k, v in source.items() if k != "requirements"
        }, name
        for before, after in zip(source["requirements"], made["requirements"], strict=True):
            assert before["id"] == after["id"], name
            assert {k: v for k, v in before.items() if k != "teacherId"} == {
                k: v for k, v in after.items() if k != "teacherId"
            }, name


def test_the_ids_the_gateway_mints_are_nobody_s_own_and_are_one_per_new_teacher(cases: dict[str, Any]) -> None:
    """A teacher the week does not name is one id on all their posts, and no real teacher's."""
    known = {r["teacherId"] for r in cases["base"]["requirements"]}
    new = [r["teacherId"] for r in cases["cases"]["staffedNew"]["payload"]["requirements"] if r["id"] in cases["springPosts"]]
    mixed = [r["teacherId"] for r in cases["cases"]["staffedMixed"]["payload"]["requirements"] if r["id"] in cases["springPosts"]]

    assert len(set(new)) == 3
    assert not set(new) & known
    assert len(set(mixed)) == 2 and len(set(mixed) - known) == 1


def test_asking_twice_about_one_payload_gives_one_answer(client: TestClient, cases: dict[str, Any]) -> None:
    """The figures the gateway compares are not noise."""
    first = _check(client, copy.deepcopy(cases["cases"]["staffedMixed"]["payload"]))
    second = _check(client, copy.deepcopy(cases["cases"]["staffedMixed"]["payload"]))
    assert first["years"] == second["years"]


# ---------------------------------------------------------------------------------------------------------------------
# A week refused in one year: the other years' rows hold only the weeks counted before the refusal.
# ---------------------------------------------------------------------------------------------------------------------


def _years_8_and_9(nine: dict[str, Any], eight: dict[str, Any]) -> dict[str, Any]:
    """Year 9 as `nine` has it, and a copy of `eight`'s groups, posts, rooms and conflicts as year 8, under ids of their own."""
    ids: dict[str, str] = {}

    def fresh(old: str) -> str:
        ids.setdefault(old, str(uuid.uuid4()))
        return ids[old]

    payload = copy.deepcopy(nine)
    for group in eight["groups"]:
        payload["groups"].append(dict(group, id=fresh(group["id"]), minGradeLevel=8, maxGradeLevel=8))
    for post in eight["requirements"]:
        copied = dict(post, id=fresh(post["id"]), studentGroupId=fresh(post["studentGroupId"]), minGradeLevel=8, maxGradeLevel=8)
        if copied.get("teacherId"):
            copied["teacherId"] = fresh(copied["teacherId"])
        payload["requirements"].append(copied)
    payload["rooms"] += [dict(room, id=fresh(room["id"])) for room in eight["rooms"]]
    payload["groupConflicts"] += [[fresh(a), fresh(b)] for a, b in eight["groupConflicts"]]
    payload["frameTimes"] = payload["frameTimes"] + [dict(payload["frameTimes"][0], minGradeLevel=8, maxGradeLevel=8)]
    return payload


def _with_lessons(payload: dict[str, Any], autumn: int | None = None, spring: int | None = None) -> dict[str, Any]:
    """The fixture's two periods with the autumn's posts on one teacher at `autumn` lessons and the spring's at `spring`."""
    out = copy.deepcopy(payload)
    for post in out["requirements"]:
        if post.get("periods") == [True, False]:
            post["teacherId"] = "cd22fde1-0000-4000-8000-000000000001"
            if autumn is not None:
                post["lessonsPerWeek"] = autumn
        if post.get("periods") == [False, True] and spring is not None:
            post["lessonsPerWeek"] = spring
    return out


def test_a_refusal_in_one_year_stops_the_count_for_the_others_so_their_rows_are_lower_bounds(
    client: TestClient, cases: dict[str, Any],
) -> None:
    """Year 8 over in the autumn (107 %) and year 9 at 91 % in the autumn and 95 % in the spring: year 9's row is 91 %.

    The engine counts the weeks one after the other, every year in each, and returns at the first week any verdict
    refuses (_prechecks). Year 9's spring is never counted, so a proposal that takes it from 95 % to 144 % (over the
    supply) leaves the row at 91 %: the same answer. That is why the gateway says "at least" of a row in an answer that
    refuses the week and does not set it beside another (countOf), and why this test fails the day the engine counts the
    years to the end.
    """
    year_8 = _with_lessons(cases["base"], autumn=9, spring=4)  # 107 % in the autumn, the fixture's 95 % in the spring
    nine = _with_lessons(cases["base"], autumn=5)  # 91 % in the autumn, 95 % in the spring
    assert _figure(_check(client, nine)) == (2100, 2200, 95)

    answer = _check(client, _years_8_and_9(nine, year_8))

    assert answer["verdict"] == "IMPOSSIBLE"
    assert _year(answer, 8) == {"year": 8, "demandMinutes": 2370, "capacityMinutes": 2200, "percent": 107, "over": True}
    assert _year(answer, 9) == {"year": 9, "demandMinutes": 2010, "capacityMinutes": 2200, "percent": 91, "over": False}

    over_in_the_spring = _with_lessons(cases["base"], autumn=5, spring=12)  # year 9 alone: the spring is 144 %, over
    assert _year(_check(client, over_in_the_spring), 9)["over"] is True
    hidden = _check(client, _years_8_and_9(over_in_the_spring, year_8))
    assert _year(hidden, 9) == {"year": 9, "demandMinutes": 2010, "capacityMinutes": 2200, "percent": 91, "over": False}
