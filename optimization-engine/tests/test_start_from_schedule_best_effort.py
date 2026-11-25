"""Ett schema som start, granskningen av #460: what Bästa möjliga schema does with the field (and what the docs say it does).

The docs said a best-effort run "tries the week strictly first". It does not: the engine has no strict try inside
`_solve_best_effort`. Where nothing in the week is priced the mode IS the strict solve and the driver runs; where
something is, the relaxed solve runs and the field is not read at all.
"""

from __future__ import annotations

import sys
from dataclasses import replace
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "benchmarks"))

from app.config import Settings  # noqa: E402
from app.schemas.schedule import OptimizeScheduleRequest, StartedLesson  # noqa: E402
from app.solver.scheduler_solver import SchedulerSolver  # noqa: E402
from school_corpus import SchoolShape, build_week  # noqa: E402

SHAPE = SchoolShape(classes_per_year=2, group_subjects=3, mixing=0.5, seed=1)


def _settings() -> Settings:
    return Settings(SOLVER_MAX_TIME_SECONDS=20.0, SOLVER_PROBE_SECONDS=0)  # type: ignore[call-arg]


def _best_effort(request: OptimizeScheduleRequest) -> OptimizeScheduleRequest:
    payload = request.model_dump(by_alias=True, exclude_none=True)
    payload["relaxation"] = {"mode": "BEST_EFFORT"}
    return OptimizeScheduleRequest.model_validate(payload)


@pytest.mark.parametrize("priced", [False, True])
def test_a_best_effort_run_starts_from_the_schedule_only_where_nothing_is_priced(
    priced: bool, monkeypatch: pytest.MonkeyPatch,
) -> None:
    week = build_week(SHAPE).request
    schedule = SchedulerSolver(_settings()).solve(week)
    assert schedule.status in ("OPTIMAL", "FEASIBLE")
    if priced:
        first = week.requirements[0]
        week = week.model_copy(update={"requirements": [first.model_copy(update={"max_lessons_per_day": first.lessons_per_week}), *week.requirements[1:]]})
    week = week.model_copy(update={"start_lessons": [
        StartedLesson(requirementId=l.requirement_id, dayOfWeek=l.day_of_week, startTime=l.start_time, endTime=l.end_time)
        for l in schedule.lessons
    ]})
    calls: list[int] = []
    original = SchedulerSolver._solve_from_start

    def counted(self, request, entered):  # noqa: ANN001, ANN202
        calls.append(len(request.start_lessons or []))
        return original(self, request, entered)

    monkeypatch.setattr(SchedulerSolver, "_solve_from_start", counted)

    answer = SchedulerSolver(_settings()).solve(_best_effort(week))

    assert answer.status in ("OPTIMAL", "FEASIBLE")
    assert bool(calls) is (not priced), "the driver runs for a week with nothing priced, and for no other"
