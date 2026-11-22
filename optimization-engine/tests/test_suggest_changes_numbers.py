"""Åtgärdsförslag vid vägran: the numbers DEPLOYMENT §33 quotes, and a check that decides nothing is not a yes.

The suite of the route pins `route_limits` against its own constants (`DEFAULT_SEARCH_SECONDS + VERIFY_SECONDS`),
which stays true whatever they are, and runs on an engine of 20 s, which hides the default of 60 and the cap of 30.
§33.4 says: "60 + 30 + 60 = 150 s, well inside the API's 240 s wait". These are those numbers, by hand.
"""

from __future__ import annotations

from uuid import UUID, uuid4

import pytest
from ortools.sat.python import cp_model

from app.schemas.schedule import Relaxation, SearchOptions
from app.solver import suggestions
from app.solver.scheduler_solver import SchedulerSolver
from app.solver.suggestions import apply_changes, changes_from, route_limits, strict_accepts, suggest_changes
from tests.test_best_effort import (
    OTHER_GROUP,
    OTHER_REQUIREMENT,
    OTHER_TEACHER,
    REQUIREMENT,
    ROOM_A,
    ROOM_B,
    SUBJECT,
    _payload,
    _requirement,
)
from tests.test_suggest_changes import _cap_week, _deviation, _engine, _request


def test_the_ceiling_on_a_production_engine_is_the_150_seconds_the_handbook_says() -> None:
    production = _engine(SOLVER_MAX_TIME_SECONDS=180.0)
    limits = route_limits(production)
    assert (limits.budget_seconds, limits.probe_seconds, limits.headroom_seconds) == (90.0, 0.0, 60.0)
    assert limits.ceiling_seconds == 150.0
    # A longer search is cut to the engine's own budget, never past it: 180 + 30 + 60.
    assert route_limits(production, SearchOptions(max_seconds=600)).ceiling_seconds == 270.0
    assert route_limits(production, SearchOptions(max_seconds=5)).ceiling_seconds == 95.0


def test_the_search_is_given_sixty_seconds_when_the_request_names_none_and_what_it_names_up_to_the_engine() -> None:
    payload, days, end = _cap_week()
    production = _engine(SOLVER_MAX_TIME_SECONDS=180.0, SCHEDULE_DAYS=days, SCHEDULE_DAY_END_MINUTES=end)
    assert suggest_changes(_request(payload), production, ceiling_seconds=500.0).search_seconds == 60
    asked = _request({**payload, "search": {"maxSeconds": 600}})
    assert suggest_changes(asked, production, ceiling_seconds=500.0).search_seconds == 180
    asked = _request({**payload, "search": {"maxSeconds": 25}})
    assert suggest_changes(asked, production, ceiling_seconds=500.0).search_seconds == 25


def test_the_check_is_given_thirty_seconds_at_most_and_what_the_ceiling_leaves_less_the_headroom(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    payload, days, end = _cap_week()
    given: list[float] = []

    def spy(*args: object, **kwargs: object) -> bool:
        given.append(float(kwargs["seconds"]))  # type: ignore[arg-type]
        return True

    monkeypatch.setattr(suggestions, "strict_accepts", spy)
    engine = _engine(SCHEDULE_DAYS=days, SCHEDULE_DAY_END_MINUTES=end)
    suggest_changes(_request(payload), engine, ceiling_seconds=10_000.0)
    assert given == [30.0]
    # A ceiling of 70 s: less the answer's slack (3) and a solve's overrun (10) and the check's own build
    # (30 s of headroom, not under its clock), about 27 s.
    given.clear()
    suggest_changes(_request(payload), engine, ceiling_seconds=70.0)
    assert len(given) == 1 and 25.0 < given[0] < 27.0


@pytest.mark.parametrize("status", [cp_model.UNKNOWN, cp_model.MODEL_INVALID, cp_model.INFEASIBLE])
def test_a_check_that_decides_nothing_or_refuses_is_not_a_yes(
    status: int, monkeypatch: pytest.MonkeyPatch,
) -> None:
    payload, days, end = _cap_week()
    request = _request(payload)
    engine = _engine(SCHEDULE_DAYS=days, SCHEDULE_DAY_END_MINUTES=end)
    found = SchedulerSolver(engine).solve(request.model_copy(update={"relaxation": Relaxation(mode="BEST_EFFORT")}))
    (change,) = suggest_changes(request, engine, ceiling_seconds=200.0).changes
    changed = apply_changes(request, [change])
    assert strict_accepts(changed, found.lessons, engine, seconds=10)
    monkeypatch.setattr(suggestions, "_solve_guarded", lambda *args, **kwargs: status)
    assert not strict_accepts(changed, found.lessons, engine, seconds=10)


@pytest.mark.parametrize("status", [cp_model.OPTIMAL, cp_model.FEASIBLE])
def test_a_check_that_found_a_timetable_is_a_yes(status: int, monkeypatch: pytest.MonkeyPatch) -> None:
    payload, days, end = _cap_week()
    request = _request(payload)
    engine = _engine(SCHEDULE_DAYS=days, SCHEDULE_DAY_END_MINUTES=end)
    monkeypatch.setattr(suggestions, "_solve_guarded", lambda *args, **kwargs: status)
    assert strict_accepts(request, [], engine, seconds=10)


def test_the_check_is_warm_started_from_the_timetable_and_stops_at_its_first_solution(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    payload, days, end = _cap_week()
    request = _request(payload)
    engine = _engine(SCHEDULE_DAYS=days, SCHEDULE_DAY_END_MINUTES=end)
    found = SchedulerSolver(engine).solve(request.model_copy(update={"relaxation": Relaxation(mode="BEST_EFFORT")}))
    (change,) = suggest_changes(request, engine, ceiling_seconds=200.0).changes
    seen: dict[str, object] = {}
    real_hint = SchedulerSolver._hint_previous_lessons

    def hint(self: SchedulerSolver, model: object, decisions: object, previous: list[object]) -> int:
        seen["hinted"] = [(str(p.requirement_id), p.day_of_week, p.start_time) for p in previous]  # type: ignore[attr-defined]
        return real_hint(self, model, decisions, previous)  # type: ignore[arg-type]

    def guarded(solver: cp_model.CpSolver, model: object, **kwargs: object) -> int:
        seen["first"] = solver.parameters.stop_after_first_solution
        seen["seconds"] = solver.parameters.max_time_in_seconds
        seen["workers"] = solver.parameters.num_workers
        return cp_model.FEASIBLE

    monkeypatch.setattr(SchedulerSolver, "_hint_previous_lessons", hint)
    monkeypatch.setattr(suggestions, "_solve_guarded", guarded)
    assert strict_accepts(apply_changes(request, [change]), found.lessons, engine, seconds=7, workers=3)
    assert seen["hinted"] == [(str(lesson.requirement_id), lesson.day_of_week, lesson.start_time) for lesson in found.lessons]
    assert seen["hinted"], "the search's timetable has lessons: they are the hint"
    assert (seen["first"], seen["seconds"], seen["workers"]) == (True, 7.0, 3)


def test_the_cheapest_change_comes_first_even_where_a_milder_rule_costs_more() -> None:
    # Five pairs of days too close (5 x 10) cost more than one lesson over its day (20), and the spacing is the
    # milder rule: ordering by the rules' own order first, as the weights are listed, would put it first.
    request = _request(_payload(
        relax=False,
        requirements=[
            _requirement(),
            _requirement(id=OTHER_REQUIREMENT, studentGroupId=OTHER_GROUP, teacherId=OTHER_TEACHER),
        ],
    ))
    per_day = _deviation(
        "DEVIATION_SUBJECT_PER_DAY",
        {"requirement": REQUIREMENT, "day": 1, "maxPerDay": 1, "count": 2, "over": 1, "needed": 2},
        requirement_ids=[UUID(REQUIREMENT)],
    )
    apart = _deviation(
        "DEVIATION_SUBJECT_DAYS_APART",
        {"requirement": OTHER_REQUIREMENT, "minDaysBetween": 3, "pairs": 5, "closest": 1, "needed": 1},
        requirement_ids=[UUID(OTHER_REQUIREMENT)],
    )
    for lines in ([apart, per_day], [per_day, apart]):
        changes = changes_from(request, [], lines)
        assert [change.rule for change in changes] == ["SUBJECT_PER_DAY", "SUBJECT_DAYS_APART"]
        assert [change.cost for change in changes] == [20, 50]


def test_a_room_lock_names_the_narrowest_rule_that_reaches_the_class_and_not_the_broad_one() -> None:
    broad, narrow = str(uuid4()), str(uuid4())
    request = _request(_payload(
        relax=False,
        requirements=[_requirement(lessonsPerWeek=1)],
        roomPreferences=[
            {"id": broad, "subjectId": SUBJECT, "roomIds": [ROOM_A], "kind": "LOCK"},
            {"id": narrow, "subjectId": SUBJECT, "roomIds": [ROOM_B], "kind": "LOCK", "minGradeLevel": 7, "maxGradeLevel": 7},
        ],
    ))
    line = _deviation(
        "DEVIATION_ROOM_LOCK", {"requirement": REQUIREMENT, "lessons": 1, "of": 1},
        requirement_ids=[UUID(REQUIREMENT)], room_ids=[UUID(ROOM_A)],
    )
    (change,) = changes_from(request, [], [line])
    # The lock the engine read for 7A is the narrow rule's (resolve_room_locks: the narrowest span wins).
    assert change.resource_ids == [UUID(narrow)]
    widened = apply_changes(request, [change])
    added = widened.room_preferences[-1]
    assert (added.min_grade_level, added.max_grade_level) == (7, 7)
