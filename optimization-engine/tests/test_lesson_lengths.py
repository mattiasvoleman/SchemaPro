"""Lektionslängder: one requirement, lessons of more than one length.

A requirement says `lessonsPerWeek` lessons of `minutesPerLesson`, and since
the gateway's 20261008090000 it may also say `lessonLengths`, one length per
lesson — idrott as 1 × 80 + 1 × 40. The engine places each lesson at its own
length under ONE requirement id, so everything keyed on the id (the spread
across days, the refusals that name a requirement) treats the 80 and the 40
as the one subject they are.

What has to hold, and what each test below pins:

  * the schema: the list agrees with the scalars (its count, its longest), or
    the payload is refused before anything is built;
  * a solve places one lesson per length, and the independent validator
    (benchmarks/validate_schedule.py) holds the engine to the multiset;
  * a uniform list is the uniform requirement it spells;
  * every refusal still says something true: the grid names the length that
    misses it, a frame names the longest (the one that binds), a rast demand is
    answered by the shortest (any lesson answers it);
  * the class's demand is the sum of the lessons, not count × longest.
"""

from __future__ import annotations

import sys
from collections import Counter
from pathlib import Path
from uuid import uuid4

import pytest
from fastapi.testclient import TestClient
from pydantic import ValidationError

from app.config import Settings
from app.exceptions import InvalidScheduleInputError
from app.main import create_app
from app.schemas.schedule import AnonymousRequirement, OptimizeScheduleRequest, ScheduledLesson
from app.solver.scheduler_solver import SchedulerSolver, _start_step

API_KEY = "test-api-key-000000000000000000000000"


def _settings(**overrides: object) -> Settings:
    return Settings(
        **{
            "API_KEY": API_KEY,
            "ALLOWED_ORIGINS": "http://testserver",
            "SCHEDULE_DAYS": "1,2,3,4,5",
            **overrides,
        },
    )


def _payload(lengths: list[int] | None, *, lessons: int | None = None, longest: int | None = None,
             **requirement: object) -> dict:
    """One class, one teacher, one room; the requirement's lengths as given."""
    count = lessons if lessons is not None else (len(lengths) if lengths else 2)
    row: dict[str, object] = {
        "id": str(uuid4()),
        "subjectId": str(uuid4()),
        "studentGroupId": str(uuid4()),
        "teacherId": str(uuid4()),
        "lessonsPerWeek": count,
        "minutesPerLesson": longest if longest is not None else (max(lengths) if lengths else 60),
        "studentGroupSize": 24,
        "minGradeLevel": 4,
        "maxGradeLevel": 4,
        **requirement,
    }
    if lengths is not None:
        row["lessonLengths"] = lengths
    return {
        "requestId": str(uuid4()),
        "academicYearId": str(uuid4()),
        "requirements": [row],
        "rooms": [{"id": str(uuid4()), "capacity": 30}],
        "constraints": [],
    }


def _minutes(clock: str) -> int:
    hours, minutes, _ = clock.split(":")
    return int(hours) * 60 + int(minutes)


def _durations(lessons: list) -> list[int]:  # noqa: ANN001
    return sorted(
        (_minutes(lesson.end_time) - _minutes(lesson.start_time) for lesson in lessons),
        reverse=True,
    )


def _solve(payload: dict, **settings: object):  # type: ignore[no-untyped-def]
    solver = SchedulerSolver(_settings(**settings))
    return solver.solve(OptimizeScheduleRequest.model_validate(payload))


def _refusal(payload: dict, **settings: object) -> InvalidScheduleInputError:
    with pytest.raises(InvalidScheduleInputError) as raised:
        _solve(payload, **settings)
    return raised.value


def _validate(payload: dict, lessons: list) -> list[str]:  # noqa: ANN001
    benchmarks = Path(__file__).resolve().parents[1] / "benchmarks"
    if str(benchmarks) not in sys.path:
        sys.path.insert(0, str(benchmarks))
    from validate_schedule import validate

    grid = SchedulerSolver(_settings())._grid
    return validate(grid, OptimizeScheduleRequest.model_validate(payload), lessons)


# ---------------------------------------------------------------------------
# The schema
# ---------------------------------------------------------------------------


def test_the_list_is_read_longest_first_and_a_uniform_requirement_repeats_its_length() -> None:
    split = AnonymousRequirement.model_validate(_payload([40, 80])["requirements"][0])
    assert split.lesson_minutes() == (80, 40)
    assert split.shortest_lesson_minutes() == 40

    uniform = AnonymousRequirement.model_validate(_payload(None, lessons=3, longest=60)["requirements"][0])
    assert uniform.lesson_lengths is None
    assert uniform.lesson_minutes() == (60, 60, 60)


@pytest.mark.parametrize(
    ("label", "lengths", "lessons", "longest"),
    [
        ("a count that disagrees with the list", [80, 40], 3, 80),
        ("a longest that disagrees with the list", [80, 40], 2, 60),
        ("a length below 15", [80, 10], 2, 80),
        ("a length above 240", [245, 40], 2, 245),
        ("an empty list", [], 1, 60),
    ],
)
def test_a_list_that_contradicts_its_scalars_is_refused(
    label: str, lengths: list[int], lessons: int, longest: int,
) -> None:
    with pytest.raises(ValidationError):
        OptimizeScheduleRequest.model_validate(_payload(lengths, lessons=lessons, longest=longest))


def test_the_route_answers_a_contradicting_list_with_422() -> None:
    client = TestClient(create_app(_settings()))
    response = client.post(
        "/api/v1/optimize",
        json=_payload([80, 40], lessons=3, longest=80),
        headers={"X-API-Key": API_KEY},
    )
    assert response.status_code == 422


# ---------------------------------------------------------------------------
# A solve
# ---------------------------------------------------------------------------


def test_each_lesson_is_placed_at_its_own_length() -> None:
    payload = _payload([80, 40])

    result = _solve(payload)

    assert result.status in {"OPTIMAL", "FEASIBLE"}
    assert _durations(result.lessons) == [80, 40]
    assert _validate(payload, result.lessons) == []


def test_the_spread_keeps_the_80_and_the_40_on_different_days() -> None:
    """One requirement id for both lengths is what makes them spread: on an
    open week the spread penalty puts the two lessons on two days, as it
    would two lessons of one length. Split into two requirements they would
    share a Monday for free."""
    payload = _payload([80, 40])

    result = _solve(payload)

    assert len({lesson.day_of_week for lesson in result.lessons}) == 2


def test_a_list_of_one_length_is_the_uniform_requirement_it_spells() -> None:
    listed = _solve(_payload([60, 60, 60]))
    plain = _solve(_payload(None, lessons=3, longest=60))

    assert _durations(listed.lessons) == _durations(plain.lessons) == [60, 60, 60]


def test_three_lengths_in_one_requirement() -> None:
    payload = _payload([80, 60, 40, 40])

    result = _solve(payload)

    assert _durations(result.lessons) == [80, 60, 40, 40]
    assert _validate(payload, result.lessons) == []


def test_the_class_demand_is_the_sum_of_its_lessons() -> None:
    """A two-hour Monday holds 1 × 80 + 1 × 40 exactly. Counted as two of the
    longest it would be 160 minutes in 120, and the week refused."""
    payload = _payload([80, 40])
    payload["frameTimes"] = [{
        "minGradeLevel": 0, "maxGradeLevel": 12, "dayOfWeek": None,
        "startTime": "08:00:00", "endTime": "10:00:00",
    }]

    result = _solve(payload, SCHEDULE_DAYS="1")

    assert result.status in {"OPTIMAL", "FEASIBLE"}
    assert _durations(result.lessons) == [80, 40]


# ---------------------------------------------------------------------------
# The refusals stay true
# ---------------------------------------------------------------------------


def test_a_length_between_slots_is_named_by_its_own_minutes() -> None:
    refusal = _refusal(_payload([60, 42]))

    assert refusal.code == "INPUT_LESSON_LENGTH_OFF_GRID"
    assert refusal.params["minutes"] == 42


def test_a_frame_that_holds_the_40_but_not_the_80_names_the_80() -> None:
    payload = _payload([80, 40])
    payload["frameTimes"] = [{
        "minGradeLevel": 0, "maxGradeLevel": 12, "dayOfWeek": None,
        "startTime": "08:00:00", "endTime": "09:00:00",
    }]

    refusal = _refusal(payload)

    assert refusal.code == "FRAME_NO_WINDOW_FOR_REQUIREMENT"
    assert refusal.params["minutes"] == 80
    assert refusal.params["remaining"] == 60


def _rast_payload(lengths: list[int] | None, *, lessons: int, longest: int) -> dict:
    """The lunch that leaves half an hour before an asking rast (see
    test_optimize.py's test_a_break_the_meal_leaves_no_room_before_is_refused_by_name):
    the meal in 11:00-12:30 frees the class at 12:00, the rast at 12:30 asks for
    a lesson before it."""
    payload = _payload(lengths, lessons=lessons, longest=longest, minGradeLevel=4, maxGradeLevel=6)
    group_id = payload["requirements"][0]["studentGroupId"]
    payload["groups"] = [{"id": group_id, "lunchHeadcount": 24, "minGradeLevel": 4, "maxGradeLevel": 6}]
    payload["frameTimes"] = [{
        "minGradeLevel": 0, "maxGradeLevel": 12, "dayOfWeek": None,
        "startTime": "08:00:00", "endTime": "14:00:00",
    }]
    payload["rasts"] = [{
        "minGradeLevel": 0, "maxGradeLevel": 12, "dayOfWeek": None,
        "startTime": "12:30:00", "endTime": "12:45:00", "requiresLessonBefore": True,
    }]
    payload["rules"] = {"lunchStartTime": "11:00:00", "lunchEndTime": "12:30:00", "lunchMinutes": 60}
    return payload


def test_a_rast_demand_is_answered_by_the_shortest_lesson() -> None:
    """Half an hour before the rast holds no 60-minute lesson, and four of them
    are refused by name. Make one of the four 30 minutes and the stretch has
    its lesson."""
    refusal = _refusal(_rast_payload(None, lessons=4, longest=60), SCHEDULE_DAYS="1")
    assert refusal.code == "RAST_DEMANDS_A_LESSON_THAT_CANNOT_FIT"
    assert refusal.params["minutes"] == 60

    payload = _rast_payload([60, 60, 60, 30], lessons=4, longest=60)
    result = _solve(payload, SCHEDULE_DAYS="1")
    assert result.status in {"OPTIMAL", "FEASIBLE"}
    thirty = [lesson for lesson in result.lessons
              if _minutes(lesson.end_time) - _minutes(lesson.start_time) == 30]
    assert len(thirty) == 1
    assert thirty[0].end_time <= "12:30:00"


# ---------------------------------------------------------------------------
# The independent validator
# ---------------------------------------------------------------------------


def _placed(payload: dict, spans: list[tuple[int, str, str]]) -> list[ScheduledLesson]:
    requirement = payload["requirements"][0]
    return [
        ScheduledLesson.model_validate({
            "requirementId": requirement["id"], "roomId": payload["rooms"][0]["id"],
            "dayOfWeek": day, "startTime": start, "endTime": end,
        })
        for day, start, end in spans
    ]


def test_the_validator_holds_a_split_requirement_to_its_lengths() -> None:
    payload = _payload([80, 40])

    right = _placed(payload, [(1, "08:00:00", "09:20:00"), (2, "08:00:00", "08:40:00")])
    wrong = _placed(payload, [(1, "08:00:00", "09:20:00"), (2, "08:00:00", "09:20:00")])

    assert _validate(payload, right) == []
    problems = _validate(payload, wrong)
    assert any("[80, 80] minutes placed, [80, 40] requested" in problem for problem in problems)


# ---------------------------------------------------------------------------
# The step
# ---------------------------------------------------------------------------


def _step(payload: dict) -> int:
    solver = SchedulerSolver(_settings())
    request = OptimizeScheduleRequest.model_validate(payload)
    return _start_step(request, solver._grid) * solver._grid.slot_minutes


@pytest.mark.parametrize(
    ("lengths", "minutes"),
    [
        (None, 60),  # three hours: the hour
        ([80, 40], 40),  # gcd(80, 40, the day's 600)
        ([60, 60, 55], 5),  # 55 shares only five minutes with the hour
        ([60, 60, 45], 15),
    ],
)
def test_every_length_of_a_requirement_feeds_the_step(lengths: list[int] | None, minutes: int) -> None:
    """The invariant _start_step rests on: every value the model compares a
    start against feeds the gcd, and a lesson's length is one of them. A 55
    among hours that did not feed it would have its starts searched on the
    hour, and a 55-minute lesson ending flush against a frame lost."""
    payload = _payload(lengths, lessons=3, longest=60) if lengths is None else _payload(lengths)
    assert _step(payload) == minutes


def test_the_uniform_requirement_builds_the_model_it_always_built() -> None:
    """A list of one length and no list are one requirement: the same lesson
    count, the same durations, the same step."""
    listed = _payload([60, 60, 60])
    plain = _payload(None, lessons=3, longest=60)
    assert _step(listed) == _step(plain)
    assert Counter(
        AnonymousRequirement.model_validate(listed["requirements"][0]).lesson_minutes()
    ) == Counter(AnonymousRequirement.model_validate(plain["requirements"][0]).lesson_minutes())
