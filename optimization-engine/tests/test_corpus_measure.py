"""benchmarks/corpus_measure.py: the measuring stick for the corpus (M5).

The stick hooks into the engine from outside (a subclass that replaces
`_generation_solver`), so the first thing held here is that the hook still
fires: a solver that stops calling it must fail these tests, not make the
nightly gate measure nothing. Then what the gate stands on: count mode repeats a
search exactly, a week with no timetable inside the budget is a TIMEOUT, and a
refusal is a refusal.
"""

from __future__ import annotations

import sys
from dataclasses import replace
from pathlib import Path

import pytest

_BENCH = Path(__file__).resolve().parents[1] / "benchmarks"
if str(_BENCH) not in sys.path:
    sys.path.insert(0, str(_BENCH))

import corpus_measure as measure  # noqa: E402
from app.schemas.schedule import TimeoutStageName  # noqa: E402
from school_corpus import SchoolShape, build_week  # noqa: E402
from typing import get_args  # noqa: E402

#: Small enough to solve in a second or two, with a group form so that the model has pupils to keep apart.
TINY = SchoolShape(classes_per_year=2, group_subjects=2, mixing=1.0)
#: Larger, so that a hundredth of a deterministic second finds nothing.
BIGGER = SchoolShape(classes_per_year=4, group_subjects=5, mixing=1.0)


def test_the_hook_sees_the_search_and_stops_at_the_first_timetable() -> None:
    result = measure.measure_request(build_week(TINY).request, mode="count", deterministic_budget=5)
    assert result["status"] == "FIRST_SCHEDULE"
    assert result["firstScheduleSeconds"] is not None
    assert result["firstScheduleDeterministic"] is not None
    assert result["firstScheduleDeterministic"] > 0
    searches = result["searches"]
    assert searches, "the engine no longer asks _generation_solver for its searches: the hook is dead"
    assert searches[-1]["status"] in ("OPTIMAL", "FEASIBLE")
    # It stopped there: phase 2 (the improving search) never ran.
    assert sum(1 for s in searches if s["status"] in ("OPTIMAL", "FEASIBLE")) == 1
    assert result["firstScheduleSeconds"] <= result["totalSeconds"] + 0.05


def test_count_mode_repeats_a_search_exactly() -> None:
    """The nightly gate compares two trees by this number: it must not move between runs."""
    request = build_week(TINY).request
    runs = [measure.measure_request(request, mode="count", deterministic_budget=5) for _ in range(2)]
    assert runs[0]["conflicts"] == runs[1]["conflicts"]
    assert runs[0]["firstScheduleDeterministic"] == runs[1]["firstScheduleDeterministic"]
    assert runs[0]["deterministicSeconds"] == runs[1]["deterministicSeconds"]


def test_count_mode_runs_one_worker_and_a_fixed_seed() -> None:
    request = build_week(TINY).request
    seen: list[tuple[int, int]] = []

    class Spy(measure.MeasuringSolver):
        def _generation_solver(self, request, seconds):  # type: ignore[override]
            solver = super()._generation_solver(request, seconds)
            seen.append((solver.parameters.num_workers, solver.parameters.random_seed))
            return solver

    from app.config import Settings

    Spy(
        Settings(SOLVER_MAX_TIME_SECONDS=100, SOLVER_PROBE_SECONDS=0),  # type: ignore[call-arg]
        mode="count", deterministic_budget=5, seed=7,
    ).measure(request)
    assert seen
    assert all(workers == 1 and seed == 7 for workers, seed in seen)


def test_a_week_with_no_timetable_inside_the_budget_is_a_timeout() -> None:
    result = measure.measure_request(build_week(BIGGER).request, mode="count", deterministic_budget=0.001)
    assert result["status"] == "TIMEOUT"
    assert result["firstScheduleSeconds"] is None
    assert result["firstScheduleDeterministic"] is None


def test_a_week_the_engine_proves_impossible_is_a_refusal_with_its_code_and_not_a_timeout() -> None:
    """Four teachers each on five parallel groups of one subject in a grade-year with 3 classes."""
    shape = SchoolShape(classes_per_year=3, group_subjects=9, shared_teachers=4, mixing=1.0)
    result = measure.measure_request(build_week(shape).request, mode="count", deterministic_budget=5)
    assert result["status"] == "INFEASIBLE"
    assert "TEACHER_SHARED_BY_PARALLEL_GROUPS" in result["conflictCodes"]
    assert result["firstScheduleSeconds"] is None


def test_a_request_the_engine_refuses_before_any_model_is_reported_refused() -> None:
    request = build_week(TINY).request
    request.requirements[0].student_group_size = 900  # fits no room
    result = measure.measure_request(request, mode="count", deterministic_budget=5)
    assert result["status"] == "REFUSED"
    assert result["conflictCodes"][0] == "InvalidScheduleInputError"
    assert result["searches"] == []


def test_the_steps_are_the_engine_s_own_names() -> None:
    result = measure.measure_request(build_week(TINY).request, mode="count", deterministic_budget=5)
    names = set(result["stages"])
    assert names
    assert names <= set(get_args(TimeoutStageName))
    assert "SEARCH_CLEAN" in names or "SEARCH_CLONE" in names


def test_clock_mode_leaves_the_engine_s_own_parameters_alone() -> None:
    request = build_week(TINY).request
    seen: list[tuple[int, bool]] = []

    class Spy(measure.MeasuringSolver):
        def _generation_solver(self, request, seconds):  # type: ignore[override]
            solver = super()._generation_solver(request, seconds)
            seen.append((solver.parameters.num_workers, solver.parameters.max_deterministic_time < float("inf")))
            return solver

    from app.config import Settings

    Spy(
        Settings(SOLVER_MAX_TIME_SECONDS=30, SOLVER_PROBE_SECONDS=0),  # type: ignore[call-arg]
        mode="clock", deterministic_budget=5, seed=1,
    ).measure(request)
    assert seen
    # The engine's default (0: every core) and no deterministic limit.
    assert all(workers == 0 and not limited for workers, limited in seen)


def test_an_unknown_mode_is_refused() -> None:
    with pytest.raises(ValueError, match="mode must be"):
        measure.measure_request(build_week(replace(TINY)).request, mode="fast")


def test_the_first_timetable_decides_even_when_the_engine_swallows_the_stop(monkeypatch) -> None:
    """An older engine's path (816ddf47d) caught the stop and went on: the measurement stands at the first."""
    import app.solver.scheduler_solver as engine

    real = engine._solve_guarded

    def swallowing(solver, model, **kwargs):
        try:
            return real(solver, model, **kwargs)
        except BaseException:  # noqa: BLE001
            return measure.cp_model.UNKNOWN

    monkeypatch.setattr(engine, "_solve_guarded", swallowing)
    request = build_week(TINY).request
    swallowed = measure.measure_request(request, mode="count", deterministic_budget=5)
    monkeypatch.undo()
    plain = measure.measure_request(request, mode="count", deterministic_budget=5)
    assert swallowed["status"] == "FIRST_SCHEDULE"
    assert swallowed["firstScheduleDeterministic"] == plain["firstScheduleDeterministic"]
    # No search was run after the first timetable.
    assert sum(1 for s in swallowed["searches"] if s["status"] in ("OPTIMAL", "FEASIBLE")) == 1


def test_an_engine_that_never_hands_its_searches_to_the_hook_is_an_error_and_not_a_measurement(monkeypatch) -> None:
    from app.config import Settings
    from app.solver.scheduler_solver import SchedulerSolver

    class Unhooked(measure.MeasuringSolver):
        def _generation_solver(self, request, seconds):  # type: ignore[override]
            return SchedulerSolver._generation_solver(request, seconds)  # a plain CpSolver: nothing recorded

    result = Unhooked(
        Settings(SOLVER_MAX_TIME_SECONDS=30, SOLVER_PROBE_SECONDS=0),  # type: ignore[call-arg]
        mode="clock", deterministic_budget=5, seed=1,
    ).measure(build_week(TINY).request)
    assert result["status"] == "ERROR"
    assert result["conflictCodes"][0] == "HOOK_NOT_CALLED"
    assert result["firstScheduleSeconds"] is None


def test_a_timeout_that_the_wall_clock_decided_is_an_error_and_not_a_timeout(monkeypatch) -> None:
    """The first sweep's 13 TIMEOUTs at load 55-119 were the host's: a search cut before its budget."""
    monkeypatch.setattr(measure, "COUNT_WALL_MULTIPLE", 0.01)  # a wall limit of 0.05 s for a budget of 5
    result = measure.measure_request(build_week(BIGGER).request, mode="count", deterministic_budget=5)
    assert result["status"] == "ERROR"
    assert result["conflictCodes"][0] == "WALL_LIMIT_BEFORE_BUDGET"
    assert result["firstScheduleSeconds"] is None


def test_a_timeout_the_deterministic_budget_decided_is_still_a_timeout() -> None:
    result = measure.measure_request(build_week(BIGGER).request, mode="count", deterministic_budget=0.001)
    assert result["status"] == "TIMEOUT"
    assert all(s["deterministic"] >= 0.95 * 0.001 for s in result["searches"])
