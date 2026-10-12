"""Ämnesfördelning: how one requirement's lessons spread over the week.

A school writes it on a subject — "idrott högst en gång per dag, inte dagar i
följd" — and may write it again on one timplanspost. The gateway sends the
rule that applies to each requirement, and with it the weekdays of the lessons
the school already locked, which reach this engine as fixed lessons with no
requirement id at all.

THE PLACEMENTS ARE PINNED in the model cases, which turns each one from an
observation about the solver's taste into an assertion about the encoding: the
spread objective already prefers different days, so a feasible week proves
nothing about a hard rule unless the week is told where its lessons are.

A FIVE-HOUR DAY on the default five-day week. Short enough that every case is
arithmetic a reader can do in their head, long enough that one 60-minute
lesson a day never runs out of hours — what decides each verdict is the day a
lesson is on, which is the only thing the rule reads.
"""

from __future__ import annotations

import sys
from pathlib import Path
from uuid import uuid4

import pytest
from ortools.sat.python import cp_model
from pydantic import ValidationError

from app.config import Settings
from app.exceptions import InvalidScheduleInputError
from app.messages import render
from app.schemas.schedule import (
    AnonymousRequirement,
    OptimizeScheduleRequest,
    ScheduledLesson,
)
from app.solver.scheduler_solver import SchedulerSolver, _spaced_capacity, _start_step

#: 08:00-13:00, Monday to Friday.
SHORT_WEEK = {"SCHEDULE_DAY_END_MINUTES": 780}

TEACHER = str(uuid4())
GROUP = str(uuid4())
REQUIREMENT = str(uuid4())

MONDAY, TUESDAY, WEDNESDAY, THURSDAY, FRIDAY = range(5)


def _settings(**overrides: object) -> Settings:
    return Settings(SOLVER_MAX_TIME_SECONDS=10.0, **overrides)  # type: ignore[arg-type]


def _requirement(**values: object) -> dict[str, object]:
    row: dict[str, object] = {
        "id": REQUIREMENT,
        "subjectId": str(uuid4()),
        "studentGroupId": GROUP,
        "teacherId": TEACHER,
        "lessonsPerWeek": 3,
        "minutesPerLesson": 60,
        "studentGroupSize": 24,
    }
    row.update(values)
    return row


def _payload(
    *,
    constraints: list[dict[str, object]] | None = None,
    frames: list[dict[str, object]] | None = None,
    **requirement: object,
) -> dict[str, object]:
    """One class, one teacher, one subject and one room — and nothing else."""
    return {
        "requestId": str(uuid4()),
        "academicYearId": str(uuid4()),
        "requirements": [_requirement(**requirement)],
        "groups": [{"id": GROUP, "lunchHeadcount": 24}],
        "rooms": [{"id": str(uuid4()), "capacity": 30}],
        "constraints": constraints or [],
        "frameTimes": frames or [],
    }


def _closure(
    start: str, end: str, day_of_week: int, *, kind: str = "TEACHER", resource: str = TEACHER,
) -> dict[str, object]:
    return {
        "id": str(uuid4()),
        "resourceKind": kind,
        "resourceId": resource,
        "dayOfWeek": day_of_week,
        "date": None,
        "startTime": start,
        "endTime": end,
        "kind": "UNAVAILABLE",
    }


def _solve(payload: dict[str, object], days: list[int], **settings: object) -> str:
    """Pin lesson k to 08:00 on days[k] — or 09:00, 10:00 for a second and
    third on the same day — build the satisfaction model and solve it once."""
    solver = SchedulerSolver(_settings(**{**SHORT_WEEK, **settings}))
    request = OptimizeScheduleRequest.model_validate(payload)
    model, _registry, decisions, _plan, _lunches = solver._build_model(
        request, use_assumptions=False, include_objective=False,
    )
    slots_per_day = solver._grid.slots_per_day
    hour = 60 // solver._grid.slot_minutes
    seen: dict[int, int] = {}
    for decision, day_index in zip(decisions, days):
        offset = seen.get(day_index, 0)
        seen[day_index] = offset + 1
        model.Add(decision.start == day_index * slots_per_day + offset * hour)

    cp = cp_model.CpSolver()
    cp.parameters.num_workers = 1
    cp.parameters.max_time_in_seconds = 10.0
    code = cp.Solve(model)
    assert code != cp_model.MODEL_INVALID, model.Validate()
    status = cp.StatusName(code)
    assert status in {"OPTIMAL", "FEASIBLE", "INFEASIBLE"}, status
    return "INFEASIBLE" if status == "INFEASIBLE" else "FEASIBLE"


def _shape(payload: dict[str, object], **settings: object) -> tuple[list[str], int]:
    solver = SchedulerSolver(_settings(**{**SHORT_WEEK, **settings}))
    request = OptimizeScheduleRequest.model_validate(payload)
    model, *_ = solver._build_model(request, use_assumptions=False, include_objective=True)
    proto = model.Proto()
    return [variable.name for variable in proto.variables], len(proto.constraints)


def _refusal(payload: dict[str, object], **settings: object) -> InvalidScheduleInputError | None:
    solver = SchedulerSolver(_settings(**{**SHORT_WEEK, **settings}))
    try:
        solver._validate_request(OptimizeScheduleRequest.model_validate(payload))
    except InvalidScheduleInputError as error:
        return error
    return None


def _validate(
    payload: dict[str, object], lessons: list[ScheduledLesson], **settings: object,
) -> list[str]:
    benchmarks = Path(__file__).resolve().parents[1] / "benchmarks"
    if str(benchmarks) not in sys.path:
        sys.path.insert(0, str(benchmarks))
    from validate_schedule import validate

    grid = SchedulerSolver(_settings(**{**SHORT_WEEK, **settings}))._grid
    return validate(grid, OptimizeScheduleRequest.model_validate(payload), lessons)


def _core_codes(payload: dict[str, object], **settings: object) -> list[str]:
    """The codes a full solve names, on a week it refuses after building."""
    solver = SchedulerSolver(_settings(**{**SHORT_WEEK, **settings}))
    response = solver.solve(OptimizeScheduleRequest.model_validate(payload))
    assert response.status == "INFEASIBLE", response.status
    assert response.conflicts is not None
    return [detail.code for detail in response.conflicts.conflicts]


def _with_literals(
    payload: dict[str, object], off: set[str], **settings: object,
) -> str:
    """Solve with every assumption literal pinned true except the codes in `off`.

    What a core can only suggest, asked directly: a rule posted under its
    literal is lifted when the literal is false. Posted bare it holds anyway,
    and the refusal can then be proved without touching the literal — on a
    big enough week, an empty core that takes every cause down with it.
    """
    solver = SchedulerSolver(_settings(**{**SHORT_WEEK, **settings}))
    request = OptimizeScheduleRequest.model_validate(payload)
    model, registry, _decisions, _plan, _lunches = solver._build_model(
        request, use_assumptions=True, include_objective=False,
    )
    model.ClearAssumptions()
    for record in registry._records:
        model.Add(record.literal == (0 if record.code in off else 1))
    cp = cp_model.CpSolver()
    cp.parameters.num_workers = 1
    cp.parameters.max_time_in_seconds = 10.0
    status = cp.StatusName(cp.Solve(model))
    assert status in {"OPTIMAL", "FEASIBLE", "INFEASIBLE"}, status
    return "INFEASIBLE" if status == "INFEASIBLE" else "FEASIBLE"


def _lesson(day_of_week: int, start: str = "08:00:00", end: str = "09:00:00") -> ScheduledLesson:
    return ScheduledLesson.model_validate({
        "requirementId": REQUIREMENT,
        "roomId": None,
        "dayOfWeek": day_of_week,
        "startTime": start,
        "endTime": end,
    })


class TestTheFields:
    def test_absent_means_no_rule_and_nothing_locked(self) -> None:
        requirement = AnonymousRequirement.model_validate(_requirement())

        assert requirement.max_lessons_per_day is None
        assert requirement.min_days_between is None
        assert requirement.locked_days == []

    @pytest.mark.parametrize(
        ("field", "value"),
        [
            ("maxLessonsPerDay", 0),
            ("maxLessonsPerDay", 21),
            # 1 would say "lesson days at least one day apart", which every two
            # different days are: a rule that cannot be broken is a gateway
            # that lost the number on the way, not a school's sentence.
            ("minDaysBetween", 1),
            ("minDaysBetween", 7),
            ("lockedDays", [8]),
            ("lockedDays", [0]),
        ],
    )
    def test_a_value_outside_what_a_week_can_mean_is_refused(
        self, field: str, value: object,
    ) -> None:
        with pytest.raises(ValidationError):
            AnonymousRequirement.model_validate(_requirement(**{field: value}))

    def test_the_bounds_themselves_are_accepted(self) -> None:
        for row in (
            _requirement(maxLessonsPerDay=1, minDaysBetween=2, lockedDays=[1, 1, 7]),
            _requirement(maxLessonsPerDay=20, minDaysBetween=6),
        ):
            AnonymousRequirement.model_validate(row)


class TestNoRuleChangesNothing:
    def test_a_payload_without_the_keys_builds_the_model_it_always_built(self) -> None:
        """The promise that lets the engine deploy beside an older gateway: a
        requirement with no rule — absent, or explicitly empty — costs not a
        variable and not a constraint."""
        bare = _payload()
        explicit = _payload(maxLessonsPerDay=None, minDaysBetween=None, lockedDays=[])
        # Locked days with no rule to read them are nothing either.
        locked_only = _payload(lockedDays=[1, 3])

        baseline = _shape(bare)
        assert _shape(explicit) == baseline
        assert _shape(locked_only) == baseline

    def test_a_rule_that_cannot_bind_builds_nothing(self) -> None:
        # Three lessons can never be more than three on a day, and one lesson
        # with nothing locked has no second day to be near.
        baseline = _shape(_payload())
        assert _shape(_payload(maxLessonsPerDay=3)) == baseline
        assert _shape(_payload(lessonsPerWeek=1, minDaysBetween=2)) == _shape(
            _payload(lessonsPerWeek=1),
        )

    def test_nothing_in_a_ruleless_model_is_named_for_the_rule(self) -> None:
        names, _constraints = _shape(_payload())

        assert not [name for name in names if name.startswith(("dist", "distday_"))]


class TestAtMostNADay:
    def test_one_a_day_refuses_two_on_monday(self) -> None:
        once = _payload(maxLessonsPerDay=1)

        assert _solve(once, [MONDAY, MONDAY, WEDNESDAY]) == "INFEASIBLE"
        assert _solve(once, [MONDAY, TUESDAY, WEDNESDAY]) == "FEASIBLE"
        # The control: the same Monday pair with no rule is a timetable.
        assert _solve(_payload(), [MONDAY, MONDAY, WEDNESDAY]) == "FEASIBLE"

    def test_two_a_day_is_a_count_not_a_ban(self) -> None:
        twice = _payload(maxLessonsPerDay=2)

        assert _solve(twice, [MONDAY, MONDAY, WEDNESDAY]) == "FEASIBLE"
        assert _solve(twice, [MONDAY, MONDAY, MONDAY]) == "INFEASIBLE"

    def test_a_locked_monday_counts_toward_monday(self) -> None:
        """The risk this whole field exists for. The locked lesson is no
        decision of this model and names no requirement, so a cap reading only
        what the solver places would let it add a second Monday."""
        locked = _payload(lessonsPerWeek=2, maxLessonsPerDay=1, lockedDays=[1])

        assert _solve(locked, [MONDAY, WEDNESDAY]) == "INFEASIBLE"
        assert _solve(locked, [TUESDAY, WEDNESDAY]) == "FEASIBLE"

    def test_what_the_school_locked_past_the_cap_is_its_own_and_is_not_refused(self) -> None:
        """Two lessons locked onto Monday break "one a day" by hand. That edit
        warned when it was made; the generator keeps the rest of the week to
        the rule and adds nothing to Monday, and the week is not refused."""
        overfull = _payload(lessonsPerWeek=2, maxLessonsPerDay=1, lockedDays=[1, 1])

        assert _refusal(overfull) is None
        assert _solve(overfull, [TUESDAY, THURSDAY]) == "FEASIBLE"
        assert _solve(overfull, [MONDAY, THURSDAY]) == "INFEASIBLE"


class TestDaysApart:
    def test_not_on_consecutive_days(self) -> None:
        apart = _payload(lessonsPerWeek=2, minDaysBetween=2)

        assert _solve(apart, [MONDAY, TUESDAY]) == "INFEASIBLE"
        assert _solve(apart, [THURSDAY, FRIDAY]) == "INFEASIBLE"
        assert _solve(apart, [MONDAY, WEDNESDAY]) == "FEASIBLE"
        assert _solve(_payload(lessonsPerWeek=2), [MONDAY, TUESDAY]) == "FEASIBLE"

    def test_the_same_day_is_not_this_rule_s_business(self) -> None:
        """Two lessons on Monday are one lesson day. Whether that is allowed is
        the per-day cap's question, so a school can say "a double lesson is
        fine, but not Monday and Tuesday"."""
        apart = _payload(lessonsPerWeek=2, minDaysBetween=2)

        assert _solve(apart, [MONDAY, MONDAY]) == "FEASIBLE"
        both = _payload(lessonsPerWeek=2, minDaysBetween=2, maxLessonsPerDay=1)
        assert _solve(both, [MONDAY, MONDAY]) == "INFEASIBLE"

    def test_three_apart_refuses_monday_and_wednesday(self) -> None:
        wide = _payload(lessonsPerWeek=2, minDaysBetween=3)

        assert _solve(wide, [MONDAY, WEDNESDAY]) == "INFEASIBLE"
        assert _solve(wide, [MONDAY, THURSDAY]) == "FEASIBLE"

    def test_days_are_weekdays_not_positions_in_the_school_s_week(self) -> None:
        """A school teaching Monday, Wednesday and Friday has no two days in a
        row. Read as positions in its own week, Monday and Wednesday would be
        neighbours and every lesson of the rule would be refused."""
        apart = _payload(lessonsPerWeek=3, minDaysBetween=2, maxLessonsPerDay=1)

        assert _solve(apart, [0, 1, 2], SCHEDULE_DAYS="1,3,5") == "FEASIBLE"

    def test_a_day_next_to_a_locked_lesson_is_closed(self) -> None:
        locked = _payload(lessonsPerWeek=1, minDaysBetween=2, lockedDays=[3])

        assert _solve(locked, [TUESDAY]) == "INFEASIBLE"
        assert _solve(locked, [THURSDAY]) == "INFEASIBLE"
        assert _solve(locked, [MONDAY]) == "FEASIBLE"
        # Beside it on the same day is one lesson day, as above.
        assert _solve(locked, [WEDNESDAY]) == "FEASIBLE"

    def test_a_lock_outside_the_grid_still_closes_its_neighbour(self) -> None:
        # A lesson locked on a Saturday this grid does not teach is still a
        # Saturday lesson, and Friday is the day before it.
        locked = _payload(lessonsPerWeek=1, minDaysBetween=2, lockedDays=[6])

        assert _solve(locked, [FRIDAY]) == "INFEASIBLE"
        assert _solve(locked, [THURSDAY]) == "FEASIBLE"


class TestThePreFlight:
    """Counting, answered before any model is built, with the row named."""

    def test_four_lessons_do_not_fit_on_five_days_without_consecutive_days(self) -> None:
        refused = _refusal(_payload(lessonsPerWeek=4, maxLessonsPerDay=1, minDaysBetween=2))

        assert refused is not None
        assert refused.code == "SUBJECT_DISTRIBUTION_WEEK_TOO_SHORT"
        assert refused.params == {
            "requirement": REQUIREMENT,
            "lessons": 4,
            "days": 5,
            "maxPerDay": 1,
            "minDaysBetween": 2,
            "locked": 0,
        }
        assert str(refused) == (
            f"{REQUIREMENT}: 4 lessons do not fit on the 5 days it can be taught, with at "
            "most 1 a day and none on consecutive days. Allow more a day or closer days, "
            "or reduce the lessons per week."
        )
        # Three is Monday, Wednesday and Friday.
        assert _refusal(_payload(lessonsPerWeek=3, maxLessonsPerDay=1, minDaysBetween=2)) is None

    def test_a_cap_alone_counts_the_days(self) -> None:
        assert _refusal(_payload(lessonsPerWeek=6, maxLessonsPerDay=1)) is not None
        assert _refusal(_payload(lessonsPerWeek=5, maxLessonsPerDay=1)) is None
        assert _refusal(_payload(lessonsPerWeek=10, maxLessonsPerDay=2)) is None

    def test_days_apart_alone_is_never_counted_out(self) -> None:
        """Every lesson on one day keeps "not on consecutive days". Whether one
        day holds them is a question about hours, which the model answers."""
        assert _refusal(_payload(lessonsPerWeek=5, minDaysBetween=2)) is None

    def test_a_teacher_who_does_not_work_fridays_leaves_four_days(self) -> None:
        """The part-time idrottslärare: the ordinary way a rule stops fitting,
        and the reason the sentence counts the days the row can be taught on
        rather than the days of the week."""
        friday_off = _payload(
            maxLessonsPerDay=1,
            minDaysBetween=2,
            constraints=[_closure("00:00:00", "23:59:00", 5)],
        )

        refused = _refusal(friday_off)
        assert refused is not None
        assert refused.params["days"] == 4
        # A closure that leaves the morning is not a day off, and the lesson
        # still fits there.
        morning = _payload(
            maxLessonsPerDay=1,
            minDaysBetween=2,
            constraints=[_closure("10:00:00", "23:59:00", 5)],
        )
        assert _refusal(morning) is None

    def test_two_closures_that_meet_close_the_day_together(self) -> None:
        split = _payload(
            maxLessonsPerDay=1,
            minDaysBetween=2,
            constraints=[
                _closure("08:00:00", "10:30:00", 5, kind="STUDENT_GROUP", resource=GROUP),
                _closure("10:30:00", "13:00:00", 5),
            ],
        )

        refused = _refusal(split)
        assert refused is not None
        assert refused.params["days"] == 4

    def test_a_room_closure_does_not_close_the_day(self) -> None:
        # A room is one place the lesson could go, never the requirement's day.
        room_shut = _payload(
            maxLessonsPerDay=1,
            minDaysBetween=2,
            constraints=[_closure("00:00:00", "23:59:00", 5, kind="ROOM", resource=str(uuid4()))],
        )

        assert _refusal(room_shut) is None

    def test_a_frame_that_closes_friday_for_the_stage_leaves_four_days(self) -> None:
        framed = _payload(
            maxLessonsPerDay=1,
            minDaysBetween=2,
            minGradeLevel=7,
            maxGradeLevel=7,
            frames=[
                {
                    "minGradeLevel": 7,
                    "maxGradeLevel": 9,
                    "dayOfWeek": 5,
                    "startTime": "08:00:00",
                    "endTime": "08:30:00",
                },
            ],
        )

        refused = _refusal(framed)
        assert refused is not None
        assert refused.params["days"] == 4

    def test_a_locked_wednesday_takes_its_neighbours_and_itself(self) -> None:
        """One lesson locked on Wednesday under one a day and no consecutive
        days: Tuesday and Thursday are its neighbours, Wednesday is full, and
        Monday and Friday hold two of the three left to place."""
        refused = _refusal(
            _payload(lessonsPerWeek=3, maxLessonsPerDay=1, minDaysBetween=2, lockedDays=[3]),
        )

        assert refused is not None
        assert (refused.params["lessons"], refused.params["locked"]) == (4, 1)
        assert "(1 of them locked)" in str(refused)
        assert _refusal(
            _payload(lessonsPerWeek=2, maxLessonsPerDay=1, minDaysBetween=2, lockedDays=[3]),
        ) is None

    @pytest.mark.parametrize(
        ("caps", "apart", "expected"),
        [
            ([(1, 1), (2, 1), (3, 1), (4, 1), (5, 1)], None, 5),
            ([(1, 1), (2, 1), (3, 1), (4, 1), (5, 1)], 2, 3),
            ([(1, 1), (2, 1), (3, 1), (4, 1), (5, 1)], 3, 2),
            ([(1, 1), (2, 1), (4, 1), (5, 1)], 2, 2),
            # A heavier day is worth giving two light ones up for.
            ([(1, 1), (2, 3), (3, 1)], 2, 3),
            ([(5, 2), (1, 2), (3, 2)], 2, 6),
            ([], 2, 0),
        ],
    )
    def test_the_count_is_the_best_choice_of_days(
        self, caps: list[tuple[int, int]], apart: int | None, expected: int,
    ) -> None:
        assert _spaced_capacity(caps, apart) == expected


class TestWhatReachesTheSchool:
    def test_a_week_the_counting_lets_through_names_the_rule_in_the_core(self) -> None:
        """Wednesday is open by the count — the reservation leaves its last
        half hour — but a 60-minute lesson does not fit in it, so Monday,
        Wednesday and Friday are not to be had after all. The model finds that
        out, and the rule has a literal of its own to be named by."""
        squeezed = _payload(
            maxLessonsPerDay=1,
            minDaysBetween=2,
            constraints=[_closure("08:00:00", "12:30:00", 3)],
        )
        assert _refusal(squeezed) is None

        solver = SchedulerSolver(_settings(**SHORT_WEEK))
        response = solver.solve(OptimizeScheduleRequest.model_validate(squeezed))

        assert response.status == "INFEASIBLE"
        assert response.conflicts is not None
        named = [
            detail for detail in response.conflicts.conflicts
            if detail.category == "SUBJECT_DISTRIBUTION"
        ]
        assert named, [detail.code for detail in response.conflicts.conflicts]
        for detail in named:
            assert detail.code in {
                "SUBJECT_DISTRIBUTION_PER_DAY", "SUBJECT_DISTRIBUTION_DAYS_APART",
            }
            assert detail.params["requirement"] == REQUIREMENT
            assert [str(value) for value in detail.requirement_ids] == [REQUIREMENT]

    def test_days_apart_alone_reaches_the_core_by_its_own_literal(self) -> None:
        """Two four-hour lessons do not fit in one five-hour day, and a week of
        Monday and Tuesday has no two days that are not consecutive. The count
        has nothing to say — there is no cap — so the model refuses it, and
        the school is told which half of the rule to look at.

        The core is sufficient, not minimal, and on a week this small it
        carries every literal there is, so this does not prove the rule HANGS
        on its literal; test_each_half_hangs_on_its_own_literal does."""
        long_pair = _payload(lessonsPerWeek=2, minutesPerLesson=240, minDaysBetween=2)
        assert _refusal(long_pair, SCHEDULE_DAYS="1,2") is None

        codes = _core_codes(long_pair, SCHEDULE_DAYS="1,2")

        assert "SUBJECT_DISTRIBUTION_DAYS_APART" in codes
        assert "SUBJECT_DISTRIBUTION_PER_DAY" not in codes

    def test_the_cap_alone_reaches_the_core_by_its_own_literal(self) -> None:
        # Tuesday is open by the count but its last half hour holds no lesson,
        # so one a day leaves the second lesson nowhere: the cap is in the core.
        squeezed = _payload(
            lessonsPerWeek=2,
            maxLessonsPerDay=1,
            constraints=[_closure("08:00:00", "12:30:00", 2)],
        )
        assert _refusal(squeezed, SCHEDULE_DAYS="1,2") is None

        codes = _core_codes(squeezed, SCHEDULE_DAYS="1,2")

        assert "SUBJECT_DISTRIBUTION_PER_DAY" in codes
        assert "SUBJECT_DISTRIBUTION_DAYS_APART" not in codes

    def test_each_half_hangs_on_its_own_literal(self) -> None:
        long_pair = _payload(lessonsPerWeek=2, minutesPerLesson=240, minDaysBetween=2)
        assert _with_literals(long_pair, set(), SCHEDULE_DAYS="1,2") == "INFEASIBLE"
        assert _with_literals(
            long_pair, {"SUBJECT_DISTRIBUTION_DAYS_APART"}, SCHEDULE_DAYS="1,2",
        ) == "FEASIBLE"

        capped = _payload(lessonsPerWeek=2, maxLessonsPerDay=1)
        assert _with_literals(capped, set(), SCHEDULE_DAYS="1") == "INFEASIBLE"
        assert _with_literals(
            capped, {"SUBJECT_DISTRIBUTION_PER_DAY"}, SCHEDULE_DAYS="1",
        ) == "FEASIBLE"

    def test_the_two_halves_are_two_sentences(self) -> None:
        assert render(
            "SUBJECT_DISTRIBUTION_DAYS_APART", {"requirement": "Idrott för 7A", "minDaysBetween": 2},
        ).startswith("Idrott för 7A may not have lessons on consecutive days")
        assert render(
            "SUBJECT_DISTRIBUTION_PER_DAY", {"requirement": "Idrott för 7A", "maxPerDay": 1},
        ).startswith("Idrott för 7A may have at most 1 lesson a day")


class TestAWholeSolve:
    def test_three_lessons_land_monday_wednesday_and_friday_and_validate(self) -> None:
        spread = _payload(maxLessonsPerDay=1, minDaysBetween=2)
        solver = SchedulerSolver(_settings(**SHORT_WEEK))

        response = solver.solve(OptimizeScheduleRequest.model_validate(spread))

        assert response.status in {"OPTIMAL", "FEASIBLE"}
        assert sorted(lesson.day_of_week for lesson in response.lessons) == [1, 3, 5]
        assert _validate(spread, response.lessons) == []

    def test_a_locked_lesson_steers_the_rest_of_the_week(self) -> None:
        # Locked on Tuesday, one a day, no consecutive days: Monday and
        # Wednesday are Tuesday's neighbours and Tuesday is full, which leaves
        # Thursday and Friday — neighbours of each other, so they hold one
        # lesson between them, and two left to place are refused by count.
        assert _refusal(
            _payload(lessonsPerWeek=2, maxLessonsPerDay=1, minDaysBetween=2, lockedDays=[2]),
        ) is not None
        # One left: Thursday or Friday, never beside Tuesday.
        one = _payload(lessonsPerWeek=1, maxLessonsPerDay=1, minDaysBetween=2, lockedDays=[2])
        solver = SchedulerSolver(_settings(**SHORT_WEEK))
        response = solver.solve(OptimizeScheduleRequest.model_validate(one))

        assert response.status in {"OPTIMAL", "FEASIBLE"}
        assert [lesson.day_of_week for lesson in response.lessons][0] in {4, 5}
        assert _validate(one, response.lessons) == []


class TestTheIndependentCheck:
    """benchmarks/validate_schedule.py re-reads the rule from the request."""

    def test_two_placed_on_one_day_break_the_cap(self) -> None:
        once = _payload(lessonsPerWeek=2, maxLessonsPerDay=1)

        problems = _validate(once, [_lesson(1), _lesson(1, "09:00:00", "10:00:00")])

        assert any("2 lessons on weekday 1" in problem for problem in problems), problems
        assert _validate(once, [_lesson(1), _lesson(2)]) == []

    def test_a_placed_lesson_beside_a_locked_one_breaks_the_cap(self) -> None:
        """The response alone holds one Monday lesson, which is within the cap;
        the request says another is locked there."""
        locked = _payload(lessonsPerWeek=1, maxLessonsPerDay=1, lockedDays=[1])

        assert _validate(locked, [_lesson(1)]) != []
        assert _validate(locked, [_lesson(2)]) == []

    def test_locked_lessons_alone_are_not_the_engine_s_fault(self) -> None:
        overfull = _payload(lessonsPerWeek=1, maxLessonsPerDay=1, minDaysBetween=2, lockedDays=[1, 1, 2])

        # Two locked Mondays and a locked Tuesday next to them, all by hand.
        assert _validate(overfull, [_lesson(4)]) == []
        # And one placed on Wednesday is beside the locked Tuesday.
        assert _validate(overfull, [_lesson(3)]) != []

    def test_consecutive_placed_days_break_the_spacing(self) -> None:
        apart = _payload(lessonsPerWeek=2, minDaysBetween=2)

        problems = _validate(apart, [_lesson(4), _lesson(5)])

        assert any("weekdays 4 and 5" in problem for problem in problems), problems
        assert _validate(apart, [_lesson(3), _lesson(5)]) == []
        assert _validate(apart, [_lesson(3), _lesson(3, "09:00:00", "10:00:00")]) == []


class TestTheTimeoutProbe:
    def test_the_rule_is_probed_and_the_locks_stay(self) -> None:
        solver = SchedulerSolver(_settings(**SHORT_WEEK))
        request = OptimizeScheduleRequest.model_validate(
            _payload(maxLessonsPerDay=1, minDaysBetween=2, lockedDays=[1]),
        )

        relaxations = dict(solver._timeout_relaxations(request))

        assert "PROBE_SOLVED_WITHOUT_DISTRIBUTION" in relaxations
        relaxed = relaxations["PROBE_SOLVED_WITHOUT_DISTRIBUTION"].requirements[0]
        assert relaxed.max_lessons_per_day is None
        assert relaxed.min_days_between is None
        assert relaxed.locked_days == [1]

    def test_either_half_alone_is_probed(self) -> None:
        solver = SchedulerSolver(_settings(**SHORT_WEEK))
        for rule in ({"maxLessonsPerDay": 1}, {"minDaysBetween": 2}):
            codes = [
                code for code, _relaxed in solver._timeout_relaxations(
                    OptimizeScheduleRequest.model_validate(_payload(**rule)),
                )
            ]
            assert "PROBE_SOLVED_WITHOUT_DISTRIBUTION" in codes

    def test_a_week_without_a_rule_is_not_probed_for_one(self) -> None:
        solver = SchedulerSolver(_settings(**SHORT_WEEK))
        codes = [
            code for code, _relaxed in solver._timeout_relaxations(
                OptimizeScheduleRequest.model_validate(_payload(lockedDays=[1])),
            )
        ]

        assert "PROBE_SOLVED_WITHOUT_DISTRIBUTION" not in codes

    def test_the_diagnosis_counts_the_requirements_with_a_rule(self) -> None:
        solver = SchedulerSolver(_settings(**SHORT_WEEK))

        assert "distributionRules=1," in solver._timeout_diagnosis(
            OptimizeScheduleRequest.model_validate(_payload(minDaysBetween=2)), "test",
        )
        assert "distributionRules=0," in solver._timeout_diagnosis(
            OptimizeScheduleRequest.model_validate(_payload()), "test",
        )


def test_the_estimate_still_bounds_the_model_it_predicts() -> None:
    solver = SchedulerSolver(_settings(**SHORT_WEEK))
    for payload in (
        _payload(maxLessonsPerDay=1),
        _payload(minDaysBetween=2),
        _payload(lessonsPerWeek=4, maxLessonsPerDay=2, minDaysBetween=2, lockedDays=[1, 5]),
        _payload(lessonsPerWeek=1, minDaysBetween=3, lockedDays=[3]),
    ):
        request = OptimizeScheduleRequest.model_validate(payload)
        model, *_ = solver._build_model(request, use_assumptions=False)
        assert solver._estimate_model_size(request) >= len(model.Proto().variables)


def test_the_rule_feeds_no_constant_to_the_start_step() -> None:
    """A day is `start // slots_per_day`, which rounding a start down to the
    step never moves — see _start_step. So the rule may not change the step,
    and a week searched every thirty minutes stays searched that way."""
    grid = SchedulerSolver(_settings(**SHORT_WEEK))._grid
    bare = OptimizeScheduleRequest.model_validate(_payload())
    ruled = OptimizeScheduleRequest.model_validate(
        _payload(maxLessonsPerDay=1, minDaysBetween=3, lockedDays=[2, 4]),
    )

    assert _start_step(ruled, grid) == _start_step(bare, grid)


#: The cases the gateway's warning and the web's dialogs replay, generated
#: from src/common/subject-distribution.ts — see its contract spec.
FIXTURE = (
    Path(__file__).resolve().parents[2]
    / "src/common/__fixtures__/subject-distribution-cases.json"
)


def _week_cases() -> list[dict[str, object]]:
    """The fixture's cases the engine's week can state: every week, no dates.

    The engine has no weeks at all — a lesson every odd week is a lesson —
    so the cases about parities and terms are the gateway's and the web's to
    agree on, and this checker is held to the rest.
    """
    import json

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


@pytest.mark.parametrize("case", _week_cases(), ids=lambda case: case["name"])
def test_the_checker_reads_the_rule_as_the_gateway_and_the_web_do(case: dict) -> None:
    """benchmarks/validate_schedule.py against the gateway's own verdicts.

    Every lesson of a case is one the solver PLACED, and the school locked
    none, so the checker's tolerance for locked-only breaches never applies
    and its verdict has to be the gateway's breach list, day for day.
    """
    import re

    rule = case["rule"]
    payload = _payload(
        lessonsPerWeek=max(1, len(case["lessons"])),
        maxLessonsPerDay=rule["maxLessonsPerDay"],
        minDaysBetween=rule["minDaysBetween"],
    )
    lessons = []
    for lesson in case["lessons"]:
        hour = 8 + sum(
            1 for other in lessons if other.day_of_week == lesson["dayOfWeek"]
        )
        lessons.append(_lesson(
            lesson["dayOfWeek"], f"{hour:02d}:00:00", f"{hour + 1:02d}:00:00",
        ))
    if not lessons:
        return

    found = set()
    # Every weekday a case names is a teaching day here: the fixture puts a
    # lesson on a Saturday, and a week without one would read it as a lesson
    # placed outside the week rather than as a day.
    for problem in _validate(payload, lessons, SCHEDULE_DAYS="1,2,3,4,5,6,7"):
        if (match := re.search(r"lessons on weekday (\d)", problem)) is not None:
            found.add(("PER_DAY", int(match.group(1))))
        elif (match := re.search(r"weekdays (\d) and (\d)", problem)) is not None:
            found.add(("DAYS_APART", int(match.group(1)), int(match.group(2))))
        else:
            # A lesson count or a clash would be the fixture's week, not the
            # rule's; the payload is built so that neither can happen.
            raise AssertionError(problem)
    expected = {
        ("PER_DAY", breach["dayOfWeek"])
        if breach["kind"] == "PER_DAY"
        else ("DAYS_APART", breach["firstDay"], breach["secondDay"])
        for breach in case["breaches"]
    }
    assert found == expected
