"""Lärarens dag: a cap on a teacher's minutes a day, and on the days a week they teach.

Two hard rules on two rows, and one wish. The CAP is the work rule's — the row
every member of staff can read, named by the rule's id. The DAYS are the
post's, which is HR, named by the post's id and never in the same sentence as
the cap. The FREE-DAY WISH is the work rule's too, and the one soft field on
it: paid for in the full model's objective, refused never.

THE SCAFFOLDING IS test_teacher_work_time.py's, for its reasons. A short day —
08:00-12:00, four 60-minute lessons — makes every case arithmetic a reader can
do in their head, and the placements are PINNED wherever a verdict is about
the encoding: with three open days the solver spreads the lessons and every
rule here holds without being asked.

WHAT COUNTS IS src/common/teacher-day.ts's definition: every lesson the teacher
is on, lead or co-teacher, generated or locked, in its own minutes. The locked
ones are facts — what they already take is subtracted, and what they break on
their own is the hand edit's warning, never this engine's refusal.

THE DAYS ARE HELD WEEK BY WEEK, in the weeks the gateway reads off the locks
and sends as the post's lockedWeekdays (TestTheWeeks); a test that names none
gets the every-week reading of its own locks from _request.
"""

from __future__ import annotations

import json
import re
import sys
from pathlib import Path
from uuid import UUID, uuid4

import pytest
from ortools.sat.python import cp_model
from pydantic import ValidationError

from app.config import Settings
from app.exceptions import InvalidScheduleInputError
from app.messages import MESSAGES, arguments_of, render
from app.schemas.schedule import (
    AnonymousTeacherDayLimit,
    AnonymousTeacherWorkRule,
    OptimizeScheduleRequest,
    ScheduledLesson,
)
from app.solver.scheduler_solver import (
    SchedulerSolver,
    _day_reach,
    _lessons_by_teacher,
    _start_step,
    _teacher_locks,
)

#: 08:00-12:00 on Monday to Wednesday: four 60-minute lessons a day, three days.
SHORT_WEEK = {"SCHEDULE_DAYS": "1,2,3", "SCHEDULE_DAY_END_MINUTES": 720}
#: The same day on Monday to Friday.
FIVE_DAYS = {"SCHEDULE_DAYS": "1,2,3,4,5", "SCHEDULE_DAY_END_MINUTES": 720}
#: Everything but the wish priced at nothing, so the objective is the wish.
WISH_ONLY = {
    "WEIGHT_TEACHER_GAP": 0,
    "WEIGHT_SPREAD": 0,
    "WEIGHT_LUNCH_DRIFT": 0,
    "WEIGHT_DISRUPTION": 0,
}

TEACHER = str(uuid4())
CO_TEACHER = str(uuid4())
OTHER_TEACHER = str(uuid4())
GROUP = str(uuid4())
OTHER_GROUP = str(uuid4())
RULE = str(uuid4())
LIMIT = str(uuid4())
REQUIREMENT = str(uuid4())
OTHER_REQUIREMENT = str(uuid4())

MONDAY, TUESDAY, WEDNESDAY, THURSDAY, FRIDAY = range(5)

#: Every variable this feature names starts here, and nothing older does.
PREFIX = "ld"


def _settings(**overrides: object) -> Settings:
    return Settings(SOLVER_MAX_TIME_SECONDS=10.0, **{**SHORT_WEEK, **overrides})  # type: ignore[arg-type]


def _rule(**values: object) -> dict[str, object]:
    """TEACHER's work rule with every field empty but the ones named."""
    row: dict[str, object] = {"id": RULE, "teacherId": TEACHER}
    row.update(values)
    return row


def _limit(
    days: int, *, teacher: str = TEACHER, limit_id: str = LIMIT,
    weeks: list[list[int]] | None = None,
) -> dict[str, object]:
    """TEACHER's post. `weeks` is its lockedWeekdays; left out, _request reads
    them off the payload's locks as every-week ones."""
    row: dict[str, object] = {"id": limit_id, "teacherId": teacher, "maxTeachingDaysPerWeek": days}
    if weeks is not None:
        row["lockedWeekdays"] = weeks
    return row


def _locked(
    start: str, end: str, day_of_week: int = 1, *, teacher: str | None = TEACHER,
    co_teacher: str | None = None,
) -> dict[str, object]:
    """A lesson somebody placed by hand, for a class of nobody's in particular —
    its own group, so what it blocks is the teacher and nothing else."""
    return {
        "id": str(uuid4()),
        "teacherId": teacher,
        "coTeacherId": co_teacher,
        "studentGroupId": str(uuid4()),
        "dayOfWeek": day_of_week,
        "startTime": start,
        "endTime": end,
    }


def _payload(
    *,
    rules: list[dict[str, object]] | None = None,
    limits: list[dict[str, object]] | None = None,
    lessons_per_week: int = 4,
    minutes_per_lesson: int = 60,
    lesson_lengths: list[int] | None = None,
    teacher: str | None = TEACHER,
    co_teacher: str | None = None,
    fixed_lessons: list[dict[str, object]] | None = None,
    frames: list[dict[str, object]] | None = None,
    previous: list[dict[str, object]] | None = None,
    other: dict[str, object] | None = None,
) -> dict[str, object]:
    """One class, one subject, one room; another class only when asked for."""
    requirement: dict[str, object] = {
        "id": REQUIREMENT,
        "subjectId": str(uuid4()),
        "studentGroupId": GROUP,
        "teacherId": teacher,
        "coTeacherId": co_teacher,
        "lessonsPerWeek": lessons_per_week,
        "minutesPerLesson": minutes_per_lesson,
        "studentGroupSize": 24,
        "minGradeLevel": 7,
        "maxGradeLevel": 7,
    }
    if lesson_lengths is not None:
        requirement["lessonLengths"] = lesson_lengths
    requirements = [requirement]
    if other is not None:
        requirements.append({
            "id": OTHER_REQUIREMENT,
            "subjectId": str(uuid4()),
            "studentGroupId": OTHER_GROUP,
            "teacherId": OTHER_TEACHER,
            "lessonsPerWeek": 2,
            "minutesPerLesson": 60,
            "studentGroupSize": 24,
            **other,
        })
    payload: dict[str, object] = {
        "requestId": str(uuid4()),
        "academicYearId": str(uuid4()),
        "requirements": requirements,
        "rooms": [{"id": str(uuid4()), "capacity": 30}, {"id": str(uuid4()), "capacity": 30}],
        "fixedLessons": fixed_lessons or [],
        "frameTimes": frames or [],
        "previousLessons": previous or [],
        "teacherWorkRules": rules or [],
        "teacherDayLimits": limits or [],
    }
    return payload


def _request(payload: dict[str, object]) -> OptimizeScheduleRequest:
    """The payload as the engine reads it, a post's weeks filled in where the
    test left them out.

    THE GATEWAY'S READING OF EVERY-WEEK LOCKS: every lock this file builds
    runs every week, so the post's one week holds every weekday the
    teacher's locks are on — lead or co-teacher, ending after they start —
    and [[]] with none. Filled here and not in _limit, so a test that swaps
    the locks (`{**payload, "fixedLessons": []}`) swaps the week with them.
    A test about the weeks names them itself, and this leaves them alone.
    """
    limits = []
    for limit in payload.get("teacherDayLimits") or []:
        if "lockedWeekdays" not in limit:
            held = sorted({
                fixed["dayOfWeek"]
                for fixed in payload.get("fixedLessons") or []
                if limit["teacherId"] in (fixed.get("teacherId"), fixed.get("coTeacherId"))
                and fixed["endTime"] > fixed["startTime"]
            })
            limit = {**limit, "lockedWeekdays": [held]}
        limits.append(limit)
    if limits:
        payload = {**payload, "teacherDayLimits": limits}
    return OptimizeScheduleRequest.model_validate(payload)


def _build(
    payload: dict[str, object], *, objective: bool = False, assumptions: bool = False,
    **settings: object,
):
    solver = SchedulerSolver(_settings(**settings))
    return solver, solver._build_model(
        _request(payload), use_assumptions=assumptions, include_objective=objective,
    )


def _pin(solver, model, decisions, placements: list[tuple[int, str]]) -> None:
    slots_per_day = solver._grid.slots_per_day
    for decision, (day_index, hhmm) in zip(decisions, placements):
        slot = (int(hhmm[:2]) * 60 + int(hhmm[3:5]) - solver._grid.day_start_minutes) // (
            solver._grid.slot_minutes
        )
        model.Add(decision.start == day_index * slots_per_day + slot)


def _run(model: cp_model.CpModel, seconds: float = 10.0) -> tuple[cp_model.CpSolver, str]:
    """One worker under a fixed budget, so a verdict is the same on every machine."""
    cp = cp_model.CpSolver()
    cp.parameters.num_workers = 1
    cp.parameters.max_time_in_seconds = seconds
    code = cp.Solve(model)
    assert code != cp_model.MODEL_INVALID, model.Validate()
    return cp, cp.StatusName(code)


def _solve(
    payload: dict[str, object],
    placements: list[tuple[int, str]] | None = None,
    *,
    off: set[str] | None = None,
    **settings: object,
) -> str:
    """Build the satisfaction model, pin the lessons, solve once: FEASIBLE or INFEASIBLE.

    `off` lifts the literals of the codes named — every other literal pinned
    true — which is what a core can only suggest, asked directly: a rule posted
    under its literal is lifted with it, and one posted bare holds anyway.
    """
    solver, (model, registry, decisions, _plan, _lunches) = _build(
        payload, assumptions=off is not None, **settings,
    )
    if off is not None:
        model.ClearAssumptions()
        for record in registry._records:
            model.Add(record.literal == (0 if record.code in off else 1))
    _pin(solver, model, decisions, placements or [])
    _cp, status = _run(model)
    assert status in {"OPTIMAL", "FEASIBLE", "INFEASIBLE"}, status
    return "INFEASIBLE" if status == "INFEASIBLE" else "FEASIBLE"


def _shape(payload: dict[str, object], **settings: object) -> tuple[list[str], int]:
    """Every variable's name and the constraint count — the model, as a value."""
    _solver, (model, *_rest) = _build(payload, objective=True, **settings)
    proto = model.Proto()
    return [variable.name for variable in proto.variables], len(proto.constraints)


def _names(payload: dict[str, object], *, objective: bool = True, **settings: object) -> list[str]:
    _solver, (model, *_rest) = _build(payload, objective=objective, **settings)
    return [variable.name for variable in model.Proto().variables]


def _refusal(payload: dict[str, object], **settings: object) -> InvalidScheduleInputError | None:
    try:
        SchedulerSolver(_settings(**settings))._validate_request(_request(payload))
    except InvalidScheduleInputError as error:
        return error
    return None


def _conflicts(payload: dict[str, object], **settings: object):
    response = SchedulerSolver(_settings(**settings)).solve(_request(payload))
    assert response.status == "INFEASIBLE", response.status
    assert response.conflicts is not None
    return response.conflicts.conflicts


def _validate(
    payload: dict[str, object], lessons: list[ScheduledLesson], **settings: object,
) -> list[str]:
    benchmarks = Path(__file__).resolve().parents[1] / "benchmarks"
    if str(benchmarks) not in sys.path:
        sys.path.insert(0, str(benchmarks))
    from validate_schedule import validate

    grid = SchedulerSolver(_settings(**settings))._grid
    return validate(grid, _request(payload), lessons)


def _lesson(
    day_of_week: int, start: str = "08:00", end: str = "09:00", *,
    requirement: str = REQUIREMENT,
) -> ScheduledLesson:
    return ScheduledLesson.model_validate({
        "requirementId": requirement,
        "roomId": None,
        "dayOfWeek": day_of_week,
        "startTime": f"{start}:00",
        "endTime": f"{end}:00",
    })


def _every_set_of_weekdays() -> list[set[int]]:
    """All 128 sets of ISO weekdays, the empty one included."""
    return [
        {weekday for weekday in range(1, 8) if mask >> (weekday - 1) & 1}
        for mask in range(128)
    ]


class TestTheFields:
    """The contract's two new fields on the work rule, and the post's own row."""

    @pytest.mark.parametrize("value", [25, 725, 32, 0])
    def test_a_cap_outside_the_database_s_check_is_a_shape(self, value: int) -> None:
        # 30..720 and a multiple of five, as the database's CHECK says: the
        # grid is five minutes wide, and a cap it cannot compare a sum of
        # lesson lengths with exactly is a gateway that lost the CHECK.
        with pytest.raises(ValidationError):
            AnonymousTeacherWorkRule.model_validate(_rule(maxTeachingMinutesPerDay=value))

    @pytest.mark.parametrize("value", [30, 35, 720])
    def test_a_cap_inside_it_is_read(self, value: int) -> None:
        rule = AnonymousTeacherWorkRule.model_validate(_rule(maxTeachingMinutesPerDay=value))

        assert rule.max_teaching_minutes_per_day == value

    @pytest.mark.parametrize("value", [0, 8])
    def test_a_wish_is_an_iso_weekday(self, value: int) -> None:
        with pytest.raises(ValidationError):
            AnonymousTeacherWorkRule.model_validate(_rule(preferredFreeDay=value))

    def test_a_rule_with_only_a_cap_or_only_a_wish_is_a_rule(self) -> None:
        """No lunch and no rest is not an empty row when the cap or the wish is
        set: the gateway sends such a row, and refusing it would refuse every
        school that set a cap and nothing else."""
        capped = AnonymousTeacherWorkRule.model_validate(_rule(maxTeachingMinutesPerDay=300))
        wished = AnonymousTeacherWorkRule.model_validate(_rule(preferredFreeDay=5))

        assert capped.max_teaching_minutes_per_day == 300
        assert capped.preferred_free_day is None
        assert not capped.has_lunch
        assert wished.preferred_free_day == 5
        assert wished.max_teaching_minutes_per_day is None

    @pytest.mark.parametrize("days", [0, 7])
    def test_the_days_are_one_to_six(self, days: int) -> None:
        with pytest.raises(ValidationError):
            AnonymousTeacherDayLimit.model_validate(_limit(days, weeks=[[]]))

    @pytest.mark.parametrize("days", [1, 6])
    def test_one_and_six_are_limits(self, days: int) -> None:
        limit = AnonymousTeacherDayLimit.model_validate(_limit(days, weeks=[[]]))

        assert limit.max_teaching_days_per_week == days

    def test_the_weeks_are_required(self) -> None:
        """No default: every lock every week is the reading the field replaces,
        and a gateway that forgot the key would get it without a word."""
        with pytest.raises(ValidationError, match="lockedWeekdays"):
            AnonymousTeacherDayLimit.model_validate(_limit(2))

    @pytest.mark.parametrize("weeks", [[], [[0]], [[8]], [[1, 1]], [[]] * 129])
    def test_a_week_is_a_set_of_iso_weekdays_and_there_is_at_least_one(
        self, weeks: list[list[int]],
    ) -> None:
        # No week at all is not "no locks" — that is [[]] — and 129 is more
        # sets than seven weekdays have.
        with pytest.raises(ValidationError):
            AnonymousTeacherDayLimit.model_validate(_limit(2, weeks=weeks))

    def test_a_weekday_twice_in_one_week_is_named(self) -> None:
        with pytest.raises(ValidationError, match="weekday twice in one week"):
            AnonymousTeacherDayLimit.model_validate(_limit(2, weeks=[[3], [1, 2, 1]]))

    @pytest.mark.parametrize("weeks", [
        [[]], [[1, 2], [3, 4]], [[2, 1], [1, 2]], [[6, 7]],
        [sorted(week) for week in _every_set_of_weekdays()],
    ])
    def test_a_set_may_be_empty_repeated_or_a_weekend(self, weeks: list[list[int]]) -> None:
        limit = AnonymousTeacherDayLimit.model_validate(_limit(2, weeks=weeks))

        assert limit.locked_weekdays == weeks

    def test_absent_is_no_limit_and_no_rule_field(self) -> None:
        request = _request({**_payload(rules=[_rule()]), "teacherDayLimits": []})
        bare = _payload()
        del bare["teacherDayLimits"]

        assert _request(bare).teacher_day_limits == []
        assert request.teacher_work_rules[0].max_teaching_minutes_per_day is None
        assert request.teacher_work_rules[0].preferred_free_day is None

    def test_the_same_post_twice_is_a_gateway_that_joined_twice(self) -> None:
        with pytest.raises(ValidationError, match="ids must be unique"):
            _request(_payload(limits=[
                _limit(2), _limit(3, teacher=str(uuid4())),
            ]))

    def test_two_posts_for_one_teacher_is_one_too_many(self) -> None:
        # The database keeps one post per teacher and year, so a second is a
        # gateway bug; built as two it would hold the stricter and name both,
        # and the gateway masks per post.
        with pytest.raises(ValidationError, match="one teacher twice"):
            _request(_payload(limits=[_limit(2), _limit(3, limit_id=str(uuid4()))]))

    def test_two_posts_for_two_teachers_are_two_limits(self) -> None:
        request = _request(_payload(limits=[
            _limit(2), _limit(3, teacher=str(uuid4()), limit_id=str(uuid4())),
        ]))

        assert len(request.teacher_day_limits) == 2


class TestTheDailyCap:
    """Minutes a day, each lesson its own, the locked ones counted as facts."""

    def test_the_cap_holds_to_the_minute(self) -> None:
        capped = _payload(rules=[_rule(maxTeachingMinutesPerDay=120)])

        assert _solve(capped, [
            (MONDAY, "08:00"), (MONDAY, "09:00"), (TUESDAY, "08:00"), (WEDNESDAY, "08:00"),
        ]) == "FEASIBLE"
        assert _solve(capped, [
            (MONDAY, "08:00"), (MONDAY, "09:00"), (MONDAY, "10:00"), (TUESDAY, "08:00"),
        ]) == "INFEASIBLE"
        # The control: what refuses the second week is the cap.
        assert _solve(_payload(), [
            (MONDAY, "08:00"), (MONDAY, "09:00"), (MONDAY, "10:00"), (TUESDAY, "08:00"),
        ]) == "FEASIBLE"

    def test_each_lesson_counts_its_own_minutes(self) -> None:
        """80 + 40 is 120, which a cap of 120 holds and 115 does not. A cap
        counted in lessons, or in the requirement's longest, would read both
        weeks the same."""
        split = {"lessons_per_week": 2, "minutes_per_lesson": 80, "lesson_lengths": [80, 40]}
        both_monday = [(MONDAY, "08:00"), (MONDAY, "09:20")]

        assert _solve(
            _payload(rules=[_rule(maxTeachingMinutesPerDay=120)], **split), both_monday,
        ) == "FEASIBLE"
        assert _solve(
            _payload(rules=[_rule(maxTeachingMinutesPerDay=115)], **split), both_monday,
        ) == "INFEASIBLE"

    def test_a_co_taught_lesson_is_the_co_teacher_s_teaching_too(self) -> None:
        co_capped = _payload(
            rules=[_rule(teacherId=CO_TEACHER, maxTeachingMinutesPerDay=120)],
            co_teacher=CO_TEACHER,
        )

        assert _solve(co_capped, [
            (MONDAY, "08:00"), (MONDAY, "09:00"), (MONDAY, "10:00"), (TUESDAY, "08:00"),
        ]) == "INFEASIBLE"

    def test_a_locked_lesson_takes_its_minutes_from_the_day(self) -> None:
        locked = _payload(
            rules=[_rule(maxTeachingMinutesPerDay=120)],
            fixed_lessons=[_locked("11:00:00", "12:00:00")],
        )

        assert _solve(locked, [
            (MONDAY, "08:00"), (TUESDAY, "08:00"), (TUESDAY, "09:00"), (WEDNESDAY, "08:00"),
        ]) == "FEASIBLE"
        assert _solve(locked, [
            (MONDAY, "08:00"), (MONDAY, "09:00"), (TUESDAY, "08:00"), (WEDNESDAY, "08:00"),
        ]) == "INFEASIBLE"

    def test_the_lock_s_minutes_are_its_clock_and_not_the_grid_s(self) -> None:
        """07:00-09:00 on an 08:00 grid is two hours of teaching, one of them
        before the grid begins. The windows the solver keeps lessons out of are
        clipped to the day; the cap reads the clock, so Monday is full."""
        early = _payload(
            rules=[_rule(maxTeachingMinutesPerDay=120)],
            lessons_per_week=3,
            fixed_lessons=[_locked("07:00:00", "09:00:00")],
        )

        assert _solve(early, [
            (MONDAY, "09:00"), (TUESDAY, "08:00"), (WEDNESDAY, "08:00"),
        ]) == "INFEASIBLE"
        assert _solve(early, [
            (TUESDAY, "08:00"), (TUESDAY, "09:00"), (WEDNESDAY, "08:00"),
        ]) == "FEASIBLE"

    def test_a_co_taught_lock_takes_the_co_teacher_s_minutes(self) -> None:
        co_locked = _payload(
            rules=[_rule(teacherId=CO_TEACHER, maxTeachingMinutesPerDay=120)],
            lessons_per_week=2,
            teacher=OTHER_TEACHER,
            co_teacher=CO_TEACHER,
            fixed_lessons=[_locked("11:00:00", "12:00:00", teacher=None, co_teacher=CO_TEACHER)],
        )

        assert _solve(co_locked, [(MONDAY, "08:00"), (MONDAY, "09:00")]) == "INFEASIBLE"

    def test_locks_over_the_cap_on_their_own_are_not_refused(self) -> None:
        """Three locked hours under a two-hour cap are the school's own hand
        edit, warned about where it was made. The week is not refused for it;
        the solver merely puts nothing more on that Monday."""
        over = _payload(
            rules=[_rule(maxTeachingMinutesPerDay=120)],
            lessons_per_week=3,
            fixed_lessons=[_locked("08:00:00", "11:00:00")],
        )

        assert _refusal(over) is None
        assert _solve(over) == "FEASIBLE"
        assert _solve(over, [(MONDAY, "11:00")]) == "INFEASIBLE"

    def test_a_residual_of_nothing_is_still_under_the_literal(self) -> None:
        """A1: never cut a domain bare, a zero residual included. Lifted, the
        cap lets the lesson onto the full Monday; posted bare it would not, and
        a core could then prove the week impossible without the cap's name."""
        full = _payload(
            rules=[_rule(maxTeachingMinutesPerDay=120)],
            lessons_per_week=1,
            fixed_lessons=[_locked("08:00:00", "10:00:00")],
        )

        assert _solve(full, [(MONDAY, "10:00")], off=set()) == "INFEASIBLE"
        assert _solve(
            full, [(MONDAY, "10:00")], off={"TEACHER_DAILY_CAP_CANNOT_BE_KEPT"},
        ) == "FEASIBLE"

    def test_the_cap_hangs_on_its_literal(self) -> None:
        capped = _payload(rules=[_rule(maxTeachingMinutesPerDay=120)])
        three = [(MONDAY, "08:00"), (MONDAY, "09:00"), (MONDAY, "10:00"), (TUESDAY, "08:00")]

        assert _solve(capped, three, off=set()) == "INFEASIBLE"
        assert _solve(capped, three, off={"TEACHER_DAILY_CAP_CANNOT_BE_KEPT"}) == "FEASIBLE"

    def test_a_locked_day_s_row_is_times_its_works_and_never_a_constant(self) -> None:
        """The lock makes Monday a teaching day whatever the solver does, and
        the cap's row there is still `Σ minutes·x ≤ 60·works`, not `≤ 60`:
        the same bound, and the constant form is what CP-SAT's presolve threw
        on (the regression below)."""
        locked = _payload(
            rules=[_rule(maxTeachingMinutesPerDay=120)],
            fixed_lessons=[_locked("11:00:00", "12:00:00", 1)],
        )
        _solver, (model, *_rest) = _build(locked)
        proto = model.Proto()
        names = [variable.name for variable in proto.variables]
        works = names.index(f"ldworks_{TEACHER}_0")
        on_monday = {
            index for index, name in enumerate(names)
            if name.startswith(f"ldon_{REQUIREMENT}_") and name.endswith("_0")
        }

        rows = [
            dict(zip(constraint.linear.vars, constraint.linear.coeffs))
            for constraint in proto.constraints
            if constraint.has_linear() and constraint.enforcement_literal
            and on_monday & set(constraint.linear.vars)
        ]
        assert len(rows) == 1
        assert rows[0][works] == -60
        assert sorted(value for index, value in rows[0].items() if index != works) == [60] * 4

    def test_a_cap_on_the_days_the_locks_fill_is_refused_by_name_and_never_raises(self) -> None:
        """The cap's half of the presolve crash, found by the fuzz once the
        locked days' linking rows were gone: a cap of 180, a post of two days
        and locks on Monday and Saturday, so the solver's 340 minutes have
        those two days and their 90-minute residuals. The pre-flights count
        the cap on every day and the best two whole days, and let it through;
        the model refuses it, and the 500 it was is gone."""
        block = str(uuid4())
        shared = {
            "subjectId": str(uuid4()), "lessonsPerWeek": 3, "minutesPerLesson": 60,
            "lessonLengths": [60, 40, 40], "studentGroupSize": 20, "minGradeLevel": 7,
            "maxGradeLevel": 7, "minutesBefore": 10, "blockId": block,
        }
        payload = _payload(
            rules=[_rule(maxTeachingMinutesPerDay=180)],
            limits=[_limit(2)],
            fixed_lessons=[
                _locked("08:07:00", "09:37:00", 1), _locked("07:30:00", "09:00:00", 6),
            ],
        )
        payload["requirements"] = [
            {**shared, "id": REQUIREMENT, "studentGroupId": GROUP, "teacherId": TEACHER},
            {
                "id": OTHER_REQUIREMENT, "subjectId": str(uuid4()), "studentGroupId": OTHER_GROUP,
                "teacherId": TEACHER, "lessonsPerWeek": 4, "minutesPerLesson": 60,
                "lessonLengths": [60, 60, 40, 40], "studentGroupSize": 20,
                "minGradeLevel": 7, "maxGradeLevel": 7,
            },
            {**shared, "id": str(uuid4()), "studentGroupId": str(uuid4()), "teacherId": OTHER_TEACHER},
        ]
        payload["rooms"] = [{"id": str(uuid4()), "capacity": 30} for _ in range(3)]
        six_days = {"SCHEDULE_DAYS": "1,2,3,4,5,6", "SCHEDULE_DAY_END_MINUTES": 720}
        assert _refusal(payload, **six_days) is None

        response = SchedulerSolver(_settings(SOLVER_PROBE_SECONDS=0, **six_days)).solve(
            _request(payload),
        )

        assert response.status == "INFEASIBLE"
        if response.conflicts and response.conflicts.summary_code == "CONFLICT_CORE_SUMMARY":
            codes = {detail.code for detail in response.conflicts.conflicts}
            assert "TEACHER_DAILY_CAP_CANNOT_BE_KEPT" in codes
            assert "TEACHER_WORK_DAYS_CANNOT_BE_KEPT" in codes

    def test_the_rest_rule_s_day_is_read_and_not_rebuilt(self) -> None:
        """A3: where the rest rule built the teacher's day, its per-lesson
        literals and its `works` are the cap's — no second set beside them, and
        nothing written into the idle objective's cache."""
        both = _payload(rules=[_rule(maxTeachingMinutesPerDay=120, minDailyRestMinutes=660)])

        names = _names(both)
        assert not [name for name in names if name.startswith(("ldon_", "ldworks_"))]
        assert _solve(both, [
            (MONDAY, "08:00"), (MONDAY, "09:00"), (MONDAY, "10:00"), (TUESDAY, "08:00"),
        ]) == "INFEASIBLE"
        assert _solve(both, [
            (MONDAY, "08:00"), (MONDAY, "09:00"), (TUESDAY, "08:00"), (WEDNESDAY, "08:00"),
        ]) == "FEASIBLE"

    def test_the_rest_rule_s_literals_are_read_for_the_right_lesson(self) -> None:
        """Its literals are aligned with the teacher's lessons as the rest rule
        collected them; read off the wrong position, a split requirement's
        long lesson would be counted as its short one."""
        split = _payload(
            rules=[_rule(maxTeachingMinutesPerDay=100, minDailyRestMinutes=660)],
            lessons_per_week=2, minutes_per_lesson=80, lesson_lengths=[80, 40],
        )

        assert _solve(split, [(MONDAY, "08:00"), (TUESDAY, "08:00")]) == "FEASIBLE"
        assert _solve(split, [(MONDAY, "08:00"), (MONDAY, "09:20")]) == "INFEASIBLE"

    def test_one_literal_per_day_the_cap_can_bind_on(self) -> None:
        # Three days, and a cap that binds on each: the line names the day.
        _solver, (_model, registry, *_rest) = _build(
            _payload(rules=[_rule(maxTeachingMinutesPerDay=120)]),
        )
        records = [record for record in registry._records if record.code.startswith("TEACHER_")]

        assert [record.params["day"] for record in records] == [1, 2, 3]
        assert all(record.category == "TEACHER_OVERLAP" for record in records)

    def test_a_day_no_lesson_can_reach_has_no_cap_line(self) -> None:
        # Monday's frame is too short for an hour: nothing the solver places
        # can land there, and a line about Monday would name a day it has no
        # say over.
        closed_monday = _payload(
            rules=[_rule(maxTeachingMinutesPerDay=60)],
            lessons_per_week=2,
            frames=[{
                "minGradeLevel": 7, "maxGradeLevel": 7, "dayOfWeek": 1,
                "startTime": "08:00:00", "endTime": "08:30:00",
            }],
        )
        _solver, (_model, registry, *_rest) = _build(closed_monday)

        assert [
            record.params["day"] for record in registry._records
            if record.code == "TEACHER_DAILY_CAP_CANNOT_BE_KEPT"
        ] == [2, 3]


class TestTheDaysLimit:
    """At most N days a week; a week's locked days are teaching days already."""

    def test_the_limit_holds_to_the_day(self) -> None:
        two = _payload(limits=[_limit(2)])

        assert _solve(two, [
            (MONDAY, "08:00"), (MONDAY, "09:00"), (TUESDAY, "08:00"), (TUESDAY, "09:00"),
        ]) == "FEASIBLE"
        assert _solve(two, [
            (MONDAY, "08:00"), (MONDAY, "09:00"), (TUESDAY, "08:00"), (WEDNESDAY, "08:00"),
        ]) == "INFEASIBLE"

    def test_a_locked_weekday_is_one_of_the_days(self) -> None:
        locked = _payload(limits=[_limit(2)], fixed_lessons=[_locked("11:00:00", "12:00:00", 3)])

        assert _solve(locked, [
            (MONDAY, "08:00"), (MONDAY, "09:00"), (WEDNESDAY, "08:00"), (WEDNESDAY, "09:00"),
        ]) == "FEASIBLE"
        assert _solve(locked, [
            (MONDAY, "08:00"), (MONDAY, "09:00"), (TUESDAY, "08:00"), (TUESDAY, "09:00"),
        ]) == "INFEASIBLE"

    def test_a_lock_on_a_day_the_grid_does_not_teach_counts(self) -> None:
        """A Saturday lesson is a teaching day on any reading of the post,
        whether or not this grid has a Saturday: with a limit of one, it is the
        day, and nothing the solver places fits beside it."""
        saturday = _payload(
            limits=[_limit(1)], lessons_per_week=1, fixed_lessons=[_locked("09:00:00", "10:00:00", 6)],
        )

        assert _solve(saturday) == "INFEASIBLE"
        assert _solve({**saturday, "teacherDayLimits": [_limit(2)]}) == "FEASIBLE"

    def test_locks_over_the_limit_on_their_own_are_not_refused(self) -> None:
        over = _payload(
            limits=[_limit(1)],
            lessons_per_week=2,
            fixed_lessons=[_locked("11:00:00", "12:00:00", 1), _locked("11:00:00", "12:00:00", 2)],
        )

        assert _refusal(over) is None
        assert _solve(over, [(MONDAY, "08:00"), (TUESDAY, "08:00")]) == "FEASIBLE"
        assert _solve(over, [(MONDAY, "08:00"), (WEDNESDAY, "08:00")]) == "INFEASIBLE"

    def test_a_co_taught_lesson_is_a_day_for_the_co_teacher(self) -> None:
        co_limited = _payload(limits=[_limit(1, teacher=CO_TEACHER)], co_teacher=CO_TEACHER)

        assert _solve(co_limited, [
            (MONDAY, "08:00"), (MONDAY, "09:00"), (MONDAY, "10:00"), (TUESDAY, "08:00"),
        ]) == "INFEASIBLE"

    def test_the_limit_hangs_on_its_literal(self) -> None:
        two = _payload(limits=[_limit(2)])
        three_days = [(MONDAY, "08:00"), (MONDAY, "09:00"), (TUESDAY, "08:00"), (WEDNESDAY, "08:00")]

        assert _solve(two, three_days, off={"TEACHER_WORK_DAYS_CANNOT_BE_KEPT"}) == "FEASIBLE"

    def test_one_literal_for_the_week(self) -> None:
        _solver, (_model, registry, *_rest) = _build(_payload(limits=[_limit(2)]))
        records = [record for record in registry._records if record.code.startswith("TEACHER_")]

        assert [(record.code, record.params) for record in records] == [
            ("TEACHER_WORK_DAYS_CANNOT_BE_KEPT", {"limit": LIMIT, "days": 2}),
        ]


def _hour_locked_on(*weekdays: int) -> list[dict[str, object]]:
    """TEACHER locked 11:00-12:00 on each weekday named: three hours of room left there."""
    return [_locked("11:00:00", "12:00:00", weekday) for weekday in weekdays]


def _days_rows(payload: dict[str, object], **settings: object) -> list[tuple[list[str], int]]:
    """The rows TEACHER's days literal holds: (the `works` they count, the bound)."""
    _solver, (model, *_rest) = _build(payload, **settings)
    proto = model.Proto()
    names = [variable.name for variable in proto.variables]
    if f"lddays_{TEACHER}" not in names:
        return []
    literal = names.index(f"lddays_{TEACHER}")
    return [
        (sorted(names[var] for var in constraint.linear.vars), list(constraint.linear.domain)[-1])
        for constraint in proto.constraints
        if constraint.has_linear() and list(constraint.enforcement_literal) == [literal]
    ]


class TestTheWeeks:
    """The days are held in every real week the locks make, never against all their weekdays at once.

    The engine has no weeks. The gateway reads them and sends, per post, the
    sets of weekdays the teacher's locks hold together in one
    (lockedWeekdays); a generated lesson runs every week, so it adds its
    weekday to every week whose locks are not already on it. Locked an hour
    from 11:00 on the days named, so each such day has three hours left.
    """

    @pytest.mark.parametrize(
        "weeks", [[[1, 2], [3, 4]], [[1, 2], [4, 5]]], ids=["odd-and-even", "autumn-and-spring"],
    )
    def test_a_post_of_two_the_weeks_fill_leaves_a_weekly_lesson_nowhere(
        self, weeks: list[list[int]],
    ) -> None:
        """The review's case. Monday and Tuesday in odd weeks, Wednesday and
        Thursday in even ones (or Monday and Tuesday in the autumn, Thursday
        and Friday in the spring): two days in every week, on a post of two.
        A weekly lesson adds its weekday to every week that does not have it,
        and every weekday is one some week does not have — so it goes nowhere,
        and the post is named. The union of the weekdays once read this as
        four locked days over a post of two, closed the one day left, and put
        the lesson on a locked weekday: three days in every other week."""
        payload = _payload(
            limits=[_limit(2, weeks=weeks)], lessons_per_week=1,
            fixed_lessons=_hour_locked_on(*sorted({day for week in weeks for day in week})),
        )
        assert _refusal(payload, **FIVE_DAYS) is None

        for day_index in (MONDAY, TUESDAY, WEDNESDAY, THURSDAY, FRIDAY):
            assert _solve(payload, [(day_index, "08:00")], **FIVE_DAYS) == "INFEASIBLE"
        response = SchedulerSolver(_settings(SOLVER_PROBE_SECONDS=0, **FIVE_DAYS)).solve(
            _request(payload),
        )
        assert response.status == "INFEASIBLE"
        # Named whenever the explaining solve finished, as above.
        if response.conflicts and response.conflicts.summary_code == "CONFLICT_CORE_SUMMARY":
            codes = [detail.code for detail in response.conflicts.conflicts]
            assert "TEACHER_WORK_DAYS_CANNOT_BE_KEPT" in codes
        # Every lock in every week is a week over the post by hand, and a
        # lesson on one of its own weekdays adds nothing to it.
        every_week = [sorted({day for week in weeks for day in week})]
        union = {**payload, "teacherDayLimits": [_limit(2, weeks=every_week)]}
        assert _solve(union, [(MONDAY, "08:00")], **FIVE_DAYS) == "FEASIBLE"

    def test_on_a_post_of_three_a_lesson_goes_where_every_week_keeps_three(self) -> None:
        """Odd weeks Monday and Tuesday, even weeks Wednesday and Thursday, on a
        post of three: each week has one day to give. A Monday lesson is the
        even weeks' third day and a Wednesday one the odd weeks', so the pair
        fits; Monday and Tuesday are both new to the even weeks, and Friday is
        new to both — so beside another day it is a fourth somewhere, and on
        its own it is everyone's third."""
        weeks = [[1, 2], [3, 4]]
        payload = _payload(
            limits=[_limit(3, weeks=weeks)], lessons_per_week=2,
            fixed_lessons=_hour_locked_on(1, 2, 3, 4),
        )

        assert _solve(payload, [(MONDAY, "08:00"), (WEDNESDAY, "08:00")], **FIVE_DAYS) == "FEASIBLE"
        assert _solve(payload, [(TUESDAY, "08:00"), (THURSDAY, "08:00")], **FIVE_DAYS) == "FEASIBLE"
        assert _solve(payload, [(FRIDAY, "08:00"), (FRIDAY, "09:00")], **FIVE_DAYS) == "FEASIBLE"
        assert _solve(payload, [(MONDAY, "08:00"), (TUESDAY, "08:00")], **FIVE_DAYS) == "INFEASIBLE"
        assert _solve(payload, [(WEDNESDAY, "08:00"), (THURSDAY, "08:00")], **FIVE_DAYS) == (
            "INFEASIBLE"
        )
        assert _solve(payload, [(MONDAY, "08:00"), (FRIDAY, "08:00")], **FIVE_DAYS) == "INFEASIBLE"

        response = SchedulerSolver(_settings(**FIVE_DAYS)).solve(_request(payload))
        assert response.status in {"OPTIMAL", "FEASIBLE"}
        assert _validate(payload, response.lessons, **FIVE_DAYS) == []
        placed = {lesson.day_of_week for lesson in response.lessons}
        assert all(len(placed | set(week)) <= 3 for week in weeks)

    def test_a_weekly_lesson_on_thursday_is_the_autumn_s_third_day(self) -> None:
        """The dated case: Monday and Tuesday until Christmas, Thursday and
        Friday after it, on a post of three. Thursday is the autumn's third
        day and Monday the spring's, so the two fit; Thursday and Friday are
        both the autumn's — four days there, though each is a locked weekday
        of the spring."""
        payload = _payload(
            limits=[_limit(3, weeks=[[1, 2], [4, 5]])], lessons_per_week=2,
            fixed_lessons=_hour_locked_on(1, 2, 4, 5),
        )

        assert _solve(payload, [(MONDAY, "08:00"), (THURSDAY, "08:00")], **FIVE_DAYS) == "FEASIBLE"
        assert _solve(payload, [(WEDNESDAY, "08:00"), (WEDNESDAY, "09:00")], **FIVE_DAYS) == (
            "FEASIBLE"
        )
        assert _solve(payload, [(THURSDAY, "08:00"), (FRIDAY, "08:00")], **FIVE_DAYS) == (
            "INFEASIBLE"
        )

    def test_one_set_is_the_model_every_week_locks_always_built(self) -> None:
        """A teacher locked the same every week sends one set, and its one row
        is the one the union of the weekdays built: the days off Monday and
        Tuesday, against what the two leave of three — the same model, proto
        for proto, as the union reading built over 600 payloads with
        every-week locks. Its subsets, the empty week, a repeat and another
        order are weeks the one set already holds, and build nothing more."""
        locked = _payload(fixed_lessons=_hour_locked_on(1, 2))

        def payload(weeks: list[list[int]]) -> dict[str, object]:
            return {**locked, "teacherDayLimits": [_limit(3, weeks=weeks)]}

        every_week = _shape(payload([[1, 2]]), **FIVE_DAYS)
        assert _shape({**locked, "teacherDayLimits": [_limit(3)]}, **FIVE_DAYS) == every_week
        for weeks in ([[2, 1]], [[1, 2], [1, 2]], [[1], [1, 2], [], [2]]):
            assert _shape(payload(weeks), **FIVE_DAYS) == every_week, weeks
        assert _days_rows(payload([[1], [1, 2], [], [2]]), **FIVE_DAYS) == [
            ([f"ldworks_{TEACHER}_{day}" for day in (WEDNESDAY, THURSDAY, FRIDAY)], 1),
        ]
        # The edge of "at most N": a set of exactly N days still holds the
        # sets inside it.
        exactly = {**locked, "teacherDayLimits": [_limit(2, weeks=[[1, 2]])]}
        inside = {**locked, "teacherDayLimits": [_limit(2, weeks=[[1], [1, 2]])]}
        assert _shape(inside, **FIVE_DAYS) == _shape(exactly, **FIVE_DAYS)

    def test_a_week_inside_one_the_locks_put_over_the_post_is_a_week_of_its_own(self) -> None:
        """The proof's edge. Monday to Wednesday locked in one week is over a
        post of two by hand; Monday alone in another is not. The first says
        the solver adds no day to it, which still lets a lesson on Tuesday and
        one on Wednesday through — and both are new to the Monday week: three
        days, one of them the generator's. So that week is a row of its own,
        and only the larger set would let the pair through."""
        payload = _payload(
            limits=[_limit(2, weeks=[[1, 2, 3], [1]])], lessons_per_week=2,
            fixed_lessons=_hour_locked_on(1, 2, 3),
        )
        tuesday_and_wednesday = [(TUESDAY, "08:00"), (WEDNESDAY, "08:00")]

        assert _solve(payload, tuesday_and_wednesday, **FIVE_DAYS) == "INFEASIBLE"
        assert _solve(payload, [(MONDAY, "08:00"), (TUESDAY, "08:00")], **FIVE_DAYS) == "FEASIBLE"
        assert _days_rows(payload, **FIVE_DAYS) == [
            ([f"ldworks_{TEACHER}_{day}" for day in (THURSDAY, FRIDAY)], 0),
            ([f"ldworks_{TEACHER}_{day}" for day in (TUESDAY, WEDNESDAY, THURSDAY, FRIDAY)], 1),
        ]
        larger_only = {**payload, "teacherDayLimits": [_limit(2, weeks=[[1, 2, 3]])]}
        assert _solve(larger_only, tuesday_and_wednesday, **FIVE_DAYS) == "FEASIBLE"

    def test_a_week_that_leaves_every_day_builds_no_row(self) -> None:
        """Three days on a post of three: Monday and Tuesday locked in one week
        leave one day, and Wednesday is the only one there is; Wednesday in
        another leaves two, and Monday and Tuesday are the two. Neither row can
        bind, so neither is built — nor the literal, nor anything else."""
        payload = _payload(
            limits=[_limit(3, weeks=[[1, 2], [3]])], fixed_lessons=_hour_locked_on(1, 2, 3),
        )

        assert _shape(payload) == _shape({**payload, "teacherDayLimits": []})

    def test_one_week_that_binds_is_built_and_the_rest_are_not(self) -> None:
        # Monday to Wednesday locked is every day the short week has: no day
        # outside it to count. Monday alone leaves one of the other two.
        payload = _payload(
            limits=[_limit(2, weeks=[[1, 2, 3], [1]])], fixed_lessons=_hour_locked_on(1, 2, 3),
        )

        assert _days_rows(payload) == [
            ([f"ldworks_{TEACHER}_{day}" for day in (TUESDAY, WEDNESDAY)], 1),
        ]


class TestTheLinkingRow:
    """Σ minutes·x ≤ C·works: bare, implied, and what closes a pigeonhole at once."""

    def _bare_rows(self, payload: dict[str, object], name: str) -> list[tuple[dict[str, int], int]]:
        """The linear rows over the variable called `name` that hang on no
        literal, as ({variable name: coefficient}, upper bound)."""
        _solver, (model, *_rest) = _build(payload)
        proto = model.Proto()
        index = next(i for i, var in enumerate(proto.variables) if var.name == name)
        return [
            (
                {
                    proto.variables[var].name: coeff
                    for var, coeff in zip(constraint.linear.vars, constraint.linear.coeffs)
                },
                list(constraint.linear.domain)[-1],
            )
            for constraint in proto.constraints
            if constraint.has_linear()
            and index in constraint.linear.vars
            and not constraint.enforcement_literal
        ]

    def test_a_day_that_cannot_hold_every_lesson_gets_the_row(self) -> None:
        # Five 60-minute lessons against a 240-minute day: the day holds at
        # most 240 minutes, and only if the teacher works it.
        five = _payload(limits=[_limit(2)], lessons_per_week=5)

        works = f"ldworks_{TEACHER}_0"
        rows = self._bare_rows(five, works)
        linking = [coeffs for coeffs, upper in rows if coeffs[works] == -240 and upper == 0]
        assert len(linking) == 1
        assert sorted(value for key, value in linking[0].items() if key != works) == [60] * 5

    def test_a_day_that_holds_them_all_gets_none(self) -> None:
        works = f"ldworks_{TEACHER}_0"
        rows = self._bare_rows(_payload(limits=[_limit(2)]), works)

        # Only `works <= Σ x` is left on it, which keeps the literal from
        # being free.
        assert [coeffs[works] for coeffs, _upper in rows] == [1]

    def test_a_cap_alone_posts_no_linking_row(self) -> None:
        # The row is the days limit's: under a cap alone the day's minutes are
        # bounded by the cap's own row, under its literal.
        works = f"ldworks_{TEACHER}_0"
        rows = self._bare_rows(
            _payload(rules=[_rule(maxTeachingMinutesPerDay=180)], lessons_per_week=5), works,
        )

        assert [coeffs[works] for coeffs, _upper in rows] == [1]

    def test_a_locked_day_s_row_is_its_room_times_its_works(self) -> None:
        """Tuesday is a teaching day by its lock and not one the limit counts,
        and its row is still there — the four hours less the locked one — and
        still times `works`: `Σ minutes·x ≤ 180·works`. The constant
        `≤ 180` it once was is what CP-SAT's presolve threw on (the
        regression below); without the row at all the LP no longer sees that
        a locked day holds its room and no more."""
        locked = _payload(
            limits=[_limit(2)], lessons_per_week=5, fixed_lessons=[_locked("08:00:00", "09:00:00", 2)],
        )

        tuesday = self._bare_rows(locked, f"ldon_{REQUIREMENT}_0_1")
        assert not [
            coeffs for coeffs, _upper in tuesday
            if sorted(coeffs.values()) == [60] * 5
        ]
        works = f"ldworks_{TEACHER}_1"
        rows = self._bare_rows(locked, works)
        linking = [coeffs for coeffs, upper in rows if coeffs[works] == -180 and upper == 0]
        assert len(linking) == 1
        assert sorted(value for key, value in linking[0].items() if key != works) == [60] * 5

    def test_a_post_the_locked_days_fill_is_refused_by_name_and_never_raises(self) -> None:
        """The week CP-SAT 9.15.6755's presolve threw an IndexError out of
        Solve on, found by the review's fuzz. The teacher leads one subject
        in a block beside another teacher's group, and a second of their
        own, 480 minutes in all; their locked lessons hold Monday and
        Thursday, and a post of two days leaves them no other. Monday's lock
        begins before the grid and Thursday's sits inside it, so the two
        locked days have 230 and 200 minutes of room, 430 against 480. The
        pre-flight's best two days are two whole ones, 480, and let it
        through, so the model is what refuses it — by the post, and never
        with a 500."""
        block = str(uuid4())
        other_teacher = str(uuid4())
        idrott = {
            "subjectId": str(uuid4()), "lessonsPerWeek": 4, "minutesPerLesson": 80,
            "lessonLengths": [80, 60, 30, 30], "studentGroupSize": 20, "blockId": block,
        }
        payload = _payload(
            limits=[_limit(2)],
            fixed_lessons=[
                _locked("07:30:00", "08:10:00", 1), _locked("08:20:00", "09:00:00", 4),
            ],
        )
        payload["requirements"] = [
            {**idrott, "id": REQUIREMENT, "studentGroupId": GROUP, "teacherId": TEACHER},
            {
                "id": OTHER_REQUIREMENT, "subjectId": str(uuid4()), "studentGroupId": OTHER_GROUP,
                "teacherId": TEACHER, "lessonsPerWeek": 4, "minutesPerLesson": 80,
                "lessonLengths": [80, 80, 60, 60], "studentGroupSize": 20,
            },
            {**idrott, "id": str(uuid4()), "studentGroupId": str(uuid4()), "teacherId": other_teacher},
        ]
        payload["rooms"] = [{"id": str(uuid4()), "capacity": 30} for _ in range(3)]
        assert _refusal(payload, **FIVE_DAYS) is None

        response = SchedulerSolver(_settings(SOLVER_PROBE_SECONDS=0, **FIVE_DAYS)).solve(
            _request(payload),
        )

        assert response.status == "INFEASIBLE"
        # Named whenever the explaining solve finished; a host loaded enough
        # to cut it short still gets the verdict, and still no exception.
        if response.conflicts and response.conflicts.summary_code == "CONFLICT_CORE_SUMMARY":
            codes = [detail.code for detail in response.conflicts.conflicts]
            assert "TEACHER_WORK_DAYS_CANNOT_BE_KEPT" in codes
        # Without the post the same week has a timetable.
        assert SchedulerSolver(_settings(SOLVER_PROBE_SECONDS=0, **FIVE_DAYS)).solve(
            _request({**payload, "teacherDayLimits": []}),
        ).status in {"OPTIMAL", "FEASIBLE"}

    def test_a_week_the_days_cannot_hold_is_refused_under_the_days_literal(self) -> None:
        """The pre-flight's best three days hold 720 minutes and the week asks
        for 600, so it lets the week through — but two of those days are the
        locked ones, and they leave 120 minutes each. 120 + 120 + 240 < 600.

        Proved, and quickly, on one worker: the linking rows make it a
        linear relaxation the solver closes, not a pigeonhole it walks."""
        locks = _payload(
            limits=[_limit(3)],
            lessons_per_week=10,
            fixed_lessons=[_locked("08:00:00", "10:00:00", 1), _locked("08:00:00", "10:00:00", 2)],
        )
        assert _refusal(locks, **FIVE_DAYS) is None

        _solver, (model, *_rest) = _build(locks, **FIVE_DAYS)
        _cp, status = _run(model, seconds=5.0)

        assert status == "INFEASIBLE"
        codes = [detail.code for detail in _conflicts(locks, **FIVE_DAYS)]
        assert "TEACHER_WORK_DAYS_CANNOT_BE_KEPT" in codes


class TestTheRoomADayHas:
    """_teaching_room and _day_reach: what the linking rows and the days pre-flight count."""

    def test_the_frames_and_the_locks_are_in_it(self) -> None:
        payload = _payload(
            limits=[_limit(2)],
            frames=[{
                "minGradeLevel": 7, "maxGradeLevel": 7,
                "startTime": "08:00:00", "endTime": "10:00:00",
            }],
            fixed_lessons=[_locked("09:00:00", "10:00:00", 2)],
        )
        solver, (_model, _registry, decisions, *_rest) = _build(payload)
        slots = solver._grid.slots_per_day
        reaches = [
            _day_reach(decision.starts, decision.duration, slots) for decision in decisions
        ]
        locked_busy = solver._teacher_busy_from_locks(_request(payload).fixed_lessons)

        room = solver._teaching_room(reaches, locked_busy, UUID(TEACHER))

        # Two hours a day inside the frame, and Tuesday's locked hour off it.
        assert room == {0: 24, 1: 12, 2: 24}

    def test_a_domain_across_a_day_edge_is_split(self) -> None:
        reach = _day_reach(cp_model.Domain(10, 30), 5, 24)

        assert reach == {0: [(10, 28)], 1: [(24, 35)]}


class TestTheLocksAsTheCapReadsThem:
    def test_the_union_of_the_clock_lead_and_co_and_any_weekday(self) -> None:
        request = _request(_payload(fixed_lessons=[
            _locked("07:00:00", "09:00:00", 1),
            _locked("08:30:00", "09:30:00", 1, teacher=None, co_teacher=TEACHER),
            _locked("10:00:00", "10:00:00", 2),
            _locked("09:00:00", "10:00:00", 6, teacher=TEACHER, co_teacher=TEACHER),
        ]))

        minutes, days = _teacher_locks(request.fixed_lessons)

        # 07:00-09:30 as one stretch; a lesson of no length takes nothing and
        # is no day; a Saturday is a day; lead and co the same person once.
        assert minutes == {(UUID(TEACHER), 1): 150, (UUID(TEACHER), 6): 60}
        assert days == {UUID(TEACHER): {1, 6}}

    def test_a_lesson_naming_one_person_twice_is_theirs_once(self) -> None:
        solver, (_model, _registry, decisions, *_rest) = _build(
            _payload(co_teacher=TEACHER),
        )

        assert len(_lessons_by_teacher(decisions)[UUID(TEACHER)]) == len(decisions) == 4


class TestWhatIsRefusedBeforeAnySolve:
    """Upper bounds on the minutes still to place, every cap before any days."""

    def test_a_lesson_longer_than_the_cap_is_named(self) -> None:
        error = _refusal(_payload(rules=[_rule(maxTeachingMinutesPerDay=55)]))

        assert error is not None
        assert error.code == "TEACHER_LESSON_LONGER_THAN_DAILY_CAP"
        assert error.params == {"rule": RULE, "minutes": 55, "lessonMinutes": 60}
        assert _refusal(_payload(rules=[_rule(maxTeachingMinutesPerDay=60)], lessons_per_week=3)) is None

    def test_the_longest_of_a_split_requirement_is_the_one_named(self) -> None:
        error = _refusal(_payload(
            rules=[_rule(maxTeachingMinutesPerDay=60)],
            lessons_per_week=2, minutes_per_lesson=80, lesson_lengths=[80, 40],
        ))

        assert error is not None
        assert error.params["lessonMinutes"] == 80

    def test_a_cap_the_school_days_cannot_hold_the_week_at_is_named(self) -> None:
        # Six hours on three days at 110 a day is 330 minutes of room.
        error = _refusal(_payload(rules=[_rule(maxTeachingMinutesPerDay=110)], lessons_per_week=6))

        assert error is not None
        assert error.code == "TEACHER_DAILY_CAP_TOO_SMALL_FOR_WEEK"
        assert error.params == {"rule": RULE, "minutes": 110, "days": 3, "weekMinutes": 360}
        assert _refusal(_payload(rules=[_rule(maxTeachingMinutesPerDay=120)], lessons_per_week=6)) is None

    def test_the_locked_minutes_come_off_the_cap_first(self) -> None:
        early = _payload(
            rules=[_rule(maxTeachingMinutesPerDay=120)],
            lessons_per_week=5,
            fixed_lessons=[_locked("07:00:00", "09:00:00")],
        )

        error = _refusal(early)
        assert error is not None
        assert error.code == "TEACHER_DAILY_CAP_TOO_SMALL_FOR_WEEK"
        assert _refusal({**early, "fixedLessons": []}) is None

    def test_days_too_few_for_the_week_are_named_without_a_rule(self) -> None:
        """A5: no cap needed, and the sentence carries the post, its days and
        the week — not a rule or a cap it does not have."""
        error = _refusal(_payload(limits=[_limit(1)], lessons_per_week=5))

        assert error is not None
        assert error.code == "TEACHER_WORK_DAYS_TOO_FEW_FOR_WEEK"
        assert error.params == {"limit": LIMIT, "days": 1, "weekMinutes": 300}
        assert _refusal(_payload(limits=[_limit(2)], lessons_per_week=5)) is None

    def test_the_frames_narrow_the_days_the_pre_flight_counts(self) -> None:
        frame = [{
            "minGradeLevel": 7, "maxGradeLevel": 7,
            "startTime": "08:00:00", "endTime": "10:00:00",
        }]

        assert _refusal(_payload(limits=[_limit(2)], lessons_per_week=4, frames=frame)) is None
        error = _refusal(_payload(limits=[_limit(2)], lessons_per_week=5, frames=frame))
        assert error is not None
        assert error.code == "TEACHER_WORK_DAYS_TOO_FEW_FOR_WEEK"

    def test_the_cap_narrows_the_days_the_pre_flight_counts(self) -> None:
        # Three days at 60 hold the week; the best two at 60 do not.
        capped = _payload(
            rules=[_rule(maxTeachingMinutesPerDay=60)], limits=[_limit(2)], lessons_per_week=3,
        )

        error = _refusal(capped)
        assert error is not None
        assert error.code == "TEACHER_WORK_DAYS_TOO_FEW_FOR_WEEK"
        assert _refusal({**capped, "teacherDayLimits": [_limit(3)]}) is None

    def test_every_cap_is_judged_before_any_days(self) -> None:
        """A reader without HR access gets the days sentence masked into one
        with nothing to act on; where a cap sentence is also true, that one —
        theirs to fix — is the one the week is refused with."""
        both = _payload(
            rules=[_rule(maxTeachingMinutesPerDay=110)], limits=[_limit(1)], lessons_per_week=6,
        )

        error = _refusal(both)
        assert error is not None
        assert error.code == "TEACHER_DAILY_CAP_TOO_SMALL_FOR_WEEK"

    def test_a_lesson_too_long_is_named_before_a_week_too_long(self) -> None:
        error = _refusal(_payload(rules=[_rule(maxTeachingMinutesPerDay=50)], lessons_per_week=6))

        assert error is not None
        assert error.code == "TEACHER_LESSON_LONGER_THAN_DAILY_CAP"

    def test_locks_on_more_days_than_the_limit_widen_the_count(self) -> None:
        """Locked on Monday and Tuesday under a limit of one: the teacher
        teaches on two days whatever happens, so two days' room is what the
        pre-flight may count — and the week fits on them."""
        locked = _payload(
            limits=[_limit(1)],
            lessons_per_week=6,
            fixed_lessons=[_locked("11:00:00", "12:00:00", 1), _locked("11:00:00", "12:00:00", 2)],
        )

        assert _refusal(locked, **FIVE_DAYS) is None
        error = _refusal({**locked, "fixedLessons": []}, **FIVE_DAYS)
        assert error is not None
        assert error.code == "TEACHER_WORK_DAYS_TOO_FEW_FOR_WEEK"

    def test_the_week_with_the_fewest_locked_days_is_the_one_counted(self) -> None:
        """An hour locked on Monday to Thursday, on a post of two, and eight
        hours to place. Locked every week, every week has four days whatever
        happens, and the best four hold thirteen hours. Locked two days a
        week, a week has two, and the best two hold seven — Friday's four and
        a locked day's three — so no week holds eight. And it takes only one
        such week: Monday alone in a week beside the four-day ones is one."""
        payload = _payload(
            limits=[_limit(2, weeks=[[1, 2], [3, 4]])], lessons_per_week=8,
            fixed_lessons=_hour_locked_on(1, 2, 3, 4),
        )

        error = _refusal(payload, **FIVE_DAYS)
        assert error is not None
        assert error.code == "TEACHER_WORK_DAYS_TOO_FEW_FOR_WEEK"
        assert error.params == {"limit": LIMIT, "days": 2, "weekMinutes": 480}
        every_week = {**payload, "teacherDayLimits": [_limit(2, weeks=[[1, 2, 3, 4]])]}
        assert _refusal(every_week, **FIVE_DAYS) is None
        one_short = {**payload, "teacherDayLimits": [_limit(2, weeks=[[1, 2, 3, 4], [1]])]}
        assert _refusal(one_short, **FIVE_DAYS) is not None

    def test_a_locked_weekday_off_the_grid_spends_the_post_and_holds_no_room(self) -> None:
        """Monday and Saturday locked every week, on a post of one: both are
        teaching days, so the post is spent and the solver's lessons may go
        on Monday alone, three hours beside its lock. The pre-flight counts
        a week's locked days of the GRID — Saturday has no room on this one
        to count — so the best one day, four hours, is what five must fit in.
        Locked Monday and Tuesday instead, the two locked days are two days
        of room, and the week goes on to the model, which fits it."""
        payload = _payload(
            limits=[_limit(1)], lessons_per_week=5,
            fixed_lessons=_hour_locked_on(1) + [_locked("09:00:00", "10:00:00", 6)],
        )

        error = _refusal(payload, **FIVE_DAYS)
        assert error is not None
        assert error.code == "TEACHER_WORK_DAYS_TOO_FEW_FOR_WEEK"
        on_the_grid = {**payload, "fixedLessons": _hour_locked_on(1, 2)}
        assert _refusal(on_the_grid, **FIVE_DAYS) is None

    def test_no_week_the_model_accepts_is_refused(self) -> None:
        """Odd weeks Monday and Tuesday, even weeks Wednesday and Thursday, a
        post of three and six hours: the model puts three on Monday and three
        on Wednesday, beside their locked hours, and every week has three
        days. The pre-flight counts a week's own locked days with the post's
        three, never the one day the post has left beside them — that would
        be four hours, and a refusal of a week that has a timetable."""
        payload = _payload(
            limits=[_limit(3, weeks=[[1, 2], [3, 4]])], lessons_per_week=6,
            fixed_lessons=_hour_locked_on(1, 2, 3, 4),
        )

        assert _refusal(payload, **FIVE_DAYS) is None
        response = SchedulerSolver(_settings(**FIVE_DAYS)).solve(_request(payload))
        assert response.status in {"OPTIMAL", "FEASIBLE"}
        assert _validate(payload, response.lessons, **FIVE_DAYS) == []

    @pytest.mark.parametrize("days", [3, 6])
    def test_a_post_that_cannot_bind_is_not_named(self, days: int) -> None:
        """Locks fill Monday to Wednesday until 11:00, so the week holds three
        of the teacher's four hours whatever the post says: a post of three
        days on a three-day week, or of six, changes nothing, and the model
        builds nothing for it. Named, it would tell a decider to allow more
        days when no number helps — and hand a reader without HR read access
        the masked sentence in place of the model's own cause."""
        locks = [_locked("08:00:00", "11:00:00", day) for day in (1, 2, 3)]
        over_full = _payload(lessons_per_week=4, fixed_lessons=locks, limits=[_limit(days)])

        assert _refusal(over_full) is None
        codes = {detail.code for detail in _conflicts(over_full, SOLVER_PROBE_SECONDS=0)}
        assert codes == {
            detail.code for detail in _conflicts({**over_full, "teacherDayLimits": []})
        }
        assert not [code for code in codes if "WORK_DAYS" in code]

    @pytest.mark.parametrize("days", [1, 2])
    def test_a_post_the_week_fails_without_is_not_what_tips_it(self, days: int) -> None:
        """Thirteen hours against three days of four: too much for every day
        together, so the post is not the reason, binding as it is — the week
        goes to the model as it would with no post at all."""
        assert _refusal(_payload(lessons_per_week=13)) is None

        assert _refusal(_payload(lessons_per_week=13, limits=[_limit(days)])) is None

    def test_a_post_is_named_where_it_is_what_tips_the_week(self) -> None:
        """Twelve hours fill the three days exactly: every day together holds
        the week, two of them do not, so a post of two is the reason and is
        named, and a post of three is not."""
        full = _payload(lessons_per_week=12, limits=[_limit(2)])

        error = _refusal(full)
        assert error is not None
        assert error.code == "TEACHER_WORK_DAYS_TOO_FEW_FOR_WEEK"
        assert error.params == {"limit": LIMIT, "days": 2, "weekMinutes": 720}
        assert _refusal({**full, "teacherDayLimits": [_limit(3)]}) is None

    def test_a_rule_or_a_post_naming_a_teacher_with_no_lessons_refuses_nothing(self) -> None:
        stranded = _payload(
            rules=[_rule(teacherId=str(uuid4()), maxTeachingMinutesPerDay=30)],
            limits=[_limit(1, teacher=str(uuid4()))],
            lessons_per_week=6,
        )

        assert _refusal(stranded) is None

    def test_one_person_as_lead_and_co_teacher_is_counted_once(self) -> None:
        # A4: 240 minutes once fit three days at 80; counted twice they would not.
        legacy = _payload(rules=[_rule(maxTeachingMinutesPerDay=80)], co_teacher=TEACHER)

        assert _refusal(legacy) is None


class TestTheRefusalNamesTheRuleAndThePostNeverTheTeacher:
    def test_a_cap_the_model_cannot_keep_names_its_rule_and_the_day(self) -> None:
        """One 60-minute lesson a day fits under 100 and a second does not:
        three days, four lessons. The pre-flight counts 300 minutes of room
        against 240 and lets it through; the model says no, by name."""
        capped = _payload(rules=[_rule(maxTeachingMinutesPerDay=100)])
        assert _refusal(capped) is None

        named = [d for d in _conflicts(capped) if d.code == "TEACHER_DAILY_CAP_CANNOT_BE_KEPT"]

        assert named
        for detail in named:
            assert detail.category == "TEACHER_OVERLAP"
            assert detail.params["rule"] == RULE
            assert detail.params["minutes"] == 100
            assert detail.params["day"] in (1, 2, 3)
            assert [str(value) for value in detail.resource_ids] == [RULE]
            assert TEACHER not in str(detail.params.values())
            assert TEACHER not in detail.message

    def test_days_the_model_cannot_keep_name_the_post_and_nothing_else(self) -> None:
        locks = _payload(
            limits=[_limit(3)],
            lessons_per_week=10,
            fixed_lessons=[_locked("08:00:00", "10:00:00", 1), _locked("08:00:00", "10:00:00", 2)],
        )

        named = [
            d for d in _conflicts(locks, **FIVE_DAYS)
            if d.code == "TEACHER_WORK_DAYS_CANNOT_BE_KEPT"
        ]

        assert len(named) == 1
        assert named[0].category == "TEACHER_OVERLAP"
        assert named[0].params == {"limit": LIMIT, "days": 3}
        assert [str(value) for value in named[0].resource_ids] == [LIMIT]
        assert TEACHER not in named[0].message


class TestNoRulesChangeNothing:
    def test_absent_empty_and_vacuous_build_the_model_they_always_built(self) -> None:
        """The switch is the data: a school that has set no cap, no days and no
        wish pays not a variable, not a constraint, not a refusal."""
        absent = _payload(lessons_per_week=4)
        del absent["teacherWorkRules"]
        del absent["teacherDayLimits"]
        empty = {**absent, "teacherWorkRules": [], "teacherDayLimits": []}
        # A row asking for nothing; a cap no day can reach (four hours a day
        # under 720 minutes); a limit allowing every day the week has.
        vacuous = {
            **absent,
            "teacherWorkRules": [_rule(), _rule(id=str(uuid4()), maxTeachingMinutesPerDay=720)],
            "teacherDayLimits": [_limit(3)],
        }
        # A wish with its weight at zero is switched off, the disruption change
        # with it.
        unpriced = {**absent, "teacherWorkRules": [_rule(preferredFreeDay=1)]}

        baseline = _shape(absent)
        assert _shape(empty) == baseline
        assert _shape(vacuous) == baseline
        assert _shape(unpriced, WEIGHT_FREE_DAY_WISH=0) == baseline

    def test_a_cap_or_a_limit_exactly_at_the_edge_builds_nothing(self) -> None:
        """The edges of "cannot bind": a cap of exactly the four hours the day
        has and the lessons bring, and a limit of exactly the days there are."""
        bare = _payload()
        edge = {
            **bare,
            "teacherWorkRules": [_rule(maxTeachingMinutesPerDay=240)],
            "teacherDayLimits": [_limit(3)],
        }

        assert _shape(edge) == _shape(bare)

    def test_a_cap_the_frames_already_keep_builds_nothing(self) -> None:
        # Two hours a day inside the frame, four hours of lessons a week: a cap
        # of two hours is the frame's own bound, and a row saying so is waste.
        frame = [{
            "minGradeLevel": 7, "maxGradeLevel": 7,
            "startTime": "08:00:00", "endTime": "10:00:00",
        }]
        framed = _payload(frames=frame)

        assert _shape({**framed, "teacherWorkRules": [_rule(maxTeachingMinutesPerDay=120)]}) == (
            _shape(framed)
        )

    def test_nothing_in_the_model_mentions_the_feature(self) -> None:
        names = _names(_payload(lessons_per_week=4))

        assert not [name for name in names if name.startswith(PREFIX)]

    def test_a_rule_naming_a_teacher_with_no_lessons_builds_nothing(self) -> None:
        stranded = _payload(
            rules=[_rule(teacherId=str(uuid4()), maxTeachingMinutesPerDay=60, preferredFreeDay=1)],
            limits=[_limit(1, teacher=str(uuid4()))],
        )

        assert not [name for name in _names(stranded) if name.startswith(PREFIX)]


class TestTheFreeDayWish:
    """weight × works(teacher, day), in the full model only."""

    def _cost(self, payload: dict[str, object], placements: list[tuple[int, str]]) -> int:
        solver, (model, _registry, decisions, *_rest) = _build(payload, objective=True, **WISH_ONLY)
        _pin(solver, model, decisions, placements)
        cp, status = _run(model)
        assert status in {"OPTIMAL", "FEASIBLE"}
        return round(cp.ObjectiveValue())

    def test_the_wish_is_paid_once_a_day_and_not_per_lesson(self) -> None:
        wished = _payload(rules=[_rule(preferredFreeDay=1)], lessons_per_week=2)

        assert self._cost(wished, [(TUESDAY, "08:00"), (WEDNESDAY, "08:00")]) == 0
        assert self._cost(wished, [(MONDAY, "08:00"), (WEDNESDAY, "08:00")]) == 40
        assert self._cost(wished, [(MONDAY, "08:00"), (MONDAY, "09:00")]) == 40

    def test_a_week_with_room_keeps_the_wish(self) -> None:
        response = SchedulerSolver(_settings()).solve(
            _request(_payload(rules=[_rule(preferredFreeDay=1)])),
        )

        assert response.status in {"OPTIMAL", "FEASIBLE"}
        assert len(response.lessons) == 4
        assert not [lesson for lesson in response.lessons if lesson.day_of_week == 1]

    def test_the_wish_is_the_co_teacher_s_too(self) -> None:
        co_wished = _payload(
            rules=[_rule(teacherId=CO_TEACHER, preferredFreeDay=1)],
            lessons_per_week=1,
            co_teacher=CO_TEACHER,
        )

        assert self._cost(co_wished, [(MONDAY, "08:00")]) == 40

    def test_nothing_in_the_satisfaction_model(self) -> None:
        wished = _payload(rules=[_rule(preferredFreeDay=1)])

        assert not [n for n in _names(wished, objective=False) if n.startswith(PREFIX)]
        assert f"ldwish_{TEACHER}_0" in _names(wished)

    def test_a_weekday_the_school_does_not_teach_builds_nothing(self) -> None:
        # A7: and never asks the grid where Saturday is, which would raise.
        saturday = _payload(rules=[_rule(preferredFreeDay=6)])

        assert _shape(saturday) == _shape(_payload())

    def test_a_day_the_teacher_s_locks_hold_builds_nothing(self) -> None:
        locked = _payload(
            rules=[_rule(preferredFreeDay=1)], fixed_lessons=[_locked("11:00:00", "12:00:00", 1)],
        )

        assert not [name for name in _names(locked) if name.startswith("ldwish_")]

    def test_a_day_no_lesson_can_reach_is_kept_by_the_frames(self) -> None:
        closed_monday = _payload(
            rules=[_rule(preferredFreeDay=1)],
            frames=[{
                "minGradeLevel": 7, "maxGradeLevel": 7, "dayOfWeek": 1,
                "startTime": "08:00:00", "endTime": "08:30:00",
            }],
        )

        assert not [name for name in _names(closed_monday) if name.startswith(PREFIX)]

    def test_the_cap_s_day_is_the_wish_s_day(self) -> None:
        """Where the cap built `works` for the day, the wish reads it rather
        than building a second answer to the same question."""
        both = _payload(rules=[_rule(maxTeachingMinutesPerDay=120, preferredFreeDay=1)])

        names = _names(both)
        assert f"ldworks_{TEACHER}_0" in names
        assert not [name for name in names if name.startswith("ldwish_")]
        assert self._cost(both, [
            (MONDAY, "08:00"), (TUESDAY, "08:00"), (TUESDAY, "09:00"), (WEDNESDAY, "08:00"),
        ]) == 40

    def test_the_rest_rule_s_day_is_the_wish_s_day(self) -> None:
        rested = _payload(rules=[_rule(minDailyRestMinutes=660, preferredFreeDay=1)])

        names = _names(rested)
        assert f"tday_{TEACHER}_0" in names
        assert not [name for name in names if name.startswith(PREFIX)]

    def test_a_lesson_with_a_day_literal_holds_the_wish_up_through_it(self) -> None:
        """The co-teacher's cap built the lesson's day literals; the lead's wish
        reads them, and a pinned Monday costs the wish all the same."""
        shared = _payload(
            rules=[
                _rule(preferredFreeDay=1),
                {"id": str(uuid4()), "teacherId": CO_TEACHER, "maxTeachingMinutesPerDay": 120},
            ],
            co_teacher=CO_TEACHER,
        )

        assert f"ldwish_{TEACHER}_0" in _names(shared)
        assert self._cost(shared, [
            (MONDAY, "08:00"), (TUESDAY, "08:00"), (TUESDAY, "09:00"), (WEDNESDAY, "08:00"),
        ]) == 40
        assert self._cost(shared, [
            (TUESDAY, "08:00"), (TUESDAY, "09:00"), (WEDNESDAY, "08:00"), (WEDNESDAY, "09:00"),
        ]) == 0


def test_the_note_on_a_wish_given_up_names_the_day_and_no_id() -> None:
    """The gateway's note, registered here: its params are the day alone, and
    whose wish it was is the teacher's name the gateway adds on read as the
    note's resourceNames. The work rule's uuid in the sentence was a line
    nobody could tell the teacher from."""
    template = MESSAGES["TEACHER_FREE_DAY_WISH_NOT_KEPT"]

    assert arguments_of(template) == {"day"}
    assert render("TEACHER_FREE_DAY_WISH_NOT_KEPT", {"day": 3}).startswith(
        "A teacher wishes Wednesdays free,",
    )


class TestTheWishAndTheDisruption:
    """A6: the teacher's previous slots on the wished day earn nothing."""

    PREVIOUS = [
        {"requirementId": REQUIREMENT, "dayOfWeek": 1, "startTime": "08:00:00"},
        {"requirementId": REQUIREMENT, "dayOfWeek": 2, "startTime": "08:00:00"},
        {"requirementId": OTHER_REQUIREMENT, "dayOfWeek": 1, "startTime": "09:00:00"},
    ]

    def _kept(self, payload: dict[str, object], **settings: object) -> list[str]:
        return sorted(
            name for name in _names(payload, **settings) if name.startswith("prev_kept_")
        )

    def test_the_wished_day_s_slot_of_the_teacher_is_not_rewarded(self) -> None:
        wished = _payload(rules=[_rule(preferredFreeDay=1)], previous=self.PREVIOUS, other={})

        # Monday's slot of the teacher's requirement goes; Tuesday's stays, and
        # so does the other teacher's Monday slot.
        assert self._kept(wished) == ["prev_kept_1", "prev_kept_2"]
        assert self._kept({**wished, "teacherWorkRules": []}) == [
            "prev_kept_0", "prev_kept_1", "prev_kept_2",
        ]

    def test_the_co_teacher_s_wish_reaches_the_requirement_too(self) -> None:
        co_wished = _payload(
            rules=[_rule(teacherId=CO_TEACHER, preferredFreeDay=1)],
            co_teacher=CO_TEACHER,
            previous=self.PREVIOUS,
            other={},
        )

        assert self._kept(co_wished) == ["prev_kept_1", "prev_kept_2"]

    def test_a_wish_switched_off_leaves_the_disruption_alone(self) -> None:
        wished = _payload(rules=[_rule(preferredFreeDay=1)], previous=self.PREVIOUS, other={})

        assert self._kept(wished, WEIGHT_FREE_DAY_WISH=0) == [
            "prev_kept_0", "prev_kept_1", "prev_kept_2",
        ]

    def test_a_wish_the_locks_already_break_leaves_it_alone(self) -> None:
        locked = _payload(
            rules=[_rule(preferredFreeDay=1)],
            previous=self.PREVIOUS,
            other={},
            fixed_lessons=[_locked("11:00:00", "12:00:00", 1)],
        )

        assert self._kept(locked) == ["prev_kept_0", "prev_kept_1", "prev_kept_2"]


class TestTheTimeoutProbe:
    def test_each_rule_is_probed_on_its_own_days_first(self) -> None:
        solver = SchedulerSolver(_settings())
        request = _request(_payload(
            rules=[_rule(maxTeachingMinutesPerDay=120, minDailyRestMinutes=660)],
            limits=[_limit(2)],
        ))

        relaxations = solver._timeout_relaxations(request)
        codes = [code for code, _relaxed in relaxations]

        assert codes.index("PROBE_SOLVED_WITHOUT_TEACHER_DAY_LIMITS") < codes.index(
            "PROBE_SOLVED_WITHOUT_TEACHER_DAILY_CAP",
        )
        by_code = dict(relaxations)
        days_off = by_code["PROBE_SOLVED_WITHOUT_TEACHER_DAY_LIMITS"]
        assert days_off.teacher_day_limits == []
        assert days_off.teacher_work_rules[0].max_teaching_minutes_per_day == 120
        cap_off = by_code["PROBE_SOLVED_WITHOUT_TEACHER_DAILY_CAP"]
        assert cap_off.teacher_work_rules[0].max_teaching_minutes_per_day is None
        assert cap_off.teacher_work_rules[0].min_daily_rest_minutes == 660
        assert [limit.max_teaching_days_per_week for limit in cap_off.teacher_day_limits] == [2]

    def test_a_week_without_either_is_not_probed_for_them(self) -> None:
        solver = SchedulerSolver(_settings())
        codes = [
            code for code, _relaxed in solver._timeout_relaxations(
                _request(_payload(rules=[_rule(preferredFreeDay=1)])),
            )
        ]

        assert "PROBE_SOLVED_WITHOUT_TEACHER_DAY_LIMITS" not in codes
        assert "PROBE_SOLVED_WITHOUT_TEACHER_DAILY_CAP" not in codes

    def test_the_diagnosis_counts_what_the_model_built(self) -> None:
        solver = SchedulerSolver(_settings())
        reaching = _request(_payload(
            rules=[_rule(maxTeachingMinutesPerDay=120, preferredFreeDay=1)], limits=[_limit(2)],
        ))
        stranded = _request(_payload(
            rules=[_rule(teacherId=str(uuid4()), maxTeachingMinutesPerDay=120, preferredFreeDay=1)],
            limits=[_limit(2, teacher=str(uuid4()))],
        ))

        assert "teacherDailyCaps=1, teacherDayLimits=1, freeDayWishes=1," in (
            solver._timeout_diagnosis(reaching, "test")
        )
        assert "teacherDailyCaps=0, teacherDayLimits=0, freeDayWishes=0," in (
            solver._timeout_diagnosis(stranded, "test")
        )


def test_the_estimate_still_bounds_the_model_it_predicts() -> None:
    """_estimate_model_size's own contract over the new builders: an upper
    bound on the full model, which is the one the budget is calibrated in."""
    solver = SchedulerSolver(_settings())
    for payload in (
        _payload(rules=[_rule(maxTeachingMinutesPerDay=120)]),
        _payload(limits=[_limit(2)], lessons_per_week=5),
        _payload(rules=[_rule(preferredFreeDay=1)]),
        _payload(
            rules=[_rule(maxTeachingMinutesPerDay=100, preferredFreeDay=2)],
            limits=[_limit(2, teacher=CO_TEACHER)],
            co_teacher=CO_TEACHER,
            fixed_lessons=[_locked("08:00:00", "09:00:00", 1)],
            previous=[{"requirementId": REQUIREMENT, "dayOfWeek": 2, "startTime": "08:00:00"}],
        ),
    ):
        request = _request(payload)
        model, *_rest = solver._build_model(request, use_assumptions=False)
        assert solver._estimate_model_size(request) >= len(model.Proto().variables)


def test_the_estimate_charges_each_rule_its_own_term() -> None:
    """The arithmetic of the term, pinned: four lessons on three days.

    A teacher with a cap or a limit: (D + 1) per lesson and D for `works`,
    22 with the cap's D literals; the limit's one literal, the wish's one
    `works`. Each rule on its own payload, against the same week without it."""
    solver = SchedulerSolver(_settings())

    def extra(**rules: object) -> int:
        return solver._estimate_model_size(_request(_payload(**rules))) - (
            solver._estimate_model_size(_request(_payload()))
        )

    assert extra(rules=[_rule(maxTeachingMinutesPerDay=120)]) == 4 * 4 + 3 + 3
    assert extra(limits=[_limit(2)]) == 4 * 4 + 3 + 1
    assert extra(rules=[_rule(preferredFreeDay=1)]) == 1
    assert extra(
        rules=[_rule(maxTeachingMinutesPerDay=120, preferredFreeDay=1)], limits=[_limit(2)],
    ) == 4 * 4 + 3 + 3 + 1 + 1
    assert extra(rules=[_rule(teacherId=str(uuid4()), maxTeachingMinutesPerDay=120)]) == 0
    assert extra(limits=[_limit(2, teacher=str(uuid4()))]) == 0


def test_the_rules_feed_no_constant_to_the_start_step() -> None:
    """A day is `start // slots_per_day`, which rounding a start down to the
    step never moves; the cap and the days compare sums of lengths, and the
    wish reads only the day. So none of them may change the step."""
    grid = SchedulerSolver(_settings())._grid
    bare = _request(_payload())
    ruled = _request(_payload(
        rules=[_rule(maxTeachingMinutesPerDay=95, preferredFreeDay=2)], limits=[_limit(2)],
    ))

    assert _start_step(ruled, grid) == _start_step(bare, grid)


class TestTheIndependentCheck:
    """benchmarks/validate_schedule.py: the same definition, none of the code."""

    def test_a_solved_week_validates(self) -> None:
        # Monday is locked for an hour, so it is one of the two days and holds
        # two more lessons under 180; the other two go on one more day.
        payload = _payload(
            rules=[_rule(maxTeachingMinutesPerDay=180, preferredFreeDay=3)],
            limits=[_limit(2)],
            fixed_lessons=[_locked("11:00:00", "12:00:00", 1)],
        )
        response = SchedulerSolver(_settings()).solve(_request(payload))

        assert response.status in {"OPTIMAL", "FEASIBLE"}
        assert _validate(payload, response.lessons) == []

    def test_a_day_over_the_cap_is_reported_with_its_locks(self) -> None:
        capped = _payload(
            rules=[_rule(maxTeachingMinutesPerDay=120)],
            lessons_per_week=2,
            fixed_lessons=[_locked("11:00:00", "12:00:00", 1)],
        )

        problems = _validate(capped, [_lesson(1), _lesson(1, "09:00", "10:00")])
        assert problems == [
            f"teacher work rule {RULE}: 180 minutes of teaching on weekday 1, "
            "its rule allows 120 a day",
        ]
        assert _validate(capped, [_lesson(1), _lesson(2)]) == []

    def test_locks_over_the_cap_alone_are_not_the_solver_s(self) -> None:
        over = _payload(
            rules=[_rule(maxTeachingMinutesPerDay=120)],
            lessons_per_week=1,
            fixed_lessons=[_locked("08:00:00", "11:00:00", 1)],
        )

        assert _validate(over, [_lesson(2)]) == []
        assert _validate(over, [_lesson(1, "11:00", "12:00")]) != []

    def test_the_days_are_counted_with_the_locked_ones(self) -> None:
        limited = _payload(
            limits=[_limit(2)], lessons_per_week=2, fixed_lessons=[_locked("11:00:00", "12:00:00", 3)],
        )

        assert _validate(limited, [_lesson(1), _lesson(1, "09:00", "10:00")]) == []
        assert _validate(limited, [_lesson(1), _lesson(2)]) == [
            f"teacher post {LIMIT}: teaching on 3 days a week (1 of them locked: weekdays 3), "
            "its post allows 2",
        ]

    def test_locks_over_the_limit_raise_the_bar_and_no_further(self) -> None:
        over = _payload(
            limits=[_limit(1)],
            lessons_per_week=1,
            fixed_lessons=[_locked("11:00:00", "12:00:00", 1), _locked("11:00:00", "12:00:00", 2)],
        )

        assert _validate(over, [_lesson(2)]) == []
        assert _validate(over, [_lesson(3)]) != []

    def test_every_week_is_counted_on_its_own(self) -> None:
        """The checker reads the weeks the request names, not the model: odd
        weeks Monday and Tuesday, even weeks Wednesday and Thursday, a post of
        three. Monday and Wednesday are a third day each; Monday and Tuesday
        are the even weeks' fourth. Every set the request names is read, so a
        week the engine leaves out as implied is still checked here."""
        payload = _payload(
            limits=[_limit(3, weeks=[[1, 2], [3, 4]])], lessons_per_week=2,
            fixed_lessons=_hour_locked_on(1, 2, 3, 4),
        )

        assert _validate(payload, [_lesson(1), _lesson(3)], **FIVE_DAYS) == []
        assert _validate(payload, [_lesson(1), _lesson(2)], **FIVE_DAYS) == [
            f"teacher post {LIMIT}: teaching on 4 days a week (2 of them locked: weekdays 3, 4), "
            "its post allows 3",
        ]
        # Locked on all four every week: over the post by hand, and a lesson
        # on one of the four adds nothing — on Friday it is a fifth.
        every_week = {**payload, "teacherDayLimits": [_limit(3, weeks=[[1, 2, 3, 4]])]}
        assert _validate(every_week, [_lesson(1), _lesson(2)], **FIVE_DAYS) == []
        assert _validate(every_week, [_lesson(1), _lesson(5)], **FIVE_DAYS) == [
            f"teacher post {LIMIT}: teaching on 5 days a week "
            "(4 of them locked: weekdays 1, 2, 3, 4), its post allows 3",
        ]
        # A week inside one the locks put over the post is a week of its own:
        # Tuesday and Wednesday add nothing to Monday-to-Wednesday, and two
        # days to Monday alone.
        nested = {**payload, "teacherDayLimits": [_limit(2, weeks=[[1, 2, 3], [1]])]}
        assert _validate(nested, [_lesson(2), _lesson(3)], **FIVE_DAYS) == [
            f"teacher post {LIMIT}: teaching on 3 days a week (1 of them locked: weekdays 1), "
            "its post allows 2",
        ]

    def test_a_co_taught_lesson_is_the_co_teacher_s(self) -> None:
        co_capped = _payload(
            rules=[_rule(teacherId=CO_TEACHER, maxTeachingMinutesPerDay=60)],
            lessons_per_week=2,
            co_teacher=CO_TEACHER,
        )

        assert _validate(co_capped, [_lesson(1), _lesson(1, "09:00", "10:00")]) != []


#: The cases the gateway's hand-edit warnings, the cover board and the web
#: replay, generated from src/common/teacher-day.ts — see its spec.
FIXTURE = (
    Path(__file__).resolve().parents[2] / "src/common/__fixtures__/teacher-day-cases.json"
)


def _week_cases() -> list[dict[str, object]]:
    """The fixture's cases the engine's week can state: every week, no dates.

    The engine has no weeks — a lesson every odd week is a lesson — so the
    cases about parities and terms are the gateway's and the web's to agree
    on, and this checker is held to the rest.
    """
    cases = json.loads(FIXTURE.read_text())["cases"]
    return [
        case for case in cases
        if all(
            lesson.get("recurrence") in (None, "ALL_WEEKS")
            and lesson.get("startDate") is None
            and lesson.get("endDate") is None
            for lesson in case["lessons"]
        )
    ]


def test_the_fixture_has_every_week_cases_to_replay() -> None:
    # A filter that kept nothing would pass the replay below vacuously.
    assert len(_week_cases()) >= 5


@pytest.mark.parametrize("case", _week_cases(), ids=lambda case: case["name"])
def test_the_checker_reads_the_day_as_the_gateway_and_the_web_do(case: dict) -> None:
    """validate_schedule.py against the gateway's own verdicts, case by case.

    Every lesson of a case is one the solver PLACED — the school locked none —
    so the checker's tolerance for locked-only breaches never applies, and its
    verdict has to be the gateway's breach list: the day, the minutes and the
    cap; the days and the limit. Each lesson is its own requirement of its own
    class, so two that overlap are the teacher's clash and nobody else's, and
    the clash line is the overlap check's to report, not this one's.
    """
    rule = case["rule"]
    requirements = []
    lessons = []
    for index, lesson in enumerate(case["lessons"]):
        requirement_id = str(uuid4())
        minutes = max(15, _minutes(lesson["end"]) - _minutes(lesson["start"]))
        requirements.append({
            "id": requirement_id,
            "subjectId": str(uuid4()),
            "studentGroupId": str(uuid4()),
            "teacherId": TEACHER,
            "lessonsPerWeek": 1,
            "minutesPerLesson": minutes,
            "studentGroupSize": 24,
        })
        lessons.append(_lesson(
            lesson["dayOfWeek"], lesson["start"], lesson["end"], requirement=requirement_id,
        ))
    payload = _payload()
    payload["requirements"] = requirements
    if rule["maxTeachingMinutesPerDay"] is not None:
        payload["teacherWorkRules"] = [_rule(maxTeachingMinutesPerDay=rule["maxTeachingMinutesPerDay"])]
    if rule["maxTeachingDaysPerWeek"] is not None:
        payload["teacherDayLimits"] = [_limit(rule["maxTeachingDaysPerWeek"])]

    found = set()
    # Every weekday is a teaching day here, so a case's Saturday is a day.
    for problem in _validate(
        payload, lessons, SCHEDULE_DAYS="1,2,3,4,5,6,7", SCHEDULE_DAY_END_MINUTES=1080,
    ):
        if "double-booked" in problem:
            continue
        if (match := re.search(
            r"(\d+) minutes of teaching on weekday (\d), its rule allows (\d+)", problem,
        )) is not None:
            found.add(("DAILY_CAP", int(match.group(2)), int(match.group(1)), int(match.group(3))))
        elif (match := re.search(
            r"teaching on (\d+) days a week .*its post allows (\d+)", problem,
        )) is not None:
            found.add(("WORK_DAYS", int(match.group(1)), int(match.group(2))))
        else:
            raise AssertionError(problem)
    expected = {
        ("DAILY_CAP", breach["dayOfWeek"], breach["minutes"], breach["cap"])
        if breach["kind"] == "DAILY_CAP"
        else ("WORK_DAYS", breach["days"], breach["max"])
        for breach in case["breaches"]
    }
    assert found == expected


def _minutes(hhmm: str) -> int:
    return int(hhmm[:2]) * 60 + int(hhmm[3:5])
