"""Ett schema som start, granskningen av #460: what the schedule clashes with before the first attempt is asked.

Whatever `staged.clashes` does not name costs a round: an INFEASIBLE proof, its explanation and a build, and a
refusal names the pins of its core, often one. After MAX_ROUNDS the whole schedule is let go. The week from the
review: a schedule that lists each lesson once for every term (two entries a lesson) was held as two places of one
requirement at one time and refused one requirement a round; six reservations of classes the schedule's lessons sat
in did the same. Both ended in a plain solve, seven attempts later, with the schedule only a hint.
"""

from __future__ import annotations

import sys
import uuid
from dataclasses import replace
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "benchmarks"))

from app.config import Settings  # noqa: E402
from app.schemas.schedule import AnonymousConstraint, OptimizeScheduleRequest, StartedLesson  # noqa: E402
from app.solver import staged  # noqa: E402
from app.solver.scheduler_solver import SchedulerSolver  # noqa: E402
from school_corpus import SchoolShape, build_week  # noqa: E402

SHAPE = SchoolShape(classes_per_year=2, group_subjects=3, mixing=0.5, seed=1)
OTHER = replace(SHAPE, seed=2)


def _clock(total: int) -> str:
    return f"{total // 60:02d}:{total % 60:02d}:00"


def _entry(requirement, day: int, start: int) -> StartedLesson:  # noqa: ANN001
    return StartedLesson(requirementId=requirement.id, dayOfWeek=day, startTime=_clock(start), endTime=_clock(start + requirement.lesson_minutes()[0]))


def _week_with(entries_of: dict, **change):  # noqa: ANN001, ANN003, ANN202
    """The week with these entries as its startLessons: {requirement index: [(day, start minute), ...]}."""
    request = build_week(SHAPE).request.model_copy(update={"group_conflicts": [], "constraints": [], **change})
    entries = [
        _entry(request.requirements[index], day, start) for index, places in entries_of.items() for day, start in places
    ]
    return request.model_copy(update={"start_lessons": entries})


def test_the_same_lesson_listed_twice_is_one_lesson() -> None:
    request = _week_with({0: [(1, 480), (1, 480), (3, 600), (3, 600)]})
    two = request.requirements[0]
    assert two.lessons_per_week >= 2

    held = staged.held_places(request)

    row = held.places[two.id]
    assert [(p.day_of_week, p.start_time) for p in row if p is not None][:2] == [(1, "08:00:00"), (3, "10:00:00")], "not the first lesson twice"
    assert held.dropped["the same lesson twice"] == 2
    assert staged.clashes(request, held) == set()


def test_a_requirement_with_two_places_at_one_time_clashes_with_itself() -> None:
    request = _week_with({0: [(1, 480), (1, 510)]})   # the second lesson starts half an hour into the first
    held = staged.held_places(request)
    assert staged.clashes(request, held) == {request.requirements[0].id}


def test_a_co_teacher_in_two_places_clashes() -> None:
    request = _week_with({0: [(1, 480)], 1: [(1, 480)]})
    first, second = request.requirements[0], request.requirements[1]
    assert first.teacher_id != second.teacher_id
    request = request.model_copy(update={"requirements": [first.model_copy(update={"co_teacher_id": second.teacher_id}), *request.requirements[1:]]})

    held = staged.held_places(request)

    assert {first.id, second.id} <= staged.clashes(request, held)


def _reservation(kind: str, **fields) -> AnonymousConstraint:  # noqa: ANN003
    return AnonymousConstraint(id=uuid.uuid4(), resourceKind=kind, dayOfWeek=1, startTime="08:00:00", endTime="09:00:00", kind="UNAVAILABLE", **fields)


def test_a_reservation_of_a_class_clashes_with_the_lessons_it_covers_and_a_reservation_of_another_does_not() -> None:
    request = _week_with({0: [(1, 480)], 1: [(1, 480)]})
    first, second = request.requirements[0], request.requirements[1]
    assert first.student_group_id != second.student_group_id
    held = staged.held_places(request)

    covers_first = request.model_copy(update={"constraints": [_reservation("STUDENT_GROUP", resourceId=first.student_group_id)]})
    assert staged.clashes(covers_first, held) == {first.id}
    elsewhere = request.model_copy(update={"constraints": [_reservation("STUDENT_GROUP", resourceId=uuid.uuid4())]})
    assert staged.clashes(elsewhere, held) == set()
    after = request.model_copy(update={"constraints": [AnonymousConstraint(id=uuid.uuid4(), resourceKind="STUDENT_GROUP", resourceId=first.student_group_id, dayOfWeek=1, startTime="09:00:00", endTime="10:00:00", kind="UNAVAILABLE")]})
    assert staged.clashes(after, held) == set(), "a lesson that ends where the reservation starts is not in it"
    dated = request.model_copy(update={"constraints": [_reservation("STUDENT_GROUP", resourceId=first.student_group_id, date="2027-01-12")]})
    assert staged.clashes(dated, held) == set(), "a one-off date is not the weekly schedule's"


def test_a_reservation_of_a_span_of_years_clashes_with_the_groups_in_it() -> None:
    request = _week_with({0: [(1, 480)]})
    first = request.requirements[0]
    request = request.model_copy(update={"requirements": [first.model_copy(update={"min_grade_level": 7, "max_grade_level": 7}), *request.requirements[1:]]})
    held = staged.held_places(request)

    in_span = request.model_copy(update={"constraints": [_reservation("GRADE_LEVEL", minGradeLevel=7, maxGradeLevel=8)]})
    assert staged.clashes(in_span, held) == {first.id}
    out_of_span = request.model_copy(update={"constraints": [_reservation("GRADE_LEVEL", minGradeLevel=8, maxGradeLevel=9)]})
    assert staged.clashes(out_of_span, held) == set()


def _settings() -> Settings:
    return Settings(SOLVER_MAX_TIME_SECONDS=30.0, SOLVER_PROBE_SECONDS=0)  # type: ignore[call-arg]


@pytest.fixture(scope="module")
def schedule_of_the_week() -> list:
    answer = SchedulerSolver(_settings()).solve(build_week(OTHER).request)
    assert answer.status in ("OPTIMAL", "FEASIBLE")
    return answer.lessons


def _attempts(monkeypatch: pytest.MonkeyPatch) -> list[int]:
    held_per_attempt: list[int] = []
    original = SchedulerSolver._solve_strict

    def counted(self, request, entered):  # noqa: ANN001, ANN202
        held_per_attempt.append(sum(1 for r in request.requirements if r.pinned_lessons is not None))
        return original(self, request, entered)

    monkeypatch.setattr(SchedulerSolver, "_solve_strict", counted)
    return held_per_attempt


def test_a_schedule_that_lists_every_lesson_twice_is_held_in_the_first_attempt(
    schedule_of_the_week: list, monkeypatch: pytest.MonkeyPatch,
) -> None:
    entries = [
        StartedLesson(requirementId=l.requirement_id, dayOfWeek=l.day_of_week, startTime=l.start_time, endTime=l.end_time)
        for l in schedule_of_the_week
    ]
    request = build_week(OTHER).request.model_copy(update={"start_lessons": [*entries, *entries]})
    attempts = _attempts(monkeypatch)

    answer = SchedulerSolver(_settings()).solve(request)

    assert answer.status in ("OPTIMAL", "FEASIBLE")
    assert len(attempts) == 1 and attempts[0] == len({l.requirement_id for l in schedule_of_the_week}), attempts


def test_reservations_of_classes_in_the_schedule_cost_no_round(
    schedule_of_the_week: list, monkeypatch: pytest.MonkeyPatch,
) -> None:
    request = build_week(OTHER).request
    by_id = {r.id: r for r in request.requirements}
    seen: set = set()
    reserved: list[AnonymousConstraint] = []
    for lesson in schedule_of_the_week:
        group = by_id[lesson.requirement_id].student_group_id
        if group in seen:
            continue
        seen.add(group)
        reserved.append(AnonymousConstraint(
            id=uuid.uuid4(), resourceKind="STUDENT_GROUP", resourceId=group, dayOfWeek=lesson.day_of_week,
            startTime=lesson.start_time, endTime=lesson.end_time, kind="UNAVAILABLE",
        ))
        if len(reserved) == 7:
            break
    request = request.model_copy(update={
        "constraints": [*request.constraints, *reserved],
        "start_lessons": [StartedLesson(requirementId=l.requirement_id, dayOfWeek=l.day_of_week, startTime=l.start_time, endTime=l.end_time) for l in schedule_of_the_week],
    })
    attempts = _attempts(monkeypatch)

    answer = SchedulerSolver(_settings()).solve(request)

    assert answer.status in ("OPTIMAL", "FEASIBLE")
    assert len(attempts) == 1, f"{len(attempts)} attempts: each reservation the schedule sat in cost a refusal"
    assert attempts[0] >= 60, f"{attempts[0]} requirements held in the first attempt: the schedule was let go, not the seven"
