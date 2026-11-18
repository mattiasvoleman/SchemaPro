"""Kontrollera veckan: POST /api/v1/check-week and SchedulerSolver.check_week.

THE SCHOOL (2026-11-17). Three times a school waited three minutes for Generera
to say "The AI engine returned an error", about a week the engine's own
arithmetic could have called impossible in a fifth of a second. This route asks
for that arithmetic alone: SchedulerSolver._prechecks, less the lunch stage
(a CP-SAT model of its own), answered as what it found.

WHAT THESE TESTS HOLD:

* the three verdicts, and that IMPOSSIBLE is the analysis solve() answers
  INFEASIBLE with (the same call, so the same words and rows);
* that nothing is solved: the scheduling model is never built, and the only
  CP-SAT call on the way is week_load's own pricing step;
* what the check cannot see is said (`skipped`), and a week only the lunch
  stage refuses is NOT called impossible by it;
* the route: key, validation, the payload refusal as the 400 Generera gives,
  the ceiling, and that the OpenAPI document gains routes and schemas only.
"""

from __future__ import annotations

import copy
import random
import sys
import time
from uuid import uuid4

import pytest
from fastapi import APIRouter
from fastapi.testclient import TestClient
from ortools.sat.python import cp_model

from app.main import create_app
from app.schemas.schedule import OptimizeScheduleRequest
from app.solver import scheduler_solver
from app.solver.scheduler_solver import SchedulerSolver
from tests import test_optimize as to
from tests import test_week_load as wl

API_KEY = to.API_KEY
HEADERS = {"X-API-Key": API_KEY}

#: Every name of the response, by hand: a field renamed on one side only is a
#: 422 or a missing key in the other. The gateway's contract spec lists the same.
RESPONSE_KEYS = {"requestId", "verdict", "years", "conflicts", "skipped", "elapsedMs"}
YEAR_KEYS = {"year", "demandMinutes", "capacityMinutes", "percent", "over"}


def _request(payload: dict[str, object]) -> OptimizeScheduleRequest:
    return OptimizeScheduleRequest.model_validate(payload)


def _checker() -> SchedulerSolver:
    return SchedulerSolver(wl._settings())


@pytest.fixture
def client() -> TestClient:
    return TestClient(create_app(to._settings()))


# ---------------------------------------------------------------------------
# The verdicts
# ---------------------------------------------------------------------------


def test_a_week_with_room_to_spare_is_ok_and_says_what_was_not_run() -> None:
    """20 x 55 + 540... with a teacher of their own per group the week is under 85 %."""
    response = _checker().check_week(_request(wl._year(class_lessons=20, shared=False)))

    assert response.verdict == "OK"
    assert response.years == []
    assert response.conflicts is None
    # An OK is "nothing found", never "a timetable exists": the stage that
    # would have looked at the lunches is named as not run.
    assert response.skipped == ["LUNCH_STAGE"]


def test_a_tight_year_is_named_with_the_rows_a_timeout_carries() -> None:
    """27 x 55 + 540 + 75 = 2,100 of 2,200 minutes: 95 %, and not a minute over."""
    solver = _checker()
    request = _request(wl._year(class_lessons=27))

    response = solver.check_week(request)

    assert response.verdict == "TIGHT"
    (year,) = response.years
    assert (year.year, year.demand_minutes, year.capacity_minutes, year.percent, year.over) == (
        8, 2100, wl.WEEK, 95, False,
    )
    assert response.conflicts is not None
    # No headline: a TIMEOUT's says "no schedule was found within N s", which
    # has not happened here.
    assert response.conflicts.summary_code == "" and response.conflicts.summary == ""
    assert [row.code for row in response.conflicts.conflicts] == [
        "TIGHT_WEEK_LOAD", "TEACHER_SHARED_BY_PARALLEL_GROUPS",
    ]
    row = response.conflicts.conflicts[0]
    assert row.category == "REQUIREMENT_DEMAND"
    assert row.params == {"grades": "8", "demandMinutes": 2100, "capacityMinutes": wl.WEEK, "percent": 95}
    # Row for row what a TIMEOUT on the same week adds to its answer
    # (_with_tight_week), because it is the same function.
    after_a_timeout = solver._with_tight_week(None, solver._week_loads(request))
    assert after_a_timeout is not None
    assert response.conflicts.conflicts == after_a_timeout.conflicts
    assert response.skipped == ["LUNCH_STAGE"]


def test_a_year_above_its_frame_is_impossible_in_the_words_solve_uses() -> None:
    """29 x 55 + 540 + 75 = 2,210 > 2,200: the analysis Generera answers INFEASIBLE with."""
    request = _request(wl._year(class_lessons=29))

    response = _checker().check_week(request)
    solved = _checker().solve(request)

    assert response.verdict == "IMPOSSIBLE"
    (year,) = response.years
    assert (year.demand_minutes, year.capacity_minutes, year.over) == (2210, wl.WEEK, True)
    assert solved.status == "INFEASIBLE" and solved.conflicts is not None
    assert response.conflicts == solved.conflicts
    assert response.conflicts is not None
    assert response.conflicts.summary_code == "DEMAND_YEAR_WEEK_SHORT"
    assert response.skipped == ["LUNCH_STAGE"]


def _full_hall() -> tuple[dict[str, object], dict[str, str]]:
    """Sixty children, thirty seats, a window one sitting wide: the count refuses it."""
    payload = to._dining_payload([30, 30])
    payload["rules"] = to._lunch_rules(diningSeats=30)
    return payload, {"SCHEDULE_DAYS": "1", "SOLVER_MAX_TIME_SECONDS": "10.0"}


def _blocked_day() -> tuple[dict[str, object], dict[str, str]]:
    """A class whose only school day is reserved: the class hours' count refuses it."""
    payload = to._dining_payload([30, 30])
    payload["rules"] = to._lunch_rules()
    payload["constraints"] = [
        to._blocks_the_whole_day(payload["requirements"][0]["studentGroupId"], 1),  # type: ignore[index]
    ]
    return payload, {"SCHEDULE_DAYS": "1", "SOLVER_MAX_TIME_SECONDS": "10.0"}


@pytest.mark.parametrize("case", [_full_hall, _blocked_day], ids=["a-full-hall", "a-reserved-day"])
def test_every_refusal_the_counts_give_is_given_as_solve_gives_it(case: object) -> None:
    """The counted verdicts come before the week load, and are the same call."""
    payload, settings = case()  # type: ignore[operator]
    request = _request(payload)
    config = to._settings(**settings)

    response = SchedulerSolver(config).check_week(request)
    solved = SchedulerSolver(config).solve(request)

    assert solved.status == "INFEASIBLE" and solved.conflicts is not None
    assert response.verdict == "IMPOSSIBLE"
    assert response.conflicts == solved.conflicts
    # A count refused it before the week load ran: no year was counted.
    assert response.years == []


# ---------------------------------------------------------------------------
# What it cannot see
# ---------------------------------------------------------------------------


def test_a_week_only_the_lunch_stage_refuses_is_not_called_impossible() -> None:
    """Eleven classes of years 4-6 in a hall of 115: the lunch stage's proof, and nobody else's.

    test_optimize's school. Neither arithmetic verdict sees it, and the check
    runs none of the stage's model, so it says what it can: nothing found, and
    the stage is named as not run. An IMPOSSIBLE here would be a proof the
    check does not hold.
    """
    payload = to._frames_that_pack_the_middle_years(to._teaching_group_school(classes=20))
    request = _request(payload)
    config = to._settings()

    response = SchedulerSolver(config).check_week(request)
    refused, *_ = SchedulerSolver(config)._prechecks(request)

    assert refused is not None and refused.conflicts is not None
    assert refused.conflicts.summary_code == "LUNCH_HALL_CANNOT_SEAT_CLASSES"
    assert response.verdict in ("OK", "TIGHT")
    assert response.conflicts is None or all(
        row.code in ("TIGHT_WEEK_LOAD", "TEACHER_SHARED_BY_PARALLEL_GROUPS")
        for row in response.conflicts.conflicts
    )
    assert response.skipped == ["LUNCH_STAGE"]


def test_a_week_load_that_ran_out_of_time_says_a_year_was_not_counted(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """With no seconds the count reaches no year, and "no year over 85 %" is not what it found."""
    request = _request(wl._year(class_lessons=27))
    assert _checker().check_week(request).skipped == ["LUNCH_STAGE"]

    monkeypatch.setattr(SchedulerSolver, "WEEK_LOAD_SECONDS", 0.0)
    response = _checker().check_week(request)

    assert response.verdict == "OK" and response.years == []
    assert response.skipped == ["LUNCH_STAGE", "WEEK_LOAD_DEADLINE"]


def _pinned(payload: dict[str, object]) -> dict[str, object]:
    """One class's first lesson held on Monday at 08:30 (Fästa lektioner)."""
    held = copy.deepcopy(payload)
    first = held["requirements"][0]  # type: ignore[index]
    first["pinnedLessons"] = [  # type: ignore[index]
        {"dayOfWeek": 1, "startTime": "08:30:00", "endTime": "09:20:00"},
        *[None] * (first["lessonsPerWeek"] - 1),  # type: ignore[index]
    ]
    return held


def test_an_impossible_week_with_pinned_lessons_says_the_probe_was_not_asked() -> None:
    """Generera asks whether releasing the pins lays the week, with a solve; the check does not."""
    pinned = _pinned(wl._year(class_lessons=29))

    response = _checker().check_week(_request(pinned))

    assert response.verdict == "IMPOSSIBLE"
    assert response.skipped == ["LUNCH_STAGE", "PLACEMENTS_PROBE"]
    # Without a pin there is nothing to release, and nothing to say.
    assert _checker().check_week(_request(wl._year(class_lessons=29))).skipped == ["LUNCH_STAGE"]


def test_no_probe_is_named_when_the_request_turns_the_probes_off() -> None:
    """`search.probes: false` is a request Generera would not ask the question of either."""
    payload = _pinned(wl._year(class_lessons=29))
    payload["search"] = {"probes": False}

    response = _checker().check_week(_request(payload))

    assert response.verdict == "IMPOSSIBLE"
    assert response.skipped == ["LUNCH_STAGE"]


# ---------------------------------------------------------------------------
# It never solves
# ---------------------------------------------------------------------------


def _nothing_is_solved(monkeypatch: pytest.MonkeyPatch) -> list[str]:
    """Fail the moment a timetable model, a probe or the lunch stage is reached.

    Returns the list of modules that created a CP-SAT solve, which the caller
    holds to week_load's own pricing step: a small model of one year's graph.
    """
    def refuse(name: str):  # noqa: ANN202
        def refused(*args: object, **kwargs: object) -> None:
            pytest.fail(f"the check reached {name}: it must not solve")
        return refused

    for name in (
        "solve", "_build_model", "_lunch_stage_one", "_name_lunch_causes", "_probe_search",
        "_placements_verdict", "_class_hours_probe",
    ):
        if hasattr(SchedulerSolver, name):
            monkeypatch.setattr(SchedulerSolver, name, refuse(name))
    monkeypatch.setattr(scheduler_solver, "_solve_guarded", refuse("_solve_guarded"))

    callers: list[str] = []
    real_solve = cp_model.CpSolver.Solve

    def recording_solve(self: cp_model.CpSolver, model: object, *args: object, **kwargs: object):  # noqa: ANN202
        callers.append(sys._getframe(1).f_globals["__name__"])
        return real_solve(self, model, *args, **kwargs)

    monkeypatch.setattr(cp_model.CpSolver, "Solve", recording_solve)
    return callers


@pytest.mark.parametrize(
    "build",
    [
        lambda: wl._year(class_lessons=20, shared=False),
        lambda: wl._year(class_lessons=27),
        lambda: wl._year(class_lessons=29),
        lambda: _pinned(wl._year(class_lessons=29)),
        lambda: to._frames_that_pack_the_middle_years(to._teaching_group_school(classes=20)),
        lambda: _full_hall()[0],
    ],
    ids=["ok", "tight", "over", "over-pinned", "the-lunch-stages-week", "a-full-hall"],
)
def test_the_check_never_builds_the_scheduling_model_or_starts_a_search(
    monkeypatch: pytest.MonkeyPatch, build: object,
) -> None:
    callers = _nothing_is_solved(monkeypatch)
    request = _request(build())  # type: ignore[operator]

    # The solver's own settings, as the route builds them; the full-hall week
    # lives on one school day.
    SchedulerSolver(to._settings(SCHEDULE_DAYS="1,2,3,4,5")).check_week(request)

    # CP-SAT is called by the week load's pricing step and by nothing else.
    assert set(callers) <= {"app.solver.week_load"}, callers


def test_the_one_cp_sat_call_on_the_way_is_the_week_loads_pricing(monkeypatch: pytest.MonkeyPatch) -> None:
    """A week whose cover the greedy colouring cannot settle is priced: the allowance is not an empty one.

    Seed 6 of test_week_load's random weeks, cut to 15:00 - 60 minutes: two
    years the arithmetic leaves tight, found by trying, and kept because the
    year's graph is the smallest that sends the week load to its pricing step.
    """
    callers = _nothing_is_solved(monkeypatch)
    payload = wl._random_week(random.Random(6), 15 * 60 - 10 * 6)

    response = SchedulerSolver(wl._settings(SCHEDULE_DAYS="1,2")).check_week(_request(payload))

    assert response.verdict == "TIGHT"
    assert callers == ["app.solver.week_load"]


# ---------------------------------------------------------------------------
# On the weeks the benchmarks measure
# ---------------------------------------------------------------------------

#: Seconds. Measured at a third of a second on the busiest of them; the bound is
#: for a host that is running two other suites, and still says "a few seconds".
SECONDS = 5.0


def _bench_weeks() -> list[tuple[str, OptimizeScheduleRequest]]:
    sys.path.insert(0, str(to.__file__).rsplit("/tests/", 1)[0] + "/benchmarks")
    try:
        import hogstadium
        import solve_2000_students
    finally:
        sys.path.pop(0)
    return [
        ("hogstadium: 450 pupils, språkval in blocks", hogstadium.build_request()),
        ("the bench school at 2,000 pupils", solve_2000_students.build_request(
            solve_2000_students.SchoolShape(students=2000),
        )),
    ]


def test_a_big_bench_week_is_checked_in_seconds_and_nothing_is_solved(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    callers = _nothing_is_solved(monkeypatch)
    for name, request in _bench_weeks():
        solver = SchedulerSolver(to._settings(SCHEDULE_DAYS="1,2,3,4,5", SOLVER_MAX_TIME_SECONDS=60.0))
        started = time.monotonic()

        response = solver.check_week(request)

        assert time.monotonic() - started < SECONDS, name
        assert response.verdict == "OK", name
        assert response.elapsed_ms < SECONDS * 1000, name
    assert set(callers) <= {"app.solver.week_load"}, callers


# ---------------------------------------------------------------------------
# The route
# ---------------------------------------------------------------------------


def test_the_route_answers_with_exactly_the_published_names(client: TestClient) -> None:
    response = client.post("/api/v1/check-week", json=wl._year(class_lessons=27), headers=HEADERS)

    assert response.status_code == 200
    body = response.json()
    assert set(body) == RESPONSE_KEYS
    assert body["verdict"] == "TIGHT"
    assert body["skipped"] == ["LUNCH_STAGE"]
    assert set(body["years"][0]) == YEAR_KEYS
    assert set(body["conflicts"]) == {"summary", "summaryCode", "summaryParams", "conflicts"}
    assert body["conflicts"]["conflicts"][0]["code"] == "TIGHT_WEEK_LOAD"
    assert body["elapsedMs"] >= 0


def test_the_route_answers_ok_without_conflicts(client: TestClient) -> None:
    body = client.post(
        "/api/v1/check-week", json=wl._year(class_lessons=20, shared=False), headers=HEADERS,
    ).json()

    assert body["verdict"] == "OK" and body["years"] == [] and body["conflicts"] is None


def test_the_route_wants_the_service_key(client: TestClient) -> None:
    payload = wl._year(class_lessons=20, shared=False)

    assert client.post("/api/v1/check-week", json=payload).status_code == 401
    assert client.post("/api/v1/check-week", json=payload, headers={"X-API-Key": "wrong"}).status_code == 401


def test_the_route_refuses_a_body_generera_would_refuse(client: TestClient) -> None:
    """The request is OptimizeScheduleRequest, which forbids a field it does not know."""
    payload = wl._year(class_lessons=20, shared=False)
    payload["somethingNew"] = 1

    response = client.post("/api/v1/check-week", json=payload, headers=HEADERS)

    assert response.status_code == 422
    assert response.json()["code"] == "VALIDATION_ERROR"


def test_a_refusal_of_the_payload_is_the_400_generera_gives(client: TestClient) -> None:
    """Thirty children to a hall of twenty seats: said before any count, as it is for a run."""
    payload = to._dining_payload([30])
    payload["rules"] = to._lunch_rules(diningSeats=20)
    group_id = payload["requirements"][0]["studentGroupId"]  # type: ignore[index]

    check = client.post("/api/v1/check-week", json=payload, headers=HEADERS)
    run = client.post("/api/v1/optimize", json=payload, headers=HEADERS)

    assert check.status_code == run.status_code == 400
    assert check.json() == run.json()
    assert check.json()["code"] == "INVALID_SCHEDULE_INPUT"
    assert f"Student group {group_id} brings 30 students to lunch" in check.json()["message"]


def test_a_check_that_is_not_quick_is_answered_503(
    client: TestClient, monkeypatch: pytest.MonkeyPatch,
) -> None:
    from app.api.v1 import week_check

    monkeypatch.setattr(week_check, "_CHECK_CEILING_SECONDS", 0.05)
    monkeypatch.setattr(SchedulerSolver, "check_week", lambda self, request: time.sleep(0.5))

    response = client.post(
        "/api/v1/check-week", json=wl._year(class_lessons=20, shared=False), headers=HEADERS,
    )

    assert response.status_code == 503
    assert response.json()["message"] == "Week check timed out."


def test_the_check_does_not_change_what_a_run_is_told(client: TestClient) -> None:
    """The same week, asked both ways, in either order: one answer for the run."""
    payload = wl._year(class_lessons=29)

    first = client.post("/api/v1/optimize", json=payload, headers=HEADERS).json()
    client.post("/api/v1/check-week", json=payload, headers=HEADERS)
    again = client.post("/api/v1/optimize", json=payload, headers=HEADERS).json()

    assert first["status"] == again["status"] == "INFEASIBLE"
    assert first["conflicts"] == again["conflicts"]


# ---------------------------------------------------------------------------
# The published contract only grows
# ---------------------------------------------------------------------------


def test_the_openapi_document_gains_a_route_and_schemas_and_changes_nothing_else(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Deployed with the API from one merge, so an older gateway must read every other
    route and schema exactly as before.

    The baseline is an app built with this router swapped for an empty one, as
    the exam planner's was (test_exams). A model named like one that exists
    would rename BOTH in the document (`app__schemas__rooms__PlacedLesson`),
    which is why every key of the baseline must be equal, not merely present.
    """
    from app import main as main_module

    with_check = create_app(to._settings()).openapi()
    monkeypatch.setattr(main_module, "week_check_router", APIRouter())
    without = create_app(to._settings()).openapi()

    assert set(with_check["paths"]) == set(without["paths"]) | {"/api/v1/check-week"}
    for path, item in without["paths"].items():
        assert with_check["paths"][path] == item, path
    assert set(with_check["paths"]["/api/v1/check-week"]) == {"post"}
    for name, schema in without["components"]["schemas"].items():
        assert with_check["components"]["schemas"][name] == schema, name
    added = set(with_check["components"]["schemas"]) - set(without["components"]["schemas"])
    assert added == {"WeekCheckResponse", "WeekCheckYear"}, added
    assert not [name for name in with_check["components"]["schemas"] if "__" in name]

    operation = with_check["paths"]["/api/v1/check-week"]["post"]
    # The request IS Generera's, so no request schema is added for it.
    assert operation["requestBody"]["content"]["application/json"]["schema"] == {
        "$ref": "#/components/schemas/OptimizeScheduleRequest",
    }
    schemas = with_check["components"]["schemas"]
    assert set(schemas["WeekCheckResponse"]["properties"]) == RESPONSE_KEYS
    assert set(schemas["WeekCheckYear"]["properties"]) == YEAR_KEYS
    assert set(schemas["WeekCheckResponse"]["required"]) == {"requestId", "verdict", "years", "skipped", "elapsedMs"}
    assert schemas["WeekCheckResponse"]["properties"]["verdict"]["enum"] == ["OK", "TIGHT", "IMPOSSIBLE"]
    assert schemas["WeekCheckResponse"]["properties"]["skipped"]["items"]["enum"] == [
        "LUNCH_STAGE", "PLACEMENTS_PROBE", "WEEK_LOAD_DEADLINE",
    ]


def test_a_request_id_is_echoed() -> None:
    request = _request(wl._year(class_lessons=20, shared=False))
    assert _checker().check_week(request).request_id == request.request_id
    assert str(uuid4()) != str(request.request_id)
