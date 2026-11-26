"""Årskurs för årskurs, granskningen av #482: the road is paid for out of the budget, and phase 1b gets what is LEFT.

`_solve_strict` read `remaining` before the road and handed phase 1b that number whether or not the road had spent its
seconds on the way: a road that ended in nothing (a step out of time, INFEASIBLE with the years above it held) gave phase 1b
the budget it had had before it, and the solve ran as long past its budget as the road had taken (up to YEARS_CAP_SECONDS),
which is past the route's ceiling (budget + probe + headroom, app.timing) and so a 503 where the TIMEOUT and its account were due.
The clock below is the test's own, so the seconds are exact; the engine's code, the model and the CP-SAT status are real
except where a search is named to give up and to spend what it was given.
"""

from __future__ import annotations

import sys
import types
from pathlib import Path

import pytest
from ortools.sat.python import cp_model

_BENCH = Path(__file__).resolve().parents[1] / "benchmarks"
if str(_BENCH) not in sys.path:
    sys.path.insert(0, str(_BENCH))

import app.solver.scheduler_solver as scheduler_solver  # noqa: E402
from app.config import Settings  # noqa: E402
from app.solver.scheduler_solver import SchedulerSolver  # noqa: E402
from school_corpus import SchoolShape, build_week  # noqa: E402

SHAPE = SchoolShape(classes_per_year=2, group_subjects=3, mixing=0.5, seed=1)
BUDGET = 540.0
START = 1000.0
#: What phase 1a spends before it gives up: its slice is min(budget, CLEAN_SAT_CAP_SECONDS), and it uses all of it.
PHASE_1A = 60.0


class _Spends(cp_model.CpSolver):
    """A search that spends `seconds` on the test's clock and answers `status` (the real status of a search that gave up)."""

    def __init__(self, now: list[float], seconds: float, status: int) -> None:
        super().__init__()
        self._now, self._seconds, self._status = now, seconds, status

    def Solve(self, model, solution_callback=None):  # noqa: N802
        self._now[0] += self._seconds
        return self._status


def _clocked(monkeypatch: pytest.MonkeyPatch, *, second_step: int, budget: float = BUDGET):  # noqa: ANN202
    """The engine with its clock replaced. Phase 1a gives up after 60 s, the road's first step is laid for real (one second), its
    second step ends in `second_step` after the whole of its time, and phase 1b gives up after all it was given: what each
    generation search was given is `given`, as (the clock when it began, seconds)."""
    now = [START]
    monkeypatch.setattr(scheduler_solver, "time", types.SimpleNamespace(monotonic=lambda: now[0], perf_counter=lambda: now[0]))
    given: list[tuple[float, float]] = []
    steps = {"n": 0}

    class Clocked(SchedulerSolver):
        @staticmethod
        def _generation_solver(request, seconds):  # type: ignore[override]  # noqa: ANN001, ANN205
            given.append((now[0], seconds))
            return _Spends(now, PHASE_1A if len(given) == 1 else seconds, cp_model.UNKNOWN)

        def _years_solver(self, request, seconds):  # type: ignore[override]  # noqa: ANN001
            steps["n"] += 1
            if steps["n"] > 1:
                return _Spends(now, seconds, second_step)
            real = SchedulerSolver._generation_solver(request, seconds)
            solve = real.Solve

            def spend(model, solution_callback=None):  # noqa: ANN001, ANN202
                now[0] += 1.0
                return solve(model)

            real.Solve = spend  # type: ignore[method-assign]
            return real

    solver = Clocked(Settings(SOLVER_MAX_TIME_SECONDS=budget, SOLVER_PROBE_SECONDS=0))  # type: ignore[call-arg]
    return solver, build_week(SHAPE).request, given, now


@pytest.mark.parametrize("second_step", [cp_model.UNKNOWN, cp_model.INFEASIBLE], ids=["out-of-time", "infeasible-with-years-held"])
def test_phase_1b_is_given_what_the_budget_has_left_after_a_road_that_ended_in_nothing(
    monkeypatch: pytest.MonkeyPatch, second_step: int,
) -> None:
    solver, request, given, now = _clocked(monkeypatch, second_step=second_step)

    response = solver.solve(request)

    assert response.status == "TIMEOUT"
    assert len(given) == 2, "phase 1a and phase 1b: the steps have their own solver"
    began, seconds = given[1]
    assert began - START >= 60.0 + 1.0, "the road ran before phase 1b"
    assert began + seconds <= START + BUDGET + 1e-6, (
        f"phase 1b began at +{began - START:.0f} s and was given {seconds:.0f} s: it ends at +{began + seconds - START:.0f} s "
        f"of a budget of {BUDGET:.0f}"
    )
    assert now[0] - START <= BUDGET + 1e-6, f"the TIMEOUT was answered at +{now[0] - START:.0f} s of a budget of {BUDGET:.0f}"


def test_a_road_that_laid_the_week_leaves_phase_1b_what_the_budget_has_left(monkeypatch: pytest.MonkeyPatch) -> None:
    """The case that was right (the budget was read again for a week the road laid): it stays so."""
    from app.schemas.schedule import PreviousLesson

    solver, request, given, now = _clocked(monkeypatch, second_step=cp_model.OPTIMAL)

    def lay(self, req, seconds):  # noqa: ANN001, ANN202
        now[0] += 40.0  # the road took 40 s and laid a week (a hint for every requirement; what is hinted is not under test)
        return [PreviousLesson(requirementId=r.id, dayOfWeek=1, startTime="08:00:00") for r in req.requirements]

    monkeypatch.setattr(SchedulerSolver, "_lay_by_years", lay)

    solver.solve(request)

    began, seconds = given[1]
    assert began - START == 100.0, "phase 1a's 60 s and the road's 40"
    assert began + seconds == START + BUDGET


# ---- what the road is given: a third of what is left, at most ninety seconds, and nothing when there is next to nothing left ----


@pytest.mark.parametrize(
    ("budget", "wanted"),
    [(540.0, 90.0), (120.0, 20.0)],
    ids=["production: the cap", "a short budget: a third"],
)
def test_the_road_is_given_a_third_of_what_phase_1a_left_and_at_most_ninety_seconds(
    monkeypatch: pytest.MonkeyPatch, budget: float, wanted: float,
) -> None:
    solver, request, _given, _now = _clocked(monkeypatch, second_step=cp_model.UNKNOWN, budget=budget)
    asked: list[float] = []
    real = SchedulerSolver._lay_by_years

    def lay(self, req, seconds):  # noqa: ANN001, ANN202
        asked.append(seconds)
        return real(self, req, seconds)

    monkeypatch.setattr(SchedulerSolver, "_lay_by_years", lay)

    solver.solve(request)

    assert asked == [pytest.approx(wanted)], asked


def test_there_is_no_road_when_less_than_two_minimum_phases_are_left(monkeypatch: pytest.MonkeyPatch) -> None:
    """The road needs room for a step's search and for phase 1b after it: under 2 x MIN_PHASE_SECONDS it is not entered."""
    solver, request, given, _now = _clocked(monkeypatch, second_step=cp_model.UNKNOWN, budget=PHASE_1A + 0.9)
    asked: list[float] = []
    real = SchedulerSolver._lay_by_years

    def lay(self, req, seconds):  # noqa: ANN001, ANN202
        asked.append(seconds)
        return real(self, req, seconds)

    monkeypatch.setattr(SchedulerSolver, "_lay_by_years", lay)

    solver.solve(request)

    assert asked == []
    assert len(given) == 2, "phase 1a and phase 1b, no step between"


def test_a_step_that_has_no_time_left_once_it_is_built_is_not_searched(monkeypatch: pytest.MonkeyPatch) -> None:
    """The builds are in the road's seconds: a step whose build took what was left is given up without a search."""
    solver, request, _given, now = _clocked(monkeypatch, second_step=cp_model.UNKNOWN, budget=PHASE_1A + 3.0)
    real_build = SchedulerSolver._build_model
    week = request.request_id

    def build(self, req, **kwargs):  # noqa: ANN001, ANN003, ANN202
        if req.request_id != week:  # a step: its build takes 0.7 s of the 1 s the road was given
            now[0] += 0.7
        return real_build(self, req, **kwargs)

    monkeypatch.setattr(SchedulerSolver, "_build_model", build)
    searched: list[float] = []
    real_years = solver._years_solver
    solver._years_solver = lambda req, seconds: searched.append(seconds) or real_years(req, seconds)  # type: ignore[method-assign]

    solver.solve(request)

    assert searched == []
