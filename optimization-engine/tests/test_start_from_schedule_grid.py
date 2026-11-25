"""Ett schema som start, granskningen av #460: a schedule's odd start does not change the week's start step.

The start step is the gcd of every constant a start is compared with, and each previous lesson and each pinned lesson
is one. A schedule held and given as the hint carries every start it has into every attempt, the last one included:
a schedule with one lesson at 08:05 in a week of half hours made the step five minutes where it was thirty, six times
the start values of every lesson and a build six times as long, in the attempt that holds nothing too.
"""

from __future__ import annotations

import sys
from dataclasses import replace
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "benchmarks"))

import app.solver.scheduler_solver as scheduler_solver  # noqa: E402
from app.config import Settings  # noqa: E402
from app.schemas.schedule import StartedLesson  # noqa: E402
from app.solver import staged  # noqa: E402
from app.solver.scheduler_solver import SchedulerSolver  # noqa: E402
from school_corpus import SchoolShape, build_week  # noqa: E402

SHAPE = SchoolShape(classes_per_year=2, group_subjects=3, mixing=0.5, seed=1)
OTHER = replace(SHAPE, seed=2)


def _clock(total: int) -> str:
    return f"{total // 60:02d}:{total % 60:02d}:00"


def _minutes(value: str) -> int:
    hours, minutes, _ = (int(part) for part in value.split(":"))
    return hours * 60 + minutes


def _settings() -> Settings:
    return Settings(SOLVER_MAX_TIME_SECONDS=30.0, SOLVER_PROBE_SECONDS=0)  # type: ignore[call-arg]


@pytest.fixture(scope="module")
def schedule() -> list:
    answer = SchedulerSolver(_settings()).solve(build_week(OTHER).request)
    assert answer.status in ("OPTIMAL", "FEASIBLE")
    return answer.lessons


def test_one_entry_off_the_weeks_grid_leaves_the_start_step_of_every_attempt_as_it_was(
    schedule: list, monkeypatch: pytest.MonkeyPatch,
) -> None:
    week = build_week(OTHER).request
    solver = SchedulerSolver(_settings())
    plain_step = scheduler_solver._start_step(week, solver._grid)
    assert plain_step > 1, "the corpus week's own times are on the half hour"
    entries = [StartedLesson(requirementId=l.requirement_id, dayOfWeek=l.day_of_week, startTime=l.start_time, endTime=l.end_time) for l in schedule]
    first = entries[0]
    entries[0] = StartedLesson(
        requirementId=first.requirement_id, dayOfWeek=first.day_of_week,
        startTime=_clock(_minutes(first.start_time) + 5), endTime=_clock(_minutes(first.end_time) + 5),
    )
    request = week.model_copy(update={"start_lessons": entries})
    steps: list[int] = []
    original = SchedulerSolver._solve_strict

    def recorded(self, attempt, entered):  # noqa: ANN001, ANN202
        steps.append(scheduler_solver._start_step(attempt, self._grid))
        return original(self, attempt, entered)

    monkeypatch.setattr(SchedulerSolver, "_solve_strict", recorded)

    answer = SchedulerSolver(_settings()).solve(request)

    assert answer.status in ("OPTIMAL", "FEASIBLE")
    assert steps and set(steps) == {plain_step}, f"the steps the attempts were built on: {steps}, the week's own is {plain_step}"


def test_a_start_the_week_does_not_reach_is_left_out_and_counted() -> None:
    week = build_week(OTHER).request
    requirement = week.requirements[0]
    length = requirement.lesson_minutes()[0]
    odd = StartedLesson(requirementId=requirement.id, dayOfWeek=1, startTime="08:05:00", endTime=_clock(8 * 60 + 5 + length))
    fine = StartedLesson(requirementId=requirement.id, dayOfWeek=2, startTime="08:00:00", endTime=_clock(8 * 60 + length))

    held = staged.held_places(week.model_copy(update={"start_lessons": [odd, fine]}), on_grid=lambda clock: clock.endswith(":00:00"))

    assert held.dropped == {"a start off the week's own grid": 1}
    assert [(p.day_of_week, p.start_time) for p in held.places[requirement.id] if p is not None] == [(2, "08:00:00")]
    attempt = staged.attempt(week.model_copy(update={"start_lessons": [odd, fine]}), held, set())
    assert [(p.day_of_week, p.start_time) for p in attempt.previous_lessons] == [(2, "08:00:00")], "the hint is what is held"
