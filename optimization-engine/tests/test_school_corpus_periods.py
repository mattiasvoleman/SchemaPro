"""A corpus year is cut into as many periods as a school's dated posts cut it into (M5).

periods-are-not-terms: a real läsår has six to eight periods, because every dated post cuts it
again, and the engine plans, checks and prices each of them as a week of its own
(app/solver/weeks.py). The corpus's first terms were two, autumn and spring, so a week with
"a quarter of its minutes in term posts" cost the engine two weeks where the school's costs six:
PRECHECKS (the lunch stage and the week load, once per solved week) took half the time.
"""

from __future__ import annotations

import sys
from dataclasses import replace
from pathlib import Path

import pytest

_BENCH = Path(__file__).resolve().parents[1] / "benchmarks"
if str(_BENCH) not in sys.path:
    sys.path.insert(0, str(_BENCH))

import school_corpus as corpus  # noqa: E402
from app.config import Settings  # noqa: E402
from app.solver.scheduler_solver import SchedulerSolver, _weeks_and_requests  # noqa: E402

SMALL = corpus.SchoolShape(classes_per_year=2, group_subjects=3)


def _solved_weeks(shape) -> int:
    return len(_weeks_and_requests(corpus.build_week(shape).request))


def test_two_periods_are_the_autumn_and_the_spring_as_they_always_were() -> None:
    week = corpus.build_week(replace(SMALL, classes_per_year=4, group_subjects=0, languages=0, term_subjects=2))
    assert {r.periods for r in week.request.requirements if r.periods is not None} == {
        (True, False), (False, True),
    }
    assert _solved_weeks(replace(SMALL, classes_per_year=4, group_subjects=0, languages=0, term_subjects=2)) == 2


def test_more_periods_are_a_run_each_and_the_engine_plans_every_one_of_them() -> None:
    shape = replace(corpus.PRODUCTION, classes_per_year=3, term_periods=6)
    week = corpus.build_week(shape)
    masks = {r.periods for r in week.request.requirements if r.periods is not None}
    assert masks
    for mask in masks:
        assert len(mask) == 6
        runs = [i for i in range(6) if mask[i]]
        assert runs == list(range(runs[0], runs[-1] + 1)), mask  # one stretch of periods, no gap
        assert mask[0] or mask[-1], mask  # an autumn post starts the year, a spring post ends it
    assert any(mask[0] and mask[2] for mask in masks), "an autumn post runs on past the first switch"
    assert any(mask[-1] and mask[3] for mask in masks), "a spring post starts before the last switch"
    assert _solved_weeks(shape) == 6
    assert _solved_weeks(replace(shape, term_periods=2)) == 2
    assert shape.name() == "n9-g10-m0-s1-t5p6-h"
    assert replace(shape, term_periods=2).name() == "n9-g10-m0-s1-t5-h"


def test_the_sweep_has_the_production_form_cut_into_six_periods_and_the_engine_does_not_refuse_it() -> None:
    solver = SchedulerSolver(Settings(SOLVER_MAX_TIME_SECONDS=5))  # type: ignore[call-arg]
    six = [s for s in corpus.sweep_shapes(seeds=(1,)) if s.term_periods == 6]
    assert {s.classes for s in six} == {6, 9}
    for shape in six:
        week = corpus.build_week(shape)
        # Six periods, as far as the posts tell them apart: six classes have too few units to
        # separate the last two.
        assert _solved_weeks(shape) == (6 if shape.classes == 9 else 5)
        assert solver.check_week(week.request).verdict != "IMPOSSIBLE", shape.name()


def test_a_period_count_the_engine_does_not_take_is_refused_here() -> None:
    for periods in (1, 0, corpus.MAX_PERIODS + 1):
        with pytest.raises(ValueError, match="term_periods"):
            corpus.build_week(replace(SMALL, term_subjects=1, term_periods=periods))
