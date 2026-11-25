"""benchmarks/m8_paths.py: the measuring script of M8 (Veckor i skolans form).

Three things are held, because the numbers in the design note stand on them:

  * a clique cover covers every pair and each of its cliques is one (so a row over it says what its pairs say);
  * a week laid under any of the three encodings has no two groups that share a pupil on top of each other
    (the encodings are the same rule written three ways, and a faster one that let a clash through would be
    measuring something else);
  * a road that cuts the week (a year at a time, a layer of terms at a time) hands back lessons that the engine
    itself accepts for the whole week with every one of them pinned where the road laid it.
"""

from __future__ import annotations

import sys
import types
from itertools import combinations
from pathlib import Path
from uuid import UUID

import pytest

_BENCH = Path(__file__).resolve().parents[1] / "benchmarks"
if str(_BENCH) not in sys.path:
    sys.path.insert(0, str(_BENCH))

import m8_paths as paths  # noqa: E402
from school_corpus import SchoolShape, build_week  # noqa: E402

TINY = SchoolShape(classes_per_year=2, group_subjects=2, mixing=1.0)
TERMS = SchoolShape(classes_per_year=2, group_subjects=2, mixing=1.0, term_subjects=2)


def _uuid(n: int) -> UUID:
    return UUID(int=n, version=4)


def test_a_clique_cover_covers_every_pair_with_cliques() -> None:
    nodes = {_uuid(n) for n in range(1, 9)}
    pairs = [(_uuid(a), _uuid(b)) for a, b in combinations(range(1, 6), 2)]  # 1..5 all together
    pairs += [(_uuid(5), _uuid(6)), (_uuid(6), _uuid(7)), (_uuid(5), _uuid(7)), (_uuid(7), _uuid(8))]
    cliques = paths.clique_cover(pairs, nodes)
    edges = {frozenset(pair) for pair in pairs}
    held = {frozenset(pair) for clique in cliques for pair in combinations(clique, 2)}
    assert held == edges, "every pair held, and no pair that does not exist"
    assert any(len(clique) == 5 for clique in cliques), "the five that are all together are one row"


def test_the_corpus_keeps_the_pupils_lists_the_pairs_were_made_from() -> None:
    """`CorpusWeek.cohorts` is what `groupConflicts` was derived from, and adds nothing to the request."""
    week = build_week(TINY)
    held = {frozenset(pair) for cohort in week.cohorts for pair in combinations(sorted(cohort, key=str), 2)}
    asked = {frozenset(pair) for pair in week.request.group_conflicts}
    assert held == asked
    assert not any("cohort" in key.lower() for key in week.request.model_dump(by_alias=True))


def test_a_clique_cover_is_the_same_every_time() -> None:
    nodes = {_uuid(n) for n in range(1, 7)}
    pairs = [(_uuid(a), _uuid(b)) for a, b in combinations(range(1, 7), 2) if (a + b) % 3]
    assert paths.clique_cover(pairs, nodes) == paths.clique_cover(list(reversed(pairs)), nodes)


@pytest.mark.parametrize("encoding", paths.ENCODINGS)
def test_every_encoding_keeps_the_pairs_apart(encoding: str) -> None:
    week = build_week(TINY)
    row = paths.measure_encoding(
        week, encoding, mode="count", budget=0, deterministic_budget=5, seed=1,
    )
    assert row["status"] == "FIRST_SCHEDULE", row
    stage = paths.run_stage(
        week.request, label="check", free=0, encoding=encoding, cohorts=week.cohorts, mode="count",
        budget=0, deterministic_budget=5, seed=1,
    )
    assert stage.status == "FIRST_SCHEDULE"
    assert paths._clashes(week, stage.lessons) == set()


def test_the_encodings_post_fewer_rows_than_the_pairs() -> None:
    week = build_week(SchoolShape(classes_per_year=3, group_subjects=4, mixing=1.0))
    # The rows are counted when the model is built; nothing here needs the week laid, so the search gets a
    # budget too small to find a timetable in (four searches to a first timetable were 60 % of this file's time).
    rows = {
        encoding: paths.measure_encoding(
            week, encoding, mode="count", budget=0, deterministic_budget=0.05, seed=1,
        )["noOverlapRows"]
        for encoding in paths.ENCODINGS
    }
    assert rows["cliques"] < rows["pairs"]
    assert rows["cohorts"] < rows["pairs"]


def _args(**more) -> types.SimpleNamespace:
    base = {
        "mode": "count", "budget": 0.0, "det_budget": 5.0, "order": "hardest", "stage_encoding": "pairs",
        "verify": True, "repair": 2,
    }
    return types.SimpleNamespace(**{**base, **more})


def test_the_years_road_lays_a_week_the_engine_accepts() -> None:
    week = build_week(TINY)
    row = paths.road_years(week, _args(), seed=1)
    assert row["status"] == "FIRST_SCHEDULE", row
    assert row["verified"] is True
    assert [stage["stage"] for stage in row["stages"]][0].startswith("year ")


def test_the_year_order_follows_the_pairs_and_the_teachers() -> None:
    week = build_week(SchoolShape(classes_per_year=2, years=(7, 8, 9), group_subjects_by_year=(0, 3, 6), mixing=1.0))
    assert paths.year_order(week, "hardest") == [9, 8, 7]
    assert paths.year_order(week, "up") == [7, 8, 9]
    assert paths.year_order(week, "down") == [9, 8, 7]


def test_the_periods_roads_lay_a_week_with_terms() -> None:
    week = build_week(TERMS)
    for road in (paths.road_periods_calendar, paths.road_periods_core):
        row = road(week, _args(repair=3), seed=1)
        assert row["status"] == "FIRST_SCHEDULE", (road.__name__, row)
        assert row["verified"] is True, road.__name__
