"""Terminer: a teacher's own rules, held period by period.

Two rules of app/solver/scheduler_solver.py read the YEAR where the school's
weeks are a term's, and so refused a year whose every term has a timetable
(the reviews of #300, MEDEL-1 and MEDEL-2):

- LÄRARENS DAG, the days of a post. The weekdays a teacher's preserved
  lessons hold were held against every week the teacher has: a Monday locked
  in the autumn took a day of the spring. They now carry their periods
  (AnonymousTeacherDayLimit.lockedWeekdayPeriods), and a week holds the sets
  of its own.
- THE TEACHER'S OWN LUNCH. One hour all year, clear of every lock and lesson
  of the year; now one in each period, clear of that period's.

What is NOT cut is the parity: an odd week's set and an even week's of one
period are both held in each of its weeks, and the lunch is one for the two
of them, as on main. A request without periods builds what it built
(benchmarks/model_identity.py).

Every school below that is solved is checked by benchmarks/validate_schedule
.py, which shares no code with the engine and reads each real week on its
own.
"""

from __future__ import annotations

import random
from uuid import UUID, uuid4

import pytest
from pydantic import ValidationError

import test_periods as periods
from app.config import Settings
from app.exceptions import InvalidScheduleInputError
from app.schemas.schedule import (
    AnonymousTeacherDayLimit,
    OptimizeScheduleRequest,
    ScheduledLesson,
)
from app.solver.relaxation import deviations_of
from app.solver.scheduler_solver import SchedulerSolver, _teacher_locks, _week_sets
from app.solver.weeks import EVEN_WEEKS, ODD_WEEKS, Weeks, whole_periods

AUTUMN, SPRING = periods.AUTUMN, periods.SPRING
SOLVED = periods.SOLVED
_payload, _requirement = periods._payload, periods._requirement
_solve, _validate = periods._solve, periods._validate


def _settings(hours: int, days: str) -> Settings:
    return periods._settings(hours=hours, days=days, SOLVER_PROBE_SECONDS=0)


def _lock(
    group: str, day: int, start: str, end: str, teacher: str, mask: list[bool] | None = None,
) -> dict[str, object]:
    row: dict[str, object] = {
        "id": str(uuid4()), "studentGroupId": group, "teacherId": teacher,
        "dayOfWeek": day, "startTime": start, "endTime": end,
    }
    if mask is not None:
        row["periods"] = mask
    return row


def _closed(kind: str, resource: str, day: int, start: str, end: str) -> dict[str, object]:
    return {"id": str(uuid4()), "resourceKind": kind, "resourceId": resource, "dayOfWeek": day,
            "startTime": start, "endTime": end, "kind": "UNAVAILABLE"}


def _limit(teacher: str, days: int, sets: list[list[int]], held: list[dict[str, object]] | None = None):
    limit: dict[str, object] = {
        "id": str(uuid4()), "teacherId": teacher, "maxTeachingDaysPerWeek": days, "lockedWeekdays": sets,
    }
    if held is not None:
        limit["lockedWeekdayPeriods"] = held
    return limit


def _codes(response) -> list[str]:
    return [line.code for line in response.conflicts.conflicts] if response.conflicts else []


# ---------------------------------------------------------------------------
# The contract
# ---------------------------------------------------------------------------


def _limit_of(held: object) -> AnonymousTeacherDayLimit:
    return AnonymousTeacherDayLimit.model_validate(_limit(str(uuid4()), 2, [[1]], held))  # type: ignore[arg-type]


def test_a_posts_days_by_period_are_each_set_once_with_the_periods_it_is_held_in() -> None:
    limit = _limit_of([{"weekdays": [], "periods": [False, True]}, {"weekdays": [1], "periods": [True, False]}])
    assert limit.locked_weekday_periods is not None
    assert [(entry.weekdays, entry.periods) for entry in limit.locked_weekday_periods] == [
        ([], (False, True)), ([1], (True, False)),
    ]
    # A set every period holds, beside one a single period does: a mask of
    # nothing but true is a mask here, unlike a requirement's.
    _limit_of([{"weekdays": [1], "periods": [True, True]}, {"weekdays": [1, 2], "periods": [False, True]}])
    # And without the field the limit is the one it was.
    assert _limit_of(None).locked_weekday_periods is None


@pytest.mark.parametrize(("held", "said"), [
    ([{"weekdays": [1], "periods": [True, False]}], "a set for every period"),
    ([{"weekdays": [1], "periods": [True, False]}, {"weekdays": [1], "periods": [False, True]}], "one set of weekdays twice"),
    ([{"weekdays": [2, 1], "periods": [True, False]}, {"weekdays": [1, 2], "periods": [False, True]}], "one set of weekdays twice"),
    ([{"weekdays": [1, 1], "periods": [True, True]}], "a weekday twice"),
    ([{"weekdays": [1], "periods": [True, True, True]}, {"weekdays": [], "periods": [True, True]}], "the same length"),
    ([{"weekdays": [1], "periods": [False, False]}, {"weekdays": [], "periods": [True, True]}], "at least one period"),
    ([{"weekdays": [1], "periods": [True]}], "at least 2"),
    ([], "at least 1 item"),
    ([{"weekdays": [1], "periods": [True, True], "recurrence": "ODD_WEEKS"}], "Extra inputs"),
])
def test_a_posts_days_by_period_in_any_other_shape_are_refused(held: object, said: str) -> None:
    with pytest.raises(ValidationError, match=said):
        _limit_of(held)


def test_the_days_masks_are_the_requests_one_cut_of_the_year() -> None:
    """Three periods on a post's days beside two on a requirement are two cuts, and refused as that."""
    teacher, group = str(uuid4()), str(uuid4())
    held = [{"weekdays": [], "periods": [True, True, False]}, {"weekdays": [1], "periods": [False, False, True]}]
    payload = _payload(
        [_requirement(group, 1, teacher=teacher, periods=AUTUMN)],
        teacherDayLimits=[_limit(teacher, 2, [[1]], held)],
    )
    with pytest.raises(ValidationError, match="same length"):
        OptimizeScheduleRequest.model_validate(payload)
    payload["requirements"][0]["periods"] = [True, False, False]  # type: ignore[index]
    OptimizeScheduleRequest.model_validate(payload)
    with pytest.raises(ValidationError, match="periodWeeks"):
        OptimizeScheduleRequest.model_validate({**payload, "periodWeeks": [20, 23]})
    OptimizeScheduleRequest.model_validate({**payload, "periodWeeks": [18, 3, 22]})


# ---------------------------------------------------------------------------
# Which sets a week holds
# ---------------------------------------------------------------------------


def test_a_week_holds_the_sets_of_its_own_periods_and_no_other_terms() -> None:
    limit = _limit_of([{"weekdays": [], "periods": [False, True]}, {"weekdays": [1], "periods": [True, False]}])
    autumn, spring = Weeks(0b0011, 2), Weeks(0b1100, 2)
    assert _week_sets(limit, autumn) == [frozenset({1})]
    assert _week_sets(limit, spring) == [frozenset()]
    # One parity of a period is that period's week.
    assert _week_sets(limit, Weeks(0b0100, 2)) == [frozenset()]
    assert _week_sets(limit, Weeks(0b0010, 2)) == [frozenset({1})]
    # A row of every week, and one of both terms, hold every set there is:
    # the empty one lies inside the Monday of a post of two days.
    assert _week_sets(limit, None) == [frozenset({1})]
    assert _week_sets(limit, Weeks(0b0110, 2)) == [frozenset({1})]
    # A parity of a year without periods is every period's.
    assert _week_sets(limit, ODD_WEEKS) == _week_sets(limit, EVEN_WEEKS) == [frozenset({1})]


def test_a_set_is_left_out_only_among_the_sets_of_one_week() -> None:
    """Monday all year and Tuesday in the spring, on a post of two.

    Over the year {Mon} lies inside {Mon, Tue} and is left out; in the autumn
    it is the only set there is, and without it the autumn has no line.
    """
    limit = _limit_of([{"weekdays": [1], "periods": [True, False]}, {"weekdays": [1, 2], "periods": [False, True]}])
    assert _week_sets(limit, Weeks(0b0011, 2)) == [frozenset({1})]
    assert _week_sets(limit, Weeks(0b1100, 2)) == [frozenset({1, 2})]
    assert _week_sets(limit, None) == [frozenset({1, 2})]
    # Inside one over the post the smaller set stays, in the week that holds both.
    over = AnonymousTeacherDayLimit.model_validate(_limit(str(uuid4()), 1, [[1], [1, 2]], [
        {"weekdays": [1], "periods": [True, True]}, {"weekdays": [1, 2], "periods": [False, True]},
    ]))
    assert _week_sets(over, Weeks(0b1100, 2)) == [frozenset({1}), frozenset({1, 2})]


def test_a_limit_without_periods_holds_every_set_in_every_week() -> None:
    limit = AnonymousTeacherDayLimit.model_validate(_limit(str(uuid4()), 1, [[1], [3]]))
    for week in (None, ODD_WEEKS, Weeks(0b0011, 2), Weeks(0b1100, 2)):
        assert _week_sets(limit, week) == [frozenset({1}), frozenset({3})]


def test_a_rows_periods_are_its_weeks_in_both_parities() -> None:
    assert whole_periods(None) is None
    # A parity alone is every week of a year without periods.
    assert whole_periods(ODD_WEEKS) is None and whole_periods("EVEN_WEEKS") is None
    assert whole_periods(Weeks(0b0001, 2)) == Weeks(0b0011, 2)
    assert whole_periods(Weeks(0b1000, 2)) == Weeks(0b1100, 2)
    assert whole_periods(Weeks(0b100001, 3)) == Weeks(0b110011, 3)
    # Some week of every period is every period.
    assert whole_periods(Weeks(0b0110, 2)) is None
    assert whole_periods(Weeks(0b1111, 2)) is None


# ---------------------------------------------------------------------------
# Lärarens dag: the review's part-timer
# ---------------------------------------------------------------------------


def _part_timer(
    lock_mask: list[bool] | None,
    lesson_mask: list[bool] | None,
    held: list[dict[str, object]] | None,
) -> dict[str, object]:
    """Two days a week, unavailable on Mondays; a lock on Monday, two lessons of four hours.

    The lessons need a day each (the day is four hours) and cannot go on the
    Monday: Tuesday and Wednesday. With the lock in their weeks that is three
    days; with the lock in other weeks, two in each.
    """
    teacher, first, second = str(uuid4()), str(uuid4()), str(uuid4())

    def lesson(group: str) -> dict[str, object]:
        return _requirement(group, 1, teacher=teacher, minutes=240, periods=lesson_mask)

    return _payload(
        [lesson(first), lesson(second)],
        constraints=[_closed("TEACHER", teacher, 1, "08:00:00", "23:59:00")],
        fixedLessons=[_lock(first, 1, "08:00:00", "09:00:00", teacher, lock_mask)],
        teacherDayLimits=[_limit(teacher, 2, [[1]], held)],
    )


BY_TERM = [{"weekdays": [], "periods": SPRING}, {"weekdays": [1], "periods": AUTUMN}]


def test_a_monday_locked_in_the_autumn_takes_no_day_of_the_spring() -> None:
    """The review's example (granskning-300-modell-data/strict_days.py), as the gateway now sends it."""
    settings = _settings(4, "1,2,3")
    payload = _part_timer(AUTUMN, SPRING, BY_TERM)
    response = _solve(payload, settings)
    assert response.status in SOLVED
    assert sorted(lesson.day_of_week for lesson in response.lessons) == [2, 3]
    assert _validate(payload, response.lessons, settings) == []


def test_the_same_week_without_the_sets_periods_is_held_as_it_was() -> None:
    """`lockedWeekdays` alone is every set in every week: the reading of an older gateway, unchanged."""
    response = _solve(_part_timer(AUTUMN, SPRING, None), _settings(4, "1,2,3"))
    assert response.status == "INFEASIBLE"
    assert "TEACHER_WORK_DAYS_CANNOT_BE_KEPT" in _codes(response)


def test_the_monday_still_takes_its_day_of_the_weeks_it_is_locked_in() -> None:
    """The non-vacuous side: the lock and the lessons in the same weeks are three days."""
    settings = _settings(4, "1,2,3")
    all_year = _solve(_part_timer(None, None, None), settings)
    assert all_year.status == "INFEASIBLE"
    assert "TEACHER_WORK_DAYS_CANNOT_BE_KEPT" in _codes(all_year)
    # Both in the spring, said by period: the spring holds the Monday.
    spring = _solve(
        _part_timer(SPRING, SPRING, [{"weekdays": [], "periods": AUTUMN}, {"weekdays": [1], "periods": SPRING}]),
        settings,
    )
    assert spring.status == "INFEASIBLE"
    assert "TEACHER_WORK_DAYS_CANNOT_BE_KEPT" in _codes(spring)


def test_a_term_locked_over_its_post_keeps_its_own_locked_days_and_is_not_held_to_another_terms() -> None:
    """The count before the model and the model itself read the week's own sets.

    A post of one day, a day of four hours. The autumn is locked on Monday
    and Tuesday mornings (over the post by hand, and never refused for it)
    and has two lessons of three hours to place; the spring is locked on
    Wednesday. The autumn's lessons go on its own two locked days, after the
    locks: a week the locks put over the post is held to adding no day.

    Held against every week, the spring's Wednesday allowed the autumn
    nothing off Wednesday and the autumn's own days nothing off Monday and
    Tuesday: no day at all, and TEACHER_WORK_DAYS_TOO_FEW_FOR_WEEK counted
    one day where the autumn has two.
    """
    teacher, group = str(uuid4()), str(uuid4())
    settings = _settings(4, "1,2,3")

    def payload(held: list[dict[str, object]] | None) -> dict[str, object]:
        return _payload(
            [_requirement(group, 2, teacher=teacher, minutes=180, periods=AUTUMN)],
            fixedLessons=[
                _lock(str(uuid4()), 1, "08:00:00", "09:00:00", teacher, AUTUMN),
                _lock(str(uuid4()), 2, "08:00:00", "09:00:00", teacher, AUTUMN),
                _lock(str(uuid4()), 3, "08:00:00", "09:00:00", teacher, SPRING),
            ],
            teacherDayLimits=[_limit(teacher, 1, [[1, 2], [3]], held)],
        )

    by_term = payload([{"weekdays": [1, 2], "periods": AUTUMN}, {"weekdays": [3], "periods": SPRING}])
    response = _solve(by_term, settings)
    assert response.status in SOLVED
    assert sorted(lesson.day_of_week for lesson in response.lessons) == [1, 2]
    assert _validate(by_term, response.lessons, settings) == []

    with pytest.raises(InvalidScheduleInputError) as refused:
        _solve(payload(None), settings)
    assert refused.value.code == "TEACHER_WORK_DAYS_TOO_FEW_FOR_WEEK"


def test_the_days_over_a_post_are_counted_against_the_weeks_own_sets() -> None:
    """Bästa möjliga schema's report reads the sets as the model holds them (relaxation.py)."""
    teacher, group = str(uuid4()), str(uuid4())
    tuesday = _requirement(group, 1, teacher=teacher, periods=SPRING)
    wednesday = _requirement(group, 1, teacher=teacher, periods=SPRING)
    locks = [_lock(group, 1, "08:00:00", "09:00:00", teacher, AUTUMN)]

    def deviations(held: list[dict[str, object]] | None):
        request = OptimizeScheduleRequest.model_validate(_payload(
            [tuesday, wednesday], fixedLessons=locks, teacherDayLimits=[_limit(teacher, 2, [[1]], held)],
        ))
        placed = [
            ScheduledLesson.model_validate({
                "requirementId": requirement["id"], "dayOfWeek": day,
                "startTime": "08:00:00", "endTime": "09:00:00", "roomId": None,
            })
            for requirement, day in ((tuesday, 2), (wednesday, 3))
        ]
        return deviations_of(
            request, placed, request.rooms, {}, (1, 2, 3),
            flatten=lambda fixed: _teacher_locks(fixed)[0],
        )

    assert deviations(BY_TERM) == []
    (line,) = deviations(None)
    assert (line.code, line.params["over"]) == ("DEVIATION_TEACHER_WORK_DAYS", 1)


# ---------------------------------------------------------------------------
# The teacher's own lunch: the review's two terms
# ---------------------------------------------------------------------------


def _two_lunches(first: dict[str, object], second: dict[str, object]) -> dict[str, object]:
    """Lunch 30 minutes in 11:00-13:00, and two lessons of an hour that fill the window between them.

    One class is here 11-12 only and the other 12-13 only. In the same weeks
    the teacher has no half hour; in two terms the autumn eats at 12 and the
    spring at 11.
    """
    teacher, early, late = str(uuid4()), str(uuid4()), str(uuid4())
    return _payload(
        [_requirement(early, 1, teacher=teacher, **first), _requirement(late, 1, teacher=teacher, **second)],
        constraints=[
            _closed("STUDENT_GROUP", early, 1, "08:00:00", "11:00:00"),
            _closed("STUDENT_GROUP", early, 1, "12:00:00", "13:00:00"),
            _closed("STUDENT_GROUP", late, 1, "08:00:00", "12:00:00"),
        ],
        teacherWorkRules=[{"id": str(uuid4()), "teacherId": teacher, "lunchMinutes": 30,
                           "lunchStartTime": "11:00:00", "lunchEndTime": "13:00:00"}],
    )


def test_a_teacher_eats_at_one_hour_in_the_autumn_and_another_in_the_spring() -> None:
    """The review's example (granskning-300-modell-data/strict_lunch.py)."""
    settings = _settings(5, "1")
    payload = _two_lunches({"periods": AUTUMN}, {"periods": SPRING})
    response = _solve(payload, settings)
    assert response.status in SOLVED
    assert sorted(lesson.start_time for lesson in response.lessons) == ["11:00:00", "12:00:00"]
    assert _validate(payload, response.lessons, settings) == []


def test_the_lunch_is_still_owed_in_the_weeks_both_lessons_run() -> None:
    response = _solve(_two_lunches({}, {}), _settings(5, "1"))
    assert response.status == "INFEASIBLE"
    assert "TEACHER_LUNCH_HAS_NOWHERE_TO_GO" in _codes(response)
    # One all year and one of the spring: the spring has both.
    response = _solve(_two_lunches({}, {"periods": SPRING}), _settings(5, "1"))
    assert response.status == "INFEASIBLE"
    assert "TEACHER_LUNCH_HAS_NOWHERE_TO_GO" in _codes(response)


def test_the_lunch_is_one_for_the_odd_weeks_and_the_even_ones_as_it_was() -> None:
    """The parity is not cut: a year without periods builds the break it built (model identity)."""
    response = _solve(
        _two_lunches({"recurrence": "ODD_WEEKS"}, {"recurrence": "EVEN_WEEKS"}), _settings(5, "1"),
    )
    assert response.status == "INFEASIBLE"
    assert "TEACHER_LUNCH_HAS_NOWHERE_TO_GO" in _codes(response)
    # Nor inside a term: the odd and the even weeks of the autumn share its break.
    response = _solve(
        _two_lunches(
            {"recurrence": "ODD_WEEKS", "periods": AUTUMN}, {"recurrence": "EVEN_WEEKS", "periods": AUTUMN},
        ),
        _settings(5, "1"),
    )
    assert response.status == "INFEASIBLE"


def _locked_lunch(
    first: list[bool] | None, second: list[bool] | None, *, autumn_post: bool = True,
) -> dict[str, object]:
    """Lunch 30 minutes in 11:00-12:00, and two locks of half an hour that fill it between them.

    The teacher has two lessons of every week and, with `autumn_post`, one of
    the autumn: without it the lessons are the same in every week, and only
    the locks tell the terms apart.
    """
    teacher = str(uuid4())
    posts = [_requirement(str(uuid4()), 2, teacher=teacher)]
    if autumn_post:
        posts.append(_requirement(str(uuid4()), 1, teacher=teacher, periods=AUTUMN))
    return _payload(
        posts,
        teacherWorkRules=[{"id": str(uuid4()), "teacherId": teacher, "lunchMinutes": 30,
                           "lunchStartTime": "11:00:00", "lunchEndTime": "12:00:00"}],
        fixedLessons=[
            _lock(str(uuid4()), 1, "11:00:00", "11:30:00", teacher, first),
            _lock(str(uuid4()), 1, "11:30:00", "12:00:00", teacher, second),
        ],
    )


def _refusal(payload: dict[str, object]) -> InvalidScheduleInputError:
    with pytest.raises(InvalidScheduleInputError) as refused:
        SchedulerSolver(_settings(5, "1"))._validate_request(OptimizeScheduleRequest.model_validate(payload))
    return refused.value


def test_locks_that_fill_a_teachers_lunch_window_are_refused_for_the_term_they_fill_it_in() -> None:
    """TEACHER_LUNCH_LEAVES_NO_START, read period by period as the model's break is.

    Both locks in the spring: the spring's refusal, and it says so (it said
    the autumn's dates once, review of #300, M1, and then no period at all).
    Both all year: the year's, and no period. One of each: the spring's
    again, since the spring is where both are.
    """
    every_year = _refusal(_locked_lunch(None, None))
    assert every_year.code == "TEACHER_LUNCH_LEAVES_NO_START"
    assert "period" not in every_year.params and "parity" not in every_year.params
    for first, second, period in ((SPRING, SPRING, 1), (AUTUMN, AUTUMN, 0), (None, SPRING, 1), (AUTUMN, None, 0)):
        refused = _refusal(_locked_lunch(first, second))
        assert refused.code == "TEACHER_LUNCH_LEAVES_NO_START"
        assert refused.params["period"] == period
        assert "parity" not in refused.params and "periods" not in refused.params
        assert {key: value for key, value in refused.params.items() if key != "period"} == {
            key: value for key, value in every_year.params.items() if key != "rule"
        } | {"rule": refused.params["rule"]}


def test_a_lock_in_each_term_leaves_each_term_its_lunch() -> None:
    """One half of the window locked in the autumn and the other in the spring: no refusal, and a timetable."""
    settings = _settings(5, "1")
    for first, second in ((AUTUMN, SPRING), (SPRING, AUTUMN)):
        # With a post of the autumn, and with lessons of every week alone:
        # then the locks are all that cuts the teacher's year, and the two
        # breaks have to be cut by them.
        for autumn_post in (True, False):
            payload = _locked_lunch(first, second, autumn_post=autumn_post)
            SchedulerSolver(settings)._validate_request(OptimizeScheduleRequest.model_validate(payload))
            response = _solve(payload, settings)
            assert response.status in SOLVED
            assert _validate(payload, response.lessons, settings) == []
            # Each term's half hour is left free: no lesson touches the window.
            assert all(
                lesson.end_time <= "11:00:00" or lesson.start_time >= "12:00:00"
                for lesson in response.lessons
            )


def test_the_two_weeks_lunch_test_read_as_two_terms_has_a_timetable() -> None:
    """test_ab_weeks' own school — a lock 11-12 in one week and 12-13 in the other, an hour's lunch in 11-13.

    As odd and even weeks it is refused, on main and here: one break for the
    two weeks, and no hour clear of both locks. As two terms each has its
    hour, and the mirror in test_periods.py no longer runs that test for them
    (HELD_BY_PARITY_ALONE). This is what it finds instead.
    """
    teacher = str(uuid4())
    settings = _settings(6, "1")

    def school(first: dict[str, object], second: dict[str, object]) -> dict[str, object]:
        return _payload(
            [_requirement(str(uuid4()), 1, teacher=teacher)],
            fixedLessons=[
                {**_lock(str(uuid4()), 1, "11:00:00", "12:00:00", teacher), **first},
                {**_lock(str(uuid4()), 1, "12:00:00", "13:00:00", teacher), **second},
            ],
            teacherWorkRules=[{"id": str(uuid4()), "teacherId": teacher, "lunchMinutes": 60,
                               "lunchStartTime": "11:00:00", "lunchEndTime": "13:00:00"}],
        )

    terms = school({"periods": AUTUMN}, {"periods": SPRING})
    response = _solve(terms, settings)
    assert response.status in SOLVED
    assert _validate(terms, response.lessons, settings) == []
    with pytest.raises(InvalidScheduleInputError) as refused:
        _solve(school({"recurrence": "ODD_WEEKS"}, {"recurrence": "EVEN_WEEKS"}), settings)
    assert refused.value.code == "TEACHER_LUNCH_LEAVES_NO_START"
    assert "period" not in refused.value.params


def test_a_term_of_odd_and_even_locks_is_read_with_both() -> None:
    """The pre-flight reads a period's locks in both parities, as the model's break does.

    An odd-week lock and an even-week lock of the spring fill the window
    between them. The break is one for the spring's two weeks, so the spring
    has none; read by the week alone each would pass, and the model would be
    handed an empty domain.
    """
    payload = _locked_lunch(SPRING, SPRING)
    payload["fixedLessons"][0]["recurrence"] = "ODD_WEEKS"  # type: ignore[index]
    payload["fixedLessons"][1]["recurrence"] = "EVEN_WEEKS"  # type: ignore[index]
    refused = _refusal(payload)
    assert (refused.code, refused.params["period"]) == ("TEACHER_LUNCH_LEAVES_NO_START", 1)


def test_a_week_that_lies_in_two_terms_is_read_one_term_at_a_time() -> None:
    """The teacher teaches in odd weeks all year; two even-week locks of the SPRING fill the window.

    The odd weeks of the autumn and of the spring hold the same lessons and
    are one week to the engine, named for both terms. The break is a term's,
    for its odd weeks and its even ones, so the spring has none — and the
    week the teacher is read in has to be read for each of its terms, not
    only the first: the model's break in the spring is kept clear of these
    locks, and a spring that passed here would be an empty domain there.
    """
    teacher = str(uuid4())

    def school(first: list[bool], second: list[bool]) -> dict[str, object]:
        return _payload(
            [_requirement(str(uuid4()), 2, teacher=teacher, recurrence="ODD_WEEKS")],
            teacherWorkRules=[{"id": str(uuid4()), "teacherId": teacher, "lunchMinutes": 30,
                               "lunchStartTime": "11:00:00", "lunchEndTime": "12:00:00"}],
            fixedLessons=[
                {**_lock(str(uuid4()), 1, "11:00:00", "11:30:00", teacher, first), "recurrence": "EVEN_WEEKS"},
                {**_lock(str(uuid4()), 1, "11:30:00", "12:00:00", teacher, second), "recurrence": "EVEN_WEEKS"},
            ],
        )

    refused = _refusal(school(SPRING, SPRING))
    assert (refused.code, refused.params["period"]) == ("TEACHER_LUNCH_LEAVES_NO_START", 1)
    refused = _refusal(school(AUTUMN, AUTUMN))
    assert (refused.code, refused.params["period"]) == ("TEACHER_LUNCH_LEAVES_NO_START", 0)
    # One in each term: each term has its half hour, and the year is laid.
    settings = _settings(5, "1")
    apart = school(AUTUMN, SPRING)
    response = _solve(apart, settings)
    assert response.status in SOLVED
    assert _validate(apart, response.lessons, settings) == []


# ---------------------------------------------------------------------------
# The validator reads both, in its own words
# ---------------------------------------------------------------------------


def _laid(requirement: dict[str, object], day: int, start: str, end: str) -> ScheduledLesson:
    return ScheduledLesson.model_validate({
        "requirementId": requirement["id"], "dayOfWeek": day,
        "startTime": start, "endTime": end, "roomId": None,
    })


def test_the_validator_reads_a_teachers_lunch_in_each_real_week() -> None:
    """benchmarks/validate_schedule.py had no reading of a teacher's own lunch at all.

    Lunch 30 minutes in 11:00-12:00. A lesson of every week 10:00-11:00, a
    lesson of the spring 11:00-11:30 and a lock of the spring 11:30-12:00:
    the spring has no half hour, the autumn has the whole window, and the
    line says which.
    """
    settings = _settings(5, "1")
    teacher = str(uuid4())
    year = _requirement(str(uuid4()), 1, teacher=teacher)
    spring = _requirement(str(uuid4()), 1, teacher=teacher, minutes=30, periods=SPRING)
    rule = {"id": str(uuid4()), "teacherId": teacher, "lunchMinutes": 30,
            "lunchStartTime": "11:00:00", "lunchEndTime": "12:00:00"}

    def problems(lock_mask: list[bool], spring_at: str) -> list[str]:
        payload = _payload(
            [year, spring], teacherWorkRules=[rule],
            fixedLessons=[_lock(str(uuid4()), 1, "11:30:00", "12:00:00", teacher, lock_mask)],
        )
        end = f"{spring_at[:3]}{int(spring_at[3:5]) + 30:02d}:00"
        return _validate(payload, [
            _laid(year, 1, "10:00:00", "11:00:00"), _laid(spring, 1, spring_at, end),
        ], settings)

    (line,) = problems(SPRING, "11:00:00")
    assert "no 30-minute lunch inside 11:00-12:00 on weekday 1" in line and "(period 1)" in line
    # The lock in the autumn instead: each term has a half hour.
    assert problems(AUTUMN, "11:00:00") == []
    # The spring's lesson earlier: the spring eats at 11:00.
    assert problems(SPRING, "09:00:00") == []
    # A day reserved for the teacher across the whole window owes no lunch.
    away = _payload(
        [year], teacherWorkRules=[rule],
        constraints=[_closed("TEACHER", teacher, 1, "11:00:00", "12:00:00")],
    )
    assert _validate(away, [_laid(year, 1, "10:00:00", "11:00:00")], settings) == []
    # And a lesson across the window, with nothing reserved, is a day without one.
    (line,) = _validate(
        _payload([year], teacherWorkRules=[rule]), [_laid(year, 1, "11:00:00", "12:00:00")], settings,
    )
    assert "no 30-minute lunch" in line and "period" not in line


def test_the_validator_holds_a_week_to_the_locked_weekdays_of_its_own_period() -> None:
    """The days of a post, read from `lockedWeekdayPeriods` as the request's words say it.

    A post of two days, a lock on the autumn's Mondays, the spring's lessons
    on Tuesday and Wednesday: two days in each term. Without the periods the
    Monday is every week's and the spring has three; and a lock that IS the
    spring's makes it three whatever is sent.
    """
    settings = _settings(4, "1,2,3")

    def problems(lock_mask: list[bool], held: list[dict[str, object]] | None) -> list[str]:
        payload = _part_timer(lock_mask, SPRING, held)
        first, second = payload["requirements"]  # type: ignore[misc]
        return _validate(payload, [
            _laid(first, 2, "08:00:00", "12:00:00"), _laid(second, 3, "08:00:00", "12:00:00"),
        ], settings)

    assert problems(AUTUMN, BY_TERM) == []
    (line,) = problems(AUTUMN, None)
    assert "teaching on 3 days a week" in line and "(period 1)" in line
    in_spring = [{"weekdays": [], "periods": AUTUMN}, {"weekdays": [1], "periods": SPRING}]
    (line,) = problems(SPRING, in_spring)
    assert "teaching on 3 days a week" in line and "(period 1)" in line


def test_a_lunch_start_for_each_period_is_built_and_is_in_the_size_estimate() -> None:
    """A teacher locked at another hour in each period has a break of each period's, every day.

    Three school days. One start a day and period, under the day's one
    literal; the estimate the size guard reads counts them, a day's worth for
    every week past the first. A year of odd and even weeks alone has the one
    break it had, and nothing is added for it.
    """
    teacher, group = str(uuid4()), str(uuid4())
    solver = SchedulerSolver(_settings(5, "1,2,3"))
    lunch = {"lunchMinutes": 30, "lunchStartTime": "11:00:00", "lunchEndTime": "13:00:00"}

    def request(with_lunch: bool, cuts: list[dict[str, object]]) -> OptimizeScheduleRequest:
        rule = {"id": str(uuid4()), "teacherId": teacher, "minDailyRestMinutes": 600,
                **(lunch if with_lunch else {})}
        return OptimizeScheduleRequest.model_validate(_payload(
            [_requirement(group, 2, teacher=teacher),
             *(_requirement(group, 1, teacher=teacher, **cut) for cut in cuts)],
            fixedLessons=[
                {**_lock(str(uuid4()), 1, "08:00:00", "09:00:00", teacher), **cut} for cut in cuts
            ],
            teacherWorkRules=[rule],
        ))

    def starts(built: OptimizeScheduleRequest) -> list[str]:
        model, *_ = solver._build_model(built, use_assumptions=False, include_objective=False)
        assert solver._estimate_model_size(built) >= len(model.Proto().variables)
        return sorted(
            variable.name for variable in model.Proto().variables
            if variable.name.startswith(f"teacherlunch_{teacher}_")
        )

    for count in (2, 3, 5):
        cuts = [{"periods": [p == q for q in range(count)]} for p in range(count)]
        lessons = {UUID(teacher): 2 + count, UUID(group): 2 + count}
        with_lunch, without = request(True, cuts), request(False, cuts)
        assert starts(with_lunch) == sorted(
            f"teacherlunch_{teacher}_{day}_p{period}" for day in range(3) for period in range(count)
        )
        assert (
            solver._week_vars(with_lunch, lessons, lessons) - solver._week_vars(without, lessons, lessons)
            == 3 * (count - 1)
        )
    # Odd and even weeks, no periods: the break it always was, by the name it always had.
    parities = [{"recurrence": "ODD_WEEKS"}, {"recurrence": "EVEN_WEEKS"}]
    lessons = {UUID(teacher): 4, UUID(group): 4}
    assert starts(request(True, parities)) == [f"teacherlunch_{teacher}_{day}" for day in range(3)]
    assert solver._week_vars(request(True, parities), lessons, lessons) == solver._week_vars(
        request(False, parities), lessons, lessons,
    )


# ---------------------------------------------------------------------------
# Planted timetables: nothing that exists is refused
# ---------------------------------------------------------------------------

DAYS = (1, 2, 3, 4, 5)
HOURS = ("08:00:00", "09:00:00", "10:00:00", "11:00:00", "12:00:00")


def _end(start: str) -> str:
    return f"{int(start[:2]) + 1:02d}:00:00"


def _planted(rng: random.Random) -> tuple[dict[str, object], dict[str, object], int]:
    """A part-timer's year laid out first, and then asked for.

    Two or three periods. In each the teacher works on at most N weekdays,
    and on every weekday has one of the two lunch hours (11 and 12) free; a
    few lessons run all year. Each lesson is its own class's, and that class
    is here at that hour and no other, so the planted week is the only
    timetable there is. Some lessons are then locked, the rest are asked for.

    The payload as the gateway sends it, the same with the days' periods left
    out (today's reading), and how many lessons the engine has to place.
    """
    count = rng.choice((2, 3))
    most = rng.randint(1, 3)
    teacher = str(uuid4())
    taken: dict[tuple[int | None, int, str], bool] = {}

    def free(period: int | None, day: int, hour: str) -> bool:
        held = range(count) if period is None else (period,)
        if any((other, day, hour) in taken or (None, day, hour) in taken for other in held):
            return False
        if hour in HOURS[3:]:
            # The other lunch hour stays free in every period this one runs in.
            other_hour = HOURS[4] if hour == HOURS[3] else HOURS[3]
            if any((p, day, other_hour) in taken or (None, day, other_hour) in taken for p in held):
                return False
        return True

    year_days = rng.sample(DAYS, rng.randint(0, min(most, 2)))
    plan: list[tuple[int | None, int, str]] = []
    for day in year_days:
        hour = rng.choice(HOURS)
        if free(None, day, hour):
            taken[(None, day, hour)] = True
            plan.append((None, day, hour))
    for period in range(count):
        own = rng.sample([day for day in DAYS if day not in year_days], most - len(year_days))
        for day in [*year_days, *own]:
            for hour in rng.sample(HOURS, rng.randint(0, 3)):
                if free(period, day, hour):
                    taken[(period, day, hour)] = True
                    plan.append((period, day, hour))

    requirements, locks, constraints = [], [], []
    for period, day, hour in plan:
        group = str(uuid4())
        mask = None if period is None else [index == period for index in range(count)]
        if rng.random() < 0.4:
            locks.append((period, day, _lock(group, day, hour, _end(hour), teacher, mask)))
            continue
        requirements.append(_requirement(group, 1, teacher=teacher, periods=mask))
        for other in DAYS:
            if other != day:
                constraints.append(_closed("STUDENT_GROUP", group, other, "08:00:00", "13:00:00"))
        if hour != HOURS[0]:
            constraints.append(_closed("STUDENT_GROUP", group, day, "08:00:00", hour))
        if hour != HOURS[-1]:
            constraints.append(_closed("STUDENT_GROUP", group, day, _end(hour), "13:00:00"))
    if not requirements:
        return _planted(rng)

    # What the gateway reads: each period's locked weekdays, a set left out
    # only inside a larger one of at most N of the same period — here one set
    # a period, so nothing is — and over the year, inside any.
    by_period = [
        sorted({day for held, day, _ in locks if held is None or held == period}) for period in range(count)
    ]
    distinct = [list(days) for days in dict.fromkeys(tuple(days) for days in by_period)]
    over_year = [
        days for days in distinct
        if not any(set(days) < set(other) and len(other) <= most for other in distinct)
    ]
    held = [
        {"weekdays": days, "periods": [by_period[period] == days for period in range(count)]}
        for days in sorted(distinct)
    ]
    limit = _limit(teacher, most, sorted(over_year), held if len(distinct) > 1 else None)
    payload = _payload(
        requirements,
        rooms=[{"id": str(uuid4()), "capacity": 30} for _ in range(4)],
        constraints=constraints,
        fixedLessons=[lock for _, _, lock in locks],
        teacherDayLimits=[limit],
        teacherWorkRules=[{"id": str(uuid4()), "teacherId": teacher, "lunchMinutes": 60,
                           "lunchStartTime": "11:00:00", "lunchEndTime": "13:00:00"}],
    )
    older = {**payload, "teacherDayLimits": [{k: v for k, v in limit.items() if k != "lockedWeekdayPeriods"}]}
    return payload, older, len(requirements)


def test_no_planted_year_is_refused_for_a_post_s_days_or_a_teachers_lunch() -> None:
    """Sixty years that have a timetable by construction: every one is laid, and laid as planted.

    Zero refusals is the claim. That the years are not easy ones is shown by
    the same years read as before: with the days' periods left out some are
    refused, and those are the ones the periods are for.
    """
    rng = random.Random(20261112)
    settings = _settings(5, "1,2,3,4,5")
    refused_before = 0
    by_period = 0
    for index in range(60):
        payload, older, lessons = _planted(rng)
        try:
            response = _solve(payload, settings)
        except InvalidScheduleInputError as refusal:  # pragma: no cover - the failure this test exists to show
            pytest.fail(f"planted year {index} refused before the model: {refusal.code} {refusal.params}")
        assert response.status in SOLVED, (index, response.status, _codes(response))
        assert len(response.lessons) == lessons
        assert _validate(payload, response.lessons, settings) == [], index
        if payload["teacherDayLimits"][0].get("lockedWeekdayPeriods") is None:  # type: ignore[index]
            continue
        by_period += 1
        try:
            if _solve(older, settings).status == "INFEASIBLE":
                refused_before += 1
        except InvalidScheduleInputError:
            refused_before += 1
    assert by_period >= 20
    assert refused_before >= 5
