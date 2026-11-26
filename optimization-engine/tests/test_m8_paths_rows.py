"""The encodings of benchmarks/m8_paths.py hold apart exactly the lessons the engine's own rows do (M8, road c).

The design note says the three other encodings are "the same rule written another way": a NoOverlap over a
clique is exactly its pairs' rows. test_m8_paths.py holds that by laying TINY once under each encoding and
looking for a clash, which a model that forgot half its rows can pass by luck (a solver that is not told two
groups must be apart still often puts them apart). These read it off the model instead, without a search:

  * the control, `pairs`, posts the engine's own rows (so a change to `_add_group_no_overlap` in the engine that
    the override does not follow is seen here, not in a measurement that compares against a stale control);
  * every other encoding holds apart the same pairs of lessons, no pair missing (a clash let through) and none
    extra (a rule the engine does not have, which would make the week harder than it is).
"""

from __future__ import annotations

import sys
from itertools import combinations
from pathlib import Path

import pytest

_BENCH = Path(__file__).resolve().parents[1] / "benchmarks"
if str(_BENCH) not in sys.path:
    sys.path.insert(0, str(_BENCH))

import m8_paths as paths  # noqa: E402
from app.config import Settings  # noqa: E402
from app.solver.scheduler_solver import SchedulerSolver  # noqa: E402
from school_corpus import SchoolShape, build_week  # noqa: E402

WEEKS = {
    "nine classes, four subjects in groups": SchoolShape(classes_per_year=3, group_subjects=4, mixing=1.0),
    "with terms": SchoolShape(classes_per_year=2, group_subjects=3, mixing=1.0, term_subjects=2),
}


class _Built(BaseException):
    """The group rows are posted: the model is read and the solve does not go on."""


class _ReadsRows:
    """Whatever solver it is mixed into: the NoOverlap rows its `_add_group_no_overlap` posts, as lesson names."""

    def _add_group_no_overlap(self, model, decisions, group_conflicts=None, **kwargs):  # type: ignore[no-untyped-def]
        proto = model.Proto()
        before = len(proto.constraints)
        super()._add_group_no_overlap(model, decisions, group_conflicts, **kwargs)  # type: ignore[misc]
        names = [proto.constraints[index].name for index in range(len(proto.constraints))]
        self.rows = [
            tuple(names[interval].split("_", 1)[1] for interval in proto.constraints[index].no_overlap.intervals)
            for index in range(before, len(proto.constraints))
            if proto.constraints[index].has_no_overlap()
        ]
        raise _Built


class _EnginesRows(_ReadsRows, SchedulerSolver):
    pass


class _EncodingsRows(_ReadsRows, paths.EncodingSolver):
    pass


def _rows(week, encoding: str | None, *, engine_cliques: bool = False) -> list[tuple[str, ...]]:
    """The rows the build posts for the groups: the engine's own for None, else those of `encoding`.

    THE ENGINE'S OWN ARE ONE ROW PER PAIR unless `engine_cliques` (SOLVER_GROUP_CLIQUES, M8 PR 6 made the full model of a
    strict solve cliques by default): the benchmark's `pairs` is the encoding the engine had, and this holds it to that."""
    settings = Settings(  # type: ignore[call-arg]
        SOLVER_MAX_TIME_SECONDS=60, SOLVER_PROBE_SECONDS=0, SOLVER_GROUP_CLIQUES=engine_cliques,
    )
    solver = (
        _EnginesRows(settings) if encoding is None
        else _EncodingsRows(
            settings, encoding=encoding, cohorts=week.cohorts, mode="count", deterministic_budget=1.0, seed=1,
        )
    )
    with pytest.raises(_Built):
        solver.solve(week.request)
    return solver.rows  # type: ignore[attr-defined]


def _held_apart(rows: list[tuple[str, ...]]) -> set[tuple[str, str]]:
    return {pair for row in rows for pair in combinations(sorted(set(row)), 2)}


@pytest.mark.parametrize("label", WEEKS)
def test_the_pair_encoding_posts_the_engines_own_rows(label: str) -> None:
    week = build_week(WEEKS[label])
    assert _rows(week, "pairs") == _rows(week, None)


@pytest.mark.parametrize("encoding", ["cliques", "cohorts", "both"])
@pytest.mark.parametrize("label", WEEKS)
def test_an_encoding_holds_apart_exactly_the_lessons_the_pairs_do(label: str, encoding: str) -> None:
    week = build_week(WEEKS[label])
    engine_rows, rows = _rows(week, None), _rows(week, encoding)
    engines, ours = _held_apart(engine_rows), _held_apart(rows)
    assert not engines - ours, f"{len(engines - ours)} pairs of lessons the engine keeps apart, {encoding} lets through"
    assert not ours - engines, f"{len(ours - engines)} pairs of lessons {encoding} keeps apart that the engine does not"


@pytest.mark.parametrize("label", WEEKS)
def test_the_engines_clique_rows_are_the_benchmarks_cliques_row_for_row(label: str) -> None:
    """The measurements of the design note (m8_paths.py's `cliques`) are of the rows the engine now posts: the same cover."""
    week = build_week(WEEKS[label])
    assert _rows(week, None, engine_cliques=True) == _rows(week, "cliques")
