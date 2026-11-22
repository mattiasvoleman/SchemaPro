"""The step a ceiling's 503 names must be a step the solve is IN (review of #371, MEDEL-1 and MEDEL-2).

`SchedulerSolver.stage_where` is what `run_solver` reads when it stops waiting: the step the
solve's own clock has open. The clock opened SEARCH_CLEAN or SEARCH_CLONE when the search began and
never closed it, so a solve that had PROVED a week infeasible (and was explaining the proof), or had
FOUND a timetable (and was improving it in phase 2), was still "in its first search for a timetable"
as far as a ceiling that fell then could tell. A best-effort solve of a week with nothing to relax
hands the week to a strict solver of its own, and the outer solver's clock stayed in PRECHECKS for
as long as that one ran. The page turns the step into a sentence ("it was busy with the first search
for a timetable, which had gone on for 230 s"), so a step that is not the one it was in is a false
sentence, said to a school.

These read `stage_where()` from the thread that waits, at the instant the solve's thread is held
inside the step in question: no ceiling and no wall clock is involved, so the answer is the same on a
loaded host.
"""

from __future__ import annotations

import threading

import pytest
from ortools.sat.python import cp_model

from app.schemas.schedule import OptimizeScheduleRequest
from app.solver import scheduler_solver
from app.solver.scheduler_solver import SchedulerSolver
from tests import test_search_options as tso


def _hold_the_nth_solve(
    monkeypatch: pytest.MonkeyPatch, nth: int, *, answers: dict[int, int] | None = None,
) -> tuple[threading.Event, threading.Event]:
    """Every CpSolver.Solve from the `nth` on waits to be released; earlier ones answer at once.

    `answers` fakes the status of the earlier calls (a proof of infeasibility at once, say); a call
    not in it runs CP-SAT for real. Returns (reached, release).
    """
    reached, release = threading.Event(), threading.Event()
    calls: list[int] = []
    original = cp_model.CpSolver.Solve

    def solve(solver: cp_model.CpSolver, model: cp_model.CpModel, *args: object, **kwargs: object) -> int:
        calls.append(1)
        number = len(calls)
        if number >= nth:
            reached.set()
            release.wait(30)
            return cp_model.INFEASIBLE if answers is not None else original(solver, model, *args, **kwargs)
        if answers is not None and number in answers:
            return answers[number]
        return original(solver, model, *args, **kwargs)

    monkeypatch.setattr(cp_model.CpSolver, "Solve", solve)
    return reached, release


def _where_while_held(
    solver: SchedulerSolver, payload: dict[str, object], reached: threading.Event, release: threading.Event,
) -> tuple[str, float, float] | None:
    request = OptimizeScheduleRequest.model_validate(payload)
    thread = threading.Thread(target=lambda: _quiet(solver, request), daemon=True)
    thread.start()
    try:
        assert reached.wait(60), "the solve never reached the step the test holds it in"
        return solver.stage_where()
    finally:
        release.set()
        thread.join(60)


def _quiet(solver: SchedulerSolver, request: OptimizeScheduleRequest) -> None:
    try:
        solver.solve(request)
    except Exception:  # noqa: BLE001 - the held step is released into a faked answer; only the clock is read
        pass


def _settings() -> object:
    return tso._settings(SOLVER_MAX_TIME_SECONDS=20, SOLVER_PROBE_SECONDS=4)


def test_a_search_in_progress_is_named_as_the_search(monkeypatch: pytest.MonkeyPatch) -> None:
    """The control: the step IS the search while phase 1a runs."""
    reached, release = _hold_the_nth_solve(monkeypatch, 1)

    where = _where_while_held(SchedulerSolver(_settings()), tso._payload(), reached, release)

    assert where is not None and where[0] == "SEARCH_CLEAN"


def test_the_explanation_of_a_proof_is_not_the_search(monkeypatch: pytest.MonkeyPatch) -> None:
    """Phase 1a answered INFEASIBLE at once; the explanation (the second solve) is what holds the thread."""
    reached, release = _hold_the_nth_solve(monkeypatch, 2, answers={1: cp_model.INFEASIBLE})
    monkeypatch.setattr(scheduler_solver, "build_conflict_analysis", lambda solver, registry: None)

    where = _where_while_held(SchedulerSolver(_settings()), tso._payload(changeover=5), reached, release)

    assert where is None, f"a ceiling now would say the solve was {where[0]} for {where[1]} s"


def test_phase_two_is_not_the_search_for_a_timetable(monkeypatch: pytest.MonkeyPatch) -> None:
    """A timetable was found by phase 1a; phase 2 (the second solve) improves it."""
    reached, release = _hold_the_nth_solve(monkeypatch, 2)

    where = _where_while_held(SchedulerSolver(_settings()), tso._payload(), reached, release)

    assert where is None, f"a ceiling now would say the solve was {where[0]} for {where[1]} s"


def test_phase_two_of_a_best_effort_solve_is_not_the_search_either(monkeypatch: pytest.MonkeyPatch) -> None:
    reached, release = _hold_the_nth_solve(monkeypatch, 2)
    payload = tso._payload()
    payload["requirements"][0]["maxLessonsPerDay"] = 2  # type: ignore[index]  # a rule on the list: something to price
    payload["relaxation"] = {"mode": "BEST_EFFORT"}

    where = _where_while_held(SchedulerSolver(_settings()), payload, reached, release)

    assert where is None, f"a ceiling now would say the solve was {where[0]} for {where[1]} s"
