"""A corpus week is one the ENGINE takes, held to the engine and not to a copy of its rules (M5).

test_school_corpus.py asks the engine's `_validate_request` and `_estimate_model_size`. The
refusals of the school week are not there: an UNAVAILABLE reservation on a weekday outside
SCHEDULE_DAYS is accepted by `_validate_request` and by `check_week`, and refused only when the
model is built (`_add_availability_constraints`: INPUT_CONSTRAINT_TIME_OFF_GRID, for the WHOLE
run; engine-reservations-need-school-week). So the week is built here, as a solve builds it, and
not solved: building every week of the sweep takes a few seconds.
"""

from __future__ import annotations

import sys
from collections import defaultdict
from dataclasses import replace
from pathlib import Path

import pytest

_BENCH = Path(__file__).resolve().parents[1] / "benchmarks"
if str(_BENCH) not in sys.path:
    sys.path.insert(0, str(_BENCH))

import school_corpus as corpus  # noqa: E402
from app.config import Settings  # noqa: E402
from app.solver.scheduler_solver import SchedulerSolver  # noqa: E402


@pytest.fixture(scope="module")
def solver() -> SchedulerSolver:
    return SchedulerSolver(Settings(SOLVER_MAX_TIME_SECONDS=5))  # type: ignore[call-arg]


def test_the_engine_builds_the_model_of_every_week_of_the_sweep(solver: SchedulerSolver) -> None:
    for shape in corpus.sweep_shapes(seeds=(1,)):
        week = corpus.build_week(shape)
        try:
            solver._build_model(week.request, use_assumptions=False, include_objective=False)
        except Exception as error:  # noqa: BLE001
            pytest.fail(f"the engine refuses to build {week.name}: {type(error).__name__}: {error}")


def test_every_reservation_and_frame_stands_on_a_day_of_the_school_week(solver: SchedulerSolver) -> None:
    """Held beside the engine's own build, because the engine reads a frame on a day outside
    SCHEDULE_DAYS by ignoring it, and a week whose frame is silently dropped is another week."""
    school_days = set(solver._grid.schedule_days)
    for shape in (corpus.BASE, corpus.PRODUCTION, replace(corpus.BASE, classes_per_year=6)):
        request = corpus.build_week(shape).request
        assert request.constraints, "a teacher's reservation is part of the form"
        assert {constraint.day_of_week for constraint in request.constraints} <= school_days
        assert {frame.day_of_week for frame in request.frame_times} == school_days


def test_every_teacher_with_a_post_has_exactly_one_reservation_inside_the_frame() -> None:
    request = corpus.build_week(replace(corpus.BASE, classes_per_year=3, shared_teachers=2)).request
    reserved: dict[object, int] = defaultdict(int)
    for constraint in request.constraints:
        assert constraint.resource_kind == "TEACHER"
        assert constraint.kind == "UNAVAILABLE"
        assert "08:00:00" <= constraint.start_time < constraint.end_time <= "16:00:00"
        reserved[constraint.resource_id] += 1
    teachers = {requirement.teacher_id for requirement in request.requirements}
    assert set(reserved) == teachers
    assert set(reserved.values()) == {1}


def test_a_teacher_on_two_groups_that_share_a_pupil_is_no_shared_teacher_to_the_engine_nor_to_the_corpus() -> None:
    """Held to the engine on a request no generator shape makes: two groups that share a pupil are
    not parallel, so one teacher on both is not what M counts (week_load._shared_teachers)."""
    request = corpus.build_week(replace(corpus.BASE, classes_per_year=4, group_subjects=3, languages=0)).request
    request = request.model_copy(deep=True)
    pairs = {frozenset(pair) for pair in request.group_conflicts}
    classes = {group.id for group in request.groups}
    groups = [r for r in request.requirements if r.student_group_id not in classes and r.min_grade_level == 7]
    first, second = next(
        (a, b) for a in groups for b in groups
        if a.id != b.id and a.teacher_id != b.teacher_id
        and frozenset((a.student_group_id, b.student_group_id)) in pairs
    )
    second.teacher_id = first.teacher_id
    solver = SchedulerSolver(Settings(SOLVER_MAX_TIME_SECONDS=5))  # type: ignore[call-arg]
    solver.TIGHT_WEEK_LOAD = 0.0  # every year, however light: the list is named only above the threshold
    engine = {teacher.teacher_id for load in solver._week_loads(request) for teacher in load.shared}
    assert first.teacher_id not in engine
    assert corpus.shared_teacher_ids_of(request) == engine

    # And a teacher on a group and on a class the group takes no pupil from: no home class in
    # common (a class has none), so not shared either.
    a_group = groups[-1]
    a_class = next(
        r for r in request.requirements
        if r.student_group_id in classes and r.min_grade_level == 7
        and frozenset((a_group.student_group_id, r.student_group_id)) not in pairs
    )
    a_class.teacher_id = a_group.teacher_id
    engine = {teacher.teacher_id for load in solver._week_loads(request) for teacher in load.shared}
    assert a_group.teacher_id not in engine
    assert corpus.shared_teacher_ids_of(request) == engine
