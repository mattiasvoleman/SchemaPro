"""benchmarks/corpus_measure.py: an engine without the stage clock is measured without a detour (M5, review of #394).

The nightly gate's floor is main as it was a week ago. `_stage_seconds` is called from inside `CpSolver.Solve`
the moment the first timetable is found; an AttributeError there is taken by the engine's `_solve_guarded` for a
CP-SAT crash and answered with a second solve without presolve, and a warning in the log for every week (seen on
a floor of 816ddf47d, which has no `_stages`).
"""

from __future__ import annotations

import sys
from pathlib import Path

_BENCH = Path(__file__).resolve().parents[1] / "benchmarks"
if str(_BENCH) not in sys.path:
    sys.path.insert(0, str(_BENCH))

import corpus_measure as measure  # noqa: E402
from app.config import Settings  # noqa: E402


def _solver() -> measure.MeasuringSolver:
    return measure.MeasuringSolver(
        Settings(SOLVER_MAX_TIME_SECONDS=100, SOLVER_PROBE_SECONDS=0),  # type: ignore[call-arg]
        mode="count", deterministic_budget=5, seed=1,
    )


def test_an_engine_with_no_stage_clock_has_no_stage_seconds() -> None:
    solver = _solver()
    del solver._stages  # what an engine from before M2 looks like
    assert solver._stage_seconds(1.0) == []


def test_an_engine_whose_clock_has_other_fields_has_no_stage_seconds_and_no_error() -> None:
    solver = _solver()
    solver._stages = object()
    assert solver._stage_seconds(1.0) == []
