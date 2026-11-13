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
from app.solver.weeks import (
    EVEN_WEEKS, ODD_WEEKS, PART_LIMIT, Weeks, named, says_exactly, together, whole_periods,
)

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


def test_a_teachers_lunch_refusal_names_every_period_it_is_refused_in() -> None:
    """A real year has more periods than terms, and the first is often a few days long.

    Four periods. The teacher has a lesson to place in the first three; two
    locks fill the window in the first two and in the last. The refusal is
    the first two periods', both of them — one run of weeks to the gateway —
    and not the first alone, nor the last, where the teacher has nothing to
    place and is owed no break.

    A lock outside the window is no part of the refusal (review of #302,
    LÅG-3): the second period's other hours that day are not what closes her
    lunch, and the school reads the same sentence for both periods.
    """
    teacher = str(uuid4())
    held = [True, True, False, True]
    payload = _payload(
        [_requirement(str(uuid4()), 2, teacher=teacher, periods=[True, True, True, False]),
         _requirement(str(uuid4()), 1, periods=[False, False, False, True])],
        teacherWorkRules=[{"id": str(uuid4()), "teacherId": teacher, "lunchMinutes": 30,
                           "lunchStartTime": "11:00:00", "lunchEndTime": "12:00:00"}],
        fixedLessons=[
            _lock(str(uuid4()), 1, "11:00:00", "11:30:00", teacher, held),
            _lock(str(uuid4()), 1, "11:30:00", "12:00:00", teacher, held),
        ],
    )
    refused = _refusal(payload)
    assert refused.code == "TEACHER_LUNCH_LEAVES_NO_START"
    assert (refused.params["period"], refused.params["periods"]) == (0, "0,1")
    # Another lock in the second period, outside the window: other locked
    # hours that day, and the same refusal: the window is closed by the same
    # two locks, so both periods are still said.
    payload["fixedLessons"].append(  # type: ignore[union-attr]
        _lock(str(uuid4()), 1, "08:00:00", "09:00:00", teacher, [False, True, False, False]))
    refused = _refusal(payload)
    assert (refused.params["period"], refused.params["periods"]) == (0, "0,1")


def _four_periods_lunch(
    locks: list[tuple[str, str, tuple[int, ...]]], lessons: tuple[list[bool], ...],
) -> InvalidScheduleInputError:
    """A teacher with a lunch of an hour in 11:00-12:00, her lessons in `lessons`, and locks `(start, end, periods)`."""
    teacher = str(uuid4())
    payload = _payload(
        [_requirement(str(uuid4()), 1, teacher=teacher, periods=mask) for mask in lessons],
        teacherWorkRules=[{"id": str(uuid4()), "teacherId": teacher, "lunchMinutes": 60,
                           "lunchStartTime": "11:00:00", "lunchEndTime": "12:00:00"}],
        fixedLessons=[
            _lock(str(uuid4()), 1, start, end, teacher, [index in held for index in range(4)] if len(held) < 4 else None)
            for start, end, held in locks
        ],
    )
    return _refusal(payload)


def _said_periods(refused: InvalidScheduleInputError) -> tuple[object, object]:
    assert refused.code == "TEACHER_LUNCH_LEAVES_NO_START"
    return refused.params["period"], refused.params.get("periods")


def test_other_locks_that_close_the_same_window_the_same_way_are_the_same_refusal() -> None:
    """Review of #302, LÅG-3: the periods said are those whose lunch is refused, whatever locks refuse it.

    An hour's lunch in an hour's window: any lock in it closes it. The
    autumn's lock is the first half hour and the spring's the second, and
    the teacher has lessons in all four periods. It is one refusal in four
    periods, which the school reads as one sentence; named by the locks the
    autumn's refusal came first and the spring's after it had been put right.
    """
    everywhere = ([True, True, False, False], [False, False, True, True])
    refused = _four_periods_lunch(
        [("11:00:00", "11:30:00", (0, 1)), ("11:30:00", "12:00:00", (2, 3))], everywhere,
    )
    assert _said_periods(refused) == (0, "0,1,2,3")
    # One period's lock is the whole window and another's a part of it.
    refused = _four_periods_lunch(
        [("11:00:00", "12:00:00", (1,)), ("11:00:00", "11:30:00", (3,))], everywhere,
    )
    assert _said_periods(refused) == (1, "1,3")


def test_a_lunch_refused_for_a_term_is_the_terms_in_both_parities_whichever_week_it_was_found_in() -> None:
    """The lunch says its own weeks: a term's, and no parity (_SAY_THEIR_OWN_WEEKS).

    The teacher's one lesson runs in the odd weeks of the autumn, so that is
    the week the refusal is found in. The break is one for the odd weeks and
    the even ones of a term and the locks that close it run in both: the
    refusal is the autumn's, as it is for a lesson of every week, and does
    not say "odd weeks".
    """
    teacher = str(uuid4())
    payload = _payload(
        [_requirement(str(uuid4()), 1, teacher=teacher, periods=AUTUMN, recurrence="ODD_WEEKS"),
         _requirement(str(uuid4()), 1, periods=SPRING)],
        teacherWorkRules=[{"id": str(uuid4()), "teacherId": teacher, "lunchMinutes": 60,
                           "lunchStartTime": "11:00:00", "lunchEndTime": "12:00:00"}],
        fixedLessons=[_lock(str(uuid4()), 1, "11:00:00", "11:30:00", teacher, AUTUMN),
                      _lock(str(uuid4()), 1, "11:30:00", "12:00:00", teacher, AUTUMN)],
    )
    refused = _refusal(payload)
    assert refused.code == "TEACHER_LUNCH_LEAVES_NO_START"
    assert refused.params["period"] == 0
    assert "parity" not in refused.params and "periods" not in refused.params


def _closed_for(teacher: str, start: str, end: str) -> dict[str, object]:
    return _closed("TEACHER", teacher, 1, start, end)


def test_a_day_the_school_has_closed_her_whole_lunch_window_owes_her_no_break() -> None:
    """A reservation over the whole window says the teacher is not here: nothing can leave her break too short.

    One lock of half an hour in the window and a reservation of the other half
    is the refusal (the cause says both); a reservation of the whole window
    refuses nothing, and the lock beside it takes nothing from a break she
    was never owed.
    """
    teacher = str(uuid4())
    window = {"lunchMinutes": 30, "lunchStartTime": "11:00:00", "lunchEndTime": "12:00:00"}
    lock = _lock(str(uuid4()), 1, "11:30:00", "12:00:00", teacher)
    base = {"teacherWorkRules": [{"id": str(uuid4()), "teacherId": teacher, **window}], "fixedLessons": [lock]}
    posts = [_requirement(str(uuid4()), 1, teacher=teacher)]
    settings = _settings(5, "1")
    request = OptimizeScheduleRequest.model_validate
    half = _payload(posts, **base, constraints=[_closed_for(teacher, "11:00:00", "11:30:00")])
    with pytest.raises(InvalidScheduleInputError) as refused:
        SchedulerSolver(settings)._validate_request(request(half))
    assert refused.value.code == "TEACHER_LUNCH_LEAVES_NO_START"
    assert refused.value.params["causes"] == "locked_closed"
    whole = _payload(posts, **base, constraints=[_closed_for(teacher, "11:00:00", "12:00:00")])
    SchedulerSolver(settings)._validate_request(request(whole))


def test_a_period_is_said_only_if_she_has_a_lesson_there_and_her_lunch_is_refused_there() -> None:
    """The two conditions a period needs to be named, and the one that is not enough alone."""
    first_half, second_half = ("11:00:00", "11:30:00"), ("11:30:00", "12:00:00")
    # Locked in the second, third and fourth, but no lesson in the third: the break is owed where she teaches.
    refused = _four_periods_lunch(
        [(*first_half, (1, 2, 3))],
        ([True, True, False, False], [False, False, False, True]),
    )
    assert _said_periods(refused) == (1, "1,3")
    # A lesson in all four, a lock in two of them: the others have a free lunch.
    refused = _four_periods_lunch(
        [(*second_half, (1, 2))], ([True, True, False, False], [False, False, True, True]),
    )
    assert _said_periods(refused) == (1, "1,2")


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
# A class's meal: still the year's, and the refusal says so
# ---------------------------------------------------------------------------

MEAL = {"lunchStartTime": "11:00:00", "lunchEndTime": "12:00:00", "lunchMinutes": 30}


def _class_meal(*locks: tuple[str, str, dict[str, object]], masks: int = 2) -> dict[str, object]:
    """7A eats 30 minutes in 11:00-12:00, and has locks in the window on Monday.

    Each lock is (start, end, when it runs). A post of the last period beside
    one of every week, so the year has `masks` periods whatever the locks say.
    """
    klass = str(uuid4())
    last = [index == masks - 1 for index in range(masks)]
    return _payload(
        [_requirement(klass, 2), _requirement(klass, 1, periods=last)],
        rules=MEAL,
        fixedLessons=[
            {**_lock(klass, 1, start, end, str(uuid4())), **when} for start, end, when in locks
        ],
    )


def _meal_refusal(payload: dict[str, object]) -> InvalidScheduleInputError:
    refused = _refusal(payload)
    assert refused.code == "LUNCH_LOCKED_LESSONS_LEAVE_NO_BREAK"
    return refused


FIRST_HALF, SECOND_HALF = ("11:00:00", "11:30:00"), ("11:30:00", "12:00:00")


def test_locks_of_two_terms_that_close_a_class_lunch_between_them_are_named_by_their_terms() -> None:
    """The meal is one hour all year, so it is still refused — and now says why.

    A lock 11:00-11:30 in the autumn and one 11:30-12:00 in the spring: each
    term has a half hour, and no Monday the school looks at is without one.
    The refusal is the year's (review of #300, M2), unchanged in its code and
    its values, with the periods whose locks close the window between them
    added as one flat value the gateway turns into dates: the periods of one
    lock with commas between them, the parts with semicolons.
    """
    every_year = _meal_refusal(_class_meal((*FIRST_HALF, {}), (*SECOND_HALF, {})))
    assert "lockPeriods" not in every_year.params

    between = _meal_refusal(_class_meal((*FIRST_HALF, {"periods": AUTUMN}), (*SECOND_HALF, {"periods": SPRING})))
    assert between.params["lockPeriods"] == "0;1"
    assert {key: value for key, value in between.params.items() if key not in ("lockPeriods", "group")} == {
        key: value for key, value in every_year.params.items() if key != "group"
    }
    assert "period" not in between.params and "periods" not in between.params
    # The order of the locks is not the order of the year.
    turned = _meal_refusal(_class_meal((*SECOND_HALF, {"periods": SPRING}), (*FIRST_HALF, {"periods": AUTUMN})))
    assert turned.params["lockPeriods"] == "0;1"
    # Three periods, the locks in the first and the last: the middle one is not named.
    apart = _meal_refusal(_class_meal(
        (*FIRST_HALF, {"periods": [True, False, False]}), (*SECOND_HALF, {"periods": [False, False, True]}),
        masks=3,
    ))
    assert apart.params["lockPeriods"] == "0;2"
    # A third period with a lock of its own in the window, which leaves that
    # period a gap: it takes a start too, and is named with the other two.
    three = _meal_refusal(_class_meal(
        (*FIRST_HALF, {"periods": [True, False, False]}),
        (*SECOND_HALF, {"periods": [False, True, False]}),
        ("11:00:00", "11:15:00", {"periods": [False, False, True]}),
        masks=3,
    ))
    assert three.params["lockPeriods"] == "0;1;2"


def test_the_periods_a_lock_runs_in_are_one_part_and_a_pair_that_closes_the_window_comes_first() -> None:
    """A real year has more periods than terms: every dated post of the school cuts it.

    Four periods, the autumn's lock in the first two and the spring's in the
    last two: two parts, not four periods of which the two earliest are both
    the autumn's (what a school of six periods was told on the first run
    against a real database: two stretches of the autumn and never the
    spring).
    """
    parts = _meal_refusal(_class_meal(
        (*FIRST_HALF, {"periods": [True, True, False, False]}),
        (*SECOND_HALF, {"periods": [False, False, True, True]}),
        masks=4,
    ))
    assert parts.params["lockPeriods"] == "0,1;2,3"
    # Periods that are not neighbours and hold the same lock are one part too.
    apart = _meal_refusal(_class_meal(
        (*FIRST_HALF, {"periods": [True, False, True, False]}),
        (*SECOND_HALF, {"periods": [False, True, False, True]}),
        masks=4,
    ))
    assert apart.params["lockPeriods"] == "0,2;1,3"
    # The first two parts are two that close the window between them. A lock
    # of a quarter of an hour in the first period and the first half hour in
    # the second leave 11:30; the quarter and the second half hour leave
    # nothing, and are named first, before the part between them.
    pair = _meal_refusal(_class_meal(
        ("11:00:00", "11:15:00", {"periods": [True, False, False]}),
        (*FIRST_HALF, {"periods": [False, True, False]}),
        (*SECOND_HALF, {"periods": [False, False, True]}),
        masks=3,
    ))
    assert pair.params["lockPeriods"] == "0;2;1"
    # Two pairs close it: the first half hour with either of two locks in the
    # second, the whole of it and its last quarter, which take different
    # starts. The earliest pair is the one named first, on every run.
    either = _meal_refusal(_class_meal(
        (*FIRST_HALF, {"periods": [True, False, False]}),
        (*SECOND_HALF, {"periods": [False, True, False]}),
        ("11:45:00", "12:00:00", {"periods": [False, False, True]}),
        masks=3,
    ))
    assert either.params["lockPeriods"] == "0;1;2"
    # A lock over the second half hour that runs on past the window takes the
    # starts the half hour's own lock takes, and is one part with it.
    past = _meal_refusal(_class_meal(
        (*FIRST_HALF, {"periods": [True, False, False]}),
        (*SECOND_HALF, {"periods": [False, True, False]}),
        ("11:30:00", "12:30:00", {"periods": [False, False, True]}),
        masks=3,
    ))
    assert past.params["lockPeriods"] == "0;1,2"
    # No two parts do it alone: three thirds of an hour and a lunch of twenty
    # minutes in a window of an hour. In the order of the year.
    thirds = _payload_of_thirds()
    assert _meal_refusal(thirds).params["lockPeriods"] == "0;1;2"


def test_periods_whose_locks_take_the_same_starts_are_one_part_however_the_locks_lie() -> None:
    """A part is the STARTS its locks take, not the locks (the review of #302, LÅG-1).

    The meal is an hour in 10:30-12:30 on Monday, so it starts 10:30-11:30.
    The first period is locked 12:00-13:00, which leaves the starts until
    11:00; the second 10:30-11:30, which leaves 11:30 alone. The third has
    the second's lock and one more inside it, 11:00-11:30, which takes no
    start the other did not: the second and the third are one part. Keyed by
    the locks they were two, "0;1;2", and a school was told of one stretch
    "among others" that is the same hour.
    """
    klass = str(uuid4())

    def refused(*third: tuple[str, str]) -> str:
        locks = [(0, "12:00:00", "13:00:00"), (1, "10:30:00", "11:30:00"), *((2, *lock) for lock in third)]
        payload = _payload(
            [_requirement(klass, 2), _requirement(klass, 1, periods=[False, False, True])],
            rules={"lunchStartTime": "10:30:00", "lunchEndTime": "12:30:00", "lunchMinutes": 60},
            fixedLessons=[
                {**_lock(klass, 1, start, end, str(uuid4())), "periods": [period == other for other in range(3)]}
                for period, start, end in locks
            ],
        )
        return str(_meal_refusal(payload).params["lockPeriods"])

    assert refused(("10:30:00", "11:30:00"), ("11:00:00", "11:30:00")) == "0;1,2"
    # In whichever order the two locks are sent,
    assert refused(("11:00:00", "11:30:00"), ("10:30:00", "11:30:00")) == "0;1,2"
    # and for one lock laid elsewhere that takes the same starts: from 10:00,
    # where the starts before 10:30 were never the window's.
    assert refused(("10:00:00", "11:30:00")) == "0;1,2"
    # A lock that leaves the third period a start the second has not is a
    # part of its own: until 11:15, the meal can start then.
    assert refused(("10:30:00", "11:15:00")) == "0;1;2"


def _payload_of_thirds() -> dict[str, object]:
    """A lunch of 20 minutes in 11:00-12:00 and a lock of 20 minutes in each of three periods."""
    payload = _class_meal(
        ("11:00:00", "11:20:00", {"periods": [True, False, False]}),
        ("11:20:00", "11:40:00", {"periods": [False, True, False]}),
        ("11:40:00", "12:00:00", {"periods": [False, False, True]}),
        masks=3,
    )
    payload["rules"] = {**MEAL, "lunchMinutes": 20}
    return payload


def test_locks_of_one_term_that_close_a_class_lunch_say_exactly_what_they_said() -> None:
    """One period's locks close the window alone: that term's own shortage, and the refusal as it always read."""
    every_year = _meal_refusal(_class_meal((*FIRST_HALF, {}), (*SECOND_HALF, {})))
    for first, second in (
        ({"periods": SPRING}, {"periods": SPRING}),
        ({"periods": AUTUMN}, {"periods": AUTUMN}),
        # One of every week and one of the spring: the spring has both.
        ({}, {"periods": SPRING}),
        ({"periods": AUTUMN}, {}),
        # The odd weeks' and the even weeks' of one term: the meal is one for the two.
        ({"periods": SPRING, "recurrence": "ODD_WEEKS"}, {"periods": SPRING, "recurrence": "EVEN_WEEKS"}),
    ):
        refused = _meal_refusal(_class_meal((*FIRST_HALF, first), (*SECOND_HALF, second)))
        assert refused.params.keys() == every_year.params.keys()
        assert {**refused.params, "group": ""} == {**every_year.params, "group": ""}


def test_a_year_of_odd_and_even_weeks_alone_is_told_what_it_always_was() -> None:
    """No periods, no new value: the bytes a school of A/B weeks gets are main's."""
    every_year = _meal_refusal(_class_meal((*FIRST_HALF, {}), (*SECOND_HALF, {})))
    klass = str(uuid4())
    payload = _payload(
        [_requirement(klass, 2)],
        rules=MEAL,
        fixedLessons=[
            {**_lock(klass, 1, *FIRST_HALF, str(uuid4())), "recurrence": "ODD_WEEKS"},
            {**_lock(klass, 1, *SECOND_HALF, str(uuid4())), "recurrence": "EVEN_WEEKS"},
        ],
    )
    refused = _meal_refusal(payload)
    assert refused.params.keys() == every_year.params.keys()


def test_a_term_is_read_in_both_its_parities_and_through_the_groups_that_share_its_pupils() -> None:
    """The meal is one for a term's odd weeks and its even ones, and a half class's lock is the class's hour."""
    # The spring's lock runs in its even weeks only: still the spring's.
    even = _meal_refusal(_class_meal(
        (*FIRST_HALF, {"periods": AUTUMN}), (*SECOND_HALF, {"periods": SPRING, "recurrence": "EVEN_WEEKS"}),
    ))
    assert even.params["lockPeriods"] == "0;1"
    # The spring's lock is 7A:1's, a group that shares pupils with 7A (groupConflicts).
    payload = _class_meal((*FIRST_HALF, {"periods": AUTUMN}), (*SECOND_HALF, {"periods": SPRING}))
    klass, half = payload["fixedLessons"][0]["studentGroupId"], str(uuid4())  # type: ignore[index]
    payload["fixedLessons"][1]["studentGroupId"] = half  # type: ignore[index]
    payload["groupConflicts"] = [[klass, half]]
    assert _meal_refusal(payload).params["lockPeriods"] == "0;1"


def test_the_terms_named_are_those_of_the_weekday_refused() -> None:
    """Tuesday's window is closed by a lock of each term; Monday has a lock of the autumn that closes nothing."""
    klass = str(uuid4())
    payload = _payload(
        [_requirement(klass, 2), _requirement(klass, 1, periods=SPRING)],
        rules=MEAL,
        fixedLessons=[
            {**_lock(klass, 1, "11:00:00", "11:15:00", str(uuid4())), "periods": AUTUMN},
            {**_lock(klass, 2, *FIRST_HALF, str(uuid4())), "periods": AUTUMN},
            {**_lock(klass, 2, *SECOND_HALF, str(uuid4())), "periods": SPRING},
        ],
    )
    with pytest.raises(InvalidScheduleInputError) as refused:
        SchedulerSolver(_settings(5, "1,2"))._validate_request(OptimizeScheduleRequest.model_validate(payload))
    assert refused.value.code == "LUNCH_LOCKED_LESSONS_LEAVE_NO_BREAK"
    assert (refused.value.params["day"], refused.value.params["lockPeriods"]) == (2, "0;1")


def test_a_lock_of_another_class_or_outside_the_window_names_no_term() -> None:
    """Only the locks that take a start of THIS class's window that day are read."""
    payload = _class_meal(
        (*FIRST_HALF, {"periods": AUTUMN}), (*SECOND_HALF, {"periods": SPRING}), masks=3,
    )
    payload["requirements"][1]["periods"] = [False, False, True]  # type: ignore[index]
    for lock in payload["fixedLessons"]:  # type: ignore[union-attr]
        lock["periods"] = [*lock["periods"], False]
    # In the third period: the class at 08:00, and another class in the window.
    klass = payload["fixedLessons"][0]["studentGroupId"]  # type: ignore[index]
    third = {"periods": [False, False, True]}
    payload["fixedLessons"] += [  # type: ignore[operator]
        {**_lock(klass, 1, "08:00:00", "09:00:00", str(uuid4())), **third},
        {**_lock(str(uuid4()), 1, "11:00:00", "12:00:00", str(uuid4())), **third},
        {**_lock(klass, 2, "11:00:00", "11:30:00", str(uuid4())), **third},
    ]
    assert _meal_refusal(payload).params["lockPeriods"] == "0;1"


def test_placed_posts_of_two_terms_in_a_class_lunch_window_are_named_with_their_terms() -> None:
    """Förlagda poster reach the engine as locks, and a school does place a post by term.

    test_placements' own school (08:00-14:00, lunch 30 minutes in 11:00-13:00,
    7A's idrott förlagd on Monday 11:00 and 12:00), with the first hour the
    autumn's post and the second the spring's. Each term has an hour for
    lunch; the meal is the year's, and the week is refused with each
    förläggning named and the lunch sentence beneath them — which carries the
    two terms.
    """
    import test_placements as placed

    case = placed.TestTheRefusalBeforeTheModel()
    payload = case._payload()
    autumn_post, spring_post = str(uuid4()), str(uuid4())
    first, second = payload["fixedLessons"]  # type: ignore[misc]
    first["periods"], second["periods"] = AUTUMN, SPRING
    payload["placements"] = {
        "lessons": [
            {"fixedLessonId": first["id"], "requirementId": autumn_post},
            {"fixedLessonId": second["id"], "requirementId": spring_post},
        ],
        "requirements": [
            placed._requirement(autumn_post, placed.ULF, 1, periods=AUTUMN),
            placed._requirement(spring_post, placed.ULF, 1, periods=SPRING),
        ],
    }
    response = SchedulerSolver(case._settings()).solve(OptimizeScheduleRequest.model_validate(payload))
    assert response.status == "INFEASIBLE" and response.conflicts is not None
    cause = response.conflicts.conflicts[-1]
    assert (cause.category, cause.code) == ("PLACEMENT", "LUNCH_LOCKED_LESSONS_LEAVE_NO_BREAK")
    assert cause.params["lockPeriods"] == "0;1"
    # And without `placements` it is the refusal itself, with the same value.
    with pytest.raises(InvalidScheduleInputError) as refused:
        SchedulerSolver(case._settings()).solve(OptimizeScheduleRequest.model_validate(
            {key: value for key, value in payload.items() if key != "placements"}))
    assert refused.value.params["lockPeriods"] == "0;1"


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


def test_the_validator_owes_the_whole_lunch_to_the_minute() -> None:
    """A gap of 25 minutes is no lunch of 30: the validator reads the rule's own figure, with no margin."""
    settings = _settings(5, "1")
    teacher = str(uuid4())
    year = _requirement(str(uuid4()), 1, teacher=teacher)
    rule = {"id": str(uuid4()), "teacherId": teacher, "lunchMinutes": 30,
            "lunchStartTime": "11:00:00", "lunchEndTime": "12:00:00"}

    def problems(locked_from: str) -> list[str]:
        payload = _payload(
            [year], teacherWorkRules=[rule],
            fixedLessons=[_lock(str(uuid4()), 1, locked_from, "12:00:00", teacher)],
        )
        return _validate(payload, [_laid(year, 1, "10:00:00", "11:00:00")], settings)

    (line,) = problems("11:25:00")
    assert "no 30-minute lunch inside 11:00-12:00 on weekday 1 (longest gap 25 minutes)" in line
    assert problems("11:30:00") == []


def test_the_validator_reads_a_years_own_sets_when_the_year_has_no_periods() -> None:
    """`lockedWeekdayPeriods` on a limit of a year that is not cut: the weeks are held to `lockedWeekdays`.

    The engine takes such a request (the masks are the only ones, and are
    their own cut), and reads the sets by period only where a week has one.
    A year of odd and even weeks is read week by week here, with no period
    to pick the sets of: the limit is the one sent, and its Monday is every
    week's. Tuesday and Wednesday beside it are three days on a post of two.
    """
    settings = _settings(4, "1,2,3")
    payload = _part_timer(None, None, BY_TERM)
    first, second = payload["requirements"]  # type: ignore[misc]
    first["recurrence"] = "ODD_WEEKS"
    lessons = [_laid(first, 2, "08:00:00", "12:00:00"), _laid(second, 3, "08:00:00", "12:00:00")]
    (line,) = _validate(payload, lessons, settings)
    # The odd weeks hold all three; the even weeks the lock and Wednesday.
    assert "teaching on 3 days a week" in line and line.endswith("(udda veckor)")


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


@pytest.mark.parametrize("row_limit", [None, 0])
def test_a_teacher_of_nine_periods_has_a_lunch_of_each_and_none_over_two_periods_locks(
    monkeypatch: pytest.MonkeyPatch, row_limit: int | None,
) -> None:
    """A teacher's breaks are never joined, however many periods the year has (the review of #302, MEDEL-1).

    A real läsår reaches nine periods: every dated post cuts it. Here the
    teacher has a lesson and a lock in each. The lock is 11-12 in every other
    period and 12-13 in the rest, and the lunch an hour in 11-13, so each
    period eats in the hour its lock leaves, and each period alone has a
    lunch. Past PART_LIMIT parts a soft row is joined into unions; a break
    over two periods' locks has no hour left, and joined the year was
    INFEASIBLE, TEACHER_LUNCH_HAS_NOWHERE_TO_GO, with a lunch in every week
    it has — past a pre-flight that reads each period on its own and found
    nothing.

    And whatever the size of the row: a large row is joined by its size
    alone when nothing is said (weeks.ROW_LIMIT), which is read here as
    nothing at all, so that leaving the word out is seen as well as turning
    it.
    """
    if row_limit is not None:
        monkeypatch.setattr(periods.weeks_module, "ROW_LIMIT", row_limit)
    count = PART_LIMIT + 1
    settings = _settings(7, "1")
    teacher = str(uuid4())
    rule = {"id": str(uuid4()), "teacherId": teacher, "lunchMinutes": 60,
            "lunchStartTime": "11:00:00", "lunchEndTime": "13:00:00"}

    def year(locked: list[tuple[int, str, str]]) -> dict[str, object]:
        def only(period: int) -> list[bool]:
            return [period == other for other in range(count)]

        return _payload(
            [_requirement(str(uuid4()), 1, teacher=teacher, periods=only(period)) for period in range(count)],
            teacherWorkRules=[rule],
            fixedLessons=[_lock(str(uuid4()), 1, start, end, teacher, only(period)) for period, start, end in locked],
        )

    locks = [
        (period, *(("11:00:00", "12:00:00") if period % 2 == 0 else ("12:00:00", "13:00:00")))
        for period in range(count)
    ]
    payload = year(locks)
    response = _solve(payload, settings)
    assert response.status == "OPTIMAL"
    assert _codes(response) == []
    assert len(response.lessons) == count
    # No lesson in the window: each period's free hour is its lunch.
    assert all(lesson.end_time <= "11:00:00" or lesson.start_time >= "13:00:00" for lesson in response.lessons)
    assert _validate(payload, response.lessons, settings) == []
    # The non-vacuous side: the last period given the other hour's lock too
    # has no lunch, and is refused as that period's.
    with pytest.raises(InvalidScheduleInputError) as refused:
        _solve(year([*locks, (count - 1, "12:00:00", "13:00:00")]), settings)
    assert refused.value.code == "TEACHER_LUNCH_LEAVES_NO_START"
    assert refused.value.params["period"] == count - 1


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


# ---------------------------------------------------------------------------
# A year with no post of every week (the second review of #300, LÅG-2, LÅG-3)
# ---------------------------------------------------------------------------

WEEK_WORDS = ("period", "periods", "parity")


def _refused(payload: dict[str, object], settings: Settings) -> tuple[str, dict[str, object]]:
    """What a year is refused with before the model, and what the refusal says of its week."""
    request = OptimizeScheduleRequest.model_validate(payload)
    try:
        response, *_ = SchedulerSolver(settings)._prechecks(request)
    except InvalidScheduleInputError as refusal:
        return refusal.code, {name: refusal.params[name] for name in WEEK_WORDS if name in refusal.params}
    assert response is not None and response.conflicts is not None
    said = {name: value for name, value in response.conflicts.summary_params.items() if name in WEEK_WORDS}
    # Every line says what the summary says, and no line something else.
    for line in response.conflicts.conflicts:
        assert {name: value for name, value in line.params.items() if name in WEEK_WORDS} == said
    return response.conflicts.summary_code, said


@pytest.mark.parametrize(("term", "other", "period"), [(AUTUMN, SPRING, 0), (SPRING, AUTUMN, 1)])
def test_a_year_dated_to_one_term_is_refused_for_that_term(
    term: list[bool], other: list[bool], period: int,
) -> None:
    """ONE WEEK WITH ANYTHING TO PLACE STILL SAYS WHICH (review of #300, round two, LÅG-3).

    Five posts of one teacher, an hour each on a day of four, every one dated
    to the same term. The other term has nothing to place, so the year has
    one week's request, and "every week refuses alike" was true of it for
    want of a second week: the refusal named no term, and the reader was not
    told which weeks had been counted. It is the term's: without its posts
    the teacher is over nothing.

    The same for a 400, a cap of an hour a day against two hours of the
    term, and the same again once the other term has a post of its own.
    """
    teacher = str(uuid4())
    settings = periods._settings()
    posts = [_requirement(str(uuid4()), 1, teacher=teacher, periods=term) for _ in range(5)]
    assert _refused(_payload(posts), settings) == ("DEMAND_TEACHER_HOURS_SHORT", {"period": period})
    beside = [*posts, _requirement(str(uuid4()), 1, periods=other)]
    assert _refused(_payload(beside), settings) == ("DEMAND_TEACHER_HOURS_SHORT", {"period": period})

    cap = [{"id": str(uuid4()), "teacherId": teacher, "maxTeachingMinutesPerDay": 60}]
    capped = [_requirement(str(uuid4()), 2, teacher=teacher, periods=term)]
    assert _refused(_payload(capped, teacherWorkRules=cap), settings) == (
        "TEACHER_DAILY_CAP_TOO_SMALL_FOR_WEEK", {"period": period},
    )
    assert _refused(
        _payload([*capped, _requirement(str(uuid4()), 1, periods=other)], teacherWorkRules=cap), settings,
    ) == ("TEACHER_DAILY_CAP_TOO_SMALL_FOR_WEEK", {"period": period})


def test_a_year_dated_to_two_of_three_periods_says_both() -> None:
    """The one week with posts lies in two periods of three, and the refusal says the two."""
    teacher = str(uuid4())
    two_of_three = [True, True, False]
    posts = [_requirement(str(uuid4()), 1, teacher=teacher, periods=two_of_three) for _ in range(5)]
    assert _refused(_payload(posts), periods._settings()) == (
        "DEMAND_TEACHER_HOURS_SHORT", {"period": 0, "periods": "0,1"},
    )


def test_a_refusal_that_reads_no_post_is_nobodys_term_in_a_year_dated_to_one() -> None:
    """The other half of LÅG-3: one week to count is no reason to name it.

    The dining hall seats 80 in one sitting and eight classes eat there, 160
    pupils. The hall is counted by the classes the school has (`groups`),
    whichever term their lessons are in, and it is as short with every post
    in the autumn as with every post all year: no period, and the same
    figures. Asked of the year without one post (_every_week_only), which
    refuses the same.
    """
    rules = {"lunchStartTime": "11:00:00", "lunchEndTime": "11:30:00", "lunchMinutes": 30, "diningSeats": 80}
    classes = [str(uuid4()) for _ in range(8)]
    settings = periods._settings(hours=5)

    def told(term: list[bool] | None):  # type: ignore[no-untyped-def]
        response, *_ = SchedulerSolver(settings)._prechecks(OptimizeScheduleRequest.model_validate(
            _payload([_requirement(group, 1, periods=term) for group in classes], rules=rules)))
        assert response is not None and response.conflicts is not None
        return response.conflicts

    all_year = told(None)
    assert all_year.summary_code == "LUNCH_HALL_CANNOT_FEED_THE_SCHOOL"
    for term in (AUTUMN, SPRING):
        dated = told(term)
        assert dated.summary_code == all_year.summary_code
        assert dated.summary_params == all_year.summary_params
        assert [line.params for line in dated.conflicts] == [line.params for line in all_year.conflicts]


def _posts_dated(payload: dict[str, object], deal: list[list[bool]]) -> dict[str, object]:
    """The same school with every post dated: each to the next of `deal` in turn."""
    dated = periods.copy.deepcopy(payload)
    for index, requirement in enumerate(dated["requirements"]):  # type: ignore[arg-type]
        requirement["periods"] = deal[index % len(deal)]
    return dated


def test_a_lunch_stage_refusal_that_reads_only_the_classes_names_no_period_when_every_post_is_dated() -> None:
    """A SOLVED REFUSAL IS ASKED OF THE YEAR WITHOUT A POST TOO (review of #300, round two, LÅG-2).

    test_optimize's register: two classes with lessons and twenty entered
    with their pupils and none, a hall of 115. The lunch stage refuses the
    hall, which cannot seat twenty-two classes in waves, and reads no lesson
    to say so. With a post of every week the refusal named no period; with
    every post dated — to the two terms in turn, or all to the autumn — no
    request held "what every week has", the question was not asked, and the
    refusal was the first week's. It is asked of the classes alone now.
    """
    settings = periods.test_optimize._settings()
    register = periods.test_optimize._the_register(idle_classes=20, pupils=24)
    plain = _refused(register, settings)
    assert plain == ("LUNCH_HALL_CANNOT_SEAT_CLASSES", {})
    assert _refused(_posts_dated(register, [AUTUMN, SPRING]), settings) == plain
    assert _refused(_posts_dated(register, [AUTUMN]), settings) == plain
    assert _refused(_posts_dated(register, [SPRING]), settings) == plain


def test_a_lunch_stage_refusal_the_dated_posts_make_is_their_terms() -> None:
    """And the other side: the same stage, refusing for what the posts pack, says their term.

    test_optimize's middle years, whose frames and 24 lessons a class leave
    the hall no waves: the classes alone are refused nothing. Every post in
    the spring, and the refusal is the spring's.
    """
    settings = periods.test_optimize._settings()
    packed = periods._hall_of_the_middle_years()
    assert _refused(packed, settings) == ("LUNCH_HALL_CANNOT_SEAT_CLASSES", {})
    assert _refused(_posts_dated(packed, [SPRING]), settings) == ("LUNCH_HALL_CANNOT_SEAT_CLASSES", {"period": 1})
    assert _refused(_posts_dated(packed, [AUTUMN]), settings) == ("LUNCH_HALL_CANNOT_SEAT_CLASSES", {"period": 0})


def test_a_400_the_locks_of_every_week_give_alone_is_nobodys_term_in_a_year_dated_to_one() -> None:
    """The same for a 400 (_is_every_weeks): asked of the year without the dated posts.

    A sports hall of 40 seats, shared, with a lesson of 45 pupils locked in
    it. The one post there is to place is the autumn's. A lock of every week
    is over the hall's seats in every week, post or no post: no period. The
    same lock dated to the autumn is the autumn's, and is not there once the
    autumn's entries are taken away.
    """
    placement = periods.test_placement
    gym = placement._gym(capacity=40)
    lock: dict[str, object] = {
        "id": str(uuid4()), "teacherId": str(uuid4()), "studentGroupId": placement.CLASS_7B,
        "roomId": gym["id"], "dayOfWeek": 1, "startTime": "08:00:00", "endTime": "09:00:00",
        "studentCount": 45,
    }
    post = {
        **placement._requirement(placement.IDROTT, placement.CLASS_7A, requiredRoomType="GYM", size=5),
        "periods": AUTUMN,
    }
    payload = placement._payload([post], rooms=[gym], fixedLessons=[lock], placementRules=placement._shared("HARD"))

    every_week = placement._refusal(payload)
    assert every_week is not None and every_week.code == "SHARED_ROOM_LOCK_OVER_CAPACITY"
    assert every_week.params == {"room": gym["id"], "pupils": 45, "capacity": 40}

    lock["periods"] = AUTUMN
    autumns = placement._refusal(payload)
    assert autumns is not None and autumns.code == "SHARED_ROOM_LOCK_OVER_CAPACITY"
    assert autumns.params == {"room": gym["id"], "pupils": 45, "capacity": 40, "period": 0}


def test_two_weeks_with_posts_are_named_when_a_third_period_has_none() -> None:
    """Two weeks that agree are the year's only when the weeks left out would agree too (review of #302, LÅG-2).

    Three periods. A teacher's five posts run in the first two, and another
    class has a post of the first alone, which makes the two different
    weeks; the third period has nothing, and is not asked. The two weeks
    refuse the teacher with the same posts and the same figures, and the
    third has no post of hers at all, so the refusal is the first two
    periods' and says them, as one week of posts does (form D of the
    review). It said none, and said "period 0, periods 0,1" for the same
    teacher with a post in the third period: named by how the posts were cut
    and not by where the trouble was.
    """
    teacher = str(uuid4())
    settings = periods._settings()
    first_two, first = [True, True, False], [True, False, False]
    beside = _requirement(str(uuid4()), 1, periods=first)
    posts = [_requirement(str(uuid4()), 1, teacher=teacher, periods=first_two) for _ in range(5)]
    both = {"period": 0, "periods": "0,1"}
    assert _refused(_payload([*posts, beside]), settings) == ("DEMAND_TEACHER_HOURS_SHORT", both)
    # The same with a post in the third period: no week is left out, and it is the same.
    third = _requirement(str(uuid4()), 1, periods=[False, False, True])
    assert _refused(_payload([*posts, beside, third]), settings) == ("DEMAND_TEACHER_HOURS_SHORT", both)

    cap = [{"id": str(uuid4()), "teacherId": teacher, "maxTeachingMinutesPerDay": 60}]
    capped = _requirement(str(uuid4()), 2, teacher=teacher, periods=first_two)
    assert _refused(_payload([capped, beside], teacherWorkRules=cap), settings) == (
        "TEACHER_DAILY_CAP_TOO_SMALL_FOR_WEEK", both,
    )
    assert _refused(_payload([capped, beside, third], teacherWorkRules=cap), settings) == (
        "TEACHER_DAILY_CAP_TOO_SMALL_FOR_WEEK", both,
    )


def test_every_week_asked_is_still_every_week_when_no_period_is_left_out() -> None:
    """The other side of it: two weeks that agree, and no period without a post, name none.

    A refusal every week of the year gives is nobody's term. Two periods, each
    with a post of its own beside the teacher's five posts of every week:
    both are asked, both refuse the same, and none is left out.
    """
    teacher = str(uuid4())
    posts = [_requirement(str(uuid4()), 1, teacher=teacher) for _ in range(5)]
    beside = [_requirement(str(uuid4()), 1, periods=AUTUMN), _requirement(str(uuid4()), 1, periods=SPRING)]
    assert _refused(_payload([*posts, *beside]), periods._settings()) == ("DEMAND_TEACHER_HOURS_SHORT", {})


def test_a_hall_every_asked_week_cannot_feed_is_the_years_though_a_period_has_no_post() -> None:
    """The year question: what a week left out would say is asked of the year without a post.

    Eight classes of twenty for a hall of 80 in one sitting, every post
    dated: the first four classes to the first period, the last four to the
    second, and the third period has none. The hall reads the classes the
    school has, and refuses the same in every week, the third included. The
    two weeks asked agree, a week is left out, and the year without a post
    refuses the same: the refusal is the year's and names no period.
    """
    classes = [str(uuid4()) for _ in range(8)]
    rules = {"lunchStartTime": "11:00:00", "lunchEndTime": "11:30:00", "lunchMinutes": 30, "diningSeats": 80}
    dated = [
        _requirement(group, 1, periods=[index < 4, index >= 4, False]) for index, group in enumerate(classes)
    ]
    code, said = _refused(_payload(dated, rules=rules), periods._settings(hours=5))
    assert (code, said) == ("LUNCH_HALL_CANNOT_FEED_THE_SCHOOL", {})


def test_a_refusal_the_year_without_a_post_gives_another_way_is_the_weeks() -> None:
    """The year question is asked of the SAME refusal: the year being refused is not enough.

    Two sports halls of 40 seats with a lesson of 45 pupils locked in each. The
    lock in the first hall runs every week and the lock in the second in the
    first two of three periods; the posts to place are of the first two. Every
    week asked refuses with the second hall's lock (it is read first), and the
    year without a post is refused too, but with the first hall's. The
    second hall's refusal is not the year's: it is the first two periods'.
    """
    placement = periods.test_placement
    first, second = placement._gym(capacity=40), placement._gym(capacity=40)

    def lock(hall: dict[str, object], mask: list[bool] | None) -> dict[str, object]:
        row: dict[str, object] = {
            "id": str(uuid4()), "teacherId": str(uuid4()), "studentGroupId": placement.CLASS_7B,
            "roomId": hall["id"], "dayOfWeek": 1, "startTime": "08:00:00", "endTime": "09:00:00",
            "studentCount": 45,
        }
        if mask is not None:
            row["periods"] = mask
        return row

    def post(mask: list[bool]) -> dict[str, object]:
        return {
            **placement._requirement(placement.IDROTT, placement.CLASS_7A, requiredRoomType="GYM", size=5),
            "periods": mask,
        }

    payload = placement._payload(
        [post([True, False, False]), post([False, True, False])],
        rooms=[second, first],
        fixedLessons=[lock(second, [True, True, False]), lock(first, None)],
        placementRules=placement._shared("HARD"),
    )
    refused = placement._refusal(payload)
    assert refused is not None and refused.code == "SHARED_ROOM_LOCK_OVER_CAPACITY"
    assert refused.params["room"] == second["id"]
    assert (refused.params["period"], refused.params["periods"]) == (0, "0,1")
    # Without the second lock the year without a post is refused the same way: nobody's term.
    payload["fixedLessons"] = [lock(first, None)]  # type: ignore[index]
    refused = placement._refusal(payload)
    assert refused is not None and refused.params["room"] == first["id"]
    assert "period" not in refused.params


# ---------------------------------------------------------------------------
# Every period a refusal is said the same in
# ---------------------------------------------------------------------------

#: The autumn of a läsår cut the way a real one is: the days before the first
#: Monday, the autumn itself and the weeks around the new year, and then the
#: spring. Four periods, and a term's posts run in the first three.
ALL_AUTUMN = [True, True, True, False]


def _cut_into_four() -> list[dict[str, object]]:
    """Posts of other teachers and classes that tell the four periods apart, an hour each."""
    return [
        _requirement(str(uuid4()), 1, periods=[False, True, True, True]),   # from the first Monday
        _requirement(str(uuid4()), 1, periods=[True, True, False, False]),  # until the holiday
        _requirement(str(uuid4()), 1, periods=[False, False, False, True]),  # the spring's own
    ]


def test_a_teacher_over_her_hours_all_autumn_is_told_every_period_of_the_autumn() -> None:
    """EVERY WEEK THAT SHARES A REFUSAL IS SAID, NOT THE FIRST.

    Five posts of one teacher, an hour each on a day of four, all autumn. The
    autumn is three periods here, as a real one is, and she is over her hours
    in each with the same posts and the same figures. Named by the first week
    the refusal said `period: 0` and the school read "the weeks from 15
    August to 16 August". It says all three, the first in `period`, and the
    gateway reads their stretches as one run of weeks.
    """
    teacher = str(uuid4())
    settings = periods._settings()
    posts = [_requirement(str(uuid4()), 1, teacher=teacher, periods=ALL_AUTUMN) for _ in range(5)]
    assert _refused(_payload([*posts, *_cut_into_four()]), settings) == (
        "DEMAND_TEACHER_HOURS_SHORT", {"period": 0, "periods": "0,1,2"},
    )
    # The odd and the even weeks of one term that share it are the term: no parity.
    in_autumn = [_requirement(str(uuid4()), 1, teacher=teacher, periods=AUTUMN) for _ in range(5)]
    apart = [
        _requirement(str(uuid4()), 1, periods=AUTUMN, recurrence="ODD_WEEKS"),
        _requirement(str(uuid4()), 1, periods=SPRING),
    ]
    assert _refused(_payload([*in_autumn, *apart]), settings) == ("DEMAND_TEACHER_HOURS_SHORT", {"period": 0})
    # A refusal one week has alone says what it always said.
    autumn_proper = [
        _requirement(str(uuid4()), 1, teacher=teacher, periods=[False, True, False, False]) for _ in range(5)
    ]
    assert _refused(_payload([*autumn_proper, *_cut_into_four()]), settings) == (
        "DEMAND_TEACHER_HOURS_SHORT", {"period": 1},
    )
    # And one more post of hers from the first Monday makes the autumn itself
    # another count, with other figures: the first week's refusal is shared
    # by the weeks around the new year and by no other.
    sixth = _requirement(str(uuid4()), 1, teacher=teacher, periods=[False, True, False, False])
    assert _refused(_payload([*posts, sixth, *_cut_into_four()]), settings) == (
        "DEMAND_TEACHER_HOURS_SHORT", {"period": 0, "periods": "0,2"},
    )


def test_a_400_some_weeks_share_says_each_of_them() -> None:
    """The same for a 400: a cap of an hour a day against two hours of every week of the autumn."""
    teacher = str(uuid4())
    cap = [{"id": str(uuid4()), "teacherId": teacher, "maxTeachingMinutesPerDay": 60}]
    capped = _requirement(str(uuid4()), 2, teacher=teacher, periods=ALL_AUTUMN)
    assert _refused(_payload([capped, *_cut_into_four()], teacherWorkRules=cap), periods._settings()) == (
        "TEACHER_DAILY_CAP_TOO_SMALL_FOR_WEEK", {"period": 0, "periods": "0,1,2"},
    )
    alone = _requirement(str(uuid4()), 2, teacher=teacher, periods=[False, False, True, False])
    assert _refused(_payload([alone, *_cut_into_four()], teacherWorkRules=cap), periods._settings()) == (
        "TEACHER_DAILY_CAP_TOO_SMALL_FOR_WEEK", {"period": 2},
    )


AUTUMN_PROPER = [False, True, False, False]


def test_the_refusal_said_is_the_one_most_of_the_year_gives() -> None:
    """THE FIRST WEEK THAT REFUSES IS NOT THE REFUSAL MOST OF THE YEAR GIVES (follow-up to #300–#302: the days before the first Monday).

    A läsår starts on a Saturday, so its first two days are a period of their
    own. The teacher's five posts run all autumn (the first three periods)
    and one more from the first Monday: she is over her hours in the first
    two days with five posts and in the autumn proper with six, and in the
    weeks around the new year with five again. The first week is the two
    days; said by it the school read the two days and the new year, and not
    the seventeen weeks of the autumn. The weeks decide (periodWeeks), and a
    year that sends none counts every period alike.
    """
    teacher = str(uuid4())
    settings = periods._settings()
    posts = [_requirement(str(uuid4()), 1, teacher=teacher, periods=ALL_AUTUMN) for _ in range(5)]
    sixth = _requirement(str(uuid4()), 1, teacher=teacher, periods=AUTUMN_PROPER)

    def refused(weeks: list[int] | None) -> tuple[str, dict[str, object]]:
        extra = {} if weeks is None else {"periodWeeks": weeks}
        return _refused(_payload([*posts, sixth, *_cut_into_four()], **extra), settings)

    code = "DEMAND_TEACHER_HOURS_SHORT"
    first, second = {"period": 0, "periods": "0,2"}, {"period": 1}
    # The two days, the autumn proper, the weeks around the new year, the spring.
    assert refused([1, 17, 3, 18]) == (code, second)
    # Three periods against one is not what decides it: a period weighs its weeks.
    assert refused([1, 3, 1, 18]) == (code, second)
    assert refused([10, 3, 4, 18]) == (code, first)
    # Equal, and the earliest: the first week of each is the two days and the autumn proper.
    assert refused([1, 2, 1, 18]) == (code, first)
    # A year that sends no weeks counts every period alike: two periods against one.
    assert refused(None) == (code, first)


def test_the_400_said_is_the_one_most_of_the_year_gives() -> None:
    """The same for a 400: a cap of an hour a day, and a post more from the first Monday."""
    teacher = str(uuid4())
    cap = [{"id": str(uuid4()), "teacherId": teacher, "maxTeachingMinutesPerDay": 60}]
    capped = _requirement(str(uuid4()), 2, teacher=teacher, periods=ALL_AUTUMN)
    more = _requirement(str(uuid4()), 1, teacher=teacher, periods=AUTUMN_PROPER)

    def refused(weeks: list[int] | None) -> tuple[str, dict[str, object]]:
        extra = {} if weeks is None else {"periodWeeks": weeks}
        payload = _payload([capped, more, *_cut_into_four()], teacherWorkRules=cap, **extra)
        return _refused(payload, periods._settings())

    code = "TEACHER_DAILY_CAP_TOO_SMALL_FOR_WEEK"
    assert refused([1, 17, 3, 18]) == (code, {"period": 1})
    assert refused([1, 3, 1, 18]) == (code, {"period": 1})
    assert refused([10, 3, 4, 18]) == (code, {"period": 0, "periods": "0,2"})
    assert refused([1, 2, 1, 18]) == (code, {"period": 0, "periods": "0,2"})
    assert refused(None) == (code, {"period": 0, "periods": "0,2"})
    # And what it says is that refusal's: the autumn proper's figure is the one in `weekMinutes`.
    with pytest.raises(InvalidScheduleInputError) as told:
        SchedulerSolver(periods._settings())._validate_request(OptimizeScheduleRequest.model_validate(
            _payload([capped, more, *_cut_into_four()], teacherWorkRules=cap, periodWeeks=[1, 17, 3, 18]),
        ))
    assert told.value.params["weekMinutes"] == 180


def test_one_rule_says_when_two_weeks_have_the_same_refusal_for_a_count_and_for_a_400() -> None:
    """Review of #300, LÅG-5: the school reads the same three things in either.

    A teacher over her hours in the autumn with five posts and in the spring
    with five other posts, to the same figures. As a count the refusal's
    lines name the posts, which are not the same posts, so each term has its
    own and the first is the autumn's. As a 400 (a cap too small for her
    week) it names no post, only the rule and the figures, which are the same
    in both: the year's, and no period. Not two meanings of "the same":
    one, and a refusal that names more has more to differ in.
    """
    teacher = str(uuid4())
    settings = periods._settings()
    five = [_requirement(str(uuid4()), 1, teacher=teacher, periods=AUTUMN) for _ in range(5)]
    five_more = [_requirement(str(uuid4()), 1, teacher=teacher, periods=SPRING) for _ in range(5)]
    assert _refused(_payload([*five, *five_more]), settings) == ("DEMAND_TEACHER_HOURS_SHORT", {"period": 0})

    cap = [{"id": str(uuid4()), "teacherId": teacher, "maxTeachingMinutesPerDay": 60}]
    autumns = _requirement(str(uuid4()), 2, teacher=teacher, periods=AUTUMN)
    springs = _requirement(str(uuid4()), 2, teacher=teacher, periods=SPRING)
    assert _refused(_payload([autumns, springs], teacherWorkRules=cap), settings) == (
        "TEACHER_DAILY_CAP_TOO_SMALL_FOR_WEEK", {},
    )
    # The same cap with another figure in the spring is two refusals, and the first is the autumn's.
    more = _requirement(str(uuid4()), 1, teacher=teacher, periods=SPRING)
    assert _refused(_payload([autumns, springs, more], teacherWorkRules=cap), settings) == (
        "TEACHER_DAILY_CAP_TOO_SMALL_FOR_WEEK", {"period": 0},
    )


def test_a_week_refused_by_two_counts_gives_the_first_in_the_order_of_the_counts() -> None:
    """Each week gives the first count that refuses it: the dining hall's, then the class hours, the teachers', the gaps'.

    Eight classes of twenty for a hall of 80 in one sitting, and one teacher
    on five of them for an hour each on a day of four hours: the hall is
    refused and so are her hours. The school is told about the hall, the more
    basic cause, with and without periods (a post of the spring cuts the year
    in two, and the hall is the same in both).
    """
    classes = [str(uuid4()) for _ in range(8)]
    teacher = str(uuid4())
    rules = {"lunchStartTime": "11:00:00", "lunchEndTime": "11:30:00", "lunchMinutes": 30, "diningSeats": 80}
    posts = [_requirement(group, 1, teacher=teacher if index < 5 else str(uuid4())) for index, group in enumerate(classes)]
    settings = periods._settings(hours=4)
    assert _refused(_payload(posts, rules=rules), settings) == ("LUNCH_HALL_CANNOT_FEED_THE_SCHOOL", {})
    spring = _requirement(str(uuid4()), 1, periods=SPRING)
    assert _refused(_payload([*posts, spring], rules=rules), settings) == ("LUNCH_HALL_CANNOT_FEED_THE_SCHOOL", {})
    # Without the hall's trouble it is the teacher's, so both are really refused.
    assert _refused(_payload(posts), settings)[0].startswith("DEMAND_")


def test_a_week_refused_by_an_earlier_count_first_still_gives_the_later_count_s_refusal() -> None:
    """The weeks said are those the refusal is true of, not only those it is the first refusal of.

    A teacher over her hours in every week, five posts of an hour on a day of
    four. A class of the spring has five lessons of its own, over its day: in
    the spring it is the class hours that refuse first, and the teacher's
    refusal comes behind it. The refusal said is the autumn's, the teacher's
    (the weeks tie and the autumn is the earliest), and it is as true of the
    spring: said of the autumn alone, the school would read that she has no
    trouble in the spring, and every week is hers.
    """
    teacher, klass = str(uuid4()), str(uuid4())
    posts = [_requirement(str(uuid4()), 1, teacher=teacher) for _ in range(5)]
    # Five posts of the class's own, one teacher each: the class is over its day, no teacher over hers.
    overfull = [_requirement(klass, 1, teacher=str(uuid4()), periods=SPRING) for _ in range(5)]
    settings = periods._settings()
    code, said = _refused(_payload([*posts, *overfull, _requirement(str(uuid4()), 1, periods=AUTUMN)]), settings)
    assert (code, said) == ("DEMAND_TEACHER_HOURS_SHORT", {})
    # Her trouble in the autumn alone is the autumn's, and the class's in the spring is another refusal.
    spring_posts = [_requirement(str(uuid4()), 1, teacher=teacher, periods=AUTUMN) for _ in range(5)]
    code, said = _refused(_payload([*spring_posts, *overfull, _requirement(str(uuid4()), 1, periods=AUTUMN)]), settings)
    assert (code, said) == ("DEMAND_TEACHER_HOURS_SHORT", {"period": 0})
    # Another teacher over her hours in the spring is another refusal, not hers: the spring refuses the
    # same count with another figure behind the class hours, and is not said.
    other = str(uuid4())
    others_posts = [_requirement(str(uuid4()), 1, teacher=other, periods=SPRING) for _ in range(5)]
    code, said = _refused(
        _payload([*spring_posts, *overfull, *others_posts, _requirement(str(uuid4()), 1, periods=AUTUMN)]), settings,
    )
    assert (code, said) == ("DEMAND_TEACHER_HOURS_SHORT", {"period": 0})


def test_a_year_without_periods_is_not_asked_of_its_other_weeks_for_a_refusal(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """A year with a parity and no periods names no week, so nothing is counted twice for it.

    Five lessons of the odd weeks and one of the even ones on a day of four
    hours: the odd weeks are refused. The refusal says no week whatever the
    even weeks say (weeks.named is empty), and it is said by the first week
    that refuses, as it always was: the even week is never counted.
    """
    seen: list[int] = []
    for name in ("_dining_hall_verdict", "_clique_hours_verdict", "_teacher_hours_verdict", "_lesson_gaps_verdict"):
        original = getattr(SchedulerSolver, name)

        def counted(self, week, _original=original):  # type: ignore[no-untyped-def]
            seen.append(week.requirements[0].lessons_per_week)
            return _original(self, week)

        monkeypatch.setattr(SchedulerSolver, name, counted)
    group = str(uuid4())
    payload = _payload([_requirement(group, 5, recurrence="ODD_WEEKS"), _requirement(group, 1, recurrence="EVEN_WEEKS")])
    code, said = _refused(payload, periods._settings())
    assert code.startswith("DEMAND") and said == {}
    assert set(seen) == {5}


def test_a_week_is_asked_as_itself_and_not_as_the_week_the_refusal_was_found_in() -> None:
    """Each week that may share a 400 is read with its own period's locks.

    The cap again, too small all autumn. Another teacher has a lunch of her
    own, a lesson in the autumn proper, and two locks that fill her lunch
    window in the days before the first Monday, where she has no lesson: she
    is refused nothing. Asked whether the autumn proper shares the cap's
    refusal, that week is read with its own locks. Read with the locks of
    the week the refusal was found in, her lunch would be refused there
    first, and the autumn proper would drop out of what the cap's refusal
    says.
    """
    teacher, other = str(uuid4()), str(uuid4())
    first_days, autumn_proper = [True, False, False, False], [False, True, False, False]
    rules = [
        {"id": str(uuid4()), "teacherId": teacher, "maxTeachingMinutesPerDay": 60},
        {"id": str(uuid4()), "teacherId": other, "lunchMinutes": 30,
         "lunchStartTime": "11:00:00", "lunchEndTime": "12:00:00"},
    ]
    payload = _payload(
        [_requirement(str(uuid4()), 2, teacher=teacher, periods=ALL_AUTUMN),
         _requirement(str(uuid4()), 1, teacher=other, periods=autumn_proper),
         *_cut_into_four()],
        teacherWorkRules=rules,
        fixedLessons=[
            periods._lock(str(uuid4()), "11:00:00", "11:30:00", teacher=other, periods=first_days),
            periods._lock(str(uuid4()), "11:30:00", "12:00:00", teacher=other, periods=first_days),
        ],
    )
    assert _refused(payload, periods._settings(hours=5)) == (
        "TEACHER_DAILY_CAP_TOO_SMALL_FOR_WEEK", {"period": 0, "periods": "0,1,2"},
    )


def test_weeks_the_words_cannot_say_exactly_leave_the_week_it_was_found_in() -> None:
    """ONLY WHEN THE WORDS SAY THOSE WEEKS AND NO OTHERS.

    Two terms, odd and even weeks. The teacher's five posts of every week
    put her over her hours all year, and a sixth in the even weeks of the
    spring makes that one week another count. A post of the autumn's odd
    weeks tells those apart, so the first refusal is shared by the odd weeks
    of the autumn, its even weeks and the odd weeks of the spring: three of
    the four, which "periods 0 and 1" would say as all four. The week it was
    found in is said alone, as before.
    """
    teacher = str(uuid4())
    posts = [_requirement(str(uuid4()), 1, teacher=teacher) for _ in range(5)]
    sixth = _requirement(str(uuid4()), 1, teacher=teacher, periods=SPRING, recurrence="EVEN_WEEKS")
    apart = _requirement(str(uuid4()), 1, periods=AUTUMN, recurrence="ODD_WEEKS")
    assert _refused(_payload([*posts, sixth, apart]), periods._settings()) == (
        "DEMAND_TEACHER_HOURS_SHORT", {"period": 0, "parity": "ODD_WEEKS"},
    )


def test_a_breach_the_weeks_of_the_autumn_have_alike_says_each_of_them() -> None:
    """Bästa möjliga schema, the same: a cap broken alike in every period of the autumn.

    test_periods' breach: 120 minutes of every week over a cap of 60. A lock
    of an hour all autumn takes the cap's whole hour there, so the lesson is
    120 over in each of the autumn's three periods and 60 over in the spring.
    The worst week was said alone, the first of the three; the line says the
    three.
    """
    line = periods._cap_breach(
        _cut_into_four(),
        locks=[periods._lock(str(uuid4()), "10:00:00", "11:00:00", periods=ALL_AUTUMN)],
    )
    assert line.params["over"] == 120
    assert {name: line.params[name] for name in WEEK_WORDS if name in line.params} == {
        "period": 0, "periods": "0,1,2",
    }
    # Broken by most in one period alone: that period, as before.
    line = periods._cap_breach(
        _cut_into_four(),
        locks=[periods._lock(str(uuid4()), "10:00:00", "11:00:00", periods=[False, False, True, False])],
    )
    assert {name: line.params[name] for name in WEEK_WORDS if name in line.params} == {"period": 2}
    # The odd and the even weeks of the autumn alike, each a week of its own:
    # the autumn, and the parity the worst week was found in is not said.
    line = periods._cap_breach(
        [_requirement(str(uuid4()), 1, periods=AUTUMN, recurrence="ODD_WEEKS"),
         _requirement(str(uuid4()), 1, periods=SPRING)],
        locks=[periods._lock(str(uuid4()), "10:00:00", "11:00:00", periods=AUTUMN)],
    )
    assert line.params["over"] == 120
    assert {name: line.params[name] for name in WEEK_WORDS if name in line.params} == {"period": 0}
    # The autumn and the odd weeks of the spring alike: no words say those
    # three weeks of four and no other, so the worst week is said alone.
    line = periods._cap_breach([], locks=[
        periods._lock(str(uuid4()), "10:00:00", "11:00:00", periods=AUTUMN),
        periods._lock(str(uuid4()), "10:00:00", "11:00:00", periods=SPRING, recurrence="ODD_WEEKS"),
    ])
    assert line.params["over"] == 120
    assert {name: line.params[name] for name in WEEK_WORDS if name in line.params} == {"period": 0}


def test_a_solved_refusal_says_the_week_it_was_found_in_and_no_other() -> None:
    """WHAT IS NOT SAID: a verdict that solves something names the one week it was found in.

    test_optimize's middle years, whose lunch stage refuses for what the
    posts pack, with every post all autumn and the autumn in three periods.
    The stage is a model, run on at most MAX_SOLVED_WEEKS weeks and stopped
    at the first that refuses; saying which other weeks share the verdict
    would be solving each of them. So the line under this refusal is the
    week it was found in — here the first of the three — and the handbook
    says that it may hold in more.
    """
    packed = _posts_dated(periods._hall_of_the_middle_years(), [ALL_AUTUMN])
    packed["requirements"].extend(_cut_into_four())  # type: ignore[union-attr]
    assert _refused(packed, periods.test_optimize._settings()) == (
        "LUNCH_HALL_CANNOT_SEAT_CLASSES", {"period": 0},
    )


@pytest.mark.parametrize(("bits", "count", "exactly"), [
    (0b0011, 2, True),      # the autumn, odd and even
    (0b0101, 2, True),      # the odd weeks of both terms
    (0b1010, 2, True),      # the even weeks of both
    (0b1111, 2, True),      # every week
    (0b0111, 2, False),     # the autumn and the spring's odd weeks
    (0b0110, 2, False),     # the autumn's even weeks and the spring's odd
    (0b110011, 3, True),    # the first and the third of three periods
    (0b010011, 3, False),   # the first whole and the third's odd weeks
    (0b01, 1, True),        # a year without periods: its odd weeks
])
def test_the_words_for_a_week_say_exactly_a_set_of_whole_periods_in_one_parity_or_both(
    bits: int, count: int, exactly: bool,
) -> None:
    assert says_exactly(Weeks(bits, count)) is exactly


def test_weeks_said_together_are_each_of_them_and_no_other() -> None:
    first, third = Weeks(0b000011, 3), Weeks(0b110000, 3)
    assert together([first, third]) == Weeks(0b110011, 3)
    assert named(together([first, third])) == {"period": 0, "periods": "0,2"}
    assert together([third]) == third
    # A parity of a year without periods beside a period: the parity is every period's.
    assert together([ODD_WEEKS, Weeks(0b0010, 2)]) == Weeks(0b0111, 2)
