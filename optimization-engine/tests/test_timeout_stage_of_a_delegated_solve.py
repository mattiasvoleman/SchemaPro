"""A best-effort solve of a week with nothing to relax names no step it is not in (review of #371, MEDEL-2).

Bästa möjliga schema on a week that carries none of the rules it may relax is the strict solve
(`prices_anything` is false), and `_solve_best_effort` hands the request to a SchedulerSolver of its
own. That solver keeps its own clock; the one the route reads (`stage_where` of the solver the route
built) stayed in PRECHECKS, opened when solve() was entered, for as long as the delegate ran. A
ceiling that fell then answered `stage: PRECHECKS`, and the page said the engine had been busy with
the checks before the search for the whole wait, while the delegate was in its first search.

Read from the thread that waits, with the solve's thread held inside the delegate's phase 1a, so no
ceiling and no wall clock is involved.
"""

from __future__ import annotations

import threading

import pytest
from ortools.sat.python import cp_model

from app.schemas.schedule import OptimizeScheduleRequest
from app.solver.scheduler_solver import SchedulerSolver
from tests import test_search_options as tso


def test_the_outer_solver_names_no_step_while_its_delegate_searches(monkeypatch: pytest.MonkeyPatch) -> None:
    reached, release = threading.Event(), threading.Event()
    original = cp_model.CpSolver.Solve

    def solve(solver: cp_model.CpSolver, model: cp_model.CpModel, *args: object, **kwargs: object) -> int:
        reached.set()
        release.wait(30)
        return original(solver, model, *args, **kwargs)

    monkeypatch.setattr(cp_model.CpSolver, "Solve", solve)
    payload = tso._payload()  # no max_lessons_per_day, no teacher rule, no room lock: nothing to price
    payload["relaxation"] = {"mode": "BEST_EFFORT"}
    request = OptimizeScheduleRequest.model_validate(payload)
    solver = SchedulerSolver(tso._settings(SOLVER_MAX_TIME_SECONDS=20, SOLVER_PROBE_SECONDS=4))

    thread = threading.Thread(target=lambda: solver.solve(request), daemon=True)
    thread.start()
    try:
        assert reached.wait(60), "the delegate never reached its first search"
        where = solver.stage_where()
    finally:
        release.set()
        thread.join(60)

    assert where is None, f"a ceiling now would say the solve was {where[0]} for {where[1]} s"
