"""The sweep of benchmarks/school_corpus.py against the engine's own verdicts (M5).

A corpus week the engine REFUSES measures the refusal, in milliseconds, and not a search:
the limits table would then read "no schedule" for a row that was never tried. build_week
holds the engine's limits (pairs, requirements, room size); what it cannot see is the arithmetic
of SchedulerSolver._prechecks, which says IMPOSSIBLE of a week whose year needs more of the
frame than the frame has. So the sweep is held to that too.
"""

from __future__ import annotations

import sys
from pathlib import Path

_BENCH = Path(__file__).resolve().parents[1] / "benchmarks"
if str(_BENCH) not in sys.path:
    sys.path.insert(0, str(_BENCH))

import school_corpus as corpus  # noqa: E402
from app.config import Settings  # noqa: E402
from app.solver.scheduler_solver import SchedulerSolver  # noqa: E402


def test_no_week_of_the_sweep_is_refused_by_the_engine_s_own_arithmetic() -> None:
    solver = SchedulerSolver(Settings(SOLVER_MAX_TIME_SECONDS=5))  # type: ignore[call-arg]
    refused = {}
    for shape in corpus.sweep_shapes(seeds=(1,)):
        answer = solver.check_week(corpus.build_week(shape).request)
        if answer.verdict == "IMPOSSIBLE":
            refused[shape.name()] = [(year.year, year.percent) for year in answer.years]
    assert not refused, f"the engine refuses these weeks before any search: {refused}"


def test_the_m_axis_reaches_as_many_shared_teachers_as_it_asks_for_where_the_week_holds_them() -> None:
    """The point of the axis: a table row for M = 4 must be a week with four shared teachers."""
    weeks = {shape.name(): corpus.build_week(shape) for shape in corpus.sweep_shapes(seeds=(1,))}
    for classes in (9, 12):
        for asked in (0, 1, 2):
            assert weeks[f"n{classes}-g3-m{asked}-s1"].facts["sharedTeachers"] == asked
    assert weeks["n12-g3-m4-s1-p2"].facts["sharedTeachers"] == 4
    assert weeks["n12-g3-m8-s1-p2"].facts["sharedTeachers"] == 8


def test_two_shapes_that_differ_only_in_how_many_groups_a_shared_teacher_has_are_two_names() -> None:
    from dataclasses import replace

    one = replace(corpus.BASE, shared_teachers=4, seed=1)
    other = replace(one, groups_per_shared_teacher=2)
    assert one.name() != other.name()
    assert corpus.build_week(one).request.request_id != corpus.build_week(other).request.request_id
    # What the default builds keeps the name it had.
    assert one.name() == "n9-g3-m4-s1"
