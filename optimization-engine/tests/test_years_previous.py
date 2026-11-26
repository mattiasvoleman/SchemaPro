"""Årskurs för årskurs, granskningen av #482: the road keeps the previous schedule as the hint it is for the year it lays.

A school that re-generates sends `previousLessons`, and phase 1b (the clone of the full model, hinted with them) settles into
last term's week by moving what has to move: 14 of 138 lessons in the review's probe. The road laid the week from nothing, put
its own timetable in place of those hints, and phase 1b took it: 126 of 138 lessons moved. The steps are the engine's own
satisfaction model and are built without the disruption term's hints, so the previous slots of the year being laid are hinted
here, and a previous schedule that is valid for the week is what the road gives back.
"""

from __future__ import annotations

import sys
from collections import Counter
from pathlib import Path

_BENCH = Path(__file__).resolve().parents[1] / "benchmarks"
if str(_BENCH) not in sys.path:
    sys.path.insert(0, str(_BENCH))

from app.config import Settings  # noqa: E402
from app.schemas.schedule import PreviousLesson, SearchOptions  # noqa: E402
from app.solver import years  # noqa: E402
from app.solver.scheduler_solver import SchedulerSolver  # noqa: E402
from school_corpus import SchoolShape, build_week  # noqa: E402

SHAPE = SchoolShape(classes_per_year=2, group_subjects=3, mixing=0.5, seed=1)


def _settings() -> Settings:
    return Settings(SOLVER_MAX_TIME_SECONDS=30, SOLVER_PROBE_SECONDS=0)  # type: ignore[call-arg]


def _slots(lessons) -> Counter:  # noqa: ANN001
    return Counter((lesson.requirement_id, lesson.day_of_week, lesson.start_time) for lesson in lessons)


def test_a_step_hints_the_previous_slots_of_the_year_it_lays_and_of_no_other() -> None:
    request = build_week(SHAPE).request
    first, second, _third = years.units_of(request) or []
    previous = [
        PreviousLesson(requirementId=r.id, dayOfWeek=1, startTime="08:00:00") for r in request.requirements
    ]
    request = request.model_copy(update={"previous_lessons": previous})

    step = years.step_request(request, second.ids, {}, "years-2")

    assert {p.requirement_id for p in step.previous_lessons} == second.ids
    assert first.ids.isdisjoint({p.requirement_id for p in step.previous_lessons})


def test_the_road_gives_back_a_previous_schedule_that_is_valid_for_the_week() -> None:
    request = build_week(SHAPE).request.model_copy(update={"search": SearchOptions(seed=1, workers=1)})
    solver = SchedulerSolver(_settings())
    earlier = solver.solve(request)
    assert earlier.lessons, earlier.status
    again = request.model_copy(update={"previous_lessons": [
        PreviousLesson(requirementId=l.requirement_id, dayOfWeek=l.day_of_week, startTime=l.start_time) for l in earlier.lessons
    ]})

    laid = SchedulerSolver(_settings())._lay_by_years(again, 120.0)

    assert laid is not None
    kept = _slots(earlier.lessons) & Counter((p.requirement_id, p.day_of_week, p.start_time) for p in laid)
    moved = len(earlier.lessons) - sum(kept.values())
    assert moved <= len(earlier.lessons) // 10, f"the road moved {moved} of {len(earlier.lessons)} lessons of a schedule that was valid"
