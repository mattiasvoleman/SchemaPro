"""The teacher-idle objective, which had no test at all before this file.

`_add_teacher_gap_objective` was never invoked by name in any test. Nothing
would have noticed if it had stopped being posted, if its 600-pair guard had
moved, or if its weight had stopped doing anything — and it shipped a defect
this file's subject is the fix for: a teacher was charged for the hole their own
protected break created.

The assertions are on the OBJECTIVE VALUE of a solved model rather than on the
placement it chose. A compact day and a scattered one are both feasible on any
week with room, so "where did the lessons land" answers the solver's taste; what
the objective is FOR is which of the two costs less.
"""

from __future__ import annotations

from uuid import uuid4

import pytest
from ortools.sat.python import cp_model

from app.config import Settings
from app.schemas.schedule import OptimizeScheduleRequest
from app.solver.scheduler_solver import SchedulerSolver


def _settings(**overrides: object) -> Settings:
    return Settings(SOLVER_MAX_TIME_SECONDS=5.0, **overrides)  # type: ignore[arg-type]


TEACHER = str(uuid4())
GROUP = str(uuid4())


def _payload(
    *,
    lessons_per_week: int = 3,
    constraints: list[dict[str, object]] | None = None,
    teacher_gap: int | None = None,
) -> dict[str, object]:
    """One teacher, one class, one room, one day, 08:00-13:00.

    A single day is what makes the objective's arithmetic visible: with five
    days the solver spreads the lessons and every idle term is zero whatever the
    encoding says.
    """
    payload: dict[str, object] = {
        "requestId": str(uuid4()),
        "academicYearId": str(uuid4()),
        "requirements": [
            {
                "id": str(uuid4()),
                "subjectId": str(uuid4()),
                "studentGroupId": GROUP,
                "teacherId": TEACHER,
                "lessonsPerWeek": lessons_per_week,
                "minutesPerLesson": 60,
                "studentGroupSize": 24,
                "minGradeLevel": 4,
                "maxGradeLevel": 6,
            }
        ],
        "groups": [
            {"id": GROUP, "lunchHeadcount": 24, "minGradeLevel": 4, "maxGradeLevel": 6},
        ],
        "rooms": [{"id": str(uuid4()), "capacity": 30}],
        "constraints": constraints or [],
        "frameTimes": [
            {
                "minGradeLevel": 0,
                "maxGradeLevel": 12,
                "dayOfWeek": None,
                "startTime": "08:00:00",
                "endTime": "13:00:00",
            },
        ],
    }
    if teacher_gap is not None:
        payload["weights"] = {"teacherGap": teacher_gap}
    return payload


def _closure(start: str, end: str, day: int = 1) -> dict[str, object]:
    return {
        "id": str(uuid4()),
        "resourceKind": "TEACHER",
        "resourceId": TEACHER,
        "dayOfWeek": day,
        "date": None,
        "startTime": f"{start}:00",
        "endTime": f"{end}:00",
        "kind": "UNAVAILABLE",
    }


def _idle_cost(
    payload: dict[str, object],
    placements: list[tuple[int, int]],
    *,
    days: str = "1",
) -> float:
    """The idle term alone, for lessons pinned where the test says.

    Nothing else is posted — not spread, not disruption, not the room
    preference — so the number that comes back is this objective's own opinion
    and no other's. Pinning the placements is what makes it an assertion about
    the ENCODING rather than about the solver's taste: a compact day and a
    scattered one are both feasible on any week with room.

    `placements` are (day_index, slot_within_day) pairs, one per lesson, in the
    order _create_lesson_decisions returns them. The return value is in SLOTS,
    the weight divided out.
    """
    solver = SchedulerSolver(_settings(SCHEDULE_DAYS=days))
    request = OptimizeScheduleRequest.model_validate(payload)
    model = cp_model.CpModel()
    decisions = solver._create_lesson_decisions(
        model, request.requirements, len(request.rooms),
        request.frame_times, request.rasts,
    )
    assert len(decisions) == len(placements), (len(decisions), len(placements))

    day_vars: dict[str, cp_model.IntVar] = {}
    terms = solver._add_idle_time_objective(
        model, decisions, request.constraints, solver._resolve_weights(request), day_vars,
    )
    for decision, (day_index, slot) in zip(decisions, placements):
        model.Add(decision.start == day_index * solver._grid.slots_per_day + slot)
    model.Minimize(sum(terms) if terms else 0)

    cp = cp_model.CpSolver()
    cp.parameters.max_time_in_seconds = 5.0
    assert cp.Solve(model) in {cp_model.OPTIMAL, cp_model.FEASIBLE}
    # Divided by the weight, so the assertions below read as SLOTS. The weight
    # has its own test; mixing the two would make every number here move when a
    # default changes for reasons that have nothing to do with the shape.
    weight = solver._resolve_weights(request).teacher_gap
    return cp.ObjectiveValue() / weight if weight else cp.ObjectiveValue()


#: Slots from 08:00 on a five-minute grid.
def _at(hhmm: str) -> int:
    hours, minutes = (int(part) for part in hhmm.split(":"))
    return (hours * 60 + minutes - 8 * 60) // 5


def _idle_minutes(payload: dict[str, object]) -> int:
    """Solve one day and read the teacher's idle minutes off the placement.

    Read from the answer rather than from the objective value, because the
    objective also carries spread, disruption and room preferences; what this
    file is about is the one term.
    """
    solver = SchedulerSolver(_settings(SCHEDULE_DAYS="1"))
    response = solver.solve(OptimizeScheduleRequest.model_validate(payload))
    assert response.status in {"OPTIMAL", "FEASIBLE"}, response.status
    minutes = sorted(
        (
            int(lesson.start_time[:2]) * 60 + int(lesson.start_time[3:5]),
            int(lesson.end_time[:2]) * 60 + int(lesson.end_time[3:5]),
        )
        for lesson in response.lessons
    )
    span = minutes[-1][1] - minutes[0][0]
    taught = sum(end - start for start, end in minutes)
    return span - taught


class TestTheDayIsMeasuredOnce:
    def test_a_day_with_no_lesson_is_not_a_reward(self) -> None:
        """The floor at zero, which only a day the teacher is absent can see.

        On a day the teacher IS present, `last - first` is at least the taught
        minutes by construction, so the term cannot go negative and the floor
        never binds. On an EMPTY day nothing constrains first or last at all —
        and minimising an unfloored `idle` would drive it to minus a whole day,
        paying a teacher handsomely for every day they do not work.
        """
        cost = _idle_cost(
            _payload(lessons_per_week=2),
            [(0, _at("08:00")), (0, _at("09:00"))],
            days="1,2",
        )

        assert cost == 0

    def test_taught_minutes_are_counted_for_the_day_not_the_week(self) -> None:
        """`taught` is summed over the lessons ON THIS DAY, not over all of them.

        Summing the whole week makes a scattered day look full: the hole is
        subtracted twice over by lessons that are somewhere else entirely, and
        the term reads zero on exactly the day it exists to price.
        """
        cost = _idle_cost(
            _payload(lessons_per_week=3),
            [(0, _at("08:00")), (0, _at("11:00")), (1, _at("08:00"))],
            days="1,2",
        )

        # Day one: 08:00-12:00 is 48 slots, 24 taught, so 24 idle. Day two has
        # one lesson and no span of its own.
        assert cost == 24

    def test_a_day_the_teacher_is_not_in_costs_nothing(self) -> None:
        """The presence literals, which a single-day fixture cannot see.

        Without them `first` and `last` span every lesson the teacher has all
        week, so two lessons on two different days would be charged the whole
        night between them — a number larger than the school day itself.
        """
        cost = _idle_cost(
            _payload(lessons_per_week=2),
            [(0, _at("08:00")), (1, _at("08:00"))],
            days="1,2",
        )

        assert cost == 0

    def test_three_lessons_are_packed_into_an_unbroken_chain(self) -> None:
        # The old pairwise encoding charged the FIRST and THIRD lesson the hour
        # between them even in a perfectly gapless chain, so a teacher paid for
        # the middle lesson's own length and their third lesson was pushed off
        # the day. Measured once per day, a chain costs nothing.
        assert _idle_minutes(_payload(lessons_per_week=3)) == 0

    def test_a_scattered_day_costs_more_than_a_compact_one(self) -> None:
        # The objective's whole purpose, and it had no test.
        solver = SchedulerSolver(_settings(SCHEDULE_DAYS="1"))
        request = OptimizeScheduleRequest.model_validate(_payload(lessons_per_week=2))
        model, _, decisions, _, _ = solver._build_model(
            request, use_assumptions=False, include_objective=True,
        )
        cp = cp_model.CpSolver()
        cp.parameters.max_time_in_seconds = 5.0
        assert cp.Solve(model) in {cp_model.OPTIMAL, cp_model.FEASIBLE}
        compact = cp.ObjectiveValue()

        # Force a two-hour hole between them and re-solve.
        first, second = decisions[0], decisions[1]
        model.Add(second.start >= first.end + 24)
        assert cp.Solve(model) in {cp_model.OPTIMAL, cp_model.FEASIBLE}
        assert cp.ObjectiveValue() > compact


class TestTheProtectedBreak:
    def test_a_teacher_is_not_charged_for_their_own_reserved_time(self) -> None:
        """The defect the old encoding shipped.

        The one way a teacher can reserve their own time is an UNAVAILABLE row
        on themselves. The pairwise gap read only lesson variables, so the hole
        that row creates was charged to them at full price — the objective
        fought the only protection the product offers.

        Two lessons pinned at 08:00 and 11:00 leave a two-hour hole, one of
        which the teacher had reserved. Twelve slots of idle become twelve minus
        the twelve credited... which is exactly the shape a test has to state as
        a NUMBER, or it proves nothing about the credit at all.
        """
        without = _idle_cost(
            _payload(lessons_per_week=2),
            [(0, _at("08:00")), (0, _at("11:00"))],
        )
        # 08:00-12:00 is 48 slots of span, 24 taught, so 24 slots idle.
        assert without == 24

        with_break = _idle_cost(
            _payload(lessons_per_week=2, constraints=[_closure("10:00", "11:00")]),
            [(0, _at("08:00")), (0, _at("11:00"))],
        )
        # The reserved hour is twelve of those slots and is no longer charged.
        assert with_break == 12

    def test_two_overlapping_rows_are_credited_once(self) -> None:
        # Summing the matching windows' lengths would pay a teacher twice for an
        # hour they wrote down in two forms.
        solver = SchedulerSolver(_settings(SCHEDULE_DAYS="1"))
        request = OptimizeScheduleRequest.model_validate(
            _payload(
                constraints=[_closure("10:00", "11:00"), _closure("10:30", "11:30")],
            ),
        )
        windows = solver._protected_windows(request.constraints)
        merged = windows[(request.constraints[0].resource_id, 1)]
        assert len(merged) == 1
        (start, end), = merged
        assert (end - start) * solver._grid.slot_minutes == 90

    def test_another_teachers_row_is_not_credited(self) -> None:
        solver = SchedulerSolver(_settings(SCHEDULE_DAYS="1"))
        other = dict(_closure("10:00", "11:00"))
        other["resourceId"] = str(uuid4())
        request = OptimizeScheduleRequest.model_validate(_payload(constraints=[other]))
        windows = solver._protected_windows(request.constraints)
        assert (TEACHER, 1) not in {(str(k[0]), k[1]) for k in windows}

    def test_a_dated_row_is_not_credited(self) -> None:
        # The model is one generic week and has nowhere to put a single date —
        # the same rule _add_availability_constraints follows.
        solver = SchedulerSolver(_settings(SCHEDULE_DAYS="1"))
        dated = dict(_closure("10:00", "11:00"))
        dated["date"] = "2026-09-07"
        request = OptimizeScheduleRequest.model_validate(_payload(constraints=[dated]))
        assert solver._protected_windows(request.constraints) == {}

    def test_a_group_row_is_not_credited(self) -> None:
        # A stage's rast subtracts from a GROUP's lesson domain and says nothing
        # about where a teacher is. Crediting it would pay a teacher for a break
        # they spent teaching another class.
        solver = SchedulerSolver(_settings(SCHEDULE_DAYS="1"))
        group_row = dict(_closure("10:00", "11:00"))
        group_row["resourceKind"] = "STUDENT_GROUP"
        group_row["resourceId"] = GROUP
        request = OptimizeScheduleRequest.model_validate(_payload(constraints=[group_row]))
        assert solver._protected_windows(request.constraints) == {}


class TestTheWeight:
    def test_zero_posts_nothing(self) -> None:
        # Asserted with REAL decisions. An empty list returns no terms whatever
        # the weight says, so a fixture without lessons would pass against a
        # builder that had stopped reading the weight at all.
        solver = SchedulerSolver(_settings(SCHEDULE_DAYS="1"))
        request = OptimizeScheduleRequest.model_validate(
            _payload(lessons_per_week=3, teacher_gap=0),
        )
        model = cp_model.CpModel()
        decisions = solver._create_lesson_decisions(
            model, request.requirements, len(request.rooms),
            request.frame_times, request.rasts,
        )
        assert decisions

        terms = solver._add_idle_time_objective(
            model, decisions, request.constraints, solver._resolve_weights(request), {},
        )

        assert terms == []

    def test_a_teacher_with_one_lesson_gets_no_terms(self) -> None:
        # One lesson is a span equal to its own length: the variables would be
        # provably zero, and building them is thousands of free literals in a
        # school where most teachers take a class once a week.
        solver = SchedulerSolver(_settings(SCHEDULE_DAYS="1"))
        request = OptimizeScheduleRequest.model_validate(_payload(lessons_per_week=1))
        model = cp_model.CpModel()
        decisions = solver._create_lesson_decisions(
            model, request.requirements, len(request.rooms),
            request.frame_times, request.rasts,
        )

        terms = solver._add_idle_time_objective(
            model, decisions, request.constraints, solver._resolve_weights(request), {},
        )

        assert terms == []

    def test_the_heaviest_teacher_is_no_longer_skipped(self) -> None:
        """The 600-pair guard is gone with the encoding that needed it.

        Above 35 lessons a teacher's pairs exceeded 600 and the whole teacher was
        skipped — silently, with nothing logged and nothing in the response. The
        one teacher a compact day matters most to was the one the objective
        ignored. A day is O(lessons), so no guard is needed.
        """
        solver = SchedulerSolver(_settings(SCHEDULE_DAYS="1,2,3,4,5"))
        request = OptimizeScheduleRequest.model_validate(_payload(lessons_per_week=40))
        model = cp_model.CpModel()
        decisions = solver._create_lesson_decisions(
            model, request.requirements, len(request.rooms),
            request.frame_times, request.rasts,
        )

        terms = solver._add_idle_time_objective(
            model, decisions, request.constraints, solver._resolve_weights(request), {},
        )

        # 40 lessons is 780 pairs — well past the old cap, which returned none.
        assert len(terms) == len(solver._grid.schedule_days)
