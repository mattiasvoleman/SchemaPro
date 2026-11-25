"""Ett schema som start, granskningen av #460: a solve that was asked again reports every second in a step.

`_explain_infeasible` begins with `_leave_stage()` (a ceiling that falls in an explanation names no step), so the
seconds of each refused attempt's explanation had no step to be in: `StageClock.enter` opened the next step at
the instant it was called and the gap fell out of the list. A TIMEOUT after six refused attempts said its steps
added up to 478 s of a total of 562, and nobody could say where the other 84 went.
"""

from __future__ import annotations

import types
import uuid

import pytest

import app.solver.scheduler_solver as scheduler_solver
from app.config import Settings
from app.schemas.schedule import ConflictAnalysis, ConflictDetail, OptimizeScheduleResponse, StartedLesson
from app.solver.scheduler_solver import SchedulerSolver
from app.solver.stage_clock import StageClock

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "benchmarks"))
from school_corpus import SchoolShape, build_week  # noqa: E402

SHAPE = SchoolShape(classes_per_year=2, group_subjects=3, mixing=0.5, seed=1)


def _report(clock: StageClock, now: float):  # noqa: ANN202
    return clock.report(now, budget_seconds=5, configured_budget_seconds=5, caller_wait_seconds=None, week_load_cut=False)


def test_the_seconds_between_a_finished_step_and_the_next_one_belong_to_the_next_one() -> None:
    clock = StageClock(0.0)
    clock.enter("BUILD", 1.0)
    clock.enter("SEARCH_CLEAN", 5.0)
    clock.finish(30.0)               # an INFEASIBLE answer is in hand: its explanation runs, with no step open
    assert clock.where(40.0) is None
    clock.enter("START", 42.0)       # the driver reads the refusal
    clock.enter("PRECHECKS", 43.0)

    report = _report(clock, 50.0)

    assert [(s.stage, s.seconds) for s in report.stages] == [("PRECHECKS", 8.0), ("BUILD", 4.0), ("SEARCH_CLEAN", 25.0), ("START", 13.0)]
    assert round(sum(s.seconds for s in report.stages), 1) == report.total_seconds == 50.0


def test_a_solve_that_ends_after_finish_is_what_it_was() -> None:
    """Nothing opens after the last `finish`, so no gap is carried into a step that was never entered."""
    clock = StageClock(0.0)
    clock.enter("BUILD", 1.0)
    clock.finish(5.0)
    clock.finish(9.0)                # `_leave_stage` is called again at the end of solve(): the first closing stands
    report = _report(clock, 9.0)
    assert [(s.stage, s.seconds) for s in report.stages] == [("PRECHECKS", 1.0), ("BUILD", 4.0)]


def _driven(monkeypatch: pytest.MonkeyPatch):  # noqa: ANN202
    """A driver run with `_solve_strict` replaced by what the real one does to the clock: builds, a refusal that is
    explained with no step open, and at last a TIMEOUT. Seconds are the fake clock's."""
    now = [1000.0]
    monkeypatch.setattr(scheduler_solver, "time", types.SimpleNamespace(monotonic=lambda: now[0], perf_counter=lambda: now[0]))
    request = build_week(SHAPE).request
    given = request.requirements[:6]
    request = request.model_copy(update={
        "start_lessons": [
            StartedLesson(requirementId=r.id, dayOfWeek=1 + i % 5, startTime="08:00:00", endTime=f"{8 + r.lesson_minutes()[0] // 60:02d}:{r.lesson_minutes()[0] % 60:02d}:00")
            for i, r in enumerate(given)
        ],
        "group_conflicts": [], "constraints": [],
    })
    calls = {"n": 0}

    def fake(self, attempt, entered):  # noqa: ANN001, ANN202
        calls["n"] += 1
        self._enter_stage("BUILD")
        now[0] += 8.0
        self._enter_stage("SEARCH_CLEAN")
        now[0] += 3.0
        if calls["n"] <= 2:
            self._leave_stage()          # _explain_infeasible's first line
            now[0] += 12.0               # the explanation
            named = given[calls["n"] - 1].id
            detail = ConflictDetail(category="PLACEMENT", code="PLACED_LESSON_IN_THE_WAY_ANY_ROOM", params={"requirement": str(named), "day": 1, "start": "08:00", "end": "09:00"}, requirement_ids=[named])
            return OptimizeScheduleResponse(request_id=uuid.uuid4(), status="INFEASIBLE", lessons=[], conflicts=ConflictAnalysis(conflicts=[detail]))  # type: ignore[arg-type]
        now[0] += 40.0
        return self._timeout_answer(attempt, None, week_load_cut=False)

    monkeypatch.setattr(SchedulerSolver, "_solve_strict", fake)
    solver = SchedulerSolver(Settings(SOLVER_MAX_TIME_SECONDS=540, SOLVER_PROBE_SECONDS=20))  # type: ignore[call-arg]
    solver._stages = StageClock(now[0])
    return solver._solve_from_start(request, now[0]), now[0] - 1000.0


def test_a_timeout_after_refused_attempts_has_steps_that_add_up_to_its_total(monkeypatch: pytest.MonkeyPatch) -> None:
    response, elapsed = _driven(monkeypatch)

    assert response.status == "TIMEOUT" and response.report is not None
    steps = response.report.stages
    assert response.report.total_seconds == elapsed == 3 * (8.0 + 3.0) + 2 * 12.0 + 40.0
    assert round(sum(s.seconds for s in steps), 1) == response.report.total_seconds, [(s.stage, s.seconds) for s in steps]
