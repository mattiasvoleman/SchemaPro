"""A/B-veckor: a lesson on odd or even ISO weeks only takes its hour only then.

Slöjd udda veckor and hemkunskap jämna veckor may share one hour of 7A's, of
one teacher's or of one room's, because no week holds both — and every rule
the model holds over several lessons is held in each real week on its own
(app/solver/weeks.py). Each test below is a week the two weeks make solvable
and one week would not, or a week one of the two weeks breaks, and each pins
the non-vacuous side as well: the same week with every lesson weekly.

Most weeks are ONE DAY (Monday) of a few hours, so the arithmetic is visible.
"""

from __future__ import annotations

import sys
from pathlib import Path
from uuid import UUID, uuid4

import pytest
from pydantic import ValidationError

from app.config import Settings
from app.exceptions import InvalidScheduleInputError
from app.schemas.schedule import OptimizeScheduleRequest, ScheduledLesson
from app.solver.scheduler_solver import SchedulerSolver, _week_requests
from app.solver.weeks import EVEN_WEEKS, ODD_WEEKS, week_parts

ODD, EVEN = "ODD_WEEKS", "EVEN_WEEKS"
SOLVED = {"OPTIMAL", "FEASIBLE"}


def _settings(hours: int = 4, days: str = "1", **overrides: object) -> Settings:
    return Settings(  # type: ignore[arg-type]
        SOLVER_MAX_TIME_SECONDS=10.0,
        SCHEDULE_DAY_END_MINUTES=480 + 60 * hours,
        SCHEDULE_DAYS=days,
        **overrides,
    )


def _requirement(
    group: str,
    lessons: int,
    *,
    teacher: str | None = None,
    minutes: int = 60,
    recurrence: str | None = None,
    **extra: object,
) -> dict[str, object]:
    requirement: dict[str, object] = {
        "id": str(uuid4()),
        "subjectId": str(uuid4()),
        "studentGroupId": group,
        "teacherId": teacher or str(uuid4()),
        "lessonsPerWeek": lessons,
        "minutesPerLesson": minutes,
        "studentGroupSize": 20,
        **extra,
    }
    if recurrence is not None:
        requirement["recurrence"] = recurrence
    return requirement


def _payload(
    requirements: list[dict[str, object]],
    *,
    rooms: list[dict[str, object]] | None = None,
    **extra: object,
) -> dict[str, object]:
    groups = list(dict.fromkeys(str(r["studentGroupId"]) for r in requirements))
    return {
        "requestId": str(uuid4()),
        "academicYearId": str(uuid4()),
        "requirements": requirements,
        "groups": [
            {"id": group, "lunchHeadcount": 20, "minGradeLevel": 7, "maxGradeLevel": 7}
            for group in groups
        ],
        "rooms": rooms or [{"id": str(uuid4()), "capacity": 30} for _ in range(6)],
        **extra,
    }


def _weekly(payload: dict[str, object]) -> dict[str, object]:
    """The same week with every lesson and lock every week: the non-vacuous side."""
    def strip(row: dict[str, object]) -> dict[str, object]:
        return {key: value for key, value in row.items() if key != "recurrence"}

    return {
        **payload,
        "requirements": [strip(r) for r in payload["requirements"]],  # type: ignore[union-attr]
        "fixedLessons": [strip(f) for f in payload.get("fixedLessons", [])],  # type: ignore[union-attr]
    }


def _solve(payload: dict[str, object], settings: Settings | None = None):
    return (settings and SchedulerSolver(settings) or SchedulerSolver(_settings())).solve(
        OptimizeScheduleRequest.model_validate(payload),
    )


def _minutes(clock: str) -> int:
    hours, minutes, *_ = (int(part) for part in clock.split(":"))
    return hours * 60 + minutes


def _spans(lessons: list[ScheduledLesson], requirement: dict[str, object]) -> list[tuple[int, int]]:
    return sorted(
        (lesson.day_of_week * 1440 + _minutes(lesson.start_time),
         lesson.day_of_week * 1440 + _minutes(lesson.end_time))
        for lesson in lessons
        if lesson.requirement_id == UUID(str(requirement["id"]))
    )


def _overlap(a: list[tuple[int, int]], b: list[tuple[int, int]]) -> bool:
    return any(s < oe and os_ < e for s, e in a for os_, oe in b)


def _validate(payload: dict[str, object], lessons, settings: Settings | None = None) -> list[str]:
    benchmarks = Path(__file__).resolve().parents[1] / "benchmarks"
    if str(benchmarks) not in sys.path:
        sys.path.insert(0, str(benchmarks))
    from validate_schedule import validate

    grid = SchedulerSolver(settings or _settings())._grid
    return validate(grid, OptimizeScheduleRequest.model_validate(payload), lessons)


# ---------------------------------------------------------------------------
# The contract
# ---------------------------------------------------------------------------


def test_the_field_is_optional_and_names_one_parity() -> None:
    group = str(uuid4())
    payload = _payload([_requirement(group, 1), _requirement(group, 1, recurrence=ODD)])
    request = OptimizeScheduleRequest.model_validate(payload)
    assert [r.recurrence for r in request.requirements] == [None, ODD]
    # Every week is the field left out: one way of saying it.
    with pytest.raises(ValidationError):
        OptimizeScheduleRequest.model_validate(
            _payload([_requirement(group, 1, recurrence="ALL_WEEKS")]),
        )
    # And absent stays absent on the way out, so a payload without it is
    # byte for byte what it was.
    dumped = request.requirements[0].model_dump(exclude_none=True)
    assert "recurrence" not in dumped


def test_week_parts_keeps_a_row_without_alternating_members_whole() -> None:
    items = ["a", "b", "c"]
    assert week_parts(items, lambda _: None) == [(None, items)]
    parity = {"a": None, "b": ODD_WEEKS, "c": EVEN_WEEKS}
    assert week_parts(items, parity.get) == [
        (ODD_WEEKS, ["a", "b"]), (EVEN_WEEKS, ["a", "c"]),
    ]
    # Implied: the even week's members are inside the odd week's, one row.
    only_odd = {"a": None, "b": ODD_WEEKS, "c": None}
    assert week_parts(items, only_odd.get) == [(ODD_WEEKS, items)]
    # Not implied: every week its members run in.
    assert week_parts(items, only_odd.get, implied=False) == [
        (ODD_WEEKS, items), (EVEN_WEEKS, ["a", "c"]),
    ]
    # A row whose locks alternate is cut with every item weekly.
    assert week_parts(items, lambda _: None, alternating=True) == [
        (ODD_WEEKS, items), (EVEN_WEEKS, items),
    ]


def test_a_school_without_alternating_lessons_is_one_week() -> None:
    group = str(uuid4())
    request = OptimizeScheduleRequest.model_validate(_payload([_requirement(group, 2)]))
    assert _week_requests(request) == [request]


# ---------------------------------------------------------------------------
# The two weeks share an hour
# ---------------------------------------------------------------------------


def test_a_class_shares_an_hour_between_its_odd_and_its_even_lessons() -> None:
    """Four hours a day; two of svenska, two of slöjd odd, two of hemkunskap even."""
    group = str(uuid4())
    svenska = _requirement(group, 2)
    slojd = _requirement(group, 2, recurrence=ODD)
    hemkunskap = _requirement(group, 2, recurrence=EVEN)
    payload = _payload([svenska, slojd, hemkunskap])

    response = _solve(payload)
    assert response.status in SOLVED
    assert _spans(response.lessons, slojd) == _spans(response.lessons, hemkunskap)
    assert not _overlap(_spans(response.lessons, svenska), _spans(response.lessons, slojd))
    assert _validate(payload, response.lessons) == []

    assert _solve(_weekly(payload)).status == "INFEASIBLE"


def test_a_teacher_teaches_two_classes_in_one_hour_of_opposite_weeks() -> None:
    teacher = str(uuid4())
    first = _requirement(str(uuid4()), 2, teacher=teacher, recurrence=ODD)
    second = _requirement(str(uuid4()), 2, teacher=teacher, recurrence=EVEN)
    payload = _payload([first, second])
    settings = _settings(hours=2)

    response = _solve(payload, settings)
    assert response.status in SOLVED
    assert _spans(response.lessons, first) == _spans(response.lessons, second)
    assert _validate(payload, response.lessons, settings) == []
    assert _solve(_weekly(payload), settings).status == "INFEASIBLE"


def test_one_slojd_room_holds_an_odd_class_and_an_even_class_at_once() -> None:
    room = str(uuid4())
    rooms = [{"id": room, "capacity": 30, "type": "slojd"}, {"id": str(uuid4()), "capacity": 30}]
    first = _requirement(str(uuid4()), 2, recurrence=ODD, requiredRoomType="slojd")
    second = _requirement(str(uuid4()), 2, recurrence=EVEN, requiredRoomType="slojd")
    payload = _payload([first, second], rooms=rooms)
    settings = _settings(hours=2)

    response = _solve(payload, settings)
    assert response.status in SOLVED
    assert {lesson.room_id for lesson in response.lessons} == {UUID(room)}
    assert _validate(payload, response.lessons, settings) == []
    assert _solve(_weekly(payload), settings).status == "INFEASIBLE"


def test_two_rooms_hold_two_odd_classes_and_two_even_ones() -> None:
    """A room class of two with no every-week lesson: one cumulative per week."""
    rooms = [
        {"id": str(uuid4()), "capacity": 30, "type": "slojd"},
        {"id": str(uuid4()), "capacity": 30, "type": "slojd"},
    ]
    requirements = [
        _requirement(str(uuid4()), 2, recurrence=parity, requiredRoomType="slojd")
        for parity in (ODD, ODD, EVEN, EVEN)
    ]
    payload = _payload(requirements, rooms=rooms)
    settings = _settings(hours=2)

    response = _solve(payload, settings)
    assert response.status in SOLVED
    assert _validate(payload, response.lessons, settings) == []
    assert _solve(_weekly(payload), settings).status == "INFEASIBLE"


def test_rooms_shared_with_every_week_lessons_count_an_alternating_lesson_in_both_weeks() -> None:
    """The conservative reading (room_allocator's module docstring).

    Two rooms, an every-week class and an odd and an even one: each real week
    has two lessons in two rooms, but per-week counts cannot promise one room
    an every-week lesson keeps through both weeks, so a pool with every-week
    lessons in it counts the alternating ones every week. The class and the
    teacher still share; only these rooms do not.
    """
    rooms = [
        {"id": str(uuid4()), "capacity": 30, "type": "slojd"},
        {"id": str(uuid4()), "capacity": 30, "type": "slojd"},
    ]
    requirements = [
        _requirement(str(uuid4()), 2, recurrence=parity, requiredRoomType="slojd")
        for parity in (None, ODD, EVEN)
    ]
    settings = _settings(hours=2)
    assert _solve(_payload(requirements, rooms=rooms), settings).status == "INFEASIBLE"
    rooms.append({"id": str(uuid4()), "capacity": 30, "type": "slojd"})
    payload = _payload(requirements, rooms=rooms)
    response = _solve(payload, settings)
    assert response.status in SOLVED
    assert _validate(payload, response.lessons, settings) == []


def test_a_lock_of_the_odd_weeks_leaves_its_hour_to_the_even_ones() -> None:
    group = str(uuid4())
    svenska = _requirement(group, 1)
    hemkunskap = _requirement(group, 1, recurrence=EVEN)
    lock = {
        "id": str(uuid4()), "teacherId": str(uuid4()), "studentGroupId": group,
        "dayOfWeek": 1, "startTime": "08:00:00", "endTime": "09:00:00", "recurrence": ODD,
    }
    payload = _payload([svenska, hemkunskap], fixedLessons=[lock])
    settings = _settings(hours=2)

    response = _solve(payload, settings)
    assert response.status in SOLVED
    assert _spans(response.lessons, hemkunskap) == [(1440 + 480, 1440 + 540)]
    assert _validate(payload, response.lessons, settings) == []
    assert _solve(_weekly(payload), settings).status == "INFEASIBLE"


def test_the_lunch_keeps_clear_of_both_weeks() -> None:
    """Five hours, an hour's meal at 11, three weekly hours and one of each week."""
    group = str(uuid4())
    payload = _payload(
        [_requirement(group, 3), _requirement(group, 1, recurrence=ODD),
         _requirement(group, 1, recurrence=EVEN)],
        rules={"lunchStartTime": "11:00:00", "lunchEndTime": "12:00:00", "lunchMinutes": 60},
    )
    settings = _settings(hours=5)
    response = _solve(payload, settings)
    assert response.status in SOLVED
    assert not _overlap(
        [(1440 + _minutes(lesson.start_time), 1440 + _minutes(lesson.end_time))
         for lesson in response.lessons],
        [(1440 + 660, 1440 + 720)],
    )
    assert _validate(payload, response.lessons, settings) == []
    assert _solve(_weekly(payload), settings).status == "INFEASIBLE"


# ---------------------------------------------------------------------------
# The rules count each week
# ---------------------------------------------------------------------------


def test_the_daily_maximum_counts_each_week() -> None:
    group = str(uuid4())
    requirements = [
        _requirement(group, 2), _requirement(group, 1, recurrence=ODD),
        _requirement(group, 1, recurrence=EVEN),
    ]
    payload = _payload(requirements, rules={"maxLessonsPerDayPerGroup": 3})
    response = _solve(payload)
    assert response.status in SOLVED
    assert _validate(payload, response.lessons) == []

    # Three a day in each week: a maximum of two refuses both weeks, by name.
    tight = _payload(requirements, rules={"maxLessonsPerDayPerGroup": 2})
    refused = _solve(tight)
    assert refused.status == "INFEASIBLE"


def test_a_rast_asks_each_week_for_a_lesson_before_it() -> None:
    """In odd weeks the class's only lesson is after the break, in even weeks before.

    Read across both weeks the even lesson would answer the odd week's break;
    each week on its own, the odd week arrives at the break untaught.
    """
    group = str(uuid4())
    late, early = str(uuid4()), str(uuid4())
    odd = _requirement(group, 1, teacher=late, recurrence=ODD)
    even = _requirement(group, 1, teacher=early, recurrence=EVEN)
    constraints = [
        {"id": str(uuid4()), "resourceKind": "TEACHER", "resourceId": late, "dayOfWeek": 1,
         "startTime": "08:00:00", "endTime": "10:20:00", "kind": "UNAVAILABLE"},
        {"id": str(uuid4()), "resourceKind": "TEACHER", "resourceId": early, "dayOfWeek": 1,
         "startTime": "10:00:00", "endTime": "12:00:00", "kind": "UNAVAILABLE"},
    ]
    rast = {"minGradeLevel": 7, "maxGradeLevel": 7, "startTime": "10:00:00",
            "endTime": "10:20:00", "requiresLessonBefore": True}
    payload = _payload([odd, even], constraints=constraints, rasts=[rast])
    # Refused by name before the model, on the odd week's request: its one
    # lesson cannot come before the break, so the class could never stay
    # after it — and its lesson is after it.
    with pytest.raises(InvalidScheduleInputError) as refused:
        _solve(payload)
    assert refused.value.code == "RAST_DEMANDS_A_LESSON_THAT_CANNOT_FIT"
    # Read as one week, the even lesson answers the break and nothing refuses.
    assert _solve(_weekly(payload)).status in SOLVED

    # An every-week lesson before the break answers both weeks.
    payload = _payload(
        [odd, even, _requirement(group, 1)], constraints=constraints, rasts=[rast],
    )
    response = _solve(payload)
    assert response.status in SOLVED


def test_a_teacher_with_one_day_a_week_teaches_monday_odd_and_tuesday_even() -> None:
    teacher = str(uuid4())
    monday, tuesday = str(uuid4()), str(uuid4())
    payload = _payload(
        [_requirement(monday, 1, teacher=teacher, recurrence=ODD),
         _requirement(tuesday, 1, teacher=teacher, recurrence=EVEN)],
        constraints=[
            {"id": str(uuid4()), "resourceKind": "STUDENT_GROUP", "resourceId": monday,
             "dayOfWeek": 2, "startTime": "00:00:00", "endTime": "23:59:00", "kind": "UNAVAILABLE"},
            {"id": str(uuid4()), "resourceKind": "STUDENT_GROUP", "resourceId": tuesday,
             "dayOfWeek": 1, "startTime": "00:00:00", "endTime": "23:59:00", "kind": "UNAVAILABLE"},
        ],
        teacherDayLimits=[{"id": str(uuid4()), "teacherId": teacher,
                           "maxTeachingDaysPerWeek": 1, "lockedWeekdays": [[]]}],
    )
    settings = _settings(hours=2, days="1,2")
    response = _solve(payload, settings)
    assert response.status in SOLVED
    assert _validate(payload, response.lessons, settings) == []
    assert _solve(_weekly(payload), settings).status == "INFEASIBLE"


def test_a_teacher_cap_counts_each_week() -> None:
    teacher = str(uuid4())
    group = str(uuid4())
    payload = _payload(
        [_requirement(group, 1, teacher=teacher),
         _requirement(group, 1, teacher=teacher, recurrence=ODD),
         _requirement(str(uuid4()), 1, teacher=teacher, recurrence=EVEN)],
        teacherWorkRules=[{"id": str(uuid4()), "teacherId": teacher,
                           "maxTeachingMinutesPerDay": 120}],
    )
    response = _solve(payload)
    assert response.status in SOLVED
    assert _validate(payload, response.lessons) == []
    # Read as one week, 180 minutes against a cap of 120 on one day: refused
    # by name before the model.
    with pytest.raises(InvalidScheduleInputError) as refused:
        _solve(_weekly(payload))
    assert refused.value.code == "TEACHER_DAILY_CAP_TOO_SMALL_FOR_WEEK"


def test_a_teacher_rests_between_each_weeks_own_evening_and_morning() -> None:
    """Monday 19-20 in odd weeks and Tuesday 08-09 in even ones: no night between them."""
    teacher = str(uuid4())
    evening, morning = str(uuid4()), str(uuid4())

    def closed(group: str, day: int, start: str, end: str) -> dict[str, object]:
        return {"id": str(uuid4()), "resourceKind": "STUDENT_GROUP", "resourceId": group,
                "dayOfWeek": day, "startTime": start, "endTime": end, "kind": "UNAVAILABLE"}

    payload = _payload(
        [_requirement(evening, 1, teacher=teacher, recurrence=ODD),
         _requirement(morning, 1, teacher=teacher, recurrence=EVEN)],
        constraints=[
            closed(evening, 1, "08:00:00", "19:00:00"), closed(evening, 2, "00:00:00", "23:59:00"),
            closed(morning, 1, "00:00:00", "23:59:00"), closed(morning, 2, "09:00:00", "20:00:00"),
        ],
        teacherWorkRules=[{"id": str(uuid4()), "teacherId": teacher,
                           "minDailyRestMinutes": 780}],
    )
    settings = _settings(hours=12, days="1,2")
    response = _solve(payload, settings)
    assert response.status in SOLVED
    assert _solve(_weekly(payload), settings).status == "INFEASIBLE"


def test_no_walk_between_two_lessons_that_never_meet() -> None:
    teacher = str(uuid4())
    near, far = str(uuid4()), str(uuid4())
    rooms = [
        {"id": str(uuid4()), "capacity": 30, "type": "near", "siteId": near},
        {"id": str(uuid4()), "capacity": 30, "type": "far", "siteId": far},
    ]
    payload = _payload(
        [_requirement(str(uuid4()), 1, teacher=teacher, recurrence=ODD, requiredRoomType="near"),
         _requirement(str(uuid4()), 1, teacher=teacher, recurrence=EVEN, requiredRoomType="far")],
        rooms=rooms,
        siteTravelTimes=[{"siteAId": near, "siteBId": far, "minutes": 30}],
    )
    settings = _settings(hours=1)
    response = _solve(payload, settings)
    assert response.status in SOLVED
    assert _validate(payload, response.lessons, settings) == []
    assert _solve(_weekly(payload), settings).status == "INFEASIBLE"


def test_a_teachers_lunch_keeps_clear_of_both_weeks_locks_and_is_refused_by_name() -> None:
    """An odd-week lock 11-12 and an even-week lock 12-13 leave no hour between 11 and 13.

    The teacher's break sits at one hour all year, so each week's locks are
    in its way: refused before the model, by name, as a lock of every week
    would be — though each week on its own leaves the hour.
    """
    teacher, group = str(uuid4()), str(uuid4())

    def lock(start: str, end: str, parity: str) -> dict[str, object]:
        return {"id": str(uuid4()), "teacherId": teacher, "studentGroupId": str(uuid4()),
                "dayOfWeek": 1, "startTime": start, "endTime": end, "recurrence": parity}

    payload = _payload(
        [_requirement(group, 1, teacher=teacher)],
        fixedLessons=[lock("11:00:00", "12:00:00", ODD), lock("12:00:00", "13:00:00", EVEN)],
        teacherWorkRules=[{"id": str(uuid4()), "teacherId": teacher, "lunchMinutes": 60,
                           "lunchStartTime": "11:00:00", "lunchEndTime": "13:00:00"}],
    )
    settings = _settings(hours=6)
    with pytest.raises(InvalidScheduleInputError) as refused:
        SchedulerSolver(settings)._validate_request(OptimizeScheduleRequest.model_validate(payload))
    assert refused.value.code == "TEACHER_LUNCH_LEAVES_NO_START"
    # One lock alone leaves the hour the other one takes.
    one = {**payload, "fixedLessons": payload["fixedLessons"][:1]}  # type: ignore[index]
    assert _solve(one, settings).status in SOLVED


def test_a_block_may_hold_an_odd_and_an_even_member_of_one_teacher() -> None:
    teacher, block = str(uuid4()), str(uuid4())
    payload = _payload([
        _requirement(str(uuid4()), 1, teacher=teacher, recurrence=ODD, blockId=block),
        _requirement(str(uuid4()), 1, teacher=teacher, recurrence=EVEN, blockId=block),
    ])
    SchedulerSolver(_settings())._validate_request(OptimizeScheduleRequest.model_validate(payload))
    with pytest.raises(InvalidScheduleInputError) as refused:
        SchedulerSolver(_settings())._validate_request(
            OptimizeScheduleRequest.model_validate(_weekly(payload)),
        )
    assert refused.value.code == "BLOCK_MEMBERS_SHARE_TEACHER"


# ---------------------------------------------------------------------------
# The checks before a run count each week
# ---------------------------------------------------------------------------


def test_a_week_the_two_weeks_hold_is_not_refused_before_the_model() -> None:
    """Six hours of lessons for a four-hour day: four in each real week."""
    group = str(uuid4())
    payload = _payload([
        _requirement(group, 2), _requirement(group, 2, recurrence=ODD),
        _requirement(group, 2, recurrence=EVEN),
    ])
    request = OptimizeScheduleRequest.model_validate(payload)
    solver = SchedulerSolver(_settings())
    for week in _week_requests(request):
        assert solver._clique_hours_verdict(week) is None
        assert solver._class_hours_verdict(week) is None
    # Read as one week, the same arithmetic refuses it.
    assert solver._clique_hours_verdict(
        OptimizeScheduleRequest.model_validate(_weekly(payload)),
    ) is not None


def test_a_refused_week_names_only_its_own_lessons() -> None:
    """Odd weeks need five hours of a four-hour day; even weeks need three."""
    group = str(uuid4())
    svenska = _requirement(group, 3)
    slojd = _requirement(group, 2, recurrence=ODD)
    hemkunskap = _requirement(group, 1, recurrence=EVEN)
    response = _solve(_payload([svenska, slojd, hemkunskap]))
    assert response.status == "INFEASIBLE"
    assert response.conflicts is not None
    named = {rid for detail in response.conflicts.conflicts for rid in detail.requirement_ids}
    assert UUID(str(hemkunskap["id"])) not in named
    assert named & {UUID(str(svenska["id"])), UUID(str(slojd["id"]))}


def test_the_validator_reads_each_week() -> None:
    group = str(uuid4())
    odd = _requirement(group, 1, recurrence=ODD)
    even = _requirement(group, 1, recurrence=EVEN)
    weekly = _requirement(group, 1)
    payload = _payload([odd, even, weekly])

    def lesson(requirement: dict[str, object], start: str, end: str) -> ScheduledLesson:
        return ScheduledLesson.model_validate({
            "requirementId": requirement["id"], "dayOfWeek": 1,
            "startTime": start, "endTime": end, "roomId": None,
        })

    shared = [lesson(odd, "08:00:00", "09:00:00"), lesson(even, "08:00:00", "09:00:00"),
              lesson(weekly, "09:00:00", "10:00:00")]
    assert _validate(payload, shared) == []
    clash = [lesson(odd, "08:00:00", "09:00:00"), lesson(even, "09:00:00", "10:00:00"),
             lesson(weekly, "08:30:00", "09:30:00")]
    problems = _validate(payload, clash)
    assert any("udda veckor" in problem for problem in problems)
    assert any("jämna veckor" in problem for problem in problems)


def test_the_size_estimate_still_bounds_a_week_of_two_weeks() -> None:
    teacher, group = str(uuid4()), str(uuid4())
    payload = _payload(
        [_requirement(group, 2, teacher=teacher), _requirement(group, 1, teacher=teacher, recurrence=ODD),
         _requirement(str(uuid4()), 2, teacher=teacher, recurrence=EVEN)],
        rules={"maxLessonsPerDayPerGroup": 2},
        teacherWorkRules=[{"id": str(uuid4()), "teacherId": teacher,
                           "maxTeachingMinutesPerDay": 180, "minDailyRestMinutes": 600}],
        teacherDayLimits=[{"id": str(uuid4()), "teacherId": teacher,
                           "maxTeachingDaysPerWeek": 2, "lockedWeekdays": [[]]}],
        rasts=[{"minGradeLevel": 7, "maxGradeLevel": 7, "startTime": "10:00:00",
                "endTime": "10:20:00", "requiresLessonBefore": True}],
    )
    request = OptimizeScheduleRequest.model_validate(payload)
    solver = SchedulerSolver(_settings(hours=6, days="1,2,3"))
    for include_objective in (False, True):
        model, *_ = solver._build_model(
            request, use_assumptions=False, include_objective=include_objective,
        )
        assert solver._estimate_model_size(request) >= len(model.Proto().variables)
