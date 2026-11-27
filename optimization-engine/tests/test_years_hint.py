"""Årskurs för årskurs, granskningen av #482: what the road is FOR is that phase 1b starts in the timetable it laid.

The road's whole value is the hint: nothing it finds is an answer, and a road whose timetable never reached phase 1b would
cost its seconds and give nothing back, with every other test of it green (a mutant that laid the week and then did not hint
the clone survived all of test_years.py).
"""

from __future__ import annotations

import sys
from pathlib import Path

from ortools.sat.python import cp_model

_BENCH = Path(__file__).resolve().parents[1] / "benchmarks"
if str(_BENCH) not in sys.path:
    sys.path.insert(0, str(_BENCH))

from app.config import Settings  # noqa: E402
from app.solver.scheduler_solver import SchedulerSolver  # noqa: E402
from school_corpus import SchoolShape, build_week  # noqa: E402

SHAPE = SchoolShape(classes_per_year=2, group_subjects=3, mixing=0.5, seed=1)


class _GivesUp(cp_model.CpSolver):
    def Solve(self, model, solution_callback=None):  # noqa: N802
        return cp_model.UNKNOWN


def test_phase_1b_is_hinted_with_a_start_for_every_lesson_the_road_laid() -> None:
    request = build_week(SHAPE).request
    hinted: list[int] = []

    class Spy(SchedulerSolver):
        asked = 0

        @staticmethod
        def _generation_solver(req, seconds):  # type: ignore[override]  # noqa: ANN001, ANN205
            Spy.asked += 1
            if Spy.asked == 1:
                return _GivesUp()  # phase 1a
            solver = SchedulerSolver._generation_solver(req, seconds)
            if Spy.asked == 2:  # phase 1b: what the clone is given
                real = solver.Solve

                def solve(model, solution_callback=None):  # noqa: ANN001, ANN202
                    hinted.append(len(model.Proto().solution_hint.vars))
                    return real(model)

                solver.Solve = solve  # type: ignore[method-assign]
            return solver

        def _years_solver(self, req, seconds):  # type: ignore[override]  # noqa: ANN001
            return SchedulerSolver._generation_solver(req, seconds)

    response = Spy(Settings(SOLVER_MAX_TIME_SECONDS=30, SOLVER_PROBE_SECONDS=0)).solve(request)  # type: ignore[call-arg]

    assert response.lessons
    assert hinted == [sum(r.lessons_per_week for r in request.requirements)], hinted
