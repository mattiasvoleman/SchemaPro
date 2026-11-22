"""benchmarks/corpus_trajectory.py: conflicts at each deterministic second, for the calibration (M5)."""

from __future__ import annotations

import sys
from pathlib import Path

_BENCH = Path(__file__).resolve().parents[1] / "benchmarks"
if str(_BENCH) not in sys.path:
    sys.path.insert(0, str(_BENCH))

import corpus_trajectory as tr  # noqa: E402
from school_corpus import SchoolShape, build_week  # noqa: E402

#: Large enough that a deterministic hundredth of a second ends the first search without a timetable.
BIGGER = SchoolShape(classes_per_year=4, group_subjects=5, mixing=1.0)
TINY = SchoolShape(classes_per_year=2, group_subjects=2, mixing=1.0)


def test_more_deterministic_seconds_mean_more_conflicts_and_the_same_table_twice() -> None:
    request = build_week(BIGGER).request
    first = tr.trajectory(request, [0.02, 0.05])
    again = tr.trajectory(request, [0.02, 0.05])
    assert first == again  # a search is the same on every run: the table does not depend on the machine
    assert all(p["conflicts"] is not None for p in first)
    assert first[0]["conflicts"] < first[1]["conflicts"]


def test_the_work_a_point_stopped_at_is_the_point_it_asked_for() -> None:
    (point,) = tr.trajectory(build_week(BIGGER).request, [0.05])
    assert 0.95 * 0.05 <= point["deterministic"] <= 1.5 * 0.05


def test_a_week_that_gets_a_timetable_before_the_point_has_no_conflicts_at_it() -> None:
    (point,) = tr.trajectory(build_week(TINY).request, [30.0])
    assert point["conflicts"] is None
