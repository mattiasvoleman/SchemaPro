"""Ett schema som start, granskningen av #460: a TIMEOUT does not talk about placed lessons the school never placed.

The probe of a TIMEOUT tries the week with its pinned lessons released and, where that finds a timetable, says so
in the school's words for the Förlägg page: "with the placed lessons let go, a timetable was found". An attempt
of the driver holds a schedule as pinned lessons, and a TIMEOUT is final at the first attempt that has them: the
same week without startLessons said one rule helped, and with it said two, one of them about lessons nobody placed.
"""

from __future__ import annotations

import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "benchmarks"))

import app.solver.scheduler_solver as scheduler_solver  # noqa: E402
from app.config import Settings  # noqa: E402
from app.schemas.schedule import PinnedLesson, StartedLesson  # noqa: E402
from app.solver.scheduler_solver import SchedulerSolver  # noqa: E402
from ortools.sat.python import cp_model  # noqa: E402
from school_corpus import SchoolShape, build_week  # noqa: E402

SHAPE = SchoolShape(classes_per_year=2, group_subjects=3, mixing=0.5, seed=1)
RELEASED = "PROBE_SOLVED_WITH_PLACEMENTS_RELEASED"


def _the_searches_find_nothing(monkeypatch: pytest.MonkeyPatch) -> None:
    """Phase 1a and 1b find nothing in their time (the probes after them are real)."""
    original = scheduler_solver._solve_guarded

    def guarded(solver, model, *args, **kwargs):  # noqa: ANN001, ANN002, ANN003, ANN202
        if str(kwargs.get("what", "")).startswith("phase 1"):
            return cp_model.UNKNOWN
        return original(solver, model, *args, **kwargs)

    monkeypatch.setattr(scheduler_solver, "_solve_guarded", guarded)


def _rows(request) -> list[str]:  # noqa: ANN001
    answer = SchedulerSolver(Settings(SOLVER_MAX_TIME_SECONDS=2.0, SOLVER_PROBE_SECONDS=6.0)).solve(request)  # type: ignore[call-arg]
    assert answer.status == "TIMEOUT"
    return [row.code for row in answer.conflicts.conflicts] if answer.conflicts is not None else []


@pytest.fixture(scope="module")
def schedule() -> list:
    answer = SchedulerSolver(Settings(SOLVER_MAX_TIME_SECONDS=20.0, SOLVER_PROBE_SECONDS=0)).solve(build_week(SHAPE).request)  # type: ignore[call-arg]
    assert answer.lessons
    return answer.lessons


def test_a_timeout_from_a_schedule_does_not_say_placed_lessons_were_in_the_way(schedule: list, monkeypatch: pytest.MonkeyPatch) -> None:
    week = build_week(SHAPE).request
    started = week.model_copy(update={"start_lessons": [
        StartedLesson(requirementId=l.requirement_id, dayOfWeek=l.day_of_week, startTime=l.start_time, endTime=l.end_time)
        for l in schedule
    ]})
    _the_searches_find_nothing(monkeypatch)

    assert RELEASED not in _rows(started)


def test_a_timeout_where_the_school_did_place_lessons_still_says_so(schedule: list, monkeypatch: pytest.MonkeyPatch) -> None:
    week = build_week(SHAPE).request
    first = week.requirements[0]
    lesson = next(l for l in schedule if l.requirement_id == first.id)
    pins = [PinnedLesson(dayOfWeek=lesson.day_of_week, startTime=lesson.start_time, endTime=lesson.end_time)] + [None] * (first.lessons_per_week - 1)
    placed = week.model_copy(update={"requirements": [first.model_copy(update={"pinned_lessons": pins}), *week.requirements[1:]]})
    _the_searches_find_nothing(monkeypatch)

    assert RELEASED in _rows(placed)
