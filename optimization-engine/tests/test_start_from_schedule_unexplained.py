"""Ett schema som start, granskningen av #460: a week that has a timetable is not refused for what the schedule held.

DEPLOYMENT §35.8 says it, and it held only where the refusal named something: a request that turned its probes off
(a candidate run) is refused without an explanation, `in_the_way` has nothing to read, and with nothing free to
widen from the driver returned the INFEASIBLE of the attempt that held the whole schedule.
"""

from __future__ import annotations

import sys
import uuid
from dataclasses import replace
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "benchmarks"))

from app.config import Settings  # noqa: E402
from app.schemas.schedule import FixedLesson, SearchOptions, StartedLesson  # noqa: E402
from app.solver.scheduler_solver import SchedulerSolver  # noqa: E402
from school_corpus import SchoolShape, build_week  # noqa: E402

SHAPE = SchoolShape(classes_per_year=2, group_subjects=3, mixing=0.5, seed=1)
OTHER = replace(SHAPE, seed=2)


def _settings() -> Settings:
    return Settings(SOLVER_MAX_TIME_SECONDS=30.0, SOLVER_PROBE_SECONDS=0)  # type: ignore[call-arg]


def test_a_lock_the_schedule_sits_on_does_not_refuse_a_week_that_has_a_timetable() -> None:
    week = build_week(OTHER).request
    schedule = SchedulerSolver(_settings()).solve(week)
    assert schedule.status in ("OPTIMAL", "FEASIBLE")
    lesson = schedule.lessons[0]
    requirement = next(r for r in week.requirements if r.id == lesson.requirement_id)
    # A lock of the requirement's own teacher at the hour the schedule has the lesson: this week's fact, not the schedule's.
    lock = FixedLesson(
        id=uuid.uuid4(), teacherId=requirement.teacher_id, studentGroupId=requirement.student_group_id,
        dayOfWeek=lesson.day_of_week, startTime=lesson.start_time, endTime=lesson.end_time,
    )
    week = week.model_copy(update={
        "fixed_lessons": [lock],
        "search": SearchOptions(probes=False),   # a candidate run: refused with no explanation
    })
    started = week.model_copy(update={"start_lessons": [
        StartedLesson(requirementId=l.requirement_id, dayOfWeek=l.day_of_week, startTime=l.start_time, endTime=l.end_time)
        for l in schedule.lessons
    ]})
    assert SchedulerSolver(_settings()).solve(week).status in ("OPTIMAL", "FEASIBLE"), "the week has a timetable without the schedule"

    answer = SchedulerSolver(_settings()).solve(started)

    assert answer.status in ("OPTIMAL", "FEASIBLE"), answer.status
